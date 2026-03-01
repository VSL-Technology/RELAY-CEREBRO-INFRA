// WireGuard/Mikrotik reconciliador simples: compara estado desejado (registry) com estado atual (wg show) e aplica correções idempotentes.
import logger from "./logger.js";
import metrics from "./metrics.js";
import wireguard from "./wireguardManager.js";
import deviceRegistry from "../registry/deviceRegistry.js";
import peerBinding from "./peerBinding.service.js";
import wireguardStatus from "./wireguardStatus.js";
import controlPlaneConfig from "../config/controlPlane.js";
import {
  listPeersDesired,
  listPeersWithRouter,
  updatePeerActual,
  upsertPeer,
  findPeerByPublicKey
} from "../repositories/wireguardPeerRepository.js";
import {
  listRoutersWithPeers,
  updateRouterWireguardActual,
  upsertRouter
} from "../repositories/routerRepository.js";
import { getDefaultTenant, listTenants } from "../lib/getDefaultTenant.js";

const DEFAULT_INTERVAL_MS = Number(process.env.RELAY_RECONCILE_INTERVAL_MS || 60000);
const SHOULD_REMOVE = process.env.RELAY_RECONCILE_REMOVE === "1" || process.env.RELAY_RECONCILE_REMOVE === "true";
const SETUP_LOG_COOLDOWN_MS = 60000;
const TENANT_AUTO_DISCOVERY_MODE = String(process.env.TENANT_AUTO_DISCOVERY_MODE || "default")
  .trim()
  .toLowerCase();
const TENANT_IP_MAP_RAW = process.env.TENANT_IP_MAP || "";
const TENANT_AUTO_DISCOVERY_MODES = new Set(["default", "by-endpoint-ip"]);
const NORMALIZED_TENANT_AUTO_DISCOVERY_MODE = TENANT_AUTO_DISCOVERY_MODES.has(TENANT_AUTO_DISCOVERY_MODE)
  ? TENANT_AUTO_DISCOVERY_MODE
  : "default";
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

function parseTenantIpMap(raw) {
  const out = new Map();
  if (!raw) return out;
  for (const pair of String(raw).split(";")) {
    const item = pair.trim();
    if (!item) continue;
    const [ip, slug] = item.split("=").map((s) => (s || "").trim());
    if (!ip || !slug) continue;
    out.set(ip, slug);
  }
  return out;
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

async function readDesiredFromDb({ tenantId } = {}) {
  const [peersDesired, routers] = await Promise.all([
    listPeersDesired({ tenantId }),
    listRoutersWithPeers({ tenantId })
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

function autoBusId(publicKey) {
  const suffix = String(publicKey || "").slice(0, 8);
  return `auto-${suffix}`;
}

function endpointHost(endpoint) {
  if (!endpoint) return null;
  const raw = String(endpoint).trim();
  if (!raw || raw === "(none)") return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 1) return raw.slice(1, end);
  }
  const lastColon = raw.lastIndexOf(":");
  if (lastColon > 0) return raw.slice(0, lastColon);
  return raw;
}

function resolveTenantForEndpoint({
  endpoint,
  tenantsBySlug,
  defaultTenant,
  tenantIpMap
}) {
  if (!defaultTenant) return null;
  if (NORMALIZED_TENANT_AUTO_DISCOVERY_MODE !== "by-endpoint-ip") return defaultTenant;

  const host = endpointHost(endpoint);
  if (!host) return defaultTenant;
  const mappedSlug = tenantIpMap.get(host);
  if (!mappedSlug) return defaultTenant;

  const mappedTenant = tenantsBySlug.get(mappedSlug);
  if (!mappedTenant) {
    logger.warn("reconciler.tenant_mapping_not_found", {
      endpointHost: host,
      mappedSlug
    });
    return defaultTenant;
  }

  return mappedTenant;
}

async function autoDiscoverPeer({
  peer,
  now,
  statusMap,
  tenant,
  knownPeerTenantByPublicKey
} = {}) {
  if (!peer || !peer.publicKey || !tenant) return false;

  const existingScoped = await findPeerByPublicKey(peer.publicKey, { tenantId: tenant.id });
  if (existingScoped) return false;

  const existingGlobal = await findPeerByPublicKey(peer.publicKey);
  if (existingGlobal && existingGlobal.router && existingGlobal.router.tenantId !== tenant.id) {
    logger.warn("reconciler.tenant_mismatch_skip", {
      publicKey: peer.publicKey,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      existingTenantId: existingGlobal.router.tenantId
    });
    return false;
  }

  const status = statusMap.get(peer.publicKey) || peer.status || null;
  const actualStatus = (status && status.status) || "ONLINE";
  const endpoint = (status && status.endpoint) || (peer.raw && peer.raw.endpoint) || null;
  const allowedIps =
    normalizeAllowed((status && status.allowedIps) || (peer.raw && peer.raw.allowedIps) || peer.allowed) ||
    "0.0.0.0/32";
  const lastHandshakeAt = deriveLastHandshakeAt(status, now);
  const bytesRx = status ? status.rx : null;
  const bytesTx = status ? status.tx : null;
  const busId = autoBusId(peer.publicKey);
  const fallbackWgPublicKey = `pending:${busId}`;
  const fallbackWgIp = "0.0.0.0/32";

  const router = await upsertRouter({
    tenantId: tenant.id,
    busId,
    wgPublicKey: fallbackWgPublicKey,
    wgIp: fallbackWgIp,
    desiredState: "ACTIVE",
    status: "ACTIVE"
  });

  await upsertPeer({
    routerId: router.id,
    publicKey: peer.publicKey,
    allowedIps,
    endpoint,
    desiredStatus: "ACTIVE"
  });

  await updatePeerActual({
    publicKey: peer.publicKey,
    actualStatus,
    lastHandshakeAt,
    bytesRx,
    bytesTx
  });

  await updateRouterWireguardActual({
    routerId: router.id,
    busId: router.busId,
    statusWireguard: actualStatus,
    lastHandshakeAt,
    bytesRx,
    bytesTx,
    lastSeenAt: new Date(now)
  });

  const host = endpointHost(endpoint);
  if (host) {
    try {
      await peerBinding.bindPeer({
        publicKey: peer.publicKey,
        deviceId: router.busId,
        mikrotikIp: host
      });
      metrics.inc("reconciler.binding_created");
      logger.info("reconciler.binding_created", {
        publicKey: peer.publicKey,
        deviceId: router.busId,
        mikrotikIp: host
      });
    } catch (e) {
      metrics.inc("reconciler.binding_error");
      logger.error("reconciler.binding_error", {
        publicKey: peer.publicKey,
        deviceId: router.busId,
        message: e && e.message
      });
    }
  }

  logger.info("reconciler.auto_discovered_peer", {
    publicKey: peer.publicKey,
    busId: router.busId,
    routerId: router.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    endpoint,
    actualState: actualStatus
  });
  metrics.inc("reconciler.auto_discovered_peer");
  if (knownPeerTenantByPublicKey) {
    knownPeerTenantByPublicKey.set(peer.publicKey, tenant.id);
  }
  return true;
}

async function persistActualStateToDb({
  peersDesired = [],
  routers = [],
  statusMap = new Map(),
  now = Date.now(),
  tenantId = null,
  tenantSlug = null
}) {
  const routersById = new Map((routers || []).map((r) => [r.id, r]));
  const routerAgg = new Map();

  let peerUpdates = 0;
  let peerErrors = 0;
  let tenantMismatchSkips = 0;
  for (const desiredPeer of peersDesired || []) {
    if (!desiredPeer || !desiredPeer.publicKey) continue;
    if (
      tenantId &&
      desiredPeer.router &&
      desiredPeer.router.tenantId &&
      desiredPeer.router.tenantId !== tenantId
    ) {
      tenantMismatchSkips += 1;
      logger.warn("reconciler.tenant_mismatch_skip", {
        scope: "peer",
        publicKey: desiredPeer.publicKey,
        tenantId,
        tenantSlug,
        peerTenantId: desiredPeer.router.tenantId
      });
      continue;
    }
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
        tenantId,
        tenantSlug,
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
    if (tenantId && router.tenantId && router.tenantId !== tenantId) {
      tenantMismatchSkips += 1;
      logger.warn("reconciler.tenant_mismatch_skip", {
        scope: "router",
        routerId,
        busId: router.busId,
        tenantId,
        tenantSlug,
        routerTenantId: router.tenantId
      });
      continue;
    }
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
        tenantId,
        tenantSlug,
        message: e && e.message
      });
    }
  }

  const summary = {
    peerUpdates,
    peerErrors,
    routerUpdates,
    routerErrors,
    tenantMismatchSkips,
    tenantId,
    tenantSlug
  };

  logger.info("reconciler.write_db_ok", summary);
  return summary;
}

async function listTenantsForCycle() {
  try {
    const tenants = await listTenants();
    if (Array.isArray(tenants) && tenants.length > 0) return tenants;
  } catch (e) {
    logger.error("reconciler.tenants_list_fail", { message: e && e.message });
  }

  try {
    const fallbackDefault = await getDefaultTenant();
    return fallbackDefault ? [fallbackDefault] : [];
  } catch (e) {
    logger.error("reconciler.default_tenant_fail", { message: e && e.message });
    return [];
  }
}

async function reconcileTenant({
  tenant,
  now,
  bindings,
  statusMap,
  actualList,
  knownPeerTenantByPublicKey,
  tenantIpMap,
  tenantsBySlug,
  defaultTenant
} = {}) {
  if (!tenant || !tenant.id) return;
  logger.info("reconciler.tenant_cycle_started", {
    tenantId: tenant.id,
    tenantSlug: tenant.slug
  });

  let desired = [];
  let peersDesiredFromDb = [];
  let routersFromDb = [];
  let usingDbDesired = false;
  let usedFallbackJson = false;

  try {
    const dbState = await readDesiredFromDb({ tenantId: tenant.id });
    desired = dbState.desired;
    peersDesiredFromDb = dbState.peersDesired;
    routersFromDb = dbState.routers;
    usingDbDesired = true;

    const dbSummary = {
      peersDesired: peersDesiredFromDb.length,
      routers: routersFromDb.length,
      tenantId: tenant.id,
      tenantSlug: tenant.slug
    };
    logger.info("reconciler.db_read_ok", dbSummary);
    logger.info("reconciler.tenant_db_read_ok", dbSummary);

    if (tenant.slug === "default" && desired.length === 0 && controlPlaneConfig.fallbackJson) {
      desired = buildDesiredFromJson();
      usedFallbackJson = true;
      logger.warn("reconciler.fallback_json_used", {
        reason: "db_desired_empty",
        desiredFromJson: desired.length,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
    }
  } catch (e) {
    logger.error("reconciler.db_read_fail", {
      message: e && e.message,
      tenantId: tenant.id,
      tenantSlug: tenant.slug
    });
    if (!controlPlaneConfig.fallbackJson || tenant.slug !== "default") {
      logger.info("reconciler.tenant_cycle_done", {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        skipped: true,
        reason: "db_read_fail"
      });
      return;
    }

    desired = buildDesiredFromJson();
    usedFallbackJson = true;
    logger.warn("reconciler.fallback_json_used", {
      reason: "db_unavailable",
      desiredFromJson: desired.length,
      tenantId: tenant.id,
      tenantSlug: tenant.slug
    });
  }

  const actualScoped = [];
  for (const a of actualList) {
    const knownTenantId = knownPeerTenantByPublicKey.get(a.publicKey) || null;
    if (knownTenantId) {
      if (knownTenantId === tenant.id) actualScoped.push(a);
      continue;
    }

    const resolvedTenant = resolveTenantForEndpoint({
      endpoint: (a.status && a.status.endpoint) || (a.raw && a.raw.endpoint) || null,
      tenantsBySlug,
      defaultTenant,
      tenantIpMap
    });

    if (resolvedTenant && resolvedTenant.id === tenant.id) {
      actualScoped.push(a);
    }
  }

  if (controlPlaneConfig.writeDb && usingDbDesired && !usedFallbackJson) {
    try {
      const summary = await persistActualStateToDb({
        peersDesired: peersDesiredFromDb,
        routers: routersFromDb,
        statusMap,
        now,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
      logger.info("reconciler.tenant_write_db_ok", summary);
    } catch (e) {
      logger.error("reconciler.write_db_fail", {
        scope: "batch",
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        message: e && e.message
      });
    }
  }

  const actualMap = new Map(actualScoped.map((p) => [p.publicKey, p]));
  const desiredMap = new Map(desired.map((d) => [d.publicKey, d]));

  const toAddOrUpdate = [];
  for (const d of desired) {
    const a = actualMap.get(d.publicKey);
    if (!a || normalizeAllowed(a.allowed) !== d.allowed) {
      toAddOrUpdate.push(d);
    }
  }

  const toRemove = [];
  for (const a of actualScoped) {
    if (!desiredMap.has(a.publicKey)) {
      toRemove.push(a);
    }
  }

  const autoDiscoveredPublicKeys = new Set();
  const allowAutoDiscovery = controlPlaneConfig.writeDb && usingDbDesired && !usedFallbackJson;
  if (allowAutoDiscovery) {
    for (const item of toRemove) {
      try {
        const discovered = await autoDiscoverPeer({
          peer: item,
          now,
          statusMap,
          tenant,
          knownPeerTenantByPublicKey
        });
        if (discovered) {
          autoDiscoveredPublicKeys.add(item.publicKey);
        }
      } catch (e) {
        metrics.inc("reconciler.auto_discovery_failed");
        logger.error("reconciler.auto_discovery_failed", {
          publicKey: item && item.publicKey,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          message: e && e.message
        });
      }
    }
  }

  for (const a of actualScoped) {
    if (a.status && a.status.status === "OFFLINE") {
      metrics.inc("reconciler.peer_offline");
      logger.warn("reconciler.peer_offline", {
        publicKey: a.publicKey,
        deviceId: a.deviceId,
        endpoint: a.raw && a.raw.endpoint,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
    }
    if (!a.binding && !autoDiscoveredPublicKeys.has(a.publicKey)) {
      metrics.inc("reconciler.missing_binding");
      logger.warn("reconciler.missing_binding", {
        publicKey: a.publicKey,
        deviceId: a.deviceId,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
    }
  }

  for (const d of desired) {
    if (!bindings.find((b) => b.publicKey === d.publicKey)) {
      metrics.inc("reconciler.desired_no_binding");
      logger.warn("reconciler.desired_no_binding", {
        publicKey: d.publicKey,
        deviceId: d.deviceId,
        mikrotikIp: d.mikrotikIp,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
      if (d.mikrotikIp) {
        try {
          await peerBinding.bindPeer({
            publicKey: d.publicKey,
            deviceId: d.deviceId,
            mikrotikIp: d.mikrotikIp
          });
          metrics.inc("reconciler.binding_created");
          logger.info("reconciler.binding_created", {
            publicKey: d.publicKey,
            deviceId: d.deviceId,
            mikrotikIp: d.mikrotikIp,
            tenantId: tenant.id,
            tenantSlug: tenant.slug
          });
        } catch (e) {
          metrics.inc("reconciler.binding_error");
          logger.error("reconciler.binding_error", {
            publicKey: d.publicKey,
            deviceId: d.deviceId,
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            message: e && e.message
          });
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
      logger.info("reconciler.peer_synced", {
        deviceId: item.deviceId,
        publicKey: item.publicKey,
        allowedIps: item.allowed,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
    } catch (e) {
      metrics.inc("reconciler.add_error");
      logger.error("reconciler.peer_sync_error", {
        deviceId: item.deviceId,
        publicKey: item.publicKey,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        message: e && e.message
      });
    }
  }

  for (const item of toRemove) {
    if (autoDiscoveredPublicKeys.has(item.publicKey)) continue;

    if (!SHOULD_REMOVE) {
      logger.warn("reconciler.extra_peer_detected", {
        publicKey: item.publicKey,
        endpoint: item.raw && item.raw.endpoint,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
      metrics.inc("reconciler.extra_peer");
      continue;
    }
    try {
      if (item.deviceId) {
        await wireguard.removePeer(item.deviceId);
      } else {
        logger.warn("reconciler.skip_remove_unknown_device", {
          publicKey: item.publicKey,
          tenantId: tenant.id,
          tenantSlug: tenant.slug
        });
        continue;
      }
      metrics.inc("reconciler.removed");
      logger.info("reconciler.peer_removed", {
        publicKey: item.publicKey,
        deviceId: item.deviceId,
        tenantId: tenant.id,
        tenantSlug: tenant.slug
      });
    } catch (e) {
      metrics.inc("reconciler.remove_error");
      logger.error("reconciler.peer_remove_error", {
        publicKey: item.publicKey,
        deviceId: item.deviceId,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        message: e && e.message
      });
    }
  }

  logger.info("reconciler.tenant_cycle_done", {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    desired: desired.length,
    actualScoped: actualScoped.length,
    toAddOrUpdate: toAddOrUpdate.length,
    toRemove: toRemove.length,
    autoDiscovered: autoDiscoveredPublicKeys.size,
    usedFallbackJson
  });
}

async function reconcileOnce() {
  const now = Date.now();

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
    } else if (shouldLogWgSetup()) {
      logger.error("reconciler.listPeers_error_setup", msg);
    }
    return;
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
  const actualList = buildActual(actual, bindings, statusMap);

  if (!controlPlaneConfig.isModeB) {
    const desired = buildDesiredFromJson();
    const actualMap = new Map(actualList.map((p) => [p.publicKey, p]));
    const desiredMap = new Map(desired.map((d) => [d.publicKey, d]));

    const toAddOrUpdate = [];
    for (const d of desired) {
      const a = actualMap.get(d.publicKey);
      if (!a || normalizeAllowed(a.allowed) !== d.allowed) {
        toAddOrUpdate.push(d);
      }
    }

    for (const d of desired) {
      if (!bindings.find((b) => b.publicKey === d.publicKey) && d.mikrotikIp) {
        try {
          await peerBinding.bindPeer({
            publicKey: d.publicKey,
            deviceId: d.deviceId,
            mikrotikIp: d.mikrotikIp
          });
          metrics.inc("reconciler.binding_created");
          logger.info("reconciler.binding_created", {
            publicKey: d.publicKey,
            deviceId: d.deviceId,
            mikrotikIp: d.mikrotikIp
          });
        } catch (e) {
          metrics.inc("reconciler.binding_error");
          logger.error("reconciler.binding_error", {
            publicKey: d.publicKey,
            deviceId: d.deviceId,
            message: e && e.message
          });
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
        logger.info("reconciler.peer_synced", {
          deviceId: item.deviceId,
          publicKey: item.publicKey,
          allowedIps: item.allowed
        });
      } catch (e) {
        metrics.inc("reconciler.add_error");
        logger.error("reconciler.peer_sync_error", {
          deviceId: item.deviceId,
          publicKey: item.publicKey,
          message: e && e.message
        });
      }
    }

    for (const a of actualList) {
      if (!desiredMap.has(a.publicKey) && !SHOULD_REMOVE) {
        logger.warn("reconciler.extra_peer_detected", {
          publicKey: a.publicKey,
          endpoint: a.raw && a.raw.endpoint
        });
        metrics.inc("reconciler.extra_peer");
      }
    }
    return;
  }

  const tenantIpMap = parseTenantIpMap(TENANT_IP_MAP_RAW);
  const tenants = await listTenantsForCycle();
  if (tenants.length === 0) {
    logger.warn("reconciler.no_tenants_available");
    return;
  }

  const tenantsBySlug = new Map(tenants.map((tenant) => [tenant.slug, tenant]));
  const defaultTenant = tenantsBySlug.get("default") || (await getDefaultTenant().catch(() => null));

  const knownPeerTenantByPublicKey = new Map();
  try {
    const allPeers = await listPeersWithRouter();
    for (const peer of allPeers || []) {
      const peerTenantId = peer && peer.router ? peer.router.tenantId : null;
      if (peer && peer.publicKey && peerTenantId) {
        knownPeerTenantByPublicKey.set(peer.publicKey, peerTenantId);
      }
    }
  } catch (e) {
    logger.error("reconciler.peer_tenant_index_fail", { message: e && e.message });
  }

  for (const tenant of tenants) {
    await reconcileTenant({
      tenant,
      now,
      bindings,
      statusMap,
      actualList,
      knownPeerTenantByPublicKey,
      tenantIpMap,
      tenantsBySlug,
      defaultTenant
    });
  }
}

let _timer = null;

function start() {
  if (_timer) return;
  if (DEFAULT_INTERVAL_MS <= 0) {
    logger.info("reconciler.disabled");
    return;
  }
  if (NORMALIZED_TENANT_AUTO_DISCOVERY_MODE !== TENANT_AUTO_DISCOVERY_MODE) {
    logger.warn("reconciler.invalid_tenant_auto_discovery_mode", {
      provided: TENANT_AUTO_DISCOVERY_MODE,
      using: NORMALIZED_TENANT_AUTO_DISCOVERY_MODE
    });
  }
  _timer = setInterval(() => {
    reconcileOnce().catch((e) => logger.error("reconciler.unhandled", { message: e && e.message }));
  }, DEFAULT_INTERVAL_MS);
  logger.info("reconciler.started", {
    intervalMs: DEFAULT_INTERVAL_MS,
    remove: SHOULD_REMOVE,
    controlPlaneMode: controlPlaneConfig.mode,
    fallbackJson: controlPlaneConfig.fallbackJson,
    writeDb: controlPlaneConfig.writeDb,
    tenantAutoDiscoveryMode: NORMALIZED_TENANT_AUTO_DISCOVERY_MODE
  });
}

function stop() {
  if (!_timer) return;
  clearInterval(_timer);
  _timer = null;
  logger.info("reconciler.stopped");
}

export default { start, stop, reconcileOnce };
