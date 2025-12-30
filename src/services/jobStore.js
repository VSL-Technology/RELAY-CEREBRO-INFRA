// src/services/jobStore.js
// jobStore supports three backends: file (default), SQLite (RELAY_USE_SQLITE=1) or Redis (RELAY_STORE=redis)
import fs from "fs";
import path from "path";

const USE_SQLITE = process.env.RELAY_USE_SQLITE === "1" || process.env.RELAY_USE_SQLITE === "true";
const USE_REDIS = (process.env.RELAY_STORE || "").toLowerCase() === "redis";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const REDIS_NAMESPACE = process.env.RELAY_NAMESPACE || "relay";

// redis keys
const REDIS_KEYS = {
  jobsZset: `${REDIS_NAMESPACE}:jobs`,
  jobHash: (id) => `${REDIS_NAMESPACE}:job:${id}`,
  processedSet: `${REDIS_NAMESPACE}:processed_events`,
  lockKey: (id) => `${REDIS_NAMESPACE}:lock:${id}`
};

let redisClient = null;
async function ensureRedis() {
  if (redisClient) return redisClient;
  try {
    const IORedis = (await import('ioredis')).default;
    redisClient = new IORedis(REDIS_URL);
    // basic error handling
    redisClient.on('error', (e) => console.error('[redis] error', e && e.message));
    return redisClient;
  } catch (e) {
    console.error('jobStore redis init failed', e.message);
    redisClient = null;
    throw e;
  }
}

// in-memory lock fallback for file/sqlite mode (single process)
const inMemoryLocks = new Map();

/**
 * Acquire a lock for a job. Returns true if acquired.
 * For Redis: use SET key value NX PX ttl
 * For file/sqlite: use in-memory Map
 */
export async function acquireLock(jobId, ttlMs = 30000) {
  if (USE_REDIS) {
    try {
      const client = await ensureRedis();
      const val = `${process.pid}-${Date.now()}`;
      const r = await client.set(REDIS_KEYS.lockKey(jobId), val, 'PX', ttlMs, 'NX');
      return r === 'OK';
    } catch (e) {
      console.error('acquireLock redis error', e.message);
      return false;
    }
  }
  // file/sqlite mode: simple in-process lock
  if (!inMemoryLocks.has(jobId)) {
    inMemoryLocks.set(jobId, Date.now() + ttlMs);
    return true;
  }
  // check expiry
  const exp = inMemoryLocks.get(jobId);
  if (exp && Date.now() > exp) {
    inMemoryLocks.set(jobId, Date.now() + ttlMs);
    return true;
  }
  return false;
}

export async function releaseLock(jobId) {
  if (USE_REDIS) {
    try {
      const client = await ensureRedis();
      await client.del(REDIS_KEYS.lockKey(jobId));
    } catch (e) {
      console.error('releaseLock redis error', e.message);
    }
    return;
  }
  inMemoryLocks.delete(jobId);
}

export async function getJobById(jobId) {
  if (USE_REDIS) {
    try {
      const client = await ensureRedis();
      const h = await client.hgetall(REDIS_KEYS.jobHash(jobId));
      if (!h || Object.keys(h).length === 0) return null;
      return { id: jobId, type: h.type, eventId: h.eventId, runAt: Number(h.runAt), payload: JSON.parse(h.payload || '{}'), createdAt: Number(h.createdAt), attempts: Number(h.attempts || 0) };
    } catch (e) {
      console.error('getJobById redis error', e.message);
      return null;
    }
  }
  // file/sqlite fallback
  if (!USE_SQLITE) {
    const jobs = readJson(JOBS_FILE, []);
    return jobs.find(j => j.id === jobId) || null;
  }
  try {
    const row = sqliteDb.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!row) return null;
    return { ...row, payload: row.payload ? JSON.parse(row.payload) : null };
  } catch (e) {
    console.error('getJobById sqlite error', e.message);
    return null;
  }
}

export async function incrementJobAttempts(jobId) {
  if (USE_REDIS) {
    try {
      const client = await ensureRedis();
      const attempts = await client.hincrby(REDIS_KEYS.jobHash(jobId), 'attempts', 1);
      return Number(attempts);
    } catch (e) {
      console.error('incrementJobAttempts redis error', e.message);
      return 0;
    }
  }
  // file/sqlite
  if (!USE_SQLITE) {
    const jobs = readJson(JOBS_FILE, []);
    const idx = jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return 0;
    jobs[idx].attempts = (jobs[idx].attempts || 0) + 1;
    writeJson(JOBS_FILE, jobs);
    return jobs[idx].attempts;
  }
  try {
    const cur = sqliteDb.prepare('SELECT attempts FROM jobs WHERE id = ?').get(jobId);
    const next = (cur && cur.attempts ? cur.attempts : 0) + 1;
    sqliteDb.prepare('UPDATE jobs SET attempts = ? WHERE id = ?').run(next, jobId);
    return next;
  } catch (e) {
    console.error('incrementJobAttempts sqlite error', e.message);
    return 0;
  }
}

export async function rescheduleJob(jobId, nextRunAt) {
  if (USE_REDIS) {
    try {
      const client = await ensureRedis();
      await client.zadd(REDIS_KEYS.jobsZset, nextRunAt, jobId);
      await client.hset(REDIS_KEYS.jobHash(jobId), 'runAt', String(nextRunAt));
    } catch (e) {
      console.error('rescheduleJob redis error', e.message);
    }
    return;
  }
  if (!USE_SQLITE) {
    const jobs = readJson(JOBS_FILE, []);
    const idx = jobs.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      jobs[idx].runAt = nextRunAt;
      writeJson(JOBS_FILE, jobs);
    }
    return;
  }
  try {
    sqliteDb.prepare('UPDATE jobs SET runAt = ? WHERE id = ?').run(nextRunAt, jobId);
  } catch (e) {
    console.error('rescheduleJob sqlite error', e.message);
  }
}

// File-based fallback (keeps backward compatibility)
const DATA_DIR = path.resolve(process.cwd(), "data");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const PROCESSED_FILE = path.join(DATA_DIR, "processed_events.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, defaultValue) {
  try {
    if (!fs.existsSync(file)) return defaultValue;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw || "null") || defaultValue;
  } catch (e) {
    console.error("jobStore readJson error", file, e.message);
    return defaultValue;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("jobStore writeJson error", file, e.message);
  }
}

// SQLite backend (lazy load)
let sqliteDb = null;
async function ensureSqlite() {
  if (sqliteDb) return sqliteDb;
  try {
    const Database = (await import('better-sqlite3')).default;
    const dbPath = path.join(DATA_DIR, 'relay.db');
    ensureDir();
    sqliteDb = new Database(dbPath);
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT,
        eventId TEXT,
        runAt INTEGER,
        payload TEXT,
        createdAt INTEGER
      );
    `);
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS processed_events (
        eventId TEXT PRIMARY KEY,
        processedAt INTEGER
      );
    `);
    return sqliteDb;
  } catch (e) {
    console.error('jobStore sqlite init failed', e.message);
    sqliteDb = null;
    throw e;
  }
}

// Public API will delegate to sqlite or file functions
export function listJobs() {
  if (USE_REDIS) {
    // Redis listJobs is not efficient; prefer using getDueJobs with score ranges. Provide a best-effort read.
    try {
      const client = redisClient;
      if (!client) throw new Error('redis not initialized');
      return client.zrange(REDIS_KEYS.jobsZset, 0, -1).then(async (ids) => {
        const res = [];
        for (const id of ids) {
          const h = await client.hgetall(REDIS_KEYS.jobHash(id));
          if (h && Object.keys(h).length) {
            res.push({ id, type: h.type, eventId: h.eventId, runAt: Number(h.runAt), payload: JSON.parse(h.payload || '{}'), createdAt: Number(h.createdAt) });
          }
        }
        return res;
      });
    } catch (e) {
      console.error('listJobs redis error', e.message);
      return [];
    }
  }
  if (!USE_SQLITE) return readJson(JOBS_FILE, []);
  try {
    const db = sqliteDb;
    if (!db) throw new Error('sqlite not initialized');
    const rows = db.prepare('SELECT * FROM jobs ORDER BY runAt ASC').all();
    return rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
  } catch (e) {
    console.error('listJobs sqlite error', e.message);
    return [];
  }
}

export function saveJobs(jobs) {
  if (USE_REDIS) {
    // Overwrite zset and hashes (best-effort)
    return ensureRedis().then(async (client) => {
      const pipeline = client.pipeline();
      // remove existing
      pipeline.del(REDIS_KEYS.jobsZset);
      for (const job of jobs) {
        pipeline.zadd(REDIS_KEYS.jobsZset, job.runAt, job.id);
        pipeline.hmset(REDIS_KEYS.jobHash(job.id), { id: job.id, type: job.type, eventId: job.eventId || '', runAt: job.runAt.toString(), payload: JSON.stringify(job.payload || {}), createdAt: (job.createdAt || Date.now()).toString() });
      }
      await pipeline.exec();
    }).catch((e) => console.error('saveJobs redis error', e.message));
  }
  if (!USE_SQLITE) return writeJson(JOBS_FILE, jobs);
  try {
    const db = sqliteDb;
    const insert = db.prepare('INSERT OR REPLACE INTO jobs (id,type,eventId,runAt,payload,createdAt) VALUES (@id,@type,@eventId,@runAt,@payload,@createdAt)');
    const del = db.prepare('DELETE FROM jobs');
    const tx = db.transaction((items) => {
      del.run();
      for (const it of items) insert.run({ ...it, payload: JSON.stringify(it.payload || {}) });
    });
    tx(jobs);
  } catch (e) {
    console.error('saveJobs sqlite error', e.message);
  }
}

export function addJob(job) {
  if (USE_REDIS) {
    return ensureRedis().then(async (client) => {
      await client.zadd(REDIS_KEYS.jobsZset, job.runAt, job.id);
      await client.hmset(REDIS_KEYS.jobHash(job.id), { id: job.id, type: job.type, eventId: job.eventId || '', runAt: job.runAt.toString(), payload: JSON.stringify(job.payload || {}), createdAt: (job.createdAt || Date.now()).toString() });
      return job;
    }).catch((e) => { console.error('addJob redis error', e.message); throw e; });
  }
  if (!USE_SQLITE) {
    const jobs = readJson(JOBS_FILE, []);
    jobs.push(job);
    writeJson(JOBS_FILE, jobs);
    return job;
  }
  try {
    const db = sqliteDb;
    const insert = db.prepare('INSERT INTO jobs (id,type,eventId,runAt,payload,createdAt) VALUES (@id,@type,@eventId,@runAt,@payload,@createdAt)');
    insert.run({ ...job, payload: JSON.stringify(job.payload || {}) });
    return job;
  } catch (e) {
    console.error('addJob sqlite error', e.message);
    throw e;
  }
}

export function removeJobById(jobId) {
  if (USE_REDIS) {
    return ensureRedis().then(async (client) => {
      await client.zrem(REDIS_KEYS.jobsZset, jobId);
      await client.del(REDIS_KEYS.jobHash(jobId));
    }).catch((e) => console.error('removeJobById redis error', e.message));
  }
  if (!USE_SQLITE) {
    let jobs = readJson(JOBS_FILE, []);
    jobs = jobs.filter((j) => j.id !== jobId);
    writeJson(JOBS_FILE, jobs);
    return;
  }
  try {
    const db = sqliteDb;
    db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
  } catch (e) {
    console.error('removeJobById sqlite error', e.message);
  }
}

export function getDueJobs(now = Date.now()) {
  if (USE_REDIS) {
    // ZRANGEBYSCORE relay:jobs -inf now LIMIT 0 50
    return ensureRedis().then(async (client) => {
      const ids = await client.zrangebyscore(REDIS_KEYS.jobsZset, '-inf', now, 'LIMIT', 0, 50);
      const jobs = [];
      for (const id of ids) {
        const h = await client.hgetall(REDIS_KEYS.jobHash(id));
        if (h && Object.keys(h).length) {
          jobs.push({ id, type: h.type, eventId: h.eventId, runAt: Number(h.runAt), payload: JSON.parse(h.payload || '{}'), createdAt: Number(h.createdAt) });
        }
      }
      return jobs;
    }).catch((e) => {
      console.error('getDueJobs redis error', e.message);
      return [];
    });
  }
  if (!USE_SQLITE) {
    const jobs = readJson(JOBS_FILE, []);
    return jobs.filter((j) => j.runAt <= now);
  }
  try {
    const db = sqliteDb;
    const rows = db.prepare('SELECT * FROM jobs WHERE runAt <= ? ORDER BY runAt ASC').all(now);
    return rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
  } catch (e) {
    console.error('getDueJobs sqlite error', e.message);
    return [];
  }
}

export function markJobAsProcessed(jobId, result = {}) {
  removeJobById(jobId);
}

// processed events
export function listProcessedEventIds() {
  if (USE_REDIS) {
    return ensureRedis().then(async (client) => {
      const members = await client.smembers(REDIS_KEYS.processedSet);
      return members || [];
    }).catch((e) => { console.error('listProcessedEventIds redis error', e.message); return []; });
  }
  if (!USE_SQLITE) return readJson(PROCESSED_FILE, []);
  try {
    const rows = sqliteDb.prepare('SELECT eventId FROM processed_events').all();
    return rows.map(r => r.eventId);
  } catch (e) {
    console.error('listProcessedEventIds sqlite error', e.message);
    return [];
  }
}

export function isEventProcessed(eventId) {
  if (USE_REDIS) {
    try {
      const client = redisClient;
      if (!client) throw new Error('redis not initialized');
      const r = client.sismember(REDIS_KEYS.processedSet, eventId);
      return Promise.resolve(r).then(Number).then(Boolean);
    } catch (e) {
      console.error('isEventProcessed redis error', e.message);
      return false;
    }
  }
  if (!USE_SQLITE) {
    const arr = readJson(PROCESSED_FILE, []);
    return arr.includes(eventId);
  }
  try {
    const row = sqliteDb.prepare('SELECT eventId FROM processed_events WHERE eventId = ?').get(eventId);
    return !!row;
  } catch (e) {
    console.error('isEventProcessed sqlite error', e.message);
    return false;
  }
}

export function markEventProcessed(eventId) {
  if (USE_REDIS) {
    return ensureRedis().then(async (client) => {
      await client.sadd(REDIS_KEYS.processedSet, eventId);
      // optional TTL on processed set members: implement using EXPIRE on the set key
      const ttl = parseInt(process.env.RELAY_PROCESSED_TTL || '0', 10);
      if (ttl > 0) await client.expire(REDIS_KEYS.processedSet, ttl);
    }).catch((e) => console.error('markEventProcessed redis error', e.message));
  }
  if (!USE_SQLITE) {
    const arr = readJson(PROCESSED_FILE, []);
    if (!arr.includes(eventId)) {
      arr.push(eventId);
      writeJson(PROCESSED_FILE, arr);
    }
    return;
  }
  try {
    sqliteDb.prepare('INSERT OR IGNORE INTO processed_events (eventId, processedAt) VALUES (?, ?)').run(eventId, Date.now());
  } catch (e) {
    console.error('markEventProcessed sqlite error', e.message);
  }
}

// initialize sqlite if requested
if (USE_SQLITE) {
  ensureDir();
  ensureSqlite().catch((e) => console.error('failed to init sqlite job store', e.message));
}

if (USE_REDIS) {
  ensureDir();
  ensureRedis().catch((e) => console.error('failed to init redis job store', e.message));
}

export default {
  acquireLock,
  releaseLock,
  getJobById,
  incrementJobAttempts,
  rescheduleJob,
  listJobs,
  saveJobs,
  addJob,
  removeJobById,
  getDueJobs,
  markJobAsProcessed,
  listProcessedEventIds,
  isEventProcessed,
  markEventProcessed
};

