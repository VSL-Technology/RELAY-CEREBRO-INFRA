// src/services/logger.js
// Simple structured JSON logger. Lightweight, no external deps.
import util from "util";
import { getRequestContext } from "../lib/requestContext.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = process.env.RELAY_LOG_LEVEL || "info";

function now() {
  return new Date().toISOString();
}

function serializeArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return { message: arg.message, stack: arg.stack };
    }
    if (typeof arg === "object") return arg;
    return String(arg);
  });
}

function applyBindings(entry, bindings = {}) {
  for (const [key, value] of Object.entries(bindings)) {
    if (value === undefined) continue;
    if (key === "ts" || key === "level" || key === "pid" || key === "msg" || key === "meta") continue;
    entry[key] = value;
  }
}

function write(level, bindings, args) {
  const requestContext = getRequestContext();
  const entry = {
    ts: now(),
    level,
    pid: process.pid,
    msg: "",
    reqId: bindings.reqId ?? requestContext.reqId ?? null
  };

  applyBindings(entry, bindings);

  const parts = serializeArgs(args);
  if (parts.length === 1 && typeof parts[0] === "string") {
    entry.msg = parts[0];
  } else {
    entry.msg = parts.map((part) => (typeof part === "string" ? part : util.inspect(part, { depth: 5 }))).join(" ");
  }

  const meta = parts.filter((part) => typeof part === "object" && !(part instanceof Error));
  if (meta.length) {
    entry.meta = meta.length === 1 ? meta[0] : meta;
  }

  try {
    process.stdout.write(JSON.stringify(entry) + "\n");
  } catch (error) {
    console.log(entry.ts, level, entry.msg);
  }
}

function levelEnabled(level) {
  return LEVELS[level] >= LEVELS[DEFAULT_LEVEL];
}

function withBindings(level, bindings, args) {
  if (levelEnabled(level)) {
    write(level, bindings || {}, args);
  }
}

export function debug(...args) { withBindings("debug", {}, args); }
export function info(...args) { withBindings("info", {}, args); }
export function warn(...args) { withBindings("warn", {}, args); }
export function error(...args) { withBindings("error", {}, args); }

export function child(bindings = {}) {
  return {
    debug: (...args) => withBindings("debug", bindings, args),
    info: (...args) => withBindings("info", bindings, args),
    warn: (...args) => withBindings("warn", bindings, args),
    error: (...args) => withBindings("error", bindings, args)
  };
}

export default { debug, info, warn, error, child };
