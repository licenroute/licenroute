import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@licenroute/policy-contracts": fileURLToPath(new URL("../../packages/policy-contracts/src/index.ts", import.meta.url)) },
  },
  // D4.4: las pruebas históricas comprueban los mensajes en español; test/messages.test.ts cubre los dos idiomas.
  test: { include: ["test/**/*.test.ts"], env: { LICENROUTE_LANG: "es" } },
});
