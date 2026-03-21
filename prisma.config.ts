import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  experimental: {
    externalTables: true,
  },
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
  migrations: {
    initShadowDb: 'CREATE SCHEMA IF NOT EXISTS "relay";',
  },
});
