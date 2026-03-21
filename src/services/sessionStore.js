import crypto from "crypto";
import logger from "./logger.js";
import redis from "../lib/redis.js";

const SESSION_KEY_PREFIX = "session:";
const SESSION_SCAN_COUNT = Number(process.env.SESSION_SCAN_COUNT || 100);

function now() {
  return Date.now();
}

function buildSession(data = {}) {
  const timestamp = now();
  return {
    sessionId: String(data.sessionId || "").trim() || crypto.randomUUID(),
    ip: data.ip || null,
    mac: data.mac || null,
    router: data.router || null,
    identity: data.identity || null,
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: data.expiresAt || null,
    plano: data.plano || null,
    active: data.active === true
  };
}

function getSessionKey(sessionId) {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function parseSession(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    logger.error("session.redis.parse_error", {
      message: error && error.message ? error.message : String(error)
    });
    return null;
  }
}

function getSessionTtlMs(session) {
  if (!session || !Number.isFinite(session.expiresAt)) {
    return null;
  }

  const ttl = Number(session.expiresAt) - now();
  return ttl > 0 ? ttl : 1;
}

async function persistSession(session, logEvent) {
  const key = getSessionKey(session.sessionId);
  const payload = JSON.stringify(session);
  const ttlMs = getSessionTtlMs(session);

  try {
    if (ttlMs) {
      await redis.set(key, payload, "PX", ttlMs);
    } else {
      await redis.set(key, payload);
    }

    logger.info(logEvent, {
      sessionId: session.sessionId,
      status: session.status,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    logger.error("session.redis.error", {
      action: logEvent,
      sessionId: session.sessionId,
      message: error && error.message ? error.message : String(error)
    });
    throw error;
  }
}

export async function createSession(data = {}) {
  const session = buildSession(data);
  await persistSession(session, "session.redis.create");
  return session;
}

export async function getSession(sessionId) {
  try {
    const raw = await redis.get(getSessionKey(sessionId));
    return parseSession(raw);
  } catch (error) {
    logger.error("session.redis.error", {
      action: "getSession",
      sessionId,
      message: error && error.message ? error.message : String(error)
    });
    return null;
  }
}

export async function updateSession(sessionId, data = {}) {
  const existing = await getSession(sessionId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...data,
    sessionId: existing.sessionId,
    createdAt: existing.createdAt,
    updatedAt: now()
  };

  await persistSession(updated, "session.redis.update");
  return updated;
}

export async function findSessionByIp(ip) {
  if (!ip) return null;
  const sessions = await listSessions();
  for (const session of sessions) {
    if (session.ip === ip) return session;
  }
  return null;
}

export async function findSessionByMac(mac) {
  if (!mac) return null;
  const sessions = await listSessions();
  for (const session of sessions) {
    if (session.mac === mac) return session;
  }
  return null;
}

export async function deleteSession(sessionId) {
  try {
    const deleted = await redis.del(getSessionKey(sessionId));
    logger.info("session.redis.delete", {
      sessionId,
      deleted: deleted > 0
    });
    return deleted > 0;
  } catch (error) {
    logger.error("session.redis.error", {
      action: "deleteSession",
      sessionId,
      message: error && error.message ? error.message : String(error)
    });
    return false;
  }
}

export async function listSessions() {
  let cursor = "0";
  const sessions = [];

  try {
    do {
      // ioredis scan returns [nextCursor, keys[]]
      // Avoid KEYS to keep production-safe iteration.
      // eslint-disable-next-line no-await-in-loop
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${SESSION_KEY_PREFIX}*`, "COUNT", SESSION_SCAN_COUNT);
      cursor = nextCursor;

      if (!Array.isArray(keys) || keys.length === 0) continue;

      // eslint-disable-next-line no-await-in-loop
      const values = await redis.mget(keys);
      for (const raw of values) {
        const session = parseSession(raw);
        if (session) sessions.push(session);
      }
    } while (cursor !== "0");

    return sessions;
  } catch (error) {
    logger.error("session.redis.error", {
      action: "listSessions",
      message: error && error.message ? error.message : String(error)
    });
    return [];
  }
}

export default {
  createSession,
  getSession,
  updateSession,
  findSessionByIp,
  findSessionByMac,
  deleteSession,
  listSessions
};
