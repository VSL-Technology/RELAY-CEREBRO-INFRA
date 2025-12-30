// src/services/mikrotikService.js
import logger from './logger.js';
import { runMikrotikCommands } from './mikrotik.js';
import { normalizeMikrotikError } from './errors/normalizeMikrotikError.js';

function isDryRun() {
  return process.env.RELAY_DRY_RUN === '1' || process.env.RELAY_DRY_RUN === 'true';
}

/**
 * @internal Low-level router connection helper.
 * Prefer higher-level mikrotikService actions in production code.
 */
async function connectToRouter(tunnelIp, opts = {}) {
  if (isDryRun()) {
    return {
      ok: true,
      dryRun: true,
      conn: null,
      chan: null,
      exec: async () => ({ ok: true, dryRun: true }),
      close: async () => {}
    };
  }
  try {
    const mikronode = (await import('mikronode-ng')).default;
    // connect via tunnel ip using RouterOS API (username/password from env should be provided at runtime)
    const user = process.env.MIKROTIK_USER;
    const pass = process.env.MIKROTIK_PASS;
    if (!user || !pass) throw new Error('MIKROTIK_USER / MIKROTIK_PASS not set');
    const conn = new mikronode(tunnelIp);
    await conn.connect();
    const chan = await conn.openChannel();
    // attempt login
    await chan.login(user, pass);
    return { ok: true, conn, chan };
  } catch (e) {
    const normalized = normalizeMikrotikError(e);
    logger.error('mikrotik.connect_error', { message: normalized && normalized.message, code: normalized && normalized.code });
    return { ok: false, error: normalized && normalized.message, code: normalized && normalized.code };
  }
}

export async function validateIdentity(tunnelIp) {
  if (isDryRun()) return { status: 'ONLINE', info: { dryRun: true } };
  const r = await connectToRouter(tunnelIp);
  if (!r.ok) return { status: 'UNREACHABLE', detail: r.error };
  try {
    // TODO: query identity / system/routerboard
    // Minimal approach: return ONLINE if connected
    return { status: 'ONLINE' };
  } catch (e) {
    return { status: 'AUTH_FAILED', detail: e && e.message };
  }
}

export async function ensureTechnicalUser(tunnelIp, { username, password } = {}) {
  const user = username || process.env.RELAY_TECH_USER || 'relay-tech';
  const pass = password || process.env.RELAY_TECH_PASS || null;
  if (!pass) {
    logger.warn('mikrotik.ensureTechnicalUser.skip', { reason: 'missing password' });
    return { ok: false, error: 'missing password' };
  }

  const cmds = [
    `/user/group add name=relay-tech policy=api,read,write comment="managed-by-relay"`,
    `:if ([:len [/user find name=${user}]] = 0) do={/user add name=${user} group=relay-tech password=${pass} comment="managed-by-relay"}`,
    `:if ([:len [/user find name=${user}]] > 0) do={/user set [find name=${user}] group=relay-tech disabled=no comment="managed-by-relay"}`
  ];

  if (isDryRun()) return { ok: true, dryRun: true, commands: cmds };

  try {
    const result = await runMikrotikCommands({
      host: tunnelIp,
      user: process.env.MIKROTIK_USER || user,
      pass: process.env.MIKROTIK_PASS || pass,
      port: process.env.MIKROTIK_PORT ? Number(process.env.MIKROTIK_PORT) : 8728
    }, cmds);
    return { ok: !!(result && result.ok), result };
  } catch (e) {
    logger.error('mikrotik.ensureTechnicalUser_error', { message: e && e.message });
    return { ok: false, error: e && e.message };
  }
}

export async function applyMinimalConfig(tunnelIp, config = {}) {
  const iface = config.interfaceName || 'wg-relay';
  const tunnelCidr = config.tunnelCidr || (config.tunnelIp ? `${config.tunnelIp}/32` : null);
  const allowedIps = config.allowedIps || tunnelCidr || null;
  const vpsPub = process.env.WG_VPS_PUBLIC_KEY || config.vpsPublicKey || '<vps-public-key>';
  const endpoint = process.env.WG_VPS_ENDPOINT || config.vpsEndpoint || '<endpoint:port>';
  const keepAlive = config.keepAlive || 25;

  if (!tunnelCidr) {
    return { ok: false, error: 'tunnelIp/tunnelCidr required' };
  }
  if (!vpsPub || vpsPub === '<vps-public-key>') {
    return { ok: false, error: 'WG_VPS_PUBLIC_KEY or vpsPublicKey required' };
  }
  if (!endpoint || endpoint === '<endpoint:port>') {
    return { ok: false, error: 'WG_VPS_ENDPOINT or vpsEndpoint required' };
  }

  const cmds = [];
  cmds.push(`:if ([:len [/interface/wireguard find name=${iface}]] = 0) do={/interface/wireguard add name=${iface} comment="managed-by-relay"}`);
  if (tunnelCidr) {
    cmds.push(`:if ([:len [/ip/address find address=${tunnelCidr}]] = 0) do={/ip/address add address=${tunnelCidr} interface=${iface} comment="relay-tunnel"}`);
  }
  if (allowedIps) {
    cmds.push(`:if ([:len [/interface/wireguard/peers find public-key="${vpsPub}"]]=0) do={/interface/wireguard/peers add interface=${iface} public-key="${vpsPub}" allowed-address=${allowedIps} endpoint-address=${endpoint} persistent-keepalive=${keepAlive} comment="vps-peer"}`);
    cmds.push(`/interface/wireguard/peers set [find public-key="${vpsPub}"] allowed-address=${allowedIps} endpoint-address=${endpoint} persistent-keepalive=${keepAlive} comment="vps-peer"`);
  }
  cmds.push(`:if ([:len [/ip/firewall/filter find comment="relay-allow-wg"]] = 0) do={/ip/firewall/filter add chain=input action=accept comment="relay-allow-wg" in-interface=${iface}}`);

  if (isDryRun()) return { ok: true, dryRun: true, commands: cmds };

  try {
    const result = await runMikrotikCommands({
      host: tunnelIp,
      user: process.env.MIKROTIK_USER,
      pass: process.env.MIKROTIK_PASS,
      port: process.env.MIKROTIK_PORT ? Number(process.env.MIKROTIK_PORT) : 8728
    }, cmds);
    return { ok: !!(result && result.ok), result, commands: cmds };
  } catch (e) {
    logger.error('mikrotik.applyMinimalConfig_error', { message: e && e.message });
    return { ok: false, error: e && e.message };
  }
}

export { connectToRouter };

export default { validateIdentity, ensureTechnicalUser, applyMinimalConfig, connectToRouter };
