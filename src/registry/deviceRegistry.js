// src/registry/deviceRegistry.js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../services/logger.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'devices.json');
const HISTORY_LIMIT = 20;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  try {
    ensureDir();
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    logger.error('deviceRegistry.readAll_error', { message: e && e.message });
    return [];
  }
}

function normalizeAllowed(allowedIps) {
  if (!allowedIps) return allowedIps;
  if (Array.isArray(allowedIps)) return allowedIps;
  if (typeof allowedIps === 'string') {
    return allowedIps
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return allowedIps;
}

function writeAll(arr) {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    logger.error('deviceRegistry.writeAll_error', { message: e && e.message });
    throw e;
  }
}

export function registerDevice({ deviceId, publicKey, allowedIps, meta = {} } = {}) {
  const items = readAll();
  // ensure id
  const id = deviceId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
  const existing = items.find(d => d.deviceId === id || d.publicKey === publicKey);
  if (existing) {
    // update fields idempotently
    existing.publicKey = existing.publicKey || publicKey;
    existing.allowedIps = normalizeAllowed(allowedIps) || existing.allowedIps;
    existing.meta = { ...(existing.meta || {}), ...(meta || {}) };
    existing.updatedAt = Date.now();
    writeAll(items);
    return existing;
  }

  const rec = { deviceId: id, publicKey, allowedIps: normalizeAllowed(allowedIps), meta, status: 'registered', createdAt: Date.now(), updatedAt: Date.now() };
  items.push(rec);
  writeAll(items);
  logger.info('deviceRegistry.registered', { deviceId: id });
  return rec;
}

export function getDevice(deviceId) {
  const items = readAll();
  return items.find(d => d.deviceId === deviceId) || null;
}

export function getDeviceByToken(token) {
  if (!token) return null;
  const items = readAll();
  return items.find(d => d.token === token) || null;
}

export function updateDeviceStatus(deviceId, status, extra = {}) {
  const items = readAll();
  const idx = items.findIndex(d => d.deviceId === deviceId);
  if (idx === -1) return null;
  items[idx].status = status;
  items[idx].updatedAt = Date.now();
  items[idx] = { ...items[idx], ...extra };
  writeAll(items);
  logger.info('deviceRegistry.status_updated', { deviceId, status });
  return items[idx];
}

export function removeDevice(deviceId) {
  let items = readAll();
  const exists = items.find(d => d.deviceId === deviceId);
  items = items.filter(d => d.deviceId !== deviceId);
  writeAll(items);
  logger.info('deviceRegistry.removed', { deviceId, existed: !!exists });
  return !!exists;
}

export function listDevices() {
  return readAll();
}

// Registro/atualização para devices "hello" (token/ip/mac) reutilizando o mesmo arquivo.
export function registerOrUpdateHelloDevice({ deviceToken, mikId, ip, mac, userAgent }) {
  const now = new Date();
  const items = readAll();
  const token = deviceToken || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));

  const idx = items.findIndex((d) => d.token === token);
  const existing = idx >= 0 ? items[idx] : {};

  const history = [
    ...(existing.ipsHistorico || []),
    { ip, mac, seenAt: now.toISOString() }
  ].slice(-HISTORY_LIMIT);

  const updated = {
    ...existing,
    deviceId: existing.deviceId || token, // fallback deviceId com o token se não existir
    token,
    mikId: mikId || existing.mikId,
    ipAtual: ip,
    macAtual: mac,
    userAgent: userAgent || existing.userAgent || null,
    firstSeenAt: existing.firstSeenAt || now.toISOString(),
    lastSeenAt: now.toISOString(),
    ipsHistorico: history
  };

  if (idx >= 0) items[idx] = updated;
  else items.push(updated);

  writeAll(items);
  return updated;
}

export default {
  registerDevice,
  getDevice,
  getDeviceByToken,
  updateDeviceStatus,
  removeDevice,
  listDevices,
  registerOrUpdateHelloDevice
};
