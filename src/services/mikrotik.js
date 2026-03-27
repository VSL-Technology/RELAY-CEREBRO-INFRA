// src/services/mikrotik.js
// MikroTik API wrapper using direct TCP socket implementation

import logger from "./logger.js";
import { runCommands } from "./mikrotikApi.js";

const DEFAULT_TIMEOUT_MS = Number(process.env.MIKROTIK_TIMEOUT_MS || 8000);

function normalizeMikConfig(mik) {
  const host = mik.host || mik.ip;
  const user = mik.user || mik.username;
  const pass = mik.pass || mik.password;
  const port = Number(mik.port || 8728);

  if (!host || !user || !pass) {
    throw new Error(`mikrotik config invalida: host/user/pass obrigatorios (host=${host})`);
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
    return sentence.map(s => String(s ?? "").trim()).filter(Boolean);
  }
  const s = String(sentence ?? "").trim();
  return s ? [s] : null;
}

export async function runMikrotikCommands(mik, sentences) {
  const commands = normalizeSentences(sentences)
    .map(normalizeCommand)
    .filter(Boolean);

  if (commands.length === 0) {
    return { ok: true, results: [] };
  }

  try {
    const cfg = normalizeMikConfig(mik);
    const result = await runCommands(cfg.host, cfg.port, cfg.user, cfg.pass, commands, DEFAULT_TIMEOUT_MS);

    const results = result.results.map(r => ({
      cmd: r.cmd,
      ok: r.ok,
      data: r.data,
      error: r.error
    }));

    const hasErrors = results.some(r => !r.ok);

    return { ok: !hasErrors, results };
  } catch (err) {
    logger.error("mikrotik.run_commands.error", {
      message: err.message
    });
    return {
      ok: false,
      results: commands.map(cmd => ({
        cmd: Array.isArray(cmd) ? cmd.join(" ") : cmd,
        ok: false,
        error: err.message,
        code: "MIKROTIK_CONNECTION_ERROR"
      }))
    };
  }
}
