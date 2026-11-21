import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@licenroute/policy-contracts": fileURLToPath(new URL("../policy-contracts/src/index.ts", import.meta.url)),
      "@licenroute/connect-express": fileURLToPath(new URL("../../sdks/node-express/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, env: { LICENROUTE_LANG: "es" }, setupFiles: ["test/support/lang-setup.ts"] },
});
