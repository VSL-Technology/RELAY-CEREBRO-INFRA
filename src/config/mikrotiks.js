// src/config/mikrotiks.js
//
// Lazy loader para MIKROTIK_NODES.
// Exemplo esperado no .env:
// MIKROTIK_NODES='[{"id":"HOTSPOT-01","host":"10.200.1.10","user":"relay","pass":"<senha>","port":8728}]'

let cached = null;

function codedError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function parseNodes(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not_array');
    return parsed;
  } catch (e) {
    throw codedError('MIKROTIK_NODES_INVALID_JSON', 'Invalid MIKROTIK_NODES JSON');
  }
}

export function getMikrotikNodes() {
  if (cached) return cached;
  const raw = process.env.MIKROTIK_NODES;
  if (!raw) {
    throw codedError('MIKROTIK_NODES_NOT_CONFIGURED', 'MIKROTIK_NODES env is required (JSON array with id/host/user/pass/port)');
  }
  cached = parseNodes(raw);
  return cached;
}

export function getMikById(mikId) {
  const nodes = getMikrotikNodes();
  const node = nodes.find((m) => m.id === mikId);
  if (!node) {
    throw codedError('MIKROTIK_NODE_NOT_FOUND', `Mikrotik com mikId=${mikId} não encontrado em MIKROTIK_NODES`);
  }
  return node;
}
