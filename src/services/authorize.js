// src/services/authorize.js
import { runMikrotikCommands } from "./mikrotik.js";
import { getMikById } from "../config/mikrotiks.js";
import { getDeviceByToken } from "./deviceRegistry.js";
import logger from "./logger.js";
import {
  buildAuthorizeCommands,
  buildRevokeCommands
} from "./paidClientAccess.js";

function normalizeMac(mac) {
  if (!mac) return null;
  return mac.trim().toUpperCase();
}

function normalizeIp(ip) {
  if (!ip) return null;
  return ip.trim();
}

/**
 * Liberação principal:
 *  - Webhook manda: pedidoId, mikId, deviceToken
 *  - Relay descobre ip/mac atuais do device
 *  - Joga em paid_clients + ip-binding + limpa host/active
 */
export async function authorizeByPedido({ pedidoId, mikId, deviceToken }) {
  const device = getDeviceByToken(deviceToken);
  if (!device) {
    logger.warn("authorize.device_token_not_found", { pedidoId, mikId, deviceToken });
    throw new Error(`deviceToken não encontrado no relay: ${deviceToken}`);
  }

  if (device.mikId !== mikId) {
    logger.warn("authorize.mik_id_mismatch", {
      pedidoId,
      deviceToken,
      expectedMikId: device.mikId,
      receivedMikId: mikId
    });
  }

  const ip = normalizeIp(device.ipAtual);
  const mac = normalizeMac(device.macAtual);

  if (!ip || !mac) {
    logger.warn("authorize.device_identity_missing", { pedidoId, mikId, deviceToken, ip, mac });
    throw new Error(`Device sem ip/mac atual. token=${deviceToken}`);
  }

  const mik = getMikById(mikId);
  const cmds = buildAuthorizeCommands({ pedidoId, ip, mac });

  const mkResult = await runMikrotikCommands(mik, cmds);

  return {
    ok: mkResult.ok,
    pedidoId,
    mikId,
    deviceToken,
    ip,
    mac,
    mikrotik: mkResult
  };
}

// Variante que aceita IP/MAC diretamente (útil para eventos que trazem ip/mac em vez de deviceToken)
export async function authorizeByPedidoIp({ pedidoId, mikId, ipAtual, macAtual }) {
  const ip = normalizeIp(ipAtual);
  const mac = normalizeMac(macAtual);

  if (!pedidoId || !mikId || !ip || !mac) {
    logger.warn("authorize_by_ip.invalid_payload", { pedidoId, mikId, ip, mac });
    throw new Error("Campos obrigatórios: pedidoId, mikId, ipAtual, macAtual");
  }

  const mik = getMikById(mikId);
  const cmds = buildAuthorizeCommands({ pedidoId, ip, mac });

  const mkResult = await runMikrotikCommands(mik, cmds);

  return {
    ok: mkResult.ok,
    pedidoId,
    mikId,
    ip,
    mac,
    mikrotik: mkResult
  };
}

/**
 * Resync: botão "já paguei e não liberou".
 * Backend manda: pedidoId, mikId, deviceToken, ipAtual, macAtual
 * Relay atualiza a visão e chama authorizeByPedido de novo.
 */
export async function resyncDevice({ pedidoId, mikId, deviceToken, ipAtual, macAtual }) {
  const device = getDeviceByToken(deviceToken);
  if (!device) {
    throw new Error(`deviceToken não encontrado no relay: ${deviceToken}`);
  }

  device.ipAtual = ipAtual;
  device.macAtual = macAtual;
  device.lastSeenAt = new Date().toISOString();

  return authorizeByPedido({ pedidoId, mikId, deviceToken });
}

/**
 * Revogar acesso (quando plano expira ou derrubar manual).
 */
export async function revokeBySession({ mikId, ip, mac }) {
  const ipNorm = normalizeIp(ip);
  const macNorm = normalizeMac(mac);

  if (!mikId || (!ipNorm && !macNorm)) {
    throw new Error("Campos obrigatórios: mikId e (ip ou mac)");
  }

  const mik = getMikById(mikId);
  const cmds = buildRevokeCommands({ ip: ipNorm, mac: macNorm });

  const mkResult = await runMikrotikCommands(mik, cmds);

  return {
    ok: mkResult.ok,
    mikId,
    ip: ipNorm,
    mac: macNorm,
    mikrotik: mkResult
  };
}
