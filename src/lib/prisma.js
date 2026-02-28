import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis;

function getDatabaseUrl() {
  return process.env.RELAY_DATABASE_URL || process.env.DATABASE_URL || "";
}

function createPrismaClient() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL/RELAY_DATABASE_URL not configured");
  }
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });
}

export function getPrisma() {
  if (!globalForPrisma.__relayPrisma) {
    globalForPrisma.__relayPrisma = createPrismaClient();
  }
  return globalForPrisma.__relayPrisma;
}

const prisma = new Proxy(
  {},
  {
    get(_target, prop) {
      const client = getPrisma();
      return client[prop];
    }
  }
);

export { prisma };
export default prisma;
