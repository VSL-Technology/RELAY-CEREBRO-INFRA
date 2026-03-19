// src/services/identityStore.js
// Simple file-backed identity store: sid -> lastSeen/pending/applied
// Locking: Redis SET NX (distributed mutex) with Promise-chain fallback if Redis is unavailable.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import redis from '../lib/redis.js';
import logger from './logger.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'identity.json');
const LAST_SEEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const APPLIED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14d
const APPLIED_MAX_ITEMS = 50;
const LOCK_TTL_MS = 10_000; // 10s max lock hold
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_RETRY_MAX = 20; // up to ~1s total wait

// ─── Promise-chain lock (single-process fallback) ────────────────────────────
let _localLock = Promise.resolve();

function withLocalLock(fn) {
  const run = _localLock.then(fn, fn);
  _localLock = run.then(() => {}, () => {});
  return run;
}

// ─── Redis distributed lock (SET NX) ─────────────────────────────────────────

async function acquireLock(key) {
  const token = randomBytes(16).toString('hex');
  const redisKey = `lock:${key}`;
  for (let i = 0; i < LOCK_RETRY_MAX; i++) {
    const acquired = await redis.set(redisKey, token, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired) return token;
    await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
  }
  return null; // could not acquire
}

// Lua script: only delete the key if we own it (atomic)
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

async function releaseLock(key, token) {
  try {
    await redis.eval(RELEASE_SCRIPT, 1, `lock:${key}`, token);
  } catch (err) {
    logger.warn('identityStore.release_lock_error', { key, message: err && err.message });
  }
}

/**
 * withLock: acquire Redis SET NX lock for the given key.
 * Falls back to the process-local Promise-chain lock if Redis is unavailable.
 */
async function withLock(key, fn) {
  let token = null;
  try {
    token = await acquireLock(key);
  } catch (err) {
    logger.warn('identityStore.redis_lock_error', { key, message: err && err.message });
  }

  if (!token) {
    // Redis unavailable or lock contention: fall back to local serialisation
    logger.warn('identityStore.lock_fallback', { key, reason: token === null ? 'contention' : 'redis_down' });
    return withLocalLock(fn);
  }

  try {
    return await Promise.resolve(fn());
  } finally {
    await releaseLock(key, token);
  }
}

// ─── File helpers ─────────────────────────────────────────────────────────────

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
    console.error('[identityStore] readAll error', e && e.message);
    return [];
  }
}

function writeAll(arr) {
  try {
    ensureDir();
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('[identityStore] writeAll error', e && e.message);
    throw e;
  }
}

function findIdx(arr, sid) {
  return arr.findIndex((r) => r.sid === sid);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getIdentity(sid) {
  const all = readAll();
  return all.find((r) => r.sid === sid) || null;
}

export function getPending(sid) {
  const rec = getIdentity(sid);
  if (!rec || !rec.pending) return null;
  if (rec.pending.status === 'APPLIED') return null;
  return rec.pending;
}

export async function upsertLastSeen(sid, ctx = {}) {
  if (!sid) throw new Error('sid required');
  return withLock(`identity:${sid}`, () => {
    const all = readAll();
    const idx = findIdx(all, sid);
    const now = Date.now();
    const record = idx >= 0 ? all[idx] : { sid, createdAt: now, applied: [] };
    const routerId = ctx.routerId || ctx.identity || ctx.routerHint || null;
    record.lastSeen = {
      ip: ctx.ip || record.lastSeen?.ip || null,
      mac: ctx.mac || record.lastSeen?.mac || null,
      routerId: routerId || record.lastSeen?.routerId || null,
      identity: ctx.identity || record.lastSeen?.identity || null,
      ts: now
    };
    record.updatedAt = now;
    if (idx >= 0) all[idx] = record; else all.push(record);
    writeAll(all);
    return record;
  });
}

export async function markPending(sid, pending = {}) {
  if (!sid) throw new Error('sid required');
  if (!pending.pedidoId) throw new Error('pedidoId required');
  return withLock(`identity:${sid}`, () => {
    const all = readAll();
    const idx = findIdx(all, sid);
    const now = Date.now();
    const record = idx >= 0 ? all[idx] : { sid, createdAt: now, applied: [] };
    record.pending = {
      pedidoId: pending.pedidoId,
      planId: pending.planId || null,
      routerId: pending.routerId || null,
      expiresAt: pending.expiresAt || null,
      markedAt: now,
      status: pending.status || 'PENDING',
      attempts: pending.attempts || 0,
      failCode: pending.failCode || null,
      failedAt: pending.failedAt || null,
      nextEligibleAt: pending.nextEligibleAt || null
    };
    record.updatedAt = now;
    if (idx >= 0) all[idx] = record; else all.push(record);
    writeAll(all);
    return record.pending;
  });
}

export async function clearPending(sid, pedidoId = null) {
  return withLock(`identity:${sid}`, () => {
    const all = readAll();
    const idx = findIdx(all, sid);
    if (idx === -1) return false;
    if (pedidoId && all[idx].pending && all[idx].pending.pedidoId !== pedidoId) return false;
    all[idx].pending = null;
    all[idx].updatedAt = Date.now();
    writeAll(all);
    return true;
  });
}

export async function markPendingFailed(sid, { pedidoId, failCode, attempts = 0, nextEligibleAt = null } = {}) {
  if (!sid || !pedidoId) throw new Error('sid and pedidoId required');
  return withLock(`identity:${sid}`, () => {
    const all = readAll();
    const idx = findIdx(all, sid);
    if (idx === -1) return false;
    const rec = all[idx];
    if (!rec.pending || rec.pending.pedidoId !== pedidoId) return false;
    const now = Date.now();
    rec.pending.status = 'FAILED';
    rec.pending.failCode = failCode || 'authorization_failed_after_retries';
    rec.pending.failedAt = now;
    rec.pending.attempts = attempts;
    rec.pending.nextEligibleAt = nextEligibleAt;
    rec.updatedAt = now;
    all[idx] = rec;
    writeAll(all);
    return true;
  });
}

export async function markPendingApplied(sid, pedidoId) {
  if (!sid || !pedidoId) throw new Error('sid and pedidoId required');
  return withLock(`identity:${sid}`, () => {
    const all = readAll();
    const idx = findIdx(all, sid);
    if (idx === -1) return false;
    const rec = all[idx];
    if (!rec.pending || rec.pending.pedidoId !== pedidoId) return false;
    const now = Date.now();
    rec.pending.status = 'APPLIED';
    rec.pending.appliedAt = now;
    rec.pending.failCode = null;
    rec.pending.failedAt = null;
    rec.pending.nextEligibleAt = null;
    rec.pending.attempts = rec.pending.attempts || 0;
    rec.updatedAt = now;
    all[idx] = rec;
    writeAll(all);
    return true;
  });
}

export function isApplied(sid, actionKey) {
  if (!sid || !actionKey) return false;
  const rec = getIdentity(sid);
  if (!rec || !Array.isArray(rec.applied)) return false;
  return rec.applied.some((a) => a.actionKey === actionKey);
}

export async function markApplied(sid, actionKey, meta = {}) {
  if (!sid || !actionKey) throw new Error('sid and actionKey required');
  return withLock(`identity:${sid}`, () => {
    const all = readAll();
    const idx = findIdx(all, sid);
    if (idx === -1) throw new Error('sid not found for markApplied');
    const now = Date.now();
    const rec = all[idx];
    rec.applied = Array.isArray(rec.applied) ? rec.applied : [];
    rec.applied.push({ actionKey, meta, at: now });
    rec.applied = rec.applied
      .filter((a) => a.at && (now - a.at) <= APPLIED_MAX_AGE_MS)
      .slice(-APPLIED_MAX_ITEMS);
    rec.updatedAt = now;
    all[idx] = rec;
    writeAll(all);
    return true;
  });
}

// internal: prune expired lastSeen/pending/applied
export async function prune() {
  return withLock('identity:global', () => {
    const all = readAll();
    const now = Date.now();
    const pruned = all.map((rec) => {
      if (rec.lastSeen && rec.lastSeen.ts && (now - rec.lastSeen.ts) > LAST_SEEN_TTL_MS) {
        rec.lastSeen = null;
      }
      if (rec.pending && rec.pending.expiresAt) {
        const expTs = new Date(rec.pending.expiresAt).getTime();
        if (Number.isFinite(expTs) && expTs < now) {
          rec.pending = null;
        }
      }
      if (Array.isArray(rec.applied)) {
        rec.applied = rec.applied
          .filter((a) => a.at && (now - a.at) <= APPLIED_MAX_AGE_MS)
          .slice(-APPLIED_MAX_ITEMS);
      }
      rec.updatedAt = now;
      return rec;
    });
    writeAll(pruned);
    return pruned.length;
  });
}

export default {
  getIdentity,
  getPending,
  upsertLastSeen,
  markPending,
  markPendingFailed,
  markPendingApplied,
  clearPending,
  isApplied,
  markApplied,
  prune
};
