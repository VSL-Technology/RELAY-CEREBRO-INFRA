// src/services/actionHandler.js
// Handler central de ações do relay — allowlist de ações e validações básicas.

import {
  authorizeByPedido,
  authorizeByPedidoIp,
  resyncDevice,
  revokeBySession
} from "./authorize.js";
import { getMikById } from "../config/mikrotiks.js";
import * as audit from "./audit.js";
import metrics from "./metrics.js";

const ACTIONS = {
  AUTHORIZE_BY_PEDIDO: authorizeByPedido,
  RESYNC_DEVICE: resyncDevice,
  REVOKE_SESSION: revokeBySession
};

function makeTraceId() {
  return (Math.random() + 1).toString(36).substring(2, 9);
}

function requireString(value, name) {
  if (value === undefined || value === null || value === "") throw new Error(`${name} required`);
  if (typeof value !== "string") throw new Error(`${name} must be string`);
}

function validatePayload(action, payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");

  if (action === "AUTHORIZE_BY_PEDIDO" || action === "RESYNC_DEVICE") {
    const { deviceToken, pedidoId, mikId, ipAtual, macAtual } = payload;
    if (deviceToken) {
      requireString(deviceToken, "deviceToken");
      if (pedidoId) requireString(pedidoId, "pedidoId");
      if (mikId) requireString(mikId, "mikId");
    } else {
      requireString(pedidoId, "pedidoId");
      requireString(mikId, "mikId");
      requireString(ipAtual, "ipAtual");
      requireString(macAtual, "macAtual");
    }
  }

  if (action === "REVOKE_SESSION") {
    const { mikId, ip, mac } = payload;
    requireString(mikId, "mikId");
    if (!ip && !mac) throw new Error("ip or mac required for revoke");
    if (ip) requireString(ip, "ip");
    if (mac) requireString(mac, "mac");
  }
}

export async function executeAction({ action, payload = {}, source = "http", traceId = null }) {
  const tid = traceId || makeTraceId();

  if (!action || typeof action !== "string") {
    const err = new Error("Missing or invalid action");
    audit.auditFail({ action, payload, source, traceId: tid, error: err.message });
    throw err;
  }

  if (!ACTIONS[action]) {
    const err = new Error(`Action not allowed: ${action}`);
    audit.auditFail({ action, payload, source, traceId: tid, error: err.message });
    const resp = { ok: false, status: 403, error: err.message };
    return resp;
  }

  // Basic validation per action
  try {
    // Emit attempt
    audit.auditAttempt({ action, payload, source, traceId: tid });
    metrics.inc("action.attempt");
    metrics.inc(`action.${action}.attempt`);
    if (payload.mikId) metrics.inc(`router.${payload.mikId}.action.attempt`);
    validatePayload(action, payload);
    const started = Date.now();

    // Validate mikrotik exists early when provided
    if (payload.mikId) {
      // throws if not found
      getMikById(payload.mikId);
    }

    // For AUTHORIZE_BY_PEDIDO / RESYNC_DEVICE: accept either deviceToken OR (pedidoId + mikId + ipAtual + macAtual)
    if (action === "AUTHORIZE_BY_PEDIDO" || action === "RESYNC_DEVICE") {
      const { deviceToken, pedidoId, mikId, ipAtual, macAtual } = payload;
      if (!deviceToken && !(pedidoId && mikId && ipAtual && macAtual)) {
        throw new Error(
          "Missing fields: deviceToken OR (pedidoId, mikId, ipAtual, macAtual) required"
        );
      }
    }

    // For REVOKE_SESSION: require mikId and (ip or mac)
    if (action === "REVOKE_SESSION") {
      const { mikId, ip, mac } = payload;
      if (!mikId || (!ip && !mac)) {
        throw new Error("Missing fields: mikId and (ip or mac) required for revoke");
      }
    }

    // Execute the mapped function
    const fn = ACTIONS[action];

    // Normalize payload shape for existing functions
    let result = null;
    if (action === "AUTHORIZE_BY_PEDIDO") {
      // if deviceToken present, use original flow. Otherwise, use ip/mac variant
      if (payload.deviceToken) {
        result = await authorizeByPedido({
          pedidoId: payload.pedidoId,
          mikId: payload.mikId,
          deviceToken: payload.deviceToken
        });
      } else {
        result = await authorizeByPedidoIp({
          pedidoId: payload.pedidoId,
          mikId: payload.mikId,
          ipAtual: payload.ipAtual,
          macAtual: payload.macAtual
        });
      }
    } else if (action === "RESYNC_DEVICE") {
      if (payload.deviceToken) {
        result = await resyncDevice({
          pedidoId: payload.pedidoId,
          mikId: payload.mikId,
          deviceToken: payload.deviceToken,
          ipAtual: payload.ipAtual,
          macAtual: payload.macAtual
        });
      } else {
        // fallback to ip/mac direct authorize if device token not available
        result = await authorizeByPedidoIp({
          pedidoId: payload.pedidoId,
          mikId: payload.mikId,
          ipAtual: payload.ipAtual,
          macAtual: payload.macAtual
        });
      }
    } else if (action === "REVOKE_SESSION") {
      result = await fn({
        mikId: payload.mikId,
        ip: payload.ip,
        mac: payload.mac
      });
    } else {
      // Shouldn't happen because of allowed check
      throw new Error("Unhandled action");
    }

    audit.auditSuccess({ action, payload, source, traceId: tid, result: !!result });
    metrics.inc("action.success");
    metrics.inc(`action.${action}.success`);
    if (payload.mikId) metrics.inc(`router.${payload.mikId}.action.success`);
    const durationMs = Date.now() - started;
    metrics.inc(`action.${action}.latency_ms_total`, durationMs);
    metrics.inc(`action.latency_ms_total`, durationMs);
    if (payload.mikId) {
      metrics.inc(`router.${payload.mikId}.latency_ms_total`, durationMs);
    }

    return { ok: true, action, traceId: tid, result };
  } catch (err) {
    audit.auditFail({ action, payload, source, traceId: tid, error: err.message });
    metrics.inc("action.fail");
    metrics.inc(`action.${action}.fail`);
    if (payload.mikId) metrics.inc(`router.${payload.mikId}.action.fail`);
    return { ok: false, action, traceId: tid, error: err.message };
  }
}

export default {
  executeAction
};
