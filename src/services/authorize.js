// src/services/authorize.js
import { runMikrotikCommands } from "./mikrotik.js";
import { getMikById } from "../config/mikrotiks.js";
import { getDeviceByToken } from "./deviceRegistry.js";

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
    throw new Error(`deviceToken não encontrado no relay: ${deviceToken}`);
  }

  if (device.mikId !== mikId) {
    console.warn(
      `[relay] mikId divergente. token=${deviceToken} esperado=${device.mikId} recebido=${mikId}`
    );
  }

  const ip = normalizeIp(device.ipAtual);
  const mac = normalizeMac(device.macAtual);

  if (!ip || !mac) {
    throw new Error(`Device sem ip/mac atual. token=${deviceToken}`);
  }

  const mik = getMikById(mikId);

  const cmds = [
    `/ip firewall address-list add list=paid_clients address=${ip} comment="pedido:${pedidoId}"`,
    `/ip hotspot ip-binding add mac-address=${mac} address=${ip} type=bypassed comment="pedido:${pedidoId}"`,
    `/ip hotspot host remove   [find mac-address=${mac}]`,
    `/ip hotspot active remove [find mac-address=${mac}]`
  ];

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
    throw new Error("Campos obrigatórios: pedidoId, mikId, ipAtual, macAtual");
  }

  const mik = getMikById(mikId);

  const cmds = [
    `/ip firewall address-list add list=paid_clients address=${ip} comment="pedido:${pedidoId}"`,
    `/ip hotspot ip-binding add mac-address=${mac} address=${ip} type=bypassed comment="pedido:${pedidoId}"`,
    `/ip hotspot host remove   [find mac-address=${mac}]`,
    `/ip hotspot active remove [find mac-address=${mac}]`
  ];

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

  const cmds = [];

  if (ipNorm) {
    cmds.push(`/ip firewall address-list remove [find list=paid_clients address=${ipNorm}]`);
  }

  if (macNorm) {
    cmds.push(`/ip hotspot ip-binding remove [find mac-address=${macNorm}]`);
    cmds.push(`/ip hotspot active remove [find mac-address=${macNorm}]`);
    cmds.push(`/ip hotspot host remove [find mac-address=${macNorm}]`);
  }

  const mkResult = await runMikrotikCommands(mik, cmds);

  return {
    ok: mkResult.ok,
    mikId,
    ip: ipNorm,
    mac: macNorm,
    mikrotik: mkResult
  };
}
