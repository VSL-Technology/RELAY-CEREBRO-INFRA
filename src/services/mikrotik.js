// src/services/mikrotik.js
// MikroTik API wrapper (Node 20 + ESM) usando mikronode-ng.

import { createRequire } from "module";
import logger from "./logger.js";

const require = createRequire(import.meta.url);
const { getConnection, parseItems } = require("mikronode-ng");

const DEFAULT_TIMEOUT_MS = Number(process.env.MIKROTIK_TIMEOUT_MS || 8000);

function pick(value, ...keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined && value[key] !== null && String(value[key]).length > 0) {
      return value[key];
    }
  }
  return undefined;
}

function normalizeMikConfig(mik) {
  const host =
    pick(mik, "host", "ip", "publicIp", "mikrotikIp", "address") ||
    pick(mik?.mikrotik, "host", "ip", "publicIp", "address");

  const user =
    pick(mik, "user", "apiUser", "username") ||
    pick(mik?.mikrotik, "user", "apiUser", "username");

  const pass =
    pick(mik, "pass", "password", "apiPassword") ||
    pick(mik?.mikrotik, "pass", "password", "apiPassword");

  const portRaw =
    pick(mik, "port", "apiPort") ||
    pick(mik?.mikrotik, "port", "apiPort");

  const port = portRaw ? Number(portRaw) : 8728;

  if (!host || !user || !pass) {
    throw new Error(`mikrotik config inválida: host/user/pass obrigatórios (host=${host}, user=${user})`);
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`mikrotik config inválida: port inválida (${portRaw})`);
  }

  return { host, user, pass, port };
}

function normalizeSentences(sentences) {
  if (Array.isArray(sentences)) return sentences;
  if (typeof sentences === "string") return [sentences];
  return [];
}

function normalizeCommand(sentence) {
  if (Array.isArray(sentence)) {
    const parts = sentence.map((item) => String(item ?? "").trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  const normalized = String(sentence ?? "").trim();
  return normalized || null;
}

function normalizeReplyData(rawReply) {
  try {
    if (Array.isArray(rawReply)) {
      return parseItems(rawReply);
    }
    if (rawReply && Array.isArray(rawReply.data)) {
      return rawReply.data;
    }
    return rawReply;
  } catch {
    return rawReply;
  }
}

function findReplyTrap(rawReply) {
  const rows = Array.isArray(rawReply) ? rawReply : [rawReply];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const type = String(pick(row, "type", "sentenceType", "event") || "").toLowerCase();
    const firstSentenceToken = Array.isArray(row.sentence)
      ? String(row.sentence[0] || "").toLowerCase()
      : "";

    const isTrap =
      type.includes("trap") ||
      type.includes("fatal") ||
      firstSentenceToken === "!trap" ||
      firstSentenceToken === "!fatal";

    if (!isTrap) continue;

    const trapMessage =
      pick(row, "message", "msg", "error", "=message") ||
      pick(row?.data, "message", "msg", "error", "=message") ||
      "RouterOS returned trap";

    return {
      code: type.includes("fatal") || firstSentenceToken === "!fatal"
        ? "MIKROTIK_FATAL"
        : "MIKROTIK_TRAP",
      error: String(trapMessage)
    };
  }

  return null;
}

function normalizeError(error, fallbackCode) {
  const code = error && error.code ? String(error.code) : fallbackCode;
  const message = error && error.message ? String(error.message) : String(error || "unknown error");
  return { code, error: message };
}

async function safeClose(resource, label, host, port) {
  if (!resource) return;

  const closeMethod = typeof resource.close === "function"
    ? "close"
    : typeof resource.end === "function"
      ? "end"
      : null;

  if (!closeMethod) return;

  if (label === "channel" && resource.closed) return;

  try {
    if (closeMethod === "close") {
      if (label === "connection") {
        await Promise.resolve(resource.close(true));
        return;
      }

      await Promise.resolve(resource.close());
      return;
    }

    await Promise.resolve(resource.end());
  } catch (closeError) {
    logger.warn("mikrotik.close_error", {
      label,
      host,
      port,
      message: closeError && closeError.message ? closeError.message : String(closeError)
    });
  }
}

export async function runMikrotikCommands(mik, sentences) {
  const commands = normalizeSentences(sentences)
    .map((sentence) => normalizeCommand(sentence))
    .filter(Boolean);

  if (commands.length === 0) {
    return { ok: true, results: [] };
  }

  let host = null;
  let port = null;
  let connection = null;
  let channel = null;

  const results = [];
  let hasErrors = false;

  try {
    const cfg = normalizeMikConfig(mik);
    host = cfg.host;
    port = cfg.port;

    connection = await getConnection(cfg.host, cfg.user, cfg.pass, {
      port: cfg.port,
      timeout: DEFAULT_TIMEOUT_MS,
      closeOnDone: true
    });

    channel = connection.openChannel();

    for (const cmd of commands) {
      const cmdLabel = Array.isArray(cmd) ? cmd.join(" ") : cmd;
      try {
        // eslint-disable-next-line no-await-in-loop
        const reply = await channel.write(cmd);
        const trap = findReplyTrap(reply);

        if (trap) {
          hasErrors = true;
          results.push({ cmd: cmdLabel, ok: false, error: trap.error, code: trap.code });
          continue;
        }

        results.push({
          cmd: cmdLabel,
          ok: true,
          reply,
          data: normalizeReplyData(reply)
        });
      } catch (commandError) {
        hasErrors = true;
        const normalized = normalizeError(commandError, "MIKROTIK_COMMAND_ERROR");
        results.push({
          cmd: cmdLabel,
          ok: false,
          error: normalized.error,
          code: normalized.code
        });
      }
    }

    return {
      ok: !hasErrors,
      results
    };
  } catch (connectionError) {
    const normalized = normalizeError(connectionError, "MIKROTIK_CONNECTION_ERROR");

    logger.error("mikrotik.run_commands.error", {
      host,
      port,
      code: normalized.code,
      message: normalized.error
    });

    const errorResults = commands.map((cmd) => ({
      cmd: Array.isArray(cmd) ? cmd.join(" ") : cmd,
      ok: false,
      error: normalized.error,
      code: normalized.code
    }));

    return {
      ok: false,
      results: errorResults,
      error: {
        code: normalized.code,
        message: normalized.error
      }
    };
  } finally {
    await safeClose(channel, "channel", host, port);
    if (!channel) {
      await safeClose(connection, "connection", host, port);
    }
  }
}

export default { runMikrotikCommands };
