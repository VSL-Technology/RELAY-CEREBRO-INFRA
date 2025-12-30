// src/services/peerBinding.service.js
// Simple file-backed peer -> device binding service for ETAPA 3.2
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(__dirname, '..', 'state');
const filePath = path.join(stateDir, 'peers.meta.json');

async function ensureDir() {
  try { await fs.mkdir(stateDir, { recursive: true }); } catch (e) { /* ignore */ }
}

async function load() {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    logger.error('peerBinding.load_error', { message: e && e.message });
    throw e;
  }
}

async function save(obj) {
  await ensureDir();
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fs.rename(tmp, filePath);
}

export async function bindPeer({ publicKey, deviceId, mikrotikIp }) {
  if (!publicKey || !deviceId || !mikrotikIp) throw new Error('publicKey, deviceId and mikrotikIp required');
  const data = await load();
  const now = Math.floor(Date.now() / 1000);
  const existing = data[publicKey];
  if (existing) {
    // update deviceId/mikrotikIp but keep createdAt
    existing.deviceId = deviceId;
    existing.mikrotikIp = mikrotikIp;
    data[publicKey] = existing;
  } else {
    data[publicKey] = { deviceId, mikrotikIp, createdAt: now };
  }
  await save(data);
  return data[publicKey];
}

export async function unbindPeer(publicKey) {
  if (!publicKey) throw new Error('publicKey required');
  const data = await load();
  if (data[publicKey]) {
    delete data[publicKey];
    await save(data);
    return true;
  }
  return false;
}

export async function getPeerBinding(publicKey) {
  if (!publicKey) return null;
  const data = await load();
  return data[publicKey] || null;
}

export async function listBindings() {
  const data = await load();
  // return array of { publicKey, deviceId, mikrotikIp, createdAt }
  return Object.keys(data).map(pk => ({ publicKey: pk, ...data[pk] }));
}

export default { bindPeer, unbindPeer, getPeerBinding, listBindings };
