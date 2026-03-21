import dotenv from "dotenv";

function bootInfo(msg) {
  console.log(`[boot] ${msg}`);
}

function bootError(msg) {
  console.error(`[boot] ${msg}`);
}

function maskDatabaseUrl(raw) {
  if (!raw) return "<empty>";
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname || "<host>";
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathname = parsed.pathname || "";
    return `${parsed.protocol}//${host}${port}${pathname}`;
  } catch (_) {
    return "<invalid>";
  }
}

function requiredJsonKeys(envName) {
  const keyEnv = `${envName}_REQUIRED_KEYS`;
  const raw = process.env[keyEnv] || "";
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function parseOptionalJsonEnv(envName) {
  const raw = process.env[envName];
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${envName} must be a JSON object`);
    }

    const requiredKeys = requiredJsonKeys(envName);
    for (const key of requiredKeys) {
      if (!(key in parsed)) {
        throw new Error(`${envName} missing key: ${key}`);
      }
    }

    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bootError(`env json invalid: ${message}`);
    process.exit(1);
  }
}

// Only load .env in development — in production, env vars come from container/deployment
if (process.env.NODE_ENV !== "production") {
  const dotenvResult = dotenv.config({ quiet: true });
  if (dotenvResult.error && process.env.NODE_ENV === "development") {
    // In development, .env is optional but log if missing
    bootInfo("dotenv: .env file not found (ok in production)");
  } else if (dotenvResult.error) {
    bootError("dotenv failed");
    process.exit(1);
  } else {
    bootInfo("dotenv ok");
  }
} else {
  bootInfo("dotenv: skipped in production (using env vars)");
}

const requiredEnv = [
  "DATABASE_URL",
  "RELAY_API_SECRET",
  "WG_PRIVATE_KEY",
  "WG_INTERFACE",
  "NODE_ENV"
];

// Diagnóstico profissional: mostra qual variável falta e como debugar
const missing = requiredEnv.filter(key => !String(process.env[key] || "").trim());
if (missing.length > 0) {
  bootError(`missing required env: ${missing.join(", ")}`);
  bootError(`\n⚠️  DIAGNÓSTICO:`);
  bootError(`   1. Verifique se .env existe no diretório: ls -la .env`);
  bootError(`   2. Verifique se docker carregou as vars: docker exec relay-real printenv | grep -E "${missing.join("|")}"`);
  bootError(`   3. Variáveis esperadas mas vazias:${missing.map(k => `\n      - ${k} = "${process.env[k] || "<vazio>"}"`).join("")}`);
  bootError(`\n   Solução: edite .env com valores não-vazios e rode: docker-compose restart relay\n`);
  process.exit(1);
}

bootInfo("env ok");
bootInfo(`DATABASE_URL: ${maskDatabaseUrl(process.env.DATABASE_URL)}`);

// Backward compatibility for modules that still read HMAC_SECRET.
process.env.HMAC_SECRET = process.env.RELAY_API_SECRET;

const relayEnvJson = parseOptionalJsonEnv("RELAY_ENV_JSON");
const appEnvJson = parseOptionalJsonEnv("APP_ENV_JSON");
if (relayEnvJson || appEnvJson) {
  bootInfo("env json ok");
}
