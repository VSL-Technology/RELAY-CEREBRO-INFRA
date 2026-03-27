import crypto from "crypto";
import logger from "./logger.js";
import redis from "../lib/redis.js";

// ============================================
// CONSTANTS
// ============================================
const SESSION_KEY_PREFIX = "session:";
const INDEX_IP_PREFIX = "idx:ip:";
const INDEX_MAC_PREFIX = "idx:mac:";
const INDEX_PEDIDO_PREFIX = "idx:pedido:";

const LOCK_AUTHORIZE_PREFIX = "lock:session:authorize:";
const LOCK_REVOKE_PREFIX = "lock:session:revoke:";
const LOCK_CREATE_PREFIX = "lock:session:create:";

const LOCK_TTL_MS = 120 * 1000; // 2 minutos
const LOCK_RETRY_MS = 100;
const MAX_LOCK_RETRIES = 60; // Max 6 segundos

const CLEANUP_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 horas
const MIN_TTL_MS = 60 * 1000; // 1 minuto

const ALLOWED_TRANSITIONS = {
  pending: ["authorized", "revoked", "expired"],
  authorized: ["revoked", "expired"],
  revoked: [],
  expired: ["authorized"]
};

// ============================================
// UTILITIES
// ============================================
function now() {
  return Date.now();
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

function computeSessionTtlMs(session) {
  if (!session || !Number.isFinite(session.expiresAt)) {
    return MIN_TTL_MS;
  }

  const ttl = session.expiresAt - now();
  if (ttl <= 0) {
    return MIN_TTL_MS;
  }

  return Math.max(ttl + CLEANUP_WINDOW_MS, MIN_TTL_MS);
}

async function acquireLock(lockKey) {
  let retries = 0;
  const token = crypto.randomBytes(16).toString("hex");

  while (retries < MAX_LOCK_RETRIES) {
    try {
      const acquired = await redis.set(
        lockKey,
        token,
        "NX",
        "PX",
        LOCK_TTL_MS
      );

      if (acquired) {
        return token;
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      retries += 1;
    } catch (error) {
      logger.warn("session.lock.acquire_error", {
        lockKey,
        message: error && error.message ? error.message : String(error)
      });
      throw error;
    }
  }

  throw new Error(`Lock timeout: ${lockKey}`);
}

async function releaseLock(lockKey, token) {
  try {
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, lockKey, token);
  } catch (error) {
    logger.warn("session.lock.release_error", {
      lockKey,
      message: error && error.message ? error.message : String(error)
    });
  }
}

function validateStateTransition(currentStatus, newStatus) {
  const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid state transition: ${currentStatus} → ${newStatus}`
    );
  }
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
    planId: data.planId || null,
    pedidoId: data.pedidoId || null,
    plano: data.plano || null,
    active: data.active === true,
    lastMikrotikResult: null
  };
}

async function persistSession(session, logEvent, customTtlMs = null) {
  const key = getSessionKey(session.sessionId);
  const payload = JSON.stringify(session);
  const ttlMs = customTtlMs !== null ? customTtlMs : computeSessionTtlMs(session);

  try {
    if (ttlMs && ttlMs > 0) {
      await redis.set(key, payload, "PX", ttlMs);
    } else {
      await redis.set(key, payload, "PX", MIN_TTL_MS);
    }

    logger.debug(logEvent, {
      sessionId: session.sessionId,
      status: session.status,
      ttlMs
    });

    return ttlMs;
  } catch (error) {
    logger.error("session.redis.error", {
      action: logEvent,
      sessionId: session.sessionId,
      message: error && error.message ? error.message : String(error)
    });
    throw error;
  }
}

async function persistIndices(session, ttlMs) {
  const updates = [];

  if (session.ip) {
    updates.push(
      redis.set(
        `${INDEX_IP_PREFIX}${session.ip}`,
        session.sessionId,
        "PX",
        ttlMs
      )
    );
  }

  if (session.mac) {
    updates.push(
      redis.set(
        `${INDEX_MAC_PREFIX}${session.mac}`,
        session.sessionId,
        "PX",
        ttlMs
      )
    );
  }

  if (session.pedidoId) {
    updates.push(
      redis.set(
        `${INDEX_PEDIDO_PREFIX}${session.pedidoId}`,
        session.sessionId,
        "PX",
        ttlMs
      )
    );
  }

  await Promise.all(updates);
}

// ============================================
// PUBLIC API
// ============================================

export async function createSession(data = {}) {
  const session = buildSession(data);

  try {
    const ttlMs = await persistSession(session, "session.redis.create", LOCK_TTL_MS);
    
    // Criar índices iniciais
    await persistIndices(session, ttlMs);

    logger.info("session.created", {
      sessionId: session.sessionId,
      ip: session.ip,
      mac: session.mac
    });

    return session;
  } catch (error) {
    logger.error("session.create.error", {
      message: error && error.message ? error.message : String(error)
    });
    throw error;
  }
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

  try {
    const ttlMs = computeSessionTtlMs(updated);
    await persistSession(updated, "session.redis.update", ttlMs);
    await persistIndices(updated, ttlMs);
    return updated;
  } catch (error) {
    logger.error("session.update.error", {
      sessionId,
      message: error && error.message ? error.message : String(error)
    });
    throw error;
  }
}

export async function findByIp(ip) {
  if (!ip) return null;

  try {
    const sessionId = await redis.get(`${INDEX_IP_PREFIX}${ip}`);
    if (!sessionId) return null;

    const session = await getSession(sessionId);

    if (!session) {
      logger.warn("session.index.orphan_cleanup", {
        index: "idx:ip",
        ip,
        sessionId
      });
      await redis.del(`${INDEX_IP_PREFIX}${ip}`);
      return null;
    }

    return session;
  } catch (error) {
    logger.error("session.redis.error", {
      action: "findByIp",
      ip,
      message: error && error.message ? error.message : String(error)
    });
    return null;
  }
}

export async function findByMac(mac) {
  if (!mac) return null;

  try {
    const sessionId = await redis.get(`${INDEX_MAC_PREFIX}${mac}`);
    if (!sessionId) return null;

    const session = await getSession(sessionId);

    if (!session) {
      logger.warn("session.index.orphan_cleanup", {
        index: "idx:mac",
        mac,
        sessionId
      });
      await redis.del(`${INDEX_MAC_PREFIX}${mac}`);
      return null;
    }

    return session;
  } catch (error) {
    logger.error("session.redis.error", {
      action: "findByMac",
      mac,
      message: error && error.message ? error.message : String(error)
    });
    return null;
  }
}

export async function findByPedidoId(pedidoId) {
  if (!pedidoId) return null;

  try {
    const sessionId = await redis.get(`${INDEX_PEDIDO_PREFIX}${pedidoId}`);
    if (!sessionId) return null;

    const session = await getSession(sessionId);

    if (!session) {
      logger.warn("session.index.orphan_cleanup", {
        index: "idx:pedido",
        pedidoId,
        sessionId
      });
      await redis.del(`${INDEX_PEDIDO_PREFIX}${pedidoId}`);
      return null;
    }

    return session;
  } catch (error) {
    logger.error("session.redis.error", {
      action: "findByPedidoId",
      pedidoId,
      message: error && error.message ? error.message : String(error)
    });
    return null;
  }
}

export async function deleteSession(sessionId) {
  try {
    const deleted = await redis.del(getSessionKey(sessionId));
    logger.debug("session.redis.delete", {
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
      // eslint-disable-next-line no-await-in-loop
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${SESSION_KEY_PREFIX}*`,
        "COUNT",
        100
      );
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

export async function getOrCreateSession({
  ip,
  mac,
  router,
  identity,
  pedidoId,
  planId,
  source = "http"
}) {
  try {
    // 1. Tentar reutilizar por pedidoId
    if (pedidoId) {
      const byPedido = await findByPedidoId(pedidoId);
      if (byPedido) {
        const updated = await updateSession(byPedido.sessionId, {
          ip,
          mac,
          router,
          identity,
          updatedAt: now()
        });

        logger.info("session.get_or_create.reused_by_pedido", {
          sessionId: updated.sessionId,
          pedidoId,
          source
        });
        return updated;
      }
    }

    // 2. Tentar reutilizar por mac
    if (mac) {
      const byMac = await findByMac(mac);
      if (byMac) {
        const updated = await updateSession(byMac.sessionId, {
          ip,
          router,
          identity,
          updatedAt: now()
        });

        logger.info("session.get_or_create.reused_by_mac", {
          sessionId: updated.sessionId,
          mac,
          source
        });
        return updated;
      }
    }

    // 3. Tentar reutilizar por ip
    if (ip) {
      const byIp = await findByIp(ip);
      if (byIp) {
        const updated = await updateSession(byIp.sessionId, {
          mac,
          router,
          identity,
          updatedAt: now()
        });

        logger.info("session.get_or_create.reused_by_ip", {
          sessionId: updated.sessionId,
          ip,
          source
        });
        return updated;
      }
    }

    // 4. Não encontrou - adquirir lock para criar
    const fingerprint = pedidoId || mac || ip;
    const createLockKey = `${LOCK_CREATE_PREFIX}${fingerprint}`;
    let lockToken;

    try {
      lockToken = await acquireLock(createLockKey);
    } catch (lockError) {
      logger.error("session.get_or_create.lock_failed", {
        fingerprint,
        message: lockError.message
      });
      throw lockError;
    }

    try {
      // 5. Double-check após lock
      if (pedidoId) {
        const byPedido = await findByPedidoId(pedidoId);
        if (byPedido) {
          const updated = await updateSession(byPedido.sessionId, {
            ip,
            mac,
            router,
            identity
          });
          logger.info("session.get_or_create.reused_after_lock", {
            sessionId: updated.sessionId,
            pedidoId
          });
          return updated;
        }
      }

      if (mac) {
        const byMac = await findByMac(mac);
        if (byMac) {
          const updated = await updateSession(byMac.sessionId, {
            ip,
            router,
            identity
          });
          logger.info("session.get_or_create.reused_after_lock", {
            sessionId: updated.sessionId,
            mac
          });
          return updated;
        }
      }

      // 6. Criar nova
      const newSession = await createSession({
        ip,
        mac,
        router,
        identity,
        planId,
        source
      });

      logger.info("session.get_or_create.created", {
        sessionId: newSession.sessionId,
        ip,
        mac,
        source
      });

      return newSession;
    } finally {
      await releaseLock(createLockKey, lockToken);
    }
  } catch (error) {
    logger.error("session.get_or_create.error", {
      ip,
      mac,
      pedidoId,
      message: error && error.message ? error.message : String(error),
      source
    });
    throw error;
  }
}

export async function authorizeSession(
  sessionId,
  planId,
  pedidoId,
  expiresAt,
  hotspotManager,
  reqId = "unknown"
) {
  if (!sessionId || !expiresAt || !hotspotManager) {
    throw new Error("sessionId, expiresAt, hotspotManager required");
  }

  const lockKey = `${LOCK_AUTHORIZE_PREFIX}${sessionId}`;
  let lockToken;

  try {
    // 1. Acquire lock
    lockToken = await acquireLock(lockKey);
  } catch (lockError) {
    logger.error("session.authorize.lock_failed", {
      sessionId,
      message: lockError.message,
      reqId
    });
    throw lockError;
  }

  try {
    // 2. Fetch session
    const session = await getSession(sessionId);
    if (!session) {
      throw new Error(`session_not_found: ${sessionId}`);
    }

    // 3. Idempotência
    if (session.status === "authorized") {
      logger.info("session.authorize.already_authorized", {
        sessionId,
        reqId,
        idempotent: true
      });
      return {
        ok: true,
        session,
        idempotent: true
      };
    }

    // Validar transição
    validateStateTransition(session.status, "authorized");

    // 4. Executar MikroTik (antes de persistir no Redis)
    let mkResult;
    try {
      mkResult = await hotspotManager.addBinding(session);
      if (!mkResult.ok) {
        logger.error("session.authorize.mikrotik_failed", {
          sessionId,
          error: mkResult.error,
          reqId
        });
        throw new Error(`MikroTik failed: ${mkResult.error}`);
      }
    } catch (mkError) {
      logger.error("session.authorize.mikrotik_exception", {
        sessionId,
        message: mkError.message,
        reqId
      });
      throw mkError;
    }

    // 5. MikroTik sucesso - atualizar sessão
    const updatedSession = {
      ...session,
      status: "authorized",
      authorizedAt: now(),
      expiresAt: Number(expiresAt),
      planId,
      pedidoId,
      updatedAt: now(),
      lastMikrotikResult: mkResult,
      active: true
    };

    // 6. Calcular TTL
    const ttlMs = computeSessionTtlMs(updatedSession);

    // 7. Salvar sessão
    await persistSession(updatedSession, "session.redis.authorize", ttlMs);

    // 8. Salvar índices com mesmo TTL
    await persistIndices(updatedSession, ttlMs);

    // 9. Sucesso
    logger.info("session.authorize.success", {
      sessionId,
      pedidoId,
      expiresAt,
      ttlMs,
      reqId
    });

    return {
      ok: true,
      session: updatedSession,
      idempotent: false
    };
  } finally {
    // Always release lock
    if (lockToken) {
      await releaseLock(lockKey, lockToken);
    }
  }
}

export async function revokeSession(
  sessionId,
  hotspotManager,
  reqId = "unknown"
) {
  if (!sessionId || !hotspotManager) {
    throw new Error("sessionId, hotspotManager required");
  }

  const lockKey = `${LOCK_REVOKE_PREFIX}${sessionId}`;
  let lockToken;

  try {
    // 1. Acquire lock
    lockToken = await acquireLock(lockKey);
  } catch (lockError) {
    logger.error("session.revoke.lock_failed", {
      sessionId,
      message: lockError.message,
      reqId
    });
    throw lockError;
  }

  try {
    // 2. Fetch session
    const session = await getSession(sessionId);
    if (!session) {
      throw new Error(`session_not_found: ${sessionId}`);
    }

    // 3. Idempotência
    if (session.status === "revoked" || session.status === "expired") {
      logger.info("session.revoke.already_revoked", {
        sessionId,
        currentStatus: session.status,
        reqId,
        idempotent: true
      });
      return {
        ok: true,
        session,
        idempotent: true
      };
    }

    // Validar transição
    validateStateTransition(session.status, "revoked");

    // 4. Executar MikroTik
    let mkResult;
    try {
      mkResult = await hotspotManager.removeBinding(session);
      if (!mkResult.ok && !mkResult.notFound) {
        logger.error("session.revoke.mikrotik_failed", {
          sessionId,
          error: mkResult.error,
          reqId
        });
        throw new Error(`MikroTik remove failed: ${mkResult.error}`);
      }
    } catch (mkError) {
      logger.error("session.revoke.mikrotik_exception", {
        sessionId,
        message: mkError.message,
        reqId
      });
      throw mkError;
    }

    // 5. Atualizar sessão
    const updatedSession = {
      ...session,
      status: "revoked",
      revokedAt: now(),
      updatedAt: now(),
      active: false
    };

    // 6. TTL curto para cleanup
    const ttlMs = CLEANUP_WINDOW_MS;

    // 7. Salvar sessão e índices
    await persistSession(updatedSession, "session.redis.revoke", ttlMs);
    await persistIndices(updatedSession, ttlMs);

    // 8. Sucesso
    logger.info("session.revoke.success", {
      sessionId,
      ttlMs,
      reqId
    });

    return {
      ok: true,
      session: updatedSession,
      idempotent: false
    };
  } finally {
    // Always release lock
    if (lockToken) {
      await releaseLock(lockKey, lockToken);
    }
  }
}

export default {
  createSession,
  getSession,
  updateSession,
  findByIp,
  findByMac,
  findByPedidoId,
  deleteSession,
  listSessions,
  getOrCreateSession,
  authorizeSession,
  revokeSession
};
