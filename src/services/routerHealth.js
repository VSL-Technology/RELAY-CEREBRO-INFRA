// src/services/routerHealth.js
// Circuit breaker per router.
// Storage: write-through Redis + in-memory cache (sync reads, async writes).
// Multiple instances share state via Redis; in-memory cache is refreshed every CB_SYNC_INTERVAL_MS.
// Fail-open: if Redis is unavailable, in-memory cache is used transparently.
import redis from '../lib/redis.js';
import metrics from './metrics.js';
import logger from './logger.js';
import { circuitBreakerState } from '../lib/metrics.js';

const FAILURE_THRESHOLD = parseInt(process.env.CB_FAILURE_THRESHOLD || '5', 10);
const RECOVERY_TIMEOUT_MS = parseInt(process.env.CB_RECOVERY_TIMEOUT_MS || '60000', 10);
const CB_KEY_TTL_S = 3600; // Redis key TTL: 1 hour
const CB_SYNC_INTERVAL_MS = 10_000; // Sync from Redis every 10s

export const STATES = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  DOWN_TRANSIENT: 'DOWN_TRANSIENT',
  AUTH_FAILED: 'AUTH_FAILED',
  MISCONFIGURED: 'MISCONFIGURED'
};

// In-memory cache (primary read path — synchronous)
const store = new Map();

function redisKey(routerId) {
  return `cb:router:${routerId}`;
}

function isCircuitOpen(health, now = Date.now()) {
  return Boolean(health && health.openUntil && Number(health.openUntil) > now);
}

function setCircuitBreakerGauge(routerId, health, now = Date.now()) {
  circuitBreakerState.set(
    { router_id: routerId },
    isCircuitOpen(health, now) ? 1 : 0
  );
}

function parseRedisHash(data) {
  if (!data || !data.state) return null;
  return {
    state: data.state,
    consecutiveFails: parseInt(data.consecutiveFails || '0', 10),
    openUntil: parseInt(data.openUntil || '0', 10),
    lastErrCode: data.lastErrCode || null,
    nextRetryAt: parseInt(data.nextRetryAt || '0', 10)
  };
}

// Write to Redis in the background; errors are swallowed (fail-open)
function persistToRedis(routerId, health) {
  const key = redisKey(routerId);
  redis.hset(
    key,
    'state', health.state,
    'consecutiveFails', String(health.consecutiveFails || 0),
    'openUntil', String(health.openUntil || 0),
    'lastErrCode', health.lastErrCode || '',
    'nextRetryAt', String(health.nextRetryAt || 0)
  )
    .then(() => redis.expire(key, CB_KEY_TTL_S))
    .catch((err) => logger.warn('cb.redis_write_error', { routerId, message: err && err.message }));
}

// Pull a single router's state from Redis into the local cache
async function refreshFromRedis(routerId) {
  try {
    const data = await redis.hgetall(redisKey(routerId));
    const parsed = parseRedisHash(data);
    if (parsed) {
      store.set(routerId, parsed);
      setCircuitBreakerGauge(routerId, parsed);
    }
  } catch (err) {
    logger.warn('cb.redis_read_error', { routerId, message: err && err.message });
  }
}

// Periodic background sync: keeps local cache fresh across instances
const _syncInterval = setInterval(() => {
  for (const routerId of store.keys()) {
    refreshFromRedis(routerId);
  }
}, CB_SYNC_INTERVAL_MS);

// Allow cleanup in tests
if (typeof _syncInterval.unref === 'function') _syncInterval.unref();

// ─── Public interface (synchronous — reads from in-memory cache) ────────────

export function getHealth(routerId) {
  return store.get(routerId) || {
    state: STATES.HEALTHY,
    consecutiveFails: 0,
    openUntil: 0,
    lastErrCode: null,
    nextRetryAt: 0
  };
}

export function canAttempt(routerId) {
  const h = getHealth(routerId);
  const now = Date.now();
  return !h.openUntil || h.openUntil <= now;
}

export function updateRouterHealth(routerId, classification) {
  if (!routerId) return;
  const h = getHealth(routerId);
  const now = Date.now();
  const wasOpen = isCircuitOpen(h, now);
  const next = { ...h, lastErrCode: classification.code || h.lastErrCode };

  if (classification.class === 'setup') {
    next.state = STATES.MISCONFIGURED;
    next.openUntil = now + (classification.openCircuitMs || 10 * 60 * 1000);
    next.consecutiveFails = (h.consecutiveFails || 0) + 1;
  } else if (classification.class === 'auth') {
    next.state = STATES.AUTH_FAILED;
    next.openUntil = now + (classification.openCircuitMs || 15 * 60 * 1000);
    next.consecutiveFails = (h.consecutiveFails || 0) + 1;
  } else if (classification.class === 'transient') {
    const fails = (h.consecutiveFails || 0) + 1;
    next.consecutiveFails = fails;
    next.state = fails >= FAILURE_THRESHOLD ? STATES.DOWN_TRANSIENT : STATES.DEGRADED;
    next.openUntil = fails >= FAILURE_THRESHOLD ? now + RECOVERY_TIMEOUT_MS : 0;
  } else {
    // unknown/inconsistent: no state change
    return h;
  }

  store.set(routerId, next);
  setCircuitBreakerGauge(routerId, next, now);
  persistToRedis(routerId, next);
  metrics.inc(`relay.router_health_state_${next.state}`);

  const isOpenNow = isCircuitOpen(next, now);
  if (!wasOpen && isOpenNow) {
    logger.warn('circuit_breaker_opened', {
      router_id: routerId,
      failures: next.consecutiveFails
    });
  } else if (wasOpen && !isOpenNow) {
    logger.info('circuit_breaker_recovered', {
      router_id: routerId
    });
  }

  return next;
}

/**
 * Optional: preload health state from Redis on startup.
 * Call with known router IDs so circuit states survive restarts.
 */
export async function preloadRouterHealth(routerIds = []) {
  for (const id of routerIds) {
    await refreshFromRedis(id);
  }
}

export default { STATES, getHealth, updateRouterHealth, canAttempt, preloadRouterHealth };
