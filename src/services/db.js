// Lazy Postgres pool for Railway. Optional: only initializes when RELAY_DATABASE_URL/DATABASE_URL is set.
import logger from "./logger.js";

let pool = null;

function getDbUrl() {
  return process.env.RELAY_DATABASE_URL || process.env.DATABASE_URL || null;
}

function buildConfig(url) {
  const sslEnv = (process.env.RELAY_DB_SSL || "true").toLowerCase();
  const ssl =
    sslEnv === "false" || sslEnv === "0"
      ? false
      : { rejectUnauthorized: false }; // Railway normalmente exige SSL; desabilite verificação se necessário
  return {
    connectionString: url,
    max: parseInt(process.env.RELAY_DB_POOL_SIZE || "5", 10),
    idleTimeoutMillis: parseInt(process.env.RELAY_DB_IDLE_MS || "30000", 10),
    ssl
  };
}

export async function getPool() {
  if (pool) return pool;
  const url = getDbUrl();
  if (!url) {
    throw new Error("RELAY_DATABASE_URL/DATABASE_URL not set");
  }
  const { Pool } = await import("pg");
  pool = new Pool(buildConfig(url));
  pool.on("error", (err) => {
    logger.error("db.pool_error", { message: err && err.message });
  });
  return pool;
}

export async function query(text, params = []) {
  const p = await getPool();
  return p.query(text, params);
}

export async function ping() {
  try {
    await query("SELECT 1");
    return { ok: true };
  } catch (e) {
    logger.error("db.ping_error", { message: e && e.message });
    return { ok: false, error: e && e.message };
  }
}

export default { getPool, query, ping };
