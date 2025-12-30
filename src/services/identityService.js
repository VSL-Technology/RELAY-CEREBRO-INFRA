// src/services/identityService.js
// Resolve identity by sid, update last seen, and authorize pending payment idempotently.
import identityStore from "./identityStore.js";
import { authorizeByPedidoIp } from "./authorize.js";
import { getMikById } from "../config/mikrotiks.js";
import { classifyError } from "./errors/classifyError.js";
import routerHealth from "./routerHealth.js";
import jobStore from "./jobStore.js";
import metrics from "./metrics.js";
import { markPendingFailed, markPendingApplied } from "./identityStore.js";

function pickRouter({ routerHint, identity, pendingRouterId, lastSeenRouterId }) {
  return routerHint || identity || pendingRouterId || lastSeenRouterId || null;
}

const PRUNE_COOLDOWN_MS = 60000;
let lastPruneAt = 0;
const AUTHORIZE_BACKOFF_MS = [2000, 5000, 10000, 20000, 40000, 60000, 120000, 240000];

async function maybePrune() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_COOLDOWN_MS) return;
  lastPruneAt = now;
  await identityStore.prune();
}

export async function refreshAndAuthorize({ sid, ip, mac, routerHint, identity }) {
  if (!sid) throw new Error('sid required');

  // persist last seen info
  await identityStore.upsertLastSeen(sid, { ip, mac, routerId: routerHint || identity, identity, routerHint });
  // periodic prune to keep store lean
  await maybePrune();

  const pending = identityStore.getPending(sid);
  if (!pending) {
    return { ok: false, code: 'no_pending_payment' };
  }
  const now = Date.now();
  if (pending.status === 'FAILED') {
    const waitMs = pending.nextEligibleAt ? Math.max(0, pending.nextEligibleAt - now) : 0;
    if (pending.nextEligibleAt && waitMs > 0) {
      return { ok: true, authorized: false, pending_authorization: false, code: pending.failCode || 'authorization_failed_after_retries', retryInMs: waitMs };
    }
    // auto-reset to PENDING after cooldown
    await identityStore.markPending(sid, { ...pending, status: 'PENDING', attempts: pending.attempts || 0, failCode: null, failedAt: null, nextEligibleAt: null });
  }

  const existing = identityStore.getIdentity(sid);
  const lastSeen = existing && existing.lastSeen ? existing.lastSeen : {};

  const routerId = pickRouter({
    routerHint,
    identity,
    pendingRouterId: pending.routerId,
    lastSeenRouterId: lastSeen.routerId
  });
  if (!routerId) return { ok: false, code: 'router_not_resolved' };

  // Validate router exists (will throw if not)
  getMikById(routerId);

  const ipToUse = ip || lastSeen.ip;
  const macToUse = mac || lastSeen.mac;
  if (!ipToUse || !macToUse) return { ok: false, code: 'missing_ip_or_mac' };

  const actionKey = `${routerId}:${pending.pedidoId}:AUTHORIZE`;
  if (identityStore.isApplied(sid, actionKey)) {
    return { ok: true, authorized: true, idempotent: true, pedidoId: pending.pedidoId, routerId, actionKey };
  }

  // circuit breaker: if router not allowed now, schedule and return pending
  if (!routerHealth.canAttempt(routerId)) {
    await scheduleAuthorizePending({
      sid,
      pedidoId: pending.pedidoId,
      routerId,
      routerHint,
      identity,
      ip: ipToUse,
      mac: macToUse,
      attempt: 0
    });
    const h = routerHealth.getHealth(routerId);
    const retryMs = h && h.openUntil ? Math.max(0, h.openUntil - Date.now()) : AUTHORIZE_BACKOFF_MS[0] || 2000;
    metrics.inc("relay.p0_authorize_pending_total");
    return {
      ok: true,
      authorized: false,
      pending_authorization: true,
      code: 'authorization_scheduled',
      retryInMs: retryMs
    };
  }

  metrics.inc("relay.p0_authorize_attempt_total");

  try {
    const res = await authorizeByPedidoIp({
      pedidoId: pending.pedidoId,
      mikId: routerId,
      ipAtual: ipToUse,
      macAtual: macToUse
    });

    if (res && res.ok) {
      await identityStore.markApplied(sid, actionKey, { pedidoId: pending.pedidoId, routerId });
      await markPendingApplied(sid, pending.pedidoId);
      metrics.inc("relay.p0_authorize_success_total");
      return { ok: true, authorized: true, pedidoId: pending.pedidoId, routerId, actionKey, result: res };
    }
    metrics.inc("relay.p0_authorize_failed_total");
    return { ok: false, code: 'authorize_failed', result: res };
  } catch (err) {
    const cls = classifyError(err);
    routerHealth.updateRouterHealth(routerId, cls);
    metrics.inc(`relay.error_class_${cls.class || 'unknown'}_${cls.code || 'unknown'}`);

    if (cls.class === 'transient') {
      await scheduleAuthorizePending({
        sid,
        pedidoId: pending.pedidoId,
        routerId,
        routerHint,
        identity,
        ip: ipToUse,
        mac: macToUse,
        attempt: 0
      });
      metrics.inc("relay.p0_authorize_pending_total");
      return {
        ok: true,
        authorized: false,
        pending_authorization: true,
        code: 'authorization_scheduled',
        retryInMs: AUTHORIZE_BACKOFF_MS[0] || 2000
      };
    }

    // setup/auth/inconsistent/unknown: do not schedule
    metrics.inc("relay.p0_authorize_failed_total");
    return { ok: false, code: cls.code || 'authorize_failed', class: cls.class || 'unknown' };
  }
}

async function scheduleAuthorizePending(payload = {}) {
  const attempt = payload.attempt || 0;
  const base = AUTHORIZE_BACKOFF_MS[Math.min(attempt, AUTHORIZE_BACKOFF_MS.length - 1)] || 2000;
  const jitter = Math.floor(base * 0.2 * Math.random());
  const delay = base + jitter;
  const id = `auth-${payload.sid || 'unknown'}-${Date.now()}-${attempt}`;
  const job = {
    id,
    type: "AUTHORIZE_PENDING",
    payload: { ...payload, attempt },
    runAt: Date.now() + delay,
    createdAt: Date.now()
  };
  await jobStore.addJob(job);
}

export async function retryAuthorizePending(payload = {}) {
  const { sid, routerId: routerIdPayload, routerHint, identity, ip, mac, attempt = 0 } = payload;
  if (!sid) return { ok: false, code: 'sid_required' };

  const pending = identityStore.getPending(sid);
  if (!pending) return { ok: false, code: 'no_pending_payment' };
  const now = Date.now();
  if (pending.status === 'FAILED') {
    const waitMs = pending.nextEligibleAt ? Math.max(0, pending.nextEligibleAt - now) : 0;
    if (pending.nextEligibleAt && waitMs > 0) {
      return { ok: false, pending_authorization: false, code: pending.failCode || 'authorization_failed_after_retries', retryInMs: waitMs };
    }
    await identityStore.markPending(sid, { ...pending, status: 'PENDING', attempts: pending.attempts || 0, failCode: null, failedAt: null, nextEligibleAt: null });
  }

  const existing = identityStore.getIdentity(sid);
  const lastSeen = existing && existing.lastSeen ? existing.lastSeen : {};

  const routerId = pickRouter({
    routerHint,
    identity,
    pendingRouterId: pending.routerId || routerIdPayload,
    lastSeenRouterId: lastSeen.routerId
  });
  if (!routerId) return { ok: false, code: 'router_not_resolved' };

  const ipToUse = ip || lastSeen.ip;
  const macToUse = mac || lastSeen.mac;
  if (!ipToUse || !macToUse) return { ok: false, code: 'missing_ip_or_mac' };

  const actionKey = `${routerId}:${pending.pedidoId}:AUTHORIZE`;
  if (identityStore.isApplied(sid, actionKey)) {
    return { ok: true, authorized: true, idempotent: true, pedidoId: pending.pedidoId, routerId, actionKey };
  }

  // respect circuit breaker
  if (!routerHealth.canAttempt(routerId)) {
    const nextAttempt = attempt;
    await scheduleAuthorizePending({ ...payload, attempt: nextAttempt });
    metrics.inc("relay.p0_authorize_pending_total");
    return { ok: false, pending_authorization: true, code: 'router_circuit_open' };
  }

  metrics.inc("relay.p0_authorize_attempt_total");

  try {
    const res = await authorizeByPedidoIp({
      pedidoId: pending.pedidoId,
      mikId: routerId,
      ipAtual: ipToUse,
      macAtual: macToUse
    });
    if (res && res.ok) {
      await identityStore.markApplied(sid, actionKey, { pedidoId: pending.pedidoId, routerId });
      await markPendingApplied(sid, pending.pedidoId);
      metrics.inc("relay.p0_authorize_success_total");
      return { ok: true, authorized: true, pedidoId: pending.pedidoId, routerId, actionKey, result: res };
    }
    metrics.inc("relay.p0_authorize_failed_total");
    return { ok: false, code: 'authorize_failed', result: res };
  } catch (err) {
    const cls = classifyError(err);
    routerHealth.updateRouterHealth(routerId, cls);
    metrics.inc(`relay.error_class_${cls.class || 'unknown'}_${cls.code || 'unknown'}`);

    if (cls.class === 'transient') {
      const nextAttempt = attempt + 1;
      if (nextAttempt >= AUTHORIZE_BACKOFF_MS.length) {
        const cooldownMs = 10 * 60 * 1000;
        await markPendingFailed(sid, { pedidoId: pending.pedidoId, failCode: 'authorization_failed_after_retries', attempts: nextAttempt, nextEligibleAt: Date.now() + cooldownMs });
        metrics.inc("relay.p0_authorize_failed_total");
        return { ok: false, code: 'authorization_failed_after_retries', pending_authorization: false, retryInMs: cooldownMs };
      }
      await scheduleAuthorizePending({ ...payload, attempt: nextAttempt });
      metrics.inc("relay.p0_authorize_pending_total");
      return { ok: false, pending_authorization: true, code: 'authorization_rescheduled', attempt: nextAttempt };
    }
    metrics.inc("relay.p0_authorize_failed_total");
    return { ok: false, code: cls.code || 'authorize_failed', class: cls.class || 'unknown' };
  }
}

export { scheduleAuthorizePending };

export default { refreshAndAuthorize, retryAuthorizePending, scheduleAuthorizePending };
