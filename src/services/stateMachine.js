// src/services/stateMachine.js
import jobStore from "./jobStore.js";
import { executeAction } from "./actionHandler.js";
import { getMikById } from "../config/mikrotiks.js";
import cb from "./circuitBreaker.js";
import audit from "./audit.js";
import metrics from "./metrics.js";
import wireguardStatus from "./wireguardStatus.js";
import identityStore from "./identityStore.js";

function now() {
  return Date.now();
}

function makeJobId(prefix = "job") {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function isValidMac(mac) {
  if (!mac) return false;
  const m = mac.trim().toUpperCase();
  // Simple MAC check
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(m);
}

function requireString(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} required`);
  if (typeof value !== "string") throw new Error(`${name} must be string`);
}

export async function processEvent(event) {
  const { eventId, type, payload = {}, timestamp = Date.now() } = event;
  const trace = { eventId, type };

  audit.auditAttempt({ ...trace, stage: "RECEIVED", timestamp });

  // basic validation
  try {
    if (!eventId) throw new Error("missing eventId");
    if (!type) throw new Error("missing type");

    // Validate router if provided
    if (payload.mikId) {
      getMikById(payload.mikId); // will throw if not found
    }

    // Field-level validation
    if (type === "TRIAL_REQUESTED" || type === "RELEASE_REQUESTED") {
      requireString(payload.pedidoId, "pedidoId");
      requireString(payload.mikId, "mikId");
      requireString(payload.ip, "ip");
      requireString(payload.mac, "mac");
      if (!isValidMac(payload.mac)) throw new Error("invalid mac for trial/release");
    }

    if (type === "REVOKE_REQUESTED") {
      requireString(payload.mikId, "mikId");
      if (!payload.ip && !payload.mac) throw new Error("ip or mac required for revoke");
      if (payload.ip) requireString(payload.ip, "ip");
      if (payload.mac) requireString(payload.mac, "mac");
      if (payload.mac && !isValidMac(payload.mac)) throw new Error("invalid mac for revoke");
    }

    if (type === "PAYMENT_CONFIRMED") {
      requireString(payload.sid, "sid");
      requireString(payload.pedidoId, "pedidoId");
      if (payload.routerId) requireString(payload.routerId, "routerId");
    }

    // Trial specific validation
    if (type === "TRIAL_REQUESTED") {
      if (!payload.mac || !isValidMac(payload.mac)) throw new Error("invalid mac for trial");
    }

    audit.auditSuccess({ ...trace, stage: "VALIDATED" });
  } catch (err) {
    audit.auditFail({ ...trace, stage: "VALIDATION_FAIL", error: err.message });
    metrics.inc("events.invalid");
    return { ok: false, reason: "validation", error: err.message };
  }

  // Check circuit
  const routerId = payload.mikId || payload.routerId;
  if (routerId && !cb.allowRequest(routerId)) {
    audit.auditFail({ ...trace, stage: "CHECK_ROUTER", error: "circuit_open" });
    metrics.inc("events.rejected_circuit");
    return { ok: false, reason: "circuit_open" };
  }

  // Optional: pause if WG peer offline for too long when publicKey is available
  const OFFLINE_MAX_AGE = Number(process.env.RELAY_OFFLINE_MAX_AGE_SEC || 300);
  if (routerId && OFFLINE_MAX_AGE > 0 && payload && payload.peerPublicKey) {
    try {
      const status = await wireguardStatus.getPeersStatus();
      const peer = (status.peers || []).find((p) => p.publicKey === payload.peerPublicKey);
      if (peer && peer.status === "OFFLINE" && peer.handshakeAge !== null && peer.handshakeAge > OFFLINE_MAX_AGE) {
        audit.auditFail({ ...trace, stage: "CHECK_ROUTER", error: "peer_offline", handshakeAge: peer.handshakeAge });
        metrics.inc("events.rejected_peer_offline");
        return { ok: false, reason: "peer_offline" };
      }
    } catch (e) {
      // best-effort; do not block
    }
  }

  // Decide action
  try {
    audit.auditAttempt({ ...trace, stage: "EXECUTING" });

    if (type === "TRIAL_REQUESTED") {
      // 1) create persistent revoke job BEFORE marking event processed
      const ttlMs = (payload.trialMinutes || 5) * 60 * 1000;
      const runAt = now() + ttlMs;
      const job = {
        id: makeJobId("trial"),
        type: "REVOKE_TRIAL",
        eventId,
        runAt,
        payload: {
          mikId: payload.mikId,
          mac: payload.mac,
          pedidoId: payload.pedidoId
        },
        createdAt: now()
      };
      jobStore.addJob(job);

      // 2) execute authorize by pedido (authorize temporary access)
      const res = await executeAction({ action: "AUTHORIZE_BY_PEDIDO", payload: { pedidoId: payload.pedidoId, mikId: payload.mikId, ipAtual: payload.ip, macAtual: payload.mac }, source: "event", traceId: eventId });

      if (res && res.ok) {
        audit.auditSuccess({ ...trace, stage: "EXECUTED", result: res });
        jobStore.markEventProcessed(eventId);
        metrics.inc("trial.granted");
        return { ok: true };
      } else {
        // schedule retry
        const retryJob = {
          id: makeJobId("retry"),
          type: "RETRY_EVENT",
          event,
          runAt: now() + 30 * 1000,
          attempts: 1,
          createdAt: now()
        };
        jobStore.addJob(retryJob);
        audit.auditFail({ ...trace, stage: "EXEC_FAILED", error: res && res.error });
        jobStore.markEventProcessed(eventId);
        metrics.inc("trial.failed");
        return { ok: false };
      }

    } else if (type === "RELEASE_REQUESTED") {
      const res = await executeAction({ action: "AUTHORIZE_BY_PEDIDO", payload: { pedidoId: payload.pedidoId, mikId: payload.mikId, ipAtual: payload.ip, macAtual: payload.mac }, source: "event", traceId: eventId });
      if (res && res.ok) {
        audit.auditSuccess({ ...trace, stage: "EXECUTED", result: res });
        jobStore.markEventProcessed(eventId);
        metrics.inc("release.granted");
        return { ok: true };
      } else {
        // retry
        const retryJob = {
          id: makeJobId("retry"),
          type: "RETRY_EVENT",
          event,
          runAt: now() + 30 * 1000,
          attempts: 1,
          createdAt: now()
        };
        jobStore.addJob(retryJob);
        audit.auditFail({ ...trace, stage: "EXEC_FAILED", error: res && res.error });
        jobStore.markEventProcessed(eventId);
        metrics.inc("release.failed");
        return { ok: false };
      }

    } else if (type === "REVOKE_REQUESTED") {
      const res = await executeAction({ action: "REVOKE_SESSION", payload: { mikId: payload.mikId, ip: payload.ip, mac: payload.mac }, source: "event", traceId: eventId });
      if (res && res.ok) {
        audit.auditSuccess({ ...trace, stage: "EXECUTED", result: res });
        jobStore.markEventProcessed(eventId);
        metrics.inc("revoke.done");
        return { ok: true };
      } else {
        const retryJob = {
          id: makeJobId("retry"),
          type: "RETRY_EVENT",
          event,
          runAt: now() + 30 * 1000,
          attempts: 1,
          createdAt: now()
        };
        jobStore.addJob(retryJob);
        audit.auditFail({ ...trace, stage: "EXEC_FAILED", error: res && res.error });
        jobStore.markEventProcessed(eventId);
        metrics.inc("revoke.failed");
        return { ok: false };
      }
    } else if (type === "PAYMENT_CONFIRMED") {
      // mark pending payment for sid; resolve/authorize happens on refresh
      await identityStore.markPending(payload.sid, {
        pedidoId: payload.pedidoId,
        planId: payload.planId || null,
        routerId: payload.routerId || null,
        expiresAt: payload.expiresAt || null
      });
      audit.auditSuccess({ ...trace, stage: "EXECUTED", result: { pendingMarked: true } });
      jobStore.markEventProcessed(eventId);
      metrics.inc("payment.confirmed");
      return { ok: true };
    } else {
      audit.auditFail({ ...trace, stage: "UNKNOWN_TYPE" });
      metrics.inc("events.unknown_type");
      return { ok: false, reason: "unknown_type" };
    }
  } catch (err) {
    audit.auditFail({ ...trace, stage: "UNHANDLED_ERROR", error: err.message });
    metrics.inc("events.error");
    // schedule retry as safe fallback
    const retryJob = {
      id: makeJobId("retry"),
      type: "RETRY_EVENT",
      event,
      runAt: now() + 30 * 1000,
      attempts: 1,
      createdAt: now()
    };
    jobStore.addJob(retryJob);
    jobStore.markEventProcessed(eventId);
    return { ok: false, error: err.message };
  }
}

export default {
  processEvent
};
