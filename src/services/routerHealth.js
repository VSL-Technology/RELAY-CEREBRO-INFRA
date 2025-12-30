// src/services/routerHealth.js
// Simple in-memory health tracking per router.
import metrics from "./metrics.js";

const STATES = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  DOWN_TRANSIENT: 'DOWN_TRANSIENT',
  AUTH_FAILED: 'AUTH_FAILED',
  MISCONFIGURED: 'MISCONFIGURED'
};

const store = new Map();

export function getHealth(routerId) {
  return store.get(routerId) || { state: STATES.HEALTHY, consecutiveFails: 0, openUntil: 0, lastErrCode: null, nextRetryAt: 0 };
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
    next.state = fails >= 3 ? STATES.DOWN_TRANSIENT : STATES.DEGRADED;
    next.openUntil = 0;
  } else {
    // unknown/inconsistent: no state change
  }

  store.set(routerId, next);
  metrics.inc(`relay.router_health_state_${next.state}`);
  return next;
}

export default { STATES, getHealth, updateRouterHealth, canAttempt };
