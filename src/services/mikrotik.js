// src/services/mikrotik.js
// Executor Mikrotik: único lugar que toca o roteador.
// Import dinâmico de `mikronode-ng` para permitir DRY_RUN sem precisar da dependência.
import { normalizeMikrotikError } from './errors/normalizeMikrotikError.js';

function isDryRun() {
  return process.env.RELAY_DRY_RUN === "1" || process.env.RELAY_DRY_RUN === "true";
}

async function makeRouter(mikConfig) {
  // Import dinâmico para evitar erro quando pacote não estiver instalado
  const pkg = await import("mikronode-ng");
  const mod = pkg.default || pkg;
  const { Router } = mod;
  return new Router({
    host: mikConfig.host,
    user: mikConfig.user,
    password: mikConfig.pass,
    port: mikConfig.port || 8728,
    timeout: mikConfig.timeoutMs || 8000
  });
}

export async function runMikrotikCommands(mikConfig, commands = []) {
  const { host } = mikConfig;

  const result = {
    ok: true,
    host,
    commands,
    dryRun: !!isDryRun(),
    errors: []
  };

  // Validate and bound commands to avoid potential DoS via untrusted length
  if (!Array.isArray(commands)) {
    result.ok = false;
    result.errors.push({
      cmd: "VALIDATION",
      message: "Invalid commands payload: expected an array"
    });
    return result;
  }

  const MAX_COMMANDS = 1000;
  if (commands.length > MAX_COMMANDS) {
    result.ok = false;
    result.errors.push({
      cmd: "VALIDATION",
      message: `Too many commands: received ${commands.length}, maximum allowed is ${MAX_COMMANDS}`
    });
    return result;
  }

  if (isDryRun()) {
    console.log(`[relay-mikrotik][DRY_RUN] ${host} > ${commands.length} command(s)`);
    return result;
  }

  let conn;
  try {
    conn = await makeRouter(mikConfig);
  } catch (err) {
    const normalized = normalizeMikrotikError(err);
    result.ok = false;
    result.errors.push({ cmd: "CONNECTION_SETUP", message: normalized.message, code: normalized.code });
    console.error("[relay-mikrotik] failed to setup connection", host, normalized.message);
    throw normalized;
  }

  try {
    const connection = await conn.connect();
    const chan = connection.openChannel("relay-batch");

    for (let idx = 0; idx < commands.length; idx += 1) {
      const cmd = commands[idx];
      try {
        console.log(`[relay-mikrotik] ${host} > command #${idx + 1}`);
        await chan.write(cmd);
      } catch (err) {
        const normalized = normalizeMikrotikError(err);
        console.error(`[relay-mikrotik] ERRO cmd #${idx + 1}`, normalized.message);
        result.ok = false;
        result.errors.push({ cmd: `#${idx + 1}`, message: normalized.message, code: normalized.code });
      }
    }

    try {
      chan.close();
    } catch (e) {
      // ignore
    }
    try {
      connection.close();
    } catch (e) {
      // ignore
    }
  } catch (err) {
    const normalized = normalizeMikrotikError(err);
    console.error("[relay-mikrotik] Erro de execução", host, normalized.message);
    result.ok = false;
    result.errors.push({ cmd: "EXEC", message: normalized.message, code: normalized.code });
    throw normalized;
  }

  return result;
}
