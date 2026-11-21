// Regenera schema/*.v1.json a partir de src/schema.ts (herramienta de desarrollo; la CLI nunca escribe archivos).
// Uso: npm run schema -w @licenroute/cli
import { writeFileSync } from "node:fs";
import { DetectResult, Plan } from "../src/schema.ts";

const out = (name: string, schema: unknown) =>
  writeFileSync(new URL(`../schema/${name}.v1.json`, import.meta.url), `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: `urn:licenroute:cli:${name}:v1`, ...(schema as object) }, null, 2)}\n`);
out("detect", DetectResult);
out("plan", Plan);
