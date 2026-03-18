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

const dotenvResult = dotenv.config({ quiet: true });
if (dotenvResult.error) {
  bootError("dotenv failed");
  process.exit(1);
}
bootInfo("dotenv ok");

const requiredEnv = [
  "DATABASE_URL",
  "RELAY_API_SECRET",
  "WG_PRIVATE_KEY",
  "WG_INTERFACE",
  "NODE_ENV"
];

for (const key of requiredEnv) {
  if (!String(process.env[key] || "").trim()) {
    bootError(`missing env: ${key}`);
    process.exit(1);
  }
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
