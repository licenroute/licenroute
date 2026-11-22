// Construye el tarball local de la CLI (S9.1; repositorio público, D4.2). No publica. El resultado queda en
// packages/cli/.pack/<ámbito>-cli-<versión>.tgz.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(cliRoot, "..", "..");
const packRoot = join(cliRoot, ".pack");
const stage = join(packRoot, "stage");
const pkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));

const FORBIDDEN = [
  "/Users/",
  "BOTGATE_HOME",
  "licenroute-internal-test-only",
  "packages/cli/test",
  "scripts/sandbox.sh",
  "insecure-ack",
  "REPO_ROOT",
];

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "dist"), { recursive: true });
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "licenses"), { recursive: true });

await build({
  entryPoints: [join(cliRoot, "src/main.ts")],
  outfile: join(stage, "dist/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  legalComments: "none",
  logLevel: "warning",
  define: { __LICENROUTE_DIST_BUILD__: "true" },
  plugins: [{
    name: "s91-aliases",
    setup(b) {
      b.onResolve({ filter: /sandbox-hint\.ts$/ }, () => ({ path: join(cliRoot, "src/sandbox-hint-dist.ts") }));
      b.onResolve({ filter: /insecure-ack\.mjs$/ }, () => ({ path: join(cliRoot, "src/insecure-disabled.ts") }));
    },
  }],
});

// S10.2-A: simulador del modo demo, empaquetado con la CLI (no es un paquete aparte). Solo policy-contracts.
await build({
  entryPoints: [join(repoRoot, "packages/simulator/src/main.ts")],
  outfile: join(stage, "dist/simulator.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  conditions: ["source"],
  legalComments: "none",
  logLevel: "warning",
});
cpSync(join(cliRoot, "scripts/simulator-launcher.mjs"), join(stage, "bin/licenroute-simulator.mjs"));
chmodSync(join(stage, "bin/licenroute-simulator.mjs"), 0o755);

cpSync(join(cliRoot, "scripts/dist-launcher.mjs"), join(stage, "bin/licenroute.mjs"));
chmodSync(join(stage, "bin/licenroute.mjs"), 0o755);
// S10.2-B: licenroute dev (lanzador) y lo que comparte con la CLI; Skill y reglas del perfil dev-preview (licenroute assistant).
for (const f of ["dev-command.mjs", "demo-common.mjs"]) cpSync(join(cliRoot, "bin", f), join(stage, "bin", f));
// D4.4: idiomas (en por defecto, es). Los usan el lanzador y dev-command; main.cjs los lleva dentro.
for (const f of ["i18n.mjs", "i18n/en.mjs", "i18n/es.mjs"]) cpSync(join(cliRoot, "bin", f), join(stage, "bin", f));
// Repositorio público: integrations/assistants/generated/ ya es el perfil public, con en/ y es/ (D4.4); `licenroute assistant`
// instala el del idioma elegido.
cpSync(join(repoRoot, "integrations/assistants/generated"), join(stage, "assistants"), { recursive: true });
cpSync(join(cliRoot, "schema"), join(stage, "schema"), { recursive: true });
// Licencias: la propia y las de lo que dist/ incrusta (TypeScript en main.cjs; typebox en main.cjs y simulator.cjs).
cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));
cpSync(join(repoRoot, "NOTICE"), join(stage, "NOTICE"));
cpSync(join(repoRoot, "node_modules/typescript/LICENSE.txt"), join(stage, "licenses/typescript-Apache-2.0.txt"));
cpSync(join(repoRoot, "node_modules/typescript/ThirdPartyNoticeText.txt"), join(stage, "licenses/typescript-ThirdPartyNoticeText.txt"));
cpSync(join(repoRoot, "node_modules/typebox/license"), join(stage, "licenses/typebox-MIT.txt"));

const readme = `# ${pkg.name} ${pkg.version} (built)

LicenRoute CLI, developer preview. It integrates LicenRoute into an Express API and tests it against a local simulator
with synthetic credentials. To charge for real routes, connect the app to the hosted pilot (https://app.licenroute.com);
payments there stay in Stripe test mode for now. Messages in English (default) or Spanish: \`--lang en|es\` or \`LICENROUTE_LANG\`; \`--json\`
output is always English.

Requires Node.js 22.13 or later. The TypeScript compiler is bundled in \`dist/main.cjs\` only to read (never run) the code of
the analysed app.

Install it in your project as a development dependency (scoped name only):

\`\`\`bash
npm install --save-dev --ignore-scripts ${pkg.name}
npm ls ${pkg.name}                               # must list the package you just installed
\`\`\`

Run it from the project where it is installed as a development dependency, never through \`npx licenroute\`: on npm the
unscoped name \`licenroute\` is not this package (anyone may publish under it), and \`npx\` downloads a missing package.

\`\`\`bash
./node_modules/.bin/licenroute init .            # plans + read-only preview; --write needs the challenge typed in YOUR terminal
./node_modules/.bin/licenroute dev . --start-app # local simulator (loopback only) + your app
./node_modules/.bin/licenroute test .            # SIMULATED PASS against the simulator, never a real verification
./node_modules/.bin/licenroute undo .            # exact revert of what init/apply wrote
\`\`\`

Source, license (Apache-2.0) and third-party notices: see LICENSE, NOTICE and licenses/.
`;
writeFileSync(join(stage, "README.md"), readme);

writeFileSync(join(stage, "package.json"), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: "LicenRoute CLI (developer preview): plan, approve, apply and undo licence keys and quotas for an Express API, with a human approval step; local simulator included.",
  license: "Apache-2.0",
  repository: { type: "git", url: "git+https://github.com/licenroute/licenroute.git", directory: "packages/cli" },
  homepage: "https://licenroute.com",
  bugs: { url: "https://github.com/licenroute/licenroute/issues" },
  author: "LicenRoute",
  keywords: ["express", "api", "license-keys", "quota", "middleware", "claude-code", "cursor"],
  type: "module",
  bin: { licenroute: "./bin/licenroute.mjs", "licenroute-simulator": "./bin/licenroute-simulator.mjs" },
  engines: { node: ">=22.13" },
  files: ["bin", "dist", "schema", "assistants", "README.md", "LICENSE", "NOTICE", "licenses"],
}, null, 2)}\n`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out); else out.push(path);
  }
  return out;
}

const files = walk(stage);
const allowed = /^(?:package\.json|README\.md|LICENSE|NOTICE|licenses\/(?:typescript-ThirdPartyNoticeText\.txt|typebox-MIT\.txt)|bin\/licenroute\.mjs|bin\/licenroute-simulator\.mjs|bin\/dev-command\.mjs|bin\/demo-common\.mjs|bin\/i18n\.mjs|bin\/i18n\/(?:en|es)\.mjs|dist\/main\.cjs|dist\/simulator\.cjs|licenses\/typescript-Apache-2\.0\.txt|schema\/(?!sandbox-)[a-z0-9.-]+\.json|assistants\/(?:en|es)\/(?:claude-code\/(?:settings\.licenroute\.json|\.claude\/hooks\/licenroute-guard\.mjs|\.claude\/skills\/licenroute\/(?:SKILL|reference\/[a-z-]+)\.md)|cursor\/\.cursor\/(?:hooks\.json|hooks\/licenroute-guard\.mjs|rules\/licenroute\.mdc|licenroute\/[a-z-]+\.md)))$/;
for (const path of files) {
  const rel = relative(stage, path);
  if (!allowed.test(rel)) throw new Error(`archivo fuera de la lista del paquete: ${rel}`);
  const text = readFileSync(path);
  if (text.includes(0)) throw new Error(`archivo binario no esperado: ${rel}`);
  const body = text.toString("utf8");
  for (const needle of FORBIDDEN) {
    const at = body.indexOf(needle);
    if (at !== -1) throw new Error(`${rel} contiene «${needle}» junto a ${JSON.stringify(body.slice(Math.max(0, at - 40), at + needle.length + 40))}`);
  }
}
const simulator = readFileSync(join(stage, "dist/simulator.cjs"), "utf8");
for (const needle of ["services/decision-api", "apps/admin-rails", 'require("pg")', 'require("ioredis")', "createHmac", "pepper"]) {
  if (simulator.includes(needle)) throw new Error(`el simulador empaquetado contiene «${needle}»: no puede llevar código de Central`);
}
const simLauncher = readFileSync(join(stage, "bin/licenroute-simulator.mjs"), "utf8");
if (!simLauncher.includes('"--permission"') || simLauncher.includes("--allow-child-process")) throw new Error("el lanzador del simulador debe usar el modelo de permisos y no permitir procesos hijos");
const launcher = readFileSync(join(stage, "bin/licenroute.mjs"), "utf8");
if (!launcher.includes('"--permission"')) throw new Error("el lanzador no activa el modelo de permisos");
// Repositorio público (L6): sin cliente del Sandbox privado. Ninguna orden concede procesos hijos y nada del paquete
// localiza, verifica ni lanza su controlador.
if (launcher.includes("--allow-child-process")) throw new Error("el lanzador no puede conceder procesos hijos");
if (launcher.includes("--allow-fs-write=") && !launcher.includes("--allow-fs-write=${t}")) throw new Error("la escritura no queda limitada a los destinos");
for (const rel of ["bin/licenroute.mjs", "dist/main.cjs"]) {
  const body = readFileSync(join(stage, rel), "utf8");
  for (const needle of ["sandbox-trust", "sandbox-locator", "sandbox-controller", "SANDBOX_API_PORT", "BOTGATE_SANDBOX_LOCATOR", "BOTGATE_SANDBOX_CONTROLLER", "BOTGATE_SANDBOX_STATE", "BOTGATE_SANDBOX_REFUSAL", "SANDBOX_ACTIVATION", "authorizePinned"]) {
    if (body.includes(needle)) throw new Error(`${rel} contiene «${needle}»: el cliente del Sandbox privado no viaja en este paquete`);
  }
}
// licenroute dev: el simulador y la app, siempre con el modelo de permisos y sin procesos hijos; la app sin escritura.
const dev = readFileSync(join(stage, "bin/dev-command.mjs"), "utf8");
if ((dev.match(/"--permission"/g) ?? []).length !== 2 || dev.includes("--allow-child-process") || dev.includes("shell: true") || /\bexec(?:Sync)?\(/.test(dev)) throw new Error("dev-command: simulador y app con --permission, sin procesos hijos ni shell");
if ((dev.match(/--allow-fs-write=/g) ?? []).length !== 3) throw new Error("dev-command: solo el simulador escribe, y solo .env.licenroute y .licenroute/");

const tgz = join(packRoot, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
rmSync(tgz, { force: true });
execFileSync("npm", ["pack", "--pack-destination", packRoot], { cwd: stage, stdio: "inherit" });
const packed = join(packRoot, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
if (packed !== tgz) throw new Error(`nombre de tarball inesperado: ${packed}`);
process.stdout.write(`tarball ${tgz}\n`);
