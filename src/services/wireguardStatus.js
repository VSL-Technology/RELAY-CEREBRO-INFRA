// src/services/wireguardStatus.js
// Read-only WireGuard status reader: executes `wg show ... dump`, parses peers and normalizes handshake status.
import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import logger from './logger.js';

const execFile = promisify(_execFile);
const WG_INTERFACE = process.env.WG_INTERFACE || null; // optional
const DRY_RUN = process.env.RELAY_DRY_RUN === '1' || process.env.RELAY_DRY_RUN === 'true';
const HANDSHAKE_ONLINE_SECONDS = Number(process.env.RELAY_HANDSHAKE_ONLINE_SECONDS || 120);

async function callWgDump() {
  if (DRY_RUN) {
    logger.info('wireguardStatus.dry_run');
    return '';
  }
  try {
    // prefer per-interface if configured for less noise
    if (WG_INTERFACE) {
      const { stdout } = await execFile('wg', ['show', WG_INTERFACE, 'dump']);
      return stdout || '';
    }
    const { stdout } = await execFile('wg', ['show', 'all', 'dump']);
    return stdout || '';
  } catch (e) {
    logger.error('wireguardStatus.callWgDump_error', { message: e && e.message });
    throw e;
  }
}

// Parse dump output lines into peer objects
export function parseWgDump(dumpText) {
  const out = [];
  if (!dumpText) return out;
  const lines = dumpText.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    // wg dump is tab-separated, fall back to whitespace split if needed
    const cols = line.split('\t');
    const parts = cols.length > 1 ? cols : line.split(/\s+/);
    // expected columns (peer line): publicKey, preshared, endpoint, allowedips, latestHandshake, rx, tx, persistentKeepalive
    if (parts.length < 6) continue; // not enough data
    const publicKey = parts[0];
    const presharedKey = parts[1] || null;
    const endpoint = parts[2] || null;
    const allowedIps = parts[3] || null;
    const latestHandshake = parts[4] ? Number(parts[4]) : 0; // seconds since epoch (wg reports unix seconds)
    const rx = parts[5] ? Number(parts[5]) : 0;
    const tx = parts[6] ? Number(parts[6]) : 0;
    out.push({ publicKey, presharedKey, endpoint, allowedIps, latestHandshake, rx, tx });
  }
  return out;
}

function handshakeAgeSeconds(latestHandshake) {
  if (!latestHandshake || latestHandshake === 0) return null;
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, now - Number(latestHandshake));
}

export function normalizePeerStatus(peer) {
  const age = handshakeAgeSeconds(peer.latestHandshake);
  let status = 'NEVER_CONNECTED';
  if (age === null) status = 'NEVER_CONNECTED';
  else if (age <= HANDSHAKE_ONLINE_SECONDS) status = 'ONLINE';
  else status = 'OFFLINE';
  return {
    publicKey: peer.publicKey,
    handshakeAge: age,
    status,
    rx: Number(peer.rx || 0),
    tx: Number(peer.tx || 0),
    allowedIps: peer.allowedIps || null,
    endpoint: peer.endpoint || null
  };
}

export async function getPeersStatus() {
  try {
    const dump = await callWgDump();
    const peers = parseWgDump(dump);
    const normalized = peers.map(normalizePeerStatus);
    return { timestamp: Math.floor(Date.now() / 1000), peers: normalized };
  } catch (e) {
    logger.error('wireguardStatus.getPeersStatus_error', { message: e && e.message });
    // on error, return empty list but surface timestamp
    return { timestamp: Math.floor(Date.now() / 1000), peers: [] };
  }
}

export default { callWgDump, parseWgDump, normalizePeerStatus, getPeersStatus };
