// src/services/errors/classifyError.js
// Normalize error classes for health/playbooks.

const SETUP_CODES = new Set([
  'WG_INTERFACE_NOT_CONFIGURED',
  'MIKROTIK_NODES_NOT_CONFIGURED',
  'MIKROTIK_NODES_INVALID_JSON',
  'MIKROTIK_NODE_NOT_FOUND',
  'router_not_resolved',
  'missing_ip_or_mac'
]);

const AUTH_CODES = new Set([
  'MIKROTIK_AUTH_FAILED',
  'MIKROTIK_PERMISSION_DENIED',
]);

const TRANSIENT_CODES = new Set([
  'WG_COMMAND_FAILED',
  'WG_LIST_PEERS_FAILED',
  'MIKROTIK_TIMEOUT',
  'MIKROTIK_UNREACHABLE',
  'MIKROTIK_CONNECTION_RESET',
  'MIKROTIK_DNS_NOT_FOUND',
  'MIKROTIK_PROTOCOL_ERROR'
]);

const INCONSISTENT_CODES = new Set([
  'EVENT_INVALID_SCHEMA',
  'EVENT_INCONSISTENT'
]);

export function classifyError(err) {
  const code = (err && err.code) || null;
  const unknown = { class: 'unknown', code: code || 'UNKNOWN_ERROR', retryable: false };

  if (!code) return unknown;

  if (SETUP_CODES.has(code)) {
    return { class: 'setup', code, retryable: false, openCircuitMs: 10 * 60 * 1000 };
  }
  if (AUTH_CODES.has(code)) {
    return { class: 'auth', code, retryable: false, openCircuitMs: 15 * 60 * 1000 };
  }
  if (TRANSIENT_CODES.has(code)) {
    return { class: 'transient', code, retryable: true };
  }
  if (INCONSISTENT_CODES.has(code)) {
    return { class: 'inconsistent', code, retryable: false };
  }

  return unknown;
}

export default { classifyError };
