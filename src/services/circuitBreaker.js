// src/services/circuitBreaker.js
// Simple in-memory circuit breaker per router

const STATES = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF: "HALF"
};

const store = new Map();

const DEFAULT_OPTIONS = {
  failureThreshold: 5,
  recoveryMs: 60 * 1000 // 1 minute
};

function get(key) {
  if (!store.has(key)) {
    store.set(key, { failures: 0, state: STATES.CLOSED, openedAt: null });
  }
  return store.get(key);
}

export function allowRequest(routerId, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const s = get(routerId);
  if (s.state === STATES.OPEN) {
    if (Date.now() - s.openedAt > o.recoveryMs) {
      s.state = STATES.HALF;
      s.failures = 0;
      return true;
    }
    return false;
  }
  return true;
}

export function recordFailure(routerId, opts = {}) {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const s = get(routerId);
  s.failures = (s.failures || 0) + 1;
  if (s.failures >= o.failureThreshold) {
    s.state = STATES.OPEN;
    s.openedAt = Date.now();
    console.warn(`[cb] router ${routerId} circuit opened`);
  }
}

export function recordSuccess(routerId) {
  const s = get(routerId);
  s.failures = 0;
  s.state = STATES.CLOSED;
}

export default { allowRequest, recordFailure, recordSuccess };
