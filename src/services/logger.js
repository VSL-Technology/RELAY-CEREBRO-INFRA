// src/services/logger.js
// Simple structured JSON logger. Lightweight, no external deps.
import util from 'util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = process.env.RELAY_LOG_LEVEL || 'info';

function now() {
  return new Date().toISOString();
}

function serializeArgs(args) {
  return args.map(a => {
    if (a instanceof Error) {
      return { message: a.message, stack: a.stack };
    }
    if (typeof a === 'object') return a;
    return String(a);
  });
}

function log(level, ...args) {
  const entry = {
    ts: now(),
    level,
    pid: process.pid,
    msg: '',
  };
  const parts = serializeArgs(args);
  if (parts.length === 1 && typeof parts[0] === 'string') {
    entry.msg = parts[0];
  } else {
    entry.msg = parts.map(p => (typeof p === 'string' ? p : util.inspect(p, { depth: 5 }))).join(' ');
  }
  // attach any object payloads under `meta`
  const meta = parts.filter(p => typeof p === 'object' && !(p instanceof Error));
  if (meta.length) entry.meta = meta.length === 1 ? meta[0] : meta;
  // print JSON
  try {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } catch (e) {
    // fallback
    console.log(entry.ts, level, entry.msg);
  }
}

function levelEnabled(level) {
  return LEVELS[level] >= LEVELS[DEFAULT_LEVEL];
}

export function debug(...args) { if (levelEnabled('debug')) log('debug', ...args); }
export function info(...args) { if (levelEnabled('info')) log('info', ...args); }
export function warn(...args) { if (levelEnabled('warn')) log('warn', ...args); }
export function error(...args) { if (levelEnabled('error')) log('error', ...args); }

export function child(bindings = {}) {
  return {
    debug: (...a) => debug({ ...bindings }, ...a),
    info: (...a) => info({ ...bindings }, ...a),
    warn: (...a) => warn({ ...bindings }, ...a),
    error: (...a) => error({ ...bindings }, ...a),
  };
}

export default { debug, info, warn, error, child };
