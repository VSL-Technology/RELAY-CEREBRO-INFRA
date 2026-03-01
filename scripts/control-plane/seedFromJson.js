import fs from "fs";
import path from "path";
import logger from "../../src/services/logger.js";
import { upsertRouter } from "../../src/repositories/routerRepository.js";
import { upsertPeer } from "../../src/repositories/wireguardPeerRepository.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const PEERS_META_CANDIDATES = [
  path.join(DATA_DIR, "peers.meta.json"),
  path.resolve(process.cwd(), "src/state/peers.meta.json")
];

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw || "null") || fallback;
  } catch (e) {
    logger.error("seed.control_plane.read_json_error", { file, message: e && e.message });
    return fallback;
  }
}

function normalizeAllowedIps(value, tunnelIp) {
  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v || "").trim()).filter(Boolean);
    return arr.length ? arr.join(",") : (tunnelIp ? `${tunnelIp}/32` : null);
  }
  if (typeof value === "string") {
    const out = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .join(",");
    return out || (tunnelIp ? `${tunnelIp}/32` : null);
  }
  return tunnelIp ? `${tunnelIp}/32` : null;
}

function resolvePeerMeta() {
  const merged = {};
  for (const file of PEERS_META_CANDIDATES) {
    const obj = readJson(file, {});
    if (obj && typeof obj === "object") {
      Object.assign(merged, obj);
    }
  }
  return merged;
}

async function seedFromDevices(devices = []) {
  let routersUpserted = 0;
  let peersUpserted = 0;
  const seededPublicKeys = new Set();

  for (const device of devices) {
    if (!device || !device.publicKey) continue;

    const busId = String(device.mikId || device.deviceId || "").trim();
    if (!busId) continue;

    const tunnelIp =
      (device.meta && device.meta.tunnelIp) ||
      (device.meta && device.meta.config && device.meta.config.tunnelIp) ||
      null;

    const allowedIps = normalizeAllowedIps(device.allowedIps, tunnelIp);
    const wgIp = tunnelIp ? `${tunnelIp}/32` : (allowedIps ? String(allowedIps).split(",")[0] : "0.0.0.0/32");

    const router = await upsertRouter({
      busId,
      nome: device.meta && device.meta.deviceName ? device.meta.deviceName : null,
      identity: device.mikId || null,
      ipLan: device.meta && device.meta.mikrotik ? device.meta.mikrotik.publicIp : null,
      apiUser: device.meta && device.meta.mikrotik ? device.meta.mikrotik.apiUser : null,
      portaApi: device.meta && device.meta.mikrotik ? device.meta.mikrotik.apiPort : null,
      wgPublicKey: device.publicKey,
      wgIp,
      endpoint: device.meta ? device.meta.endpoint : null,
      keepalive: device.meta ? device.meta.keepalive : null,
      desiredState: "ACTIVE",
      status: device.status || null
    });
    routersUpserted += 1;

    if (allowedIps) {
      await upsertPeer({
        routerId: router.id,
        publicKey: device.publicKey,
        allowedIps,
        endpoint: device.meta ? device.meta.endpoint : null,
        persistentKeepalive: device.meta ? device.meta.keepalive : null,
        desiredStatus: "ACTIVE"
      });
      peersUpserted += 1;
      seededPublicKeys.add(device.publicKey);
    } else {
      logger.warn("seed.control_plane.peer_skipped_missing_allowed_ips", {
        busId,
        publicKey: device.publicKey
      });
    }
  }

  return { routersUpserted, peersUpserted, seededPublicKeys };
}

async function seedFromPeerMeta(peerMeta, seededPublicKeys) {
  let routersUpserted = 0;

  for (const [publicKey, meta] of Object.entries(peerMeta || {})) {
    if (!publicKey || seededPublicKeys.has(publicKey)) continue;

    const deviceId =
      typeof meta === "string"
        ? meta
        : meta && typeof meta === "object"
          ? meta.deviceId
          : null;

    if (!deviceId) continue;

    await upsertRouter({
      busId: String(deviceId),
      wgPublicKey: publicKey,
      wgIp: "0.0.0.0/32",
      ipLan: meta && typeof meta === "object" ? meta.mikrotikIp || null : null,
      desiredState: "PENDING"
    });
    routersUpserted += 1;
  }

  return { routersUpserted };
}

async function main() {
  logger.info("seed.control_plane.start", {
    devicesFile: DEVICES_FILE,
    peerMetaCandidates: PEERS_META_CANDIDATES
  });

  const devices = readJson(DEVICES_FILE, []);
  const peerMeta = resolvePeerMeta();

  const fromDevices = await seedFromDevices(Array.isArray(devices) ? devices : []);
  const fromPeerMeta = await seedFromPeerMeta(peerMeta, fromDevices.seededPublicKeys);

  logger.info("seed.control_plane.done", {
    devicesCount: Array.isArray(devices) ? devices.length : 0,
    peerMetaCount: Object.keys(peerMeta || {}).length,
    routersUpsertedFromDevices: fromDevices.routersUpserted,
    peersUpsertedFromDevices: fromDevices.peersUpserted,
    routersUpsertedFromPeerMeta: fromPeerMeta.routersUpserted
  });
}

main().catch((e) => {
  logger.error("seed.control_plane.failed", { message: e && e.message, stack: e && e.stack });
  process.exit(1);
});
