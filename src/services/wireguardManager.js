// src/services/wireguardManager.js
import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';
import deviceRegistry from '../registry/deviceRegistry.js';

const execFile = promisify(_execFile);
const DRY_RUN = process.env.RELAY_DRY_RUN === '1' || process.env.RELAY_DRY_RUN === 'true';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const META_FILE = path.join(DATA_DIR, 'peers.meta.json');

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function getWgInterface() {
  if (DRY_RUN) return process.env.WG_INTERFACE || 'wg0';
  const iface = process.env.WG_INTERFACE;
  if (!iface) {
    throw codedError('WG_INTERFACE_NOT_CONFIGURED', 'WG_INTERFACE env not set');
  }
  return iface;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readMeta() {
  try {
    ensureDir();
    if (!fs.existsSync(META_FILE)) return {};
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8') || '{}');
  } catch (e) {
    logger.error('wireguard.readMeta_error', { message: e && e.message });
    return {};
  }
}

function writeMeta(obj) {
  try {
    ensureDir();
    fs.writeFileSync(META_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    logger.error('wireguard.writeMeta_error', { message: e && e.message });
    throw e;
  }
}

function validatePublicKey(key) {
  if (!key) return false;
  try {
    const buf = Buffer.from(key, 'base64');
    return buf.length === 32;
  } catch (e) {
    return false;
  }
}

function validateAllowedIps(allowedIps) {
  if (!allowedIps) return false;
  if (Array.isArray(allowedIps)) return allowedIps.length > 0;
  if (typeof allowedIps === 'string') return allowedIps.trim().length > 0;
  return false;
}

async function callWg(args = []) {
  if (DRY_RUN) {
    logger.info('wireguard.dry_run', { args });
    return { stdout: '', stderr: '' };
  }
  // use execFile for safety
  try {
    const res = await execFile('wg', args);
    return res;
  } catch (e) {
    const err = codedError('WG_COMMAND_FAILED', e && e.message ? e.message : 'wg command failed');
    err.cause = e;
    const debugWg = process.env.DEBUG_WG === '1';
    if (debugWg) {
      logger.error('wireguard.command_failed', { message: err.message, code: err.code });
    }
    throw err;
  }
}

// parse output of: wg show <iface> dump
export function parsePeers(dumpText, meta = {}) {
  // wg dump columns: private key (only in config), public key, preshared key, endpoint, allowed ips, latest handshake, transfer rx, transfer tx, persistent keepalive
  // but `wg show <iface> dump` has a headerless tab-separated format per peer
  if (!dumpText) return [];
  const lines = dumpText.trim().split(/\n+/).map(l => l.trim()).filter(Boolean);
  const peers = [];
  for (const line of lines) {
    const cols = line.split('\t');
    // defensive: accept space-separated too
    if (cols.length < 5) {
      const cols2 = line.split(/\s+/);
      if (cols2.length < 5) continue;
      // map to expected positions
      // publicKey at index 0, endpoint at 2? best-effort
      // Skip fragile mapping
      continue;
    }
    const publicKey = cols[0];
    const preshared = cols[1];
    const endpoint = cols[2];
    const allowedIps = cols[3];
    const latestHandshake = cols[4];
    const deviceId = meta[publicKey] || null;
    peers.push({ publicKey, preshared, endpoint, allowedIps, latestHandshake, deviceId });
  }
  return peers;
}

export async function listPeers() {
  const iface = getWgInterface();
  try {
    // wg show <iface> dump
    const meta = readMeta();
    if (DRY_RUN) {
      // return registry-known peers
      const regs = deviceRegistry.listDevices();
      return regs.map(r => ({ publicKey: r.publicKey, allowedIps: Array.isArray(r.allowedIps) ? r.allowedIps.join(',') : r.allowedIps, deviceId: r.deviceId }));
    }
    const { stdout } = await callWg(['show', iface, 'dump']);
    return parsePeers(stdout, meta);
  } catch (e) {
    const err = e && e.code ? e : codedError('WG_LIST_PEERS_FAILED', e && e.message ? e.message : 'listPeers failed');
    logger.error('wireguard.listPeers_error', { message: err && err.message, code: err && err.code });
    throw err;
  }
}

export async function getPeer(deviceId) {
  const meta = readMeta();
  const entries = Object.entries(meta);
  for (const [pub, id] of entries) {
    if (id === deviceId) {
      const peers = await listPeers();
      return peers.find(p => p.publicKey === pub) || null;
    }
  }
  return null;
}

export async function addPeer({ deviceId, publicKey, allowedIps, endpoint = null, keepalive = null, presharedKey = null }) {
  if (!deviceId) throw new Error('deviceId required');
  if (!validatePublicKey(publicKey)) throw new Error('invalid publicKey');
  if (!validateAllowedIps(allowedIps)) throw new Error('allowedIps required');

  const allowed = Array.isArray(allowedIps) ? allowedIps.join(',') : String(allowedIps);
  const meta = readMeta();
  const iface = getWgInterface();

  const argsBase = ['set', iface, 'peer', publicKey, 'allowed-ips', allowed];
  if (endpoint) argsBase.push('endpoint', endpoint);
  if (keepalive !== null && keepalive !== undefined) argsBase.push('persistent-keepalive', String(keepalive));
  if (presharedKey) argsBase.push('preshared-key', presharedKey);

  // check existing
  const peers = await listPeers();
  const existing = peers.find(p => p.publicKey === publicKey || p.deviceId === deviceId);
  let created = false;
  let updated = false;
  if (existing) {
    const needsUpdate =
      (existing.allowedIps || '') !== allowed ||
      (endpoint && existing.endpoint !== endpoint) ||
      (keepalive && existing.keepalive !== keepalive) ||
      (presharedKey && existing.preshared !== presharedKey);
    if (needsUpdate) {
      if (!DRY_RUN) await callWg(argsBase);
      updated = true;
      logger.info('wireguard.updatePeer', { deviceId, publicKey, allowedIps, endpoint, keepalive: keepalive || null });
    } else {
      logger.info('wireguard.addPeer.noop', { deviceId, publicKey });
    }
  } else {
    // create peer
    if (!DRY_RUN) await callWg(argsBase);
    created = true;
    logger.info('wireguard.addPeer.created', { deviceId, publicKey, allowedIps, endpoint, keepalive: keepalive || null });
  }

  // persist meta mapping for deviceId -> publicKey
  meta[publicKey] = deviceId;
  writeMeta(meta);
  // update registry for convenience
  deviceRegistry.registerDevice({ deviceId, publicKey, allowedIps, meta: { endpoint, keepalive, presharedKey } });
  return { created, updated };
}

export async function removePeer(deviceId) {
  if (!deviceId) throw new Error('deviceId required');
  const meta = readMeta();
  const pub = Object.keys(meta).find(k => meta[k] === deviceId);
  if (!pub) {
    logger.info('wireguard.removePeer.noop', { deviceId });
    return { removed: false };
  }
  try {
    const iface = getWgInterface();
    if (!DRY_RUN) await callWg(['set', iface, 'peer', pub, 'remove']);
    // remove meta and update registry
    delete meta[pub];
    writeMeta(meta);
    deviceRegistry.updateDeviceStatus(deviceId, 'deprovisioned');
    logger.info('wireguard.removePeer.removed', { deviceId });
    return { removed: true };
  } catch (e) {
    logger.error('wireguard.removePeer_error', { message: e && e.message });
    throw e;
  }
}

export default { addPeer, removePeer, listPeers, getPeer, parsePeers };
