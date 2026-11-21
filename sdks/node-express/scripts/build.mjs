// Construye un paquete AUTOCONTENIDO (Fase 9): instalable fuera del monorepositorio con `npm pack`.
//  - dist/index.js: un solo módulo ESM con @licenroute/policy-contracts (interno, no publicado) incrustado.
//    Solo depende de paquetes públicos de npm (typebox, declarado en dependencies) y de Node.
//  - dist/*.d.ts: tipos del SDK; los de policy-contracts se copian en dist/contracts/ y se reescriben
//    las importaciones, para que un proyecto TypeScript externo los resuelva sin el monorepositorio.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(dist, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  conditions: ["source"], // en el monorepositorio, @licenroute/policy-contracts se resuelve a su código fuente
  external: ["typebox"],
  legalComments: "none",
  logLevel: "warning",
});

const tsc = join(root, "../../node_modules/typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json"), "--emitDeclarationOnly"], { stdio: "inherit" });
execFileSync(process.execPath, [tsc, "-p", join(root, "../../packages/policy-contracts/tsconfig.build.json"), "--emitDeclarationOnly", "--outDir", join(dist, "contracts")], { stdio: "inherit" });

// Las declaraciones del SDK apuntan al paquete interno: se redirigen a la copia de dist/contracts.
for (const file of readdirSync(dist)) {
  const path = join(dist, file);
  if (!statSync(path).isFile() || !file.endsWith(".d.ts")) continue;
  const text = readFileSync(path, "utf8").replaceAll('"@licenroute/policy-contracts"', '"./contracts/index.js"');
  writeFileSync(path, text);
}
const leftovers = readdirSync(dist, { recursive: true }).filter((f) => String(f).endsWith(".js") || String(f).endsWith(".d.ts"))
  .filter((f) => readFileSync(join(dist, String(f)), "utf8").includes("@licenroute/"));
if (leftovers.length) throw new Error(`referencias al monorepositorio en dist: ${leftovers.join(", ")}`);
