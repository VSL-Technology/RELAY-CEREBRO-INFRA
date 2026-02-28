// src/services/mikrotik.js
// MikroTik API wrapper (Node 20 + ESM) usando mikronode-ng via getConnection().
// Corrige: "MikroNodeCtor is not a constructor"

import { createRequire } from "module";
import logger from "./logger.js";

const require = createRequire(import.meta.url);
const { getConnection, parseItems } = require("mikronode-ng");

function pick(v, ...keys) {
  for (const k of keys) {
    if (v && v[k] !== undefined && v[k] !== null && String(v[k]).length) return v[k];
  }
  return undefined;
}

function normalizeMik(mik) {
  const host =
    pick(mik, "host", "ip", "publicIp", "mikrotikIp", "address") ||
    pick(mik?.mikrotik, "host", "ip", "publicIp");

  const user =
    pick(mik, "user", "apiUser", "username") ||
    pick(mik?.mikrotik, "apiUser", "user", "username");

  const password =
    pick(mik, "pass", "password", "apiPassword") ||
    pick(mik?.mikrotik, "apiPassword", "password", "pass");

  const portRaw =
    pick(mik, "port", "apiPort") ||
    pick(mik?.mikrotik, "apiPort", "port");

  const port = portRaw ? Number(portRaw) : 8728;

  if (!host || !user || !password) {
    throw new Error(`mikrotik config inválida: host/user/password obrigatórios (host=${host}, user=${user})`);
  }
  return { host, user, password, port };
}

function normalizeResult(raw) {
  // mikronode-ng costuma retornar "sentences" (array) ou objeto com "data"
  // A gente tenta parsear itens quando fizer sentido.
  try {
    if (Array.isArray(raw)) {
      // tenta parseItems por compat
      return parseItems(raw);
    }
    if (raw && Array.isArray(raw.data)) return raw.data;
    return raw;
  } catch (e) {
    return raw;
  }
}

export async function runMikrotikCommands(mik, sentences) {
  const cmds = Array.isArray(sentences) ? sentences : (typeof sentences === "string" ? [sentences] : []);
  if (!cmds.length) return { ok: true, results: [] };

  const { host, user, password, port } = normalizeMik(mik);

  let conn = null;
  let chan = null;

  try {
    // getConnection(host, user, pass, options) -> Promise<Connection>
    conn = await getConnection(host, user, password, {
      port,
      timeout: Number(process.env.MIKROTIK_TIMEOUT_MS || 8000),
    });

    chan = conn.openChannel();

    const results = [];
    for (const cmd of cmds) {
      const c = String(cmd || "").trim();
      if (!c) continue;

      // chan.write costuma retornar Promise
      // Em alguns builds ele resolve em "sentences"; em outros, objeto com data.
      // Vamos só capturar e normalizar.
      // eslint-disable-next-line no-await-in-loop
      const raw = await chan.write(c);
      results.push({ cmd: c, raw, data: normalizeResult(raw) });
    }

    try { chan.close && chan.close(); } catch (_) {}
    try { conn.close && conn.close(); } catch (_) {}

    return { ok: true, results };
  } catch (e) {
    logger.error("mikrotik.run_commands.error", {
      host,
      port,
      code: e?.code,
      message: e?.message || String(e),
    });

    try { chan && chan.close && chan.close(); } catch (_) {}
    try { conn && conn.close && conn.close(); } catch (_) {}

    return {
      ok: false,
      error: { code: "MIKROTIK_ERROR", message: e?.message || String(e) },
    };
  }
}

export default { runMikrotikCommands };
