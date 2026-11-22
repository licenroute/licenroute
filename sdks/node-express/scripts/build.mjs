// Construye un paquete AUTOCONTENIDO (Fase 9): instalable fuera del monorepositorio con `npm pack`.
//  - dist/index.js (ESM, `import`) y dist/cjs/index.js (CommonJS, `require()`): un solo módulo cada uno, con
//    @licenroute/policy-contracts (interno) y typebox incrustados. Sin dependencias en tiempo de ejecución: typebox solo
//    se publica como ESM y, fuera, `require()` fallaría en Node anterior a 20.19 / 22.12 (0.8.1).
//  - dist/*.d.ts: tipos del SDK; los de policy-contracts se copian en dist/contracts/ y se reescriben
//    las importaciones, para que un proyecto TypeScript externo los resuelva sin el monorepositorio.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const common = {
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  conditions: ["source"], // en el monorepositorio, @licenroute/policy-contracts se resuelve a su código fuente
  legalComments: "none",
  logLevel: "warning",
};
await build({ ...common, outfile: join(dist, "index.js"), format: "esm" });
await build({ ...common, outfile: join(dist, "cjs", "index.js"), format: "cjs" });
// En dist/cjs/ los .js y .d.ts son CommonJS (sin esto heredarían "type": "module" del paquete).
writeFileSync(join(dist, "cjs", "package.json"), '{ "type": "commonjs" }\n');

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
// typebox va incrustado en los dos módulos: su licencia (MIT) viaja con el paquete.
mkdirSync(join(dist, "licenses"), { recursive: true });
cpSync(join(root, "../../node_modules/typebox/license"), join(dist, "licenses", "typebox-MIT.txt"));
// Las mismas declaraciones para quien usa require(): una copia en dist/cjs/ (el package.json de esa carpeta las marca CJS).
cpSync(join(dist, "contracts"), join(dist, "cjs", "contracts"), { recursive: true });
for (const file of readdirSync(dist)) if (file.endsWith(".d.ts")) cpSync(join(dist, file), join(dist, "cjs", file));
const leftovers = readdirSync(dist, { recursive: true }).filter((f) => String(f).endsWith(".js") || String(f).endsWith(".d.ts"))
  .filter((f) => readFileSync(join(dist, String(f)), "utf8").includes("@licenroute/"));
if (leftovers.length) throw new Error(`referencias al monorepositorio en dist: ${leftovers.join(", ")}`);
