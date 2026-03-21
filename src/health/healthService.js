// /health/live is liveness probe; /health/ready is readiness probe.
import { execSync } from "child_process";
import { getPrisma } from "../lib/prisma.js";

async function checkDatabase() {
  try {
    const prisma = getPrisma();
    await prisma.$queryRaw`SELECT 1`;
    return "connected";
  } catch (_) {
    return "error";
  }
}

function checkWireguardInterface() {
  const iface = process.env.WG_INTERFACE;
  if (!iface) return "missing_interface";

  try {
    execSync(`wg show ${iface}`, { stdio: "ignore" });
    return "interface_ok";
  } catch (_) {
    return "missing_interface";
  }
}

function checkHmac() {
  return process.env.HMAC_SECRET ? "loaded" : "missing";
}

export async function runHealthCheck() {
  const uptime = Number(process.uptime().toFixed(3));
  const [database, wireguard] = await Promise.all([
    checkDatabase(),
    Promise.resolve(checkWireguardInterface())
  ]);
  const hmac = checkHmac();
  const env = "valid";

  const status =
    database === "connected" &&
    wireguard === "interface_ok" &&
    hmac === "loaded"
      ? "ok"
      : "degraded";

  return {
    status,
    uptime,
    database,
    wireguard,
    hmac,
    env
  };
}

export default {
  runHealthCheck
};
