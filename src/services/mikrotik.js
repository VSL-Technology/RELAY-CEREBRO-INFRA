// src/services/mikrotik.js
// Executor Mikrotik: único lugar que toca o roteador.
// Import dinâmico de `mikronode-ng` para permitir DRY_RUN sem precisar da dependência.
import { normalizeMikrotikError } from './errors/normalizeMikrotikError.js';
import logger from './logger.js';

const DEBUG_MIKROTIK = process.env.DEBUG_MIKROTIK === '1' || process.env.DEBUG_MIKROTIK === 'true';

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
    if (DEBUG_MIKROTIK) logger.debug('relay.mikrotik.dry_run', { commands: commands.length, host });
    return result;
  }

  let conn;
  try {
    conn = await makeRouter(mikConfig);
  } catch (err) {
    const normalized = normalizeMikrotikError(err);
    result.ok = false;
    result.errors.push({ cmd: "CONNECTION_SETUP", message: normalized.message, code: normalized.code });
    logger.error('relay.mikrotik.connection_setup_error', { code: normalized.code, message: normalized.message, host });
    throw normalized;
  }

  try {
    const connection = await conn.connect();
    const chan = connection.openChannel("relay-batch");

    for (let idx = 0; idx < commands.length; idx += 1) {
      const cmd = commands[idx];
      try {
        if (DEBUG_MIKROTIK) logger.debug('relay.mikrotik.command', { index: idx + 1, host });
        await chan.write(cmd);
      } catch (err) {
        const normalized = normalizeMikrotikError(err);
        logger.error('relay.mikrotik.command_error', { index: idx + 1, code: normalized.code, message: normalized.message, host });
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
    logger.error('relay.mikrotik.execution_error', { code: normalized.code, message: normalized.message, host });
    result.ok = false;
    result.errors.push({ cmd: "EXEC", message: normalized.message, code: normalized.code });
    throw normalized;
  }

  return result;
}
