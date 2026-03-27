#!/usr/bin/env node

/**
 * test-imports.js
 * Validação rápida: todos os imports funcionam corretamente
 * Uso: node scripts/test-imports.js
 */

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testImports() {
  console.log("🔍 Validando imports...\n");

  const tests = [
    {
      name: "sessionStore",
      path: "../src/services/sessionStore.js",
      expectedIntegrations: [
        "createSession",
        "getSession",
        "updateSession",
        "findByIp",
        "findByMac",
        "findByPedidoId",
        "deleteSession",
        "listSessions",
        "getOrCreateSession",
        "authorizeSession",
        "revokeSession"
      ]
    },
    {
      name: "sessionRoutes",
      path: "../src/routes/sessionRoutes.js",
      expectedIntegrations: ["default"] // Express router
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const module = await import(test.path);
      const exportedNames = Object.keys(module);

      // Validar exports esperados
      const hasAll = test.expectedIntegrations.every((name) => {
        if (name === "default") return "default" in module;
        return name in module;
      });

      if (hasAll) {
        console.log(`✅ ${test.name}: ${exportedNames.join(", ")}`);
        passed += 1;
      } else {
        const missing = test.expectedIntegrations.filter((name) => {
          if (name === "default") return !("default" in module);
          return !(name in module);
        });
        console.log(`❌ ${test.name}: FALTAM ${missing.join(", ")}`);
        failed += 1;
      }
    } catch (error) {
      console.log(`❌ ${test.name}: ${error.message}`);
      failed += 1;
    }
  }

  console.log(`\n📊 Resultado: ${passed} passaram, ${failed} falharam`);
  process.exit(failed > 0 ? 1 : 0);
}

testImports().catch((error) => {
  console.error("❌ Erro fatal:", error.message);
  process.exit(1);
});
