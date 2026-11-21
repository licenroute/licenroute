import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Solo para las pruebas de S10.1 con el simulador y el SDK reales; la CLI no los importa.
  resolve: {
    alias: {
      "@licenroute/policy-contracts": fileURLToPath(new URL("../policy-contracts/src/index.ts", import.meta.url)),
      "@licenroute/connect-express": fileURLToPath(new URL("../../sdks/node-express/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Cada caso lanza la CLI real (procesos con el modelo de permisos de Node).
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // D4.4: las pruebas históricas comprueban los textos en español; test/i18n.test.ts cubre los dos idiomas.
    env: { LICENROUTE_LANG: "es" },
    setupFiles: ["test/support/lang-setup.ts"],
  },
});
