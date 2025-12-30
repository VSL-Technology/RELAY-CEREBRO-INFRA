// src/services/errors/normalizeMikrotikError.js
// Normalize mikrotik-related errors into stable codes for health/playbooks.

export function normalizeMikrotikError(err) {
  if (!err) return { code: 'MIKROTIK_UNKNOWN_ERROR', message: 'Unknown error' };
  const msg = (err.message || String(err || '')).toLowerCase();
  const code = err.code;

  // Preserve existing setup codes
  if (code && (code.startsWith('MIKROTIK_NODES_') || code === 'MIKROTIK_NODE_NOT_FOUND')) {
    return err;
  }

  // Auth/permission
  if (
    msg.includes('invalid user') ||
    (msg.includes('password') && msg.includes('invalid')) ||
    msg.includes('authentication failed') ||
    msg.includes('login failure') ||
    msg.includes('not logged in')
  ) {
    err.code = 'MIKROTIK_AUTH_FAILED';
    return err;
  }
  if (msg.includes('permission denied') || msg.includes('not enough permissions') || msg.includes('forbidden')) {
    err.code = 'MIKROTIK_PERMISSION_DENIED';
    return err;
  }

  // Network/transient
  if (err.name === 'AbortError' || code === 'ETIMEDOUT' || msg.includes('timeout')) {
    err.code = 'MIKROTIK_TIMEOUT';
    return err;
  }
  if (code === 'ENOTFOUND') {
    err.code = 'MIKROTIK_DNS_NOT_FOUND';
    return err;
  }
  if (code === 'ECONNRESET') {
    err.code = 'MIKROTIK_CONNECTION_RESET';
    return err;
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || msg.includes('unreach')) {
    err.code = 'MIKROTIK_UNREACHABLE';
    return err;
  }

  // Protocol/response issues
  if (msg.includes('protocol') || msg.includes('bad response') || msg.includes('malformed') || msg.includes('parse')) {
    err.code = 'MIKROTIK_PROTOCOL_ERROR';
    return err;
  }

  // Fallback
  err.code = err.code || 'MIKROTIK_UNKNOWN_ERROR';
  return err;
}

export default { normalizeMikrotikError };
