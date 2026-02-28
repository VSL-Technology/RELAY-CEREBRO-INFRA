// WireGuard/Mikrotik reconciliador simples: compara estado desejado (registry) com estado atual (wg show) e aplica correções idempotentes.
import logger from "./logger.js";
import metrics from "./metrics.js";
import wireguard from "./wireguardManager.js";
import deviceRegistry from "../registry/deviceRegistry.js";
import peerBinding from "./peerBinding.service.js";
import wireguardStatus from "./wireguardStatus.js";
import controlPlaneConfig from "../config/controlPlane.js";
import { listPeersDesired, updatePeerActual } from "../repositories/wireguardPeerRepository.js";
import {
  listRoutersWithPeers,
  updateRouterWireguardActual
} from "../repositories/routerRepository.js";

const DEFAULT_INTERVAL_MS = Number(process.env.RELAY_RECONCILE_INTERVAL_MS || 60000);
const SHOULD_REMOVE = process.env.RELAY_RECONCILE_REMOVE === "1" || process.env.RELAY_RECONCILE_REMOVE === "true";
const SETUP_LOG_COOLDOWN_MS = 60000;
let lastWgSetupLogAt = 0;

function classifyWgError(err) {
  const code = err && err.code;
  if (code === "WG_INTERFACE_NOT_CONFIGURED") return { retry: false, code };
  if (code === "WG_COMMAND_FAILED" || code === "WG_LIST_PEERS_FAILED") return { retry: true, code };
  return { retry: true, code: code || "WG_UNKNOWN_ERROR" };
}

function shouldLogWgSetup(now = Date.now()) {
  if (now - lastWgSetupLogAt >= SETUP_LOG_COOLDOWN_MS) {
    lastWgSetupLogAt = now;
    return true;
  }
  return false;
}

function normalizeAllowed(allowed) {
  if (!allowed) return "";
  if (Array.isArray(allowed)) return allowed.map((a) => a.trim()).filter(Boolean).sort().join(",");
  return String(allowed)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

function buildDesiredFromJson() {
  const items = deviceRegistry.listDevices() || [];
  return items
    .filter((d) => d.publicKey && d.allowedIps)
    .map((d) => ({
      deviceId: d.deviceId,
      publicKey: d.publicKey,
      allowed: normalizeAllowed(d.allowedIps),
      mikrotikIp: d.meta && d.meta.mikrotik && d.meta.mikrotik.publicIp ? d.meta.mikrotik.publicIp : null
    }));
}

async function readDesiredFromDb() {
  const [peersDesired, routers] = await Promise.all([
    listPeersDesired(),
    listRoutersWithPeers()
  ]);

  const desired = (peersDesired || [])
    .filter((p) => p && p.publicKey && p.allowedIps)
    .map((p) => ({
      deviceId: (p.router && p.router.busId) || p.routerId,
      routerId: p.routerId,
      publicKey: p.publicKey,
      allowed: normalizeAllowed(p.allowedIps),
      mikrotikIp: (p.router && p.router.ipLan) || null
    }));

  return {
    desired,
    peersDesired,
    routers
  };
}

function buildActual(peers = [], bindings = [], statusMap = new Map()) {
  const bindingMap = new Map(bindings.map((b) => [b.publicKey, b]));
  return peers.map((p) => ({
    deviceId: p.deviceId || (bindingMap.get(p.publicKey) && bindingMap.get(p.publicKey).deviceId) || null,
    publicKey: p.publicKey,
    allowed: normalizeAllowed(p.allowedIps || p.allowedIps),
    raw: p,
    binding: bindingMap.get(p.publicKey) || null,
    status: statusMap.get(p.publicKey) || null
  }));
}

function deriveLastHandshakeAt(peerStatus, now = Date.now()) {
  if (!peerStatus || peerStatus.handshakeAge === null || peerStatus.handshakeAge === undefined) return null;
  const age = Number(peerStatus.handshakeAge);
  if (!Number.isFinite(age) || age < 0) return null;
  return new Date(now - age * 1000);
}

function deriveRouterStatus(statuses = []) {
  if (!statuses.length) return "NO_PEERS";
  if (statuses.some((s) => s === "ONLINE")) return "ONLINE";
  if (statuses.some((s) => s === "OFFLINE")) return "OFFLINE";
  if (statuses.some((s) => s === "NEVER_CONNECTED")) return "NEVER_CONNECTED";
  if (statuses.some((s) => s === "MISSING")) return "MISSING";
  return "UNKNOWN";
}

async function persistActualStateToDb({ peersDesired = [], routers = [], statusMap = new Map(), now = Date.now() }) {
  const routersById = new Map((routers || []).map((r) => [r.id, r]));
  const routerAgg = new Map();

  let peerUpdates = 0;
  let peerErrors = 0;
  for (const desiredPeer of peersDesired || []) {
    if (!desiredPeer || !desiredPeer.publicKey) continue;
    const status = statusMap.get(desiredPeer.publicKey) || null;
    const actualStatus = status ? status.status : "MISSING";
    const lastHandshakeAt = deriveLastHandshakeAt(status, now);
    const bytesRx = status ? status.rx : null;
    const bytesTx = status ? status.tx : null;

    try {
      await updatePeerActual({
        publicKey: desiredPeer.publicKey,
        actualStatus,
        lastHandshakeAt,
        bytesRx,
        bytesTx
      });
      peerUpdates += 1;
    } catch (e) {
      peerErrors += 1;
      logger.error("reconciler.write_db_fail", {
        scope: "peer",
        publicKey: desiredPeer.publicKey,
        message: e && e.message
      });
    }

    const key = desiredPeer.routerId;
    if (!key) continue;
    if (!routerAgg.has(key)) {
      routerAgg.set(key, {
        statuses: [],
        bytesRx: 0n,
        bytesTx: 0n,
        lastHandshakeAt: null
      });
    }
    const agg = routerAgg.get(key);
    agg.statuses.push(actualStatus);
    if (status) {
      try {
        agg.bytesRx += BigInt(status.rx || 0);
        agg.bytesTx += BigInt(status.tx || 0);
      } catch (_) {
        // ignore malformed byte metrics
      }
      if (lastHandshakeAt && (!agg.lastHandshakeAt || lastHandshakeAt > agg.lastHandshakeAt)) {
        agg.lastHandshakeAt = lastHandshakeAt;
      }
    }
  }

  let routerUpdates = 0;
  let routerErrors = 0;
  for (const [routerId, agg] of routerAgg.entries()) {
    const router = routersById.get(routerId);
    if (!router) continue;
    const statusWireguard = deriveRouterStatus(agg.statuses);
    try {
      await updateRouterWireguardActual({
        routerId,
        busId: router.busId,
        statusWireguard,
        lastHandshakeAt: agg.lastHandshakeAt,
        bytesRx: agg.bytesRx,
        bytesTx: agg.bytesTx,
        lastSeenAt: new Date(now)
      });
      routerUpdates += 1;
    } catch (e) {
      routerErrors += 1;
      logger.error("reconciler.write_db_fail", {
        scope: "router",
        routerId,
        busId: router.busId,
        message: e && e.message
      });
    }
  }

  logger.info("reconciler.write_db_ok", {
    peerUpdates,
    peerErrors,
    routerUpdates,
    routerErrors
  });
}

async function reconcileOnce() {
  const now = Date.now();
  let desired = [];
  let peersDesiredFromDb = [];
  let routersFromDb = [];
  let usingDbDesired = false;
  let usedFallbackJson = false;

  if (controlPlaneConfig.isModeB) {
    try {
      const dbState = await readDesiredFromDb();
      desired = dbState.desired;
      peersDesiredFromDb = dbState.peersDesired;
      routersFromDb = dbState.routers;
      usingDbDesired = true;
      logger.info("reconciler.db_read_ok", {
        peersDesired: peersDesiredFromDb.length,
        routers: routersFromDb.length
      });

      if (desired.length === 0 && controlPlaneConfig.fallbackJson) {
        desired = buildDesiredFromJson();
        usedFallbackJson = true;
        logger.warn("reconciler.fallback_json_used", {
          reason: "db_desired_empty",
          desiredFromJson: desired.length
        });
      }
    } catch (e) {
      logger.error("reconciler.db_read_fail", { message: e && e.message });
      if (!controlPlaneConfig.fallbackJson) {
        return;
      }
      desired = buildDesiredFromJson();
      usedFallbackJson = true;
      logger.warn("reconciler.fallback_json_used", {
        reason: "db_unavailable",
        desiredFromJson: desired.length
      });
    }
  } else {
    desired = buildDesiredFromJson();
  }

  let actual = [];
  let bindings = [];
  let status = [];
  try {
    bindings = await peerBinding.listBindings();
  } catch (e) {
    logger.error("reconciler.bindings_error", { message: e && e.message });
    metrics.inc("reconciler.bindings_error");
  }
  try {
    actual = await wireguard.listPeers();
  } catch (e) {
    const wg = classifyWgError(e);
    metrics.inc(`reconciler.wg_error_${wg.code}`);
    const msg = { message: e && e.message, code: wg.code, retry: wg.retry };
    if (wg.retry) {
      logger.warn("reconciler.listPeers_error_retry", msg);
    } else {
      if (shouldLogWgSetup()) {
        logger.error("reconciler.listPeers_error_setup", msg);
      }
    }
    return; // skip this cycle; next tick will retry if allowed
  }

  try {
    const st = await wireguardStatus.getPeersStatus();
    status = st && st.peers ? st.peers : [];
    if (st && st.ok === false) {
      logger.error("reconciler.wg_dump_fail", { message: st.error || "wg dump failed" });
    } else {
      logger.info("reconciler.wg_dump_ok", { peers: status.length });
    }
  } catch (e) {
    logger.error("reconciler.wg_dump_fail", { message: e && e.message });
    logger.error("reconciler.status_error", { message: e && e.message });
    metrics.inc("reconciler.status_error");
  }

  const statusMap = new Map(status.map((s) => [s.publicKey, s]));

  if (controlPlaneConfig.isModeB && controlPlaneConfig.writeDb && usingDbDesired && !usedFallbackJson) {
    try {
      await persistActualStateToDb({
        peersDesired: peersDesiredFromDb,
        routers: routersFromDb,
        statusMap,
        now
      });
    } catch (e) {
      logger.error("reconciler.write_db_fail", {
        scope: "batch",
        message: e && e.message
      });
    }
  }

  const actualList = buildActual(actual, bindings, statusMap);
  const actualMap = new Map(actualList.map((p) => [p.publicKey, p]));
  const desiredMap = new Map(desired.map((d) => [d.publicKey, d]));

  const toAddOrUpdate = [];
  for (const d of desired) {
    const a = actualMap.get(d.publicKey);
    if (!a || normalizeAllowed(a.allowed) !== d.allowed) {
      toAddOrUpdate.push(d);
    }
  }

  const toRemove = [];
  for (const a of actualList) {
    if (!desiredMap.has(a.publicKey)) {
      toRemove.push(a);
    }
  }

  // Detect peers offline or missing binding
  for (const a of actualList) {
    if (a.status && a.status.status === "OFFLINE") {
      metrics.inc("reconciler.peer_offline");
      logger.warn("reconciler.peer_offline", { publicKey: a.publicKey, deviceId: a.deviceId, endpoint: a.raw && a.raw.endpoint });
      // if allowedIps matches desired and binding exists, schedule reapply minimal config? best-effort: handled via desired entries
    }
    if (!a.binding) {
      metrics.inc("reconciler.missing_binding");
      logger.warn("reconciler.missing_binding", { publicKey: a.publicKey, deviceId: a.deviceId });
    }
  }

  for (const d of desired) {
    if (!bindings.find((b) => b.publicKey === d.publicKey)) {
      metrics.inc("reconciler.desired_no_binding");
      logger.warn("reconciler.desired_no_binding", { publicKey: d.publicKey, deviceId: d.deviceId, mikrotikIp: d.mikrotikIp });
      if (d.mikrotikIp) {
        try {
          await peerBinding.bindPeer({ publicKey: d.publicKey, deviceId: d.deviceId, mikrotikIp: d.mikrotikIp });
          metrics.inc("reconciler.binding_created");
          logger.info("reconciler.binding_created", { publicKey: d.publicKey, deviceId: d.deviceId, mikrotikIp: d.mikrotikIp });
        } catch (e) {
          metrics.inc("reconciler.binding_error");
          logger.error("reconciler.binding_error", { publicKey: d.publicKey, deviceId: d.deviceId, message: e && e.message });
        }
      }
    }
  }

  for (const item of toAddOrUpdate) {
    try {
      await wireguard.addPeer({
        deviceId: item.deviceId,
        publicKey: item.publicKey,
        allowedIps: item.allowed
      });
      metrics.inc("reconciler.added");
      logger.info("reconciler.peer_synced", { deviceId: item.deviceId, publicKey: item.publicKey, allowedIps: item.allowed });
    } catch (e) {
      metrics.inc("reconciler.add_error");
      logger.error("reconciler.peer_sync_error", { deviceId: item.deviceId, publicKey: item.publicKey, message: e && e.message });
    }
  }

  for (const item of toRemove) {
    if (!SHOULD_REMOVE) {
      logger.warn("reconciler.extra_peer_detected", { publicKey: item.publicKey, endpoint: item.raw && item.raw.endpoint });
      metrics.inc("reconciler.extra_peer");
      continue;
    }
    try {
      if (item.deviceId) {
        await wireguard.removePeer(item.deviceId);
      } else {
        logger.warn("reconciler.skip_remove_unknown_device", { publicKey: item.publicKey });
        continue;
      }
      metrics.inc("reconciler.removed");
      logger.info("reconciler.peer_removed", { publicKey: item.publicKey, deviceId: item.deviceId });
    } catch (e) {
      metrics.inc("reconciler.remove_error");
      logger.error("reconciler.peer_remove_error", { publicKey: item.publicKey, deviceId: item.deviceId, message: e && e.message });
    }
  }
}

let _timer = null;

function start() {
  if (_timer) return;
  if (DEFAULT_INTERVAL_MS <= 0) {
    logger.info("reconciler.disabled");
    return;
  }
  _timer = setInterval(() => {
    reconcileOnce().catch((e) => logger.error("reconciler.unhandled", { message: e && e.message }));
  }, DEFAULT_INTERVAL_MS);
  logger.info("reconciler.started", {
    intervalMs: DEFAULT_INTERVAL_MS,
    remove: SHOULD_REMOVE,
    controlPlaneMode: controlPlaneConfig.mode,
    fallbackJson: controlPlaneConfig.fallbackJson,
    writeDb: controlPlaneConfig.writeDb
  });
}

function stop() {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
  logger.info("reconciler.stopped");
}

export default { start, stop, reconcileOnce };
