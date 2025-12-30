// src/services/audit.js
// Auditoria simples para registrar tentativas, sucessos e falhas das ações do relay
import metrics from "./metrics.js";

function makeTraceId() {
  return (Math.random() + 1).toString(36).substring(2, 9);
}

const REDACT_KEYS = new Set(["password", "pass", "apiPassword", "token", "secret"]);

function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const clone = { ...obj };
  for (const [k, v] of Object.entries(clone)) {
    if (REDACT_KEYS.has(k)) {
      clone[k] = "<redacted>";
    } else if (typeof v === "object") {
      clone[k] = redact(v);
    }
  }
  return clone;
}

function normalizeDetail(detail) {
  const base = detail && typeof detail === "object" ? { ...detail } : {};
  base.traceId = base.traceId || makeTraceId();
  if (base.payload) base.payload = redact(base.payload);
  return base;
}

function now() {
  return new Date().toISOString();
}

function baseEvent(type, detail) {
  return {
    type,
    timestamp: now(),
    ...detail
  };
}

export function auditAttempt(detail) {
  const ev = baseEvent("RELAY_ACTION_ATTEMPT", normalizeDetail(detail));
  metrics.inc("audit.attempt");
  console.log(JSON.stringify(ev));
  return ev;
}

export function auditSuccess(detail) {
  const ev = baseEvent("RELAY_ACTION_SUCCESS", normalizeDetail(detail));
  metrics.inc("audit.success");
  console.log(JSON.stringify(ev));
  return ev;
}

export function auditFail(detail) {
  const ev = baseEvent("RELAY_ACTION_FAIL", normalizeDetail(detail));
  metrics.inc("audit.fail");
  console.error(JSON.stringify(ev));
  return ev;
}

export default {
  auditAttempt,
  auditSuccess,
  auditFail
};
