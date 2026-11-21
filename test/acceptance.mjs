// End-to-end acceptance of the packages built from this repository (derived from the Dev Preview kit acceptance,
// S10.2-B, with a second app for existing authentication and HTTP methods, F-D4-1). Like an external developer: an
// independent Express app, Docker removed from PATH, the CLI and SDK from dist-packages/, approval challenges typed in
// a real pseudo-terminal as a person would. Demo credentials only.
//   node test/acceptance.mjs <dist-packages> [--lang en|es]
// D4.4: the run uses one language for every human message (default en). Checks on human text use that language's
// phrase (written here, not read from the CLI catalogs); --json, check ids, codes and approvals must not depend on it.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ptyScript, sha256Tool } from "./platform.mjs";

const [distArg] = process.argv.slice(2);
const langAt = process.argv.indexOf("--lang"); const LANG = langAt > 0 ? process.argv[langAt + 1] : "en";
if (!distArg || !["en", "es"].includes(LANG)) { process.stderr.write("usage: acceptance.mjs <dist-packages> [--lang en|es]\n"); process.exit(2); }
const PHRASES = {
  en: { unsupported: /is not supported in this LicenRoute distribution/, decision: /Need your decision/, previewOf: /Preview of api-catalogo, api-informes/, nothingWritten: /Nothing was written/,
    diffChanged: /the diff has changed/, applied: /applied/, noConsent: /--consent does not exist/, noScript: /no package\.json script is used/, demo: /DEMO MODE · LOCAL SIMULATION/,
    methodsOnly: /licence only on GET, HEAD/, confirmed: /Approval confirmed\./, notConfirmed: /Not confirmed/, falseDep: /no longer declares it|Sandbox/, declared: /still declares @licenroute\/connect-express/,
    skill: /Language of these instructions: \*\*English \(en\)\*\*/ },
  es: { unsupported: /no está soportado en esta distribución/, decision: /Requieren tu decisión/, previewOf: /Vista previa de api-catalogo, api-informes/, nothingWritten: /Nada se ha escrito/,
    diffChanged: /el diff ha cambiado/, applied: /aplicado/, noConsent: /--consent no existe/, noScript: /no se usa ningún script de package\.json/, demo: /MODO DEMO · SIMULACIÓN LOCAL/,
    methodsOnly: /licencia solo en GET, HEAD/, confirmed: /Aprobación confirmada\./, notConfirmed: /No confirmado/, falseDep: /ya no lo declara|Sandbox/, declared: /sigue declarando @licenroute\/connect-express/,
    skill: /Idioma de estas instrucciones: \*\*español \(es\)\*\*/ },
};
const T = PHRASES[LANG];
// --samples <dir>: also saves the human output of init, the write, dev and test (for the docs). Never secrets: checked below.
const samplesAt = process.argv.indexOf("--samples"); const samples = samplesAt > 0 ? process.argv[samplesAt + 1] : null;
const sample = (name, text) => { if (samples) { mkdirSync(samples, { recursive: true }); writeFileSync(join(samples, `${LANG}-${name}.txt`), text); } };
const dist = realpathSync(distArg);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const iso = { wrap: (cmd, args) => [cmd, args] };
const fails = [];
const ok = (m) => process.stdout.write(`OK   ${m}\n`);
const ko = (m) => { fails.push(m); process.stdout.write(`FAIL ${m}\n`); };
const t0 = Date.now(); const secs = (from = t0) => `${((Date.now() - from) / 1000).toFixed(1)} s`;
const timings = {};

// No Docker: a stub named docker goes first on PATH and always fails. (Dropping every PATH entry that contains docker
// would also drop /usr/bin on Ubuntu, where apt installs docker next to git, sha256sum and script.)
const noDocker = realpathSync(mkdtempSync(join(tmpdir(), "licenroute-nodocker-")));
writeFileSync(join(noDocker, "docker"), "#!/bin/sh\necho 'docker is disabled in this test' >&2\nexit 127\n", { mode: 0o755 });
process.on("exit", () => rmSync(noDocker, { recursive: true, force: true }));
const PATH = [noDocker, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean)].join(delimiter);
const baseEnv = { ...process.env, PATH };
for (const k of Object.keys(baseEnv)) if (/^(?:LICENROUTE|BOTGATE)_/.test(k)) delete baseEnv[k]; // both prefixes, only in this copy
baseEnv.LICENROUTE_LANG = LANG;
for (const k of ["NODE_OPTIONS", "NODE_ENV"]) delete baseEnv[k];
const run = (cmd, args, opts = {}) => { const [c, a] = iso.wrap(cmd, args); return spawnSync(c, a, { encoding: "utf8", shell: false, timeout: opts.timeout ?? 300_000, cwd: opts.cwd, env: { ...baseEnv, ...(opts.env ?? {}) }, maxBuffer: 32 * 1024 * 1024, detached: true }); };
const procs = [];
const start = (cmd, args, opts = {}) => { const [c, a] = iso.wrap(cmd, args); const p = spawn(c, a, { cwd: opts.cwd, env: { ...baseEnv, ...(opts.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"], detached: true }); let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; }); procs.push(p); return { p, out: () => out, exit: new Promise((r) => p.on("close", r)) }; };
const until = async (fn, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => done(p)); }); });
const status = (url, headers = {}) => fetch(url, { headers }).then((r) => r.status).catch(() => null);
/** Orden con reto: se lee el reto del pseudoterminal y se teclea (answer) como lo haría la persona. */
const withTty = (cmd, args, answer = "challenge") => {
  const fifo = join(work, `tty-${procs.length}.fifo`); const outFile = join(work, `tty-${procs.length}.out`);
  spawnSync("mkfifo", [fifo]); writeFileSync(outFile, "");
  const fd = openSync(fifo, "r+");
  const [sh, shArgs] = ptyScript(); const [wc, wa] = iso.wrap(cmd, args);
  const p = spawn(sh, [...shArgs, wc, ...wa], { stdio: "ignore", env: { ...baseEnv, IN: fifo, OUT: outFile } });
  procs.push(p);
  let answered = false; let closed = false; const close = () => { if (!closed) { closed = true; try { closeSync(fd); } catch { /* cerrado */ } } };
  const out = () => readFileSync(outFile, "utf8");
  const tick = setInterval(() => { const t = out(); const m = /(?:type|escribe) ([A-Z0-9]{4}-[A-Z0-9]{4}) (?:and press Enter|y pulsa Intro)/.exec(t); if (m && !answered) { answered = true; writeSync(fd, `${answer === "challenge" ? m[1] : answer}\n`); } if (answered && /Aprobación confirmada\.|No confirmado|Approval confirmed\.|Not confirmed/.test(t)) { clearTimeout(guard); close(); } }, 100);
  // A regression that never shows (or never resolves) the challenge must fail, not hang: 120 s until the challenge is
  // resolved (a dev session keeps running after it).
  const guard = setTimeout(() => { close(); try { p.kill("SIGKILL"); } catch { /* ended */ } }, 120_000);
  const done = new Promise((r) => p.on("close", () => { clearInterval(tick); clearTimeout(guard); close(); r(out()); }));
  return { p, out, done };
};
const secretsIn = (text, secrets) => secrets.filter((s) => s && text.includes(s));

const work = realpathSync(mkdtempSync(join(tmpdir(), "licenroute-devprev-acc-")));
const cleanup = () => { for (const p of procs) { try { p.kill("SIGINT"); } catch { /* terminado */ } } };
process.on("exit", cleanup);
try {
  // 0. Integrity of the built packages and environment.
  const dockerProbe = run("docker", ["info"]);
  if (dockerProbe.status === 127 && /disabled in this test/.test(dockerProbe.stderr)) ok("no Docker: docker on the test PATH is a stub that always fails"); else ko(`docker is usable on the test PATH (${dockerProbe.status})`);
  const [shaCmd, shaArgs] = sha256Tool();
  const sums = run(shaCmd, [...shaArgs, "-c", "SHA256SUMS"], { cwd: dist });
  const tgz = readFileSync(join(dist, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.split(/\s+/)[1]);
  const cliTgz = join(dist, tgz.find((f) => /-cli-\d/.test(f))); const sdkTgz = join(dist, tgz.find((f) => /-connect-express-\d/.test(f)));
  if (sums.status === 0 && tgz.length === 2) ok(`packages intact (SHA256SUMS): ${tgz.join(", ")}`); else { ko(`SHA256SUMS: ${sums.stdout}${sums.stderr}`); throw new Error("integrity"); }

  // 1. Contenido de los paquetes.
  const list = (t) => spawnSync("tar", ["-tzf", t], { encoding: "utf8" }).stdout.trim().split("\n").sort();
  const cliFiles = list(cliTgz);
  const allowedCli = /^package\/(?:package\.json|README\.md|LICENSE|NOTICE|licenses\/(?:typescript-ThirdPartyNoticeText\.txt|typebox-MIT\.txt)|bin\/(?:licenroute|licenroute-simulator|dev-command|demo-common|i18n)\.mjs|bin\/i18n\/(?:en|es)\.mjs|dist\/(?:main|simulator)\.cjs|licenses\/typescript-Apache-2\.0\.txt|schema\/(?!sandbox-)[a-z0-9.-]+\.json|assistants\/(?:en|es)\/(?:claude-code|cursor)\/[A-Za-z0-9._/-]+)$/;
  const stray = cliFiles.filter((f) => !allowedCli.test(f));
  const cliPkg = JSON.parse(spawnSync("tar", ["-xOzf", cliTgz, "package/package.json"], { encoding: "utf8" }).stdout);
  const sdkPkg = JSON.parse(spawnSync("tar", ["-xOzf", sdkTgz, "package/package.json"], { encoding: "utf8" }).stdout);
  const sdkFiles = list(sdkTgz);
  const licensed = cliPkg.license === "Apache-2.0" && sdkPkg.license === "Apache-2.0" && ["package/LICENSE", "package/NOTICE", "package/licenses/typebox-MIT.txt", "package/licenses/typescript-Apache-2.0.txt"].every((f) => cliFiles.includes(f)) && ["package/LICENSE", "package/NOTICE"].every((f) => sdkFiles.includes(f));
  if (!stray.length && !cliPkg.dependencies && JSON.stringify(Object.keys(sdkPkg.dependencies ?? {})) === '["typebox"]' && cliFiles.includes("package/bin/dev-command.mjs") && cliFiles.some((f) => f.endsWith("SKILL.md")) && licensed && cliPkg.private === true && sdkPkg.private === true) ok(`packages: CLI ${cliPkg.version} with ${cliFiles.length} files, no dependencies (simulator, dev and Skill inside); SDK ${sdkPkg.version} depends only on typebox; Apache-2.0 with LICENSE, NOTICE and bundled third-party licences; both private (not publishable by accident)`);
  else ko(`packages: extra ${stray.join(", ") || "-"} · CLI deps ${JSON.stringify(cliPkg.dependencies)} · licences ${licensed} · private ${cliPkg.private}/${sdkPkg.private}`);

  // 1b. The Skill and Cursor rules inside the CLI package are byte-identical to integrations/assistants/generated/.
  {
    const genRoot = join(repoRoot, "integrations/assistants/generated");
    const walkGen = (d, base = d, acc = []) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walkGen(p, base, acc); else acc.push(p.slice(base.length + 1)); } return acc; };
    const gen = walkGen(genRoot).sort();
    const packed = cliFiles.filter((f) => f.startsWith("package/assistants/")).map((f) => f.slice("package/assistants/".length)).sort();
    const differ = gen.filter((f) => spawnSync("tar", ["-xOzf", cliTgz, `package/assistants/${f}`]).stdout?.toString("utf8") !== readFileSync(join(genRoot, f), "utf8"));
    if (JSON.stringify(gen) === JSON.stringify(packed) && !differ.length) ok(`assistants: the ${gen.length} Skill and Cursor rule files in the package are identical to integrations/assistants/generated/`);
    else ko(`assistants: repo ${gen.length} vs package ${packed.length} files; different: ${differ.join(", ") || "-"}`);
  }

  // 2. Instalación sin red en una app Express independiente. Un script de package.json «trampa» nunca debe ejecutarse.
  const app = join(work, "mi-api");
  cpSync(join(repoRoot, "examples/express-demo"), app, { recursive: true });
  const pkgPath = join(app, "package.json"); const appPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  appPkg.scripts = { start: "node -e \"require('fs').writeFileSync('PWNED-start','x')\"", dev: "node -e \"require('fs').writeFileSync('PWNED-dev','x')\"", postinstall: "node -e \"require('fs').writeFileSync('PWNED-postinstall','x')\"" };
  writeFileSync(pkgPath, `${JSON.stringify(appPkg, null, 2)}\n`);
  run("git", ["init", "-q"], { cwd: app }); run("git", ["add", "-A"], { cwd: app }); run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base", "--no-gpg-sign"], { cwd: app });
  const tInstall = Date.now();
  const i1 = run("npm", ["install", "--save-dev", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", cliTgz], { cwd: app });
  const i2 = run("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", sdkTgz], { cwd: app });
  timings.install = secs(tInstall);
  const licenroute = join(app, "node_modules/.bin/licenroute");
  if (i1.status === 0 && i2.status === 0 && existsSync(licenroute)) ok(`install: CLI (dev) and SDK from dist-packages/, express and typebox from the public registry or the npm cache, --ignore-scripts (${timings.install})`);
  else { ko(`npm install: ${(i1.stderr || i2.stderr).slice(-400)}`); throw new Error("instalación"); }
  // 2a. 0.2.8: the way the Skill runs LicenRoute. The local binary is the approved package and runs without asking the
  //     registry; without the package, `npm ls` fails (the Skill stops) without asking it either; and `npx licenroute` in a
  //     project without it asks the registry for the unscoped `licenroute` package (not this one) (why the Skill forbids it). The
  //     registry is a local server that answers 404 to everything: nothing is downloaded.
  {
    // Asynchronous runs: the registry is served by this same process (spawnSync would block it).
    const runAsync = (cmd, args, opts) => new Promise((done) => { const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...baseEnv, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; p.stdout.on("data", (d) => { stdout += d; }); p.stderr.on("data", () => {}); const kill = setTimeout(() => p.kill("SIGKILL"), 120_000); p.on("close", (status) => { clearTimeout(kill); done({ status, stdout }); }); });
    const hits = []; const reg = createServer((req, res) => { hits.push(req.url); res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); });
    await new Promise((done) => reg.listen(0, "127.0.0.1", done));
    const registryEnv = { npm_config_registry: `http://127.0.0.1:${reg.address().port}/`, npm_config_cache: join(work, "npx-cache"), npm_config_fetch_retries: "0", npm_config_update_notifier: "false" };
    const empty = join(work, "without-licenroute"); mkdirSync(empty); writeFileSync(join(empty, "package.json"), "{\"name\":\"without-licenroute\",\"version\":\"1.0.0\",\"private\":true}\n");
    const lsInstalled = await runAsync("npm", ["ls", "@licenroute/cli", "--depth=0"], { cwd: app, env: registryEnv });
    const version = await runAsync(licenroute, ["--version"], { cwd: app, env: registryEnv });
    const isOurs = realpathSync(licenroute) === realpathSync(join(app, "node_modules/@licenroute/cli/bin/licenroute.mjs"));
    const localHits = hits.length;
    const lsMissing = await runAsync("npm", ["ls", "@licenroute/cli", "--depth=0"], { cwd: empty, env: registryEnv });
    const missingHits = hits.length - localHits;
    const npx = await runAsync("npx", ["licenroute", "--version"], { cwd: empty, env: registryEnv });
    await new Promise((done) => reg.close(done));
    const npxAsked = hits.slice(localHits + missingHits).some((u) => /^\/licenroute(?:$|[?/])/.test(u));
    if (lsInstalled.status === 0 && /detect\/v1 plan\/v1/.test(version.stdout) && isOurs && localHits === 0 && lsMissing.status !== 0 && missingHits === 0 && npx.status !== 0 && npxAsked) ok("execution form of the Skill: ./node_modules/.bin/licenroute is the installed package and asks no registry; without it npm ls fails offline (the Skill stops); npx licenroute would fetch the third-party licenroute from the registry");
    else ko(`execution form: npm ls ${lsInstalled.status} · version ${/detect\/v1 plan\/v1/.test(version.stdout)} · ours ${isOurs} · registry hits local ${localHits} missing ${missingHits} · npm ls without it ${lsMissing.status} · npx ${npx.status} asked ${npxAsked} (${hits.join(" ")})`);
  }
  // 2b. R10: the public documentation and the demo never run npx, and every documented read-only command works as written
  //     from this clean install. The demo runs end to end with a trap `npx` first in PATH: if anything called npx, it fails.
  {
    const walkDocs = (d, acc = []) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walkDocs(p, acc); else if (e.name.endsWith(".md")) acc.push(p); } return acc; };
    const docFiles = [join(repoRoot, "README.md"), join(repoRoot, "SECURITY.md"), ...walkDocs(join(repoRoot, "docs")), join(repoRoot, "demo/demo.sh")];
    const PROHIBITION = /Never use `npx licenroute`|Nunca uses `npx licenroute`|`npx` downloads|`npx` descarga|never npx|npx would download/;
    const unsafe = []; const commands = new Set();
    for (const file of docFiles) {
      const rel = file.slice(repoRoot.length + 1);
      for (const [i, l] of readFileSync(file, "utf8").split("\n").entries()) {
        if ((/\bnpx\b/.test(l) && !PROHIBITION.test(l)) || /\bnpm exec\b/.test(l)) unsafe.push(`${rel}:${i + 1}`);
        for (const m of l.matchAll(/\.\/node_modules\/\.bin\/licenroute((?: [^\s`#|;&]+)+)/g)) commands.add(m[1].trim());
      }
    }
    // Read-only commands only: writes, the simulator, test and undo are run (with the challenge) by the steps below.
    const readOnly = [...commands].filter((c) => !/--write|--approve|--start-app|--stop|--status|…|<|^(?:dev|test|undo|doctor)\b/.test(c));
    const before = run("git", ["status", "--porcelain"], { cwd: app }).stdout;
    const failed = readOnly.filter((c) => run(licenroute, c.split(" "), { cwd: app }).status !== 0);
    const lsDoc = run("npm", ["ls", "@licenroute/cli"], { cwd: app });
    const untouched = run("git", ["status", "--porcelain"], { cwd: app }).stdout === before;
    if (!unsafe.length && readOnly.length >= 8 && !failed.length && lsDoc.status === 0 && untouched) ok(`documentation: no npx instruction in ${docFiles.length} files (README, SECURITY, docs en/es, demo); the ${readOnly.length} documented read-only commands run as written from a clean install and write nothing`);
    else ko(`documentation: npx in ${unsafe.join(", ") || "-"} · ${readOnly.length} read-only commands, failing: ${failed.join(" | ") || "-"} · npm ls ${lsDoc.status} · untouched ${untouched}`);
    const trap = join(work, "npx-trap"); mkdirSync(trap); const called = join(work, "npx-called");
    writeFileSync(join(trap, "npx"), `#!/bin/sh\necho "$@" >> "${called}"\nexit 97\n`, { mode: 0o755 });
    const demoTmp = join(work, "demo-tmp"); mkdirSync(demoTmp);
    const demo = run("bash", [join(repoRoot, "demo/demo.sh")], { cwd: repoRoot, env: { PATH: `${trap}${delimiter}${PATH}`, TMPDIR: demoTmp }, timeout: 600_000 });
    if (demo.status === 0 && /Nothing was written \(git diff is empty\)/.test(demo.stdout) && !existsSync(called)) ok("demo/demo.sh: runs end to end from the built packages with a trap npx first in PATH; npx is never called and nothing is written");
    else ko(`demo: exit ${demo.status} · npx called ${existsSync(called) ? readFileSync(called, "utf8").trim() : "no"} · ${(demo.stdout + demo.stderr).slice(-300)}`);
  }
  const snap = Object.fromEntries(["server.js", "package.json", ".gitignore"].map((f) => [f, readFileSync(join(app, f), "utf8")]));
  // 2b. No write without the challenge, from the installed package (D4.3, F-D4.3-1). Up to 0.2.3, running the write
  //     phase directly with --consent tty-challenge wrote without asking. detached: no controlling terminal.
  {
    const sha = JSON.parse(run(licenroute, ["plan", app, "--json"]).stdout || "{}").approval?.plan_sha256;
    const applyArgs = ["apply", app, "--plans", "api-informes", "--plan-sha", sha, "--app", "mi-api"];
    const apr = JSON.parse(run(licenroute, [...applyArgs, "--json"]).stdout || "{}").approval_code;
    const mainCjs = join(app, "node_modules/@licenroute/cli/dist/main.cjs");
    // A new session with no controlling terminal, like an agent without the person's terminal (spawnSync cannot detach).
    const detachedRun = (args) => new Promise((done) => {
      const p = spawn(process.execPath, args, { detached: true, stdio: ["ignore", "ignore", "pipe"], env: baseEnv });
      let stderr = ""; p.stderr.on("data", (d) => { stderr += d; }); p.on("close", (status) => done({ status, stderr }));
    });
    const forged = await detachedRun([mainCjs, ...applyArgs, "--approve", apr, "--phase", "write", "--consent", "tty-challenge"]);
    const direct = await detachedRun([mainCjs, ...applyArgs, "--approve", apr, "--phase", "write"]);
    const fakeTree = join(app, "node_modules/@licenroute/cli/test"); mkdirSync(fakeTree, { recursive: true }); writeFileSync(join(fakeTree, "apply.test.ts"), "// copied test tree\n");
    const insecure = run(licenroute, [...applyArgs, "--approve", apr], { env: { LICENROUTE_APPROVAL: "insecure-test", LICENROUTE_INSECURE_TEST: "licenroute-internal-test-only" } });
    rmSync(fakeTree, { recursive: true, force: true });
    const untouched = Object.entries(snap).every(([f, t]) => readFileSync(join(app, f), "utf8") === t) && !existsSync(join(app, ".licenroute/journal"));
    if (apr && forged.status === 2 && T.noConsent.test(forged.stderr) && direct.status === 5 && /terminal/.test(direct.stderr) && insecure.status === 5 && untouched) ok("unprotected write unreachable from the package: the write phase run directly (with or without --consent tty-challenge) and insecure-test with both variables and a copied test tree all refuse; nothing written");
    else ko(`unprotected write: code ${apr} · forged ${forged.status} · direct ${direct.status} · insecure ${insecure.status} · untouched ${untouched}`);
  }
  // 2c. Supported scope: Express 4 and 5 only. On a Rails app the installed CLI analyses read-only and refuses to write.
  {
    const rails = join(work, "rails-app"); cpSync(join(repoRoot, "packages/cli/test/fixtures/rails8"), rails, { recursive: true });
    const before = readFileSync(join(rails, "config/routes.rb"), "utf8");
    const plan = run(licenroute, ["plan", rails, "--json"]); const init = run(licenroute, ["init", rails]);
    const target = JSON.parse(plan.stdout || "{}").target;
    if (plan.status === 0 && target === "rails" && init.status !== 0 && T.unsupported.test(init.stdout + init.stderr) && !existsSync(join(rails, "config/initializers/botgate.rb")) && readFileSync(join(rails, "config/routes.rb"), "utf8") === before) ok("Rails out of scope: plan analyses it read-only; init refuses with a clear message and writes nothing");
    else ko(`rails: plan ${plan.status} ${target} · init ${init.status} ${(init.stdout + init.stderr).slice(-200)}`);
  }
  const tFlow = Date.now();

  // 3. init: lista, selección, vista previa, rechazos y escritura con el reto.
  const list1 = run(licenroute, ["init", app]);
  const listed = /\n\s+1\s+api-catalogo[\s\S]*\n\s+2\s+api-informes/.test(list1.stdout) && new RegExp(`${T.decision.source}[\\s\\S]*POST /api/pedidos`).test(list1.stdout);
  if (list1.status === 0 && listed) ok("init: planes numerados; POST /api/pedidos y / quedan para decisión manual"); else ko(`init: ${list1.stdout.slice(-400)}`);
  // 3b. D4.4: the language changes only the text. --json (detect, plan, init preview with its approval code) is byte-identical
  //     with LICENROUTE_LANG=en, LICENROUTE_LANG=es, --lang and the system locale; the human output is in the chosen language.
  {
    const variants = [{ env: { LICENROUTE_LANG: "en" } }, { env: { LICENROUTE_LANG: "es" } }, { args: ["--lang", "es"], env: { LICENROUTE_LANG: "en" } }, { env: { LICENROUTE_LANG: undefined, LANG: "es_ES.UTF-8", LC_ALL: undefined, LC_MESSAGES: undefined } }];
    const same = [["detect", app, "--json"], ["plan", app, "--json"], ["init", app, "--plans", "1,2", "--app", "mi-api", "--json"]].every((args) => new Set(variants.map((v) => run(licenroute, [...args, ...(v.args ?? [])], { env: v.env }).stdout)).size === 1);
    const human = ["en", "es"].map((l) => run(licenroute, ["init", app], { env: { LICENROUTE_LANG: l } }).stdout);
    const badLang = run(licenroute, ["init", app, "--lang", "fr"]);
    if (same && /Need your decision/.test(human[0]) && /Requieren tu decisión/.test(human[1]) && badLang.status === 2) ok("languages: --json and the approval code identical in en and es (env, --lang, locale); human output in the chosen language; --lang fr is a usage error");
    else ko(`languages: json identical ${same} · en ${/Need your decision/.test(human[0])} · es ${/Requieren tu decisión/.test(human[1])} · --lang fr ${badLang.status}`);
    // Changing the language never skips the challenge: the code from the other language's preview, without a terminal, writes nothing.
    const other = LANG === "en" ? "es" : "en";
    const otherCode = JSON.parse(run(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--json", "--lang", other]).stdout || "{}").preview?.approval_code;
    const noTtyOther = run(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--write", "--approve", otherCode ?? "apr_x", "--lang", other]);
    if (otherCode && noTtyOther.status === 5 && readFileSync(join(app, "server.js"), "utf8") === snap["server.js"]) ok(`languages: an approval prepared in ${other} still needs the challenge in a terminal (exit 5, nothing written)`);
    else ko(`languages/approval: ${noTtyOther.status}`);
  }
  const pre = run(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api"]);
  if (pre.status === 0 && T.previewOf.test(pre.stdout) && T.nothingWritten.test(pre.stdout) && readFileSync(join(app, "server.js"), "utf8") === snap["server.js"]) ok("init --plans 1,2: vista previa completa (diff), nada escrito"); else ko(`vista previa: ${pre.stdout.slice(-300)}`);
  const dangerous = run(licenroute, ["init", app, "--plans", "api-pedidos", "--app", "mi-api", "--write"]);
  const noTty = run(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--write"]);
  const insecure = run(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--write"], { env: { LICENROUTE_APPROVAL: "insecure-test", LICENROUTE_INSECURE_TEST: "licenroute-internal-test-only" } });
  if (dangerous.status === 5 && noTty.status === 5 && insecure.status === 5 && readFileSync(join(app, "server.js"), "utf8") === snap["server.js"]) ok("rechazos de init: ruta que requiere decisión, sin terminal e insecure-test (salida 5, nada escrito)"); else ko(`rechazos de init: ${dangerous.status} ${noTty.status} ${insecure.status}`);
  const denied = await withTty(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--write"], "NO-VALE").done;
  // 0.2.2: la escritura lleva el código del diff de la vista previa; uno de otro diff no escribe.
  const code = JSON.parse(run(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--json"]).stdout || "{}").preview?.approval_code;
  const staleCode = run(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--write", "--approve", "apr_0123456789abcdef0123"]);
  if (staleCode.status === 5 && T.diffChanged.test(staleCode.stdout + staleCode.stderr) && readFileSync(join(app, "server.js"), "utf8") === snap["server.js"]) ok("init --write --approve con el código de otro diff: no escribe"); else ko(`código de otro diff: ${staleCode.status}`);
  const written = await withTty(licenroute, ["init", app, "--plans", "1,2", "--app", "mi-api", "--write", "--approve", code]).done;
  if (T.notConfirmed.test(denied) && T.confirmed.test(written) && T.applied.test(written) && /@licenroute\/connect-express/.test(readFileSync(join(app, "server.js"), "utf8"))) ok("init --write --approve <código vigente>: reto incorrecto no escribe; el reto tecleado en el terminal aplica el diff");
  else { ko(`init --write: ${written.slice(-400)}`); throw new Error("init"); }

  // 4. dev --start-app: comando revisado + reto; simulador y app reales.
  const dev = withTty(licenroute, ["dev", app, "--start-app"]);
  const appFile = join(app, ".licenroute/demo-app.json");
  if (!(await until(() => existsSync(appFile), 40_000))) { ko(`dev --start-app: ${dev.out().slice(-600)}`); throw new Error("dev"); }
  const devOut = dev.out();
  const appUrl = JSON.parse(readFileSync(appFile, "utf8")).url;
  const adminText = readFileSync(join(app, ".licenroute/demo-admin.json"), "utf8"); const admin = JSON.parse(adminText);
  const envText = readFileSync(join(app, ".env.licenroute"), "utf8"); const apiKey = /^LICENROUTE_API_KEY=(.*)$/m.exec(envText)?.[1];
  const secrets = [admin.admin_token, apiKey];
  if (T.noScript.test(devOut) && /--permission --allow-fs-read=/.test(devOut) && T.demo.test(devOut) && (await status(`${appUrl}/health`)) === 200) ok(`dev --start-app: comando exacto (node + server.js, con permisos) confirmado con reto; app en ${appUrl} y simulador en ${admin.url}`);
  else ko(`dev: ${devOut.slice(-500)}`);
  if (!["PWNED-start", "PWNED-dev", "PWNED-postinstall"].some((f) => existsSync(join(app, f)))) ok("ningún script de package.json se ha ejecutado (ni postinstall al instalar como dice el README, ni start ni dev)"); else ko("se ejecutó un script de package.json");
  timings.flow = secs(tFlow);
  sample("init", list1.stdout); sample("preview", pre.stdout); sample("write", written); sample("dev", devOut);

  // 5. test (sin --app ni --base-url), env, doctor y estado: SIMULATED PASS y ningún secreto en la salida.
  const tj = run(licenroute, ["test", app, "--json"], { timeout: 600_000 });
  const doc = JSON.parse(tj.stdout.slice(tj.stdout.indexOf("{")) || "{}");
  const want = ["demo", "activacion", "api-informes:sin-licencia /api/informes", "api-informes:licencia-valida", "api-informes:licencia-de-otro-plan", "api-informes:licencia-inventada", "api-informes:cuota", "api-informes:revocada", "api-catalogo:cuota", "central-caido:api-catalogo", "central-caido:api-informes", "central-caido:cobertura", "central-recuperado"]; // 0.2.2: la caída se prueba en todos los planes
  const passed = (doc.checks ?? []).filter((c) => c.result === "simulated_pass").map((c) => c.id);
  timings.firstPass = secs(tFlow);
  if (tj.status === 0 && doc.result === "simulated_pass" && want.every((w) => passed.includes(w)) && !(doc.checks ?? []).some((c) => c.result === "verified_pass")) ok(`licenroute test (app y URL de licenroute dev): ${passed.length} escenarios SIMULATED PASS; ninguno VERIFIED`);
  else ko(`licenroute test: ${tj.status} ${doc.result} faltan ${want.filter((w) => !passed.includes(w)).join(", ")} · ${JSON.stringify((doc.checks ?? []).filter((c) => c.ok === false)).slice(0, 400)} ${tj.stderr.slice(-200)}`);
  if (samples) { const human = run(licenroute, ["test", app], { timeout: 600_000 }).stdout; if (secretsIn(human, secrets).length) ko("secrets in the human test output"); else sample("test", human); }
  const env = run(licenroute, ["env", app, "--json"]); const e = JSON.parse(env.stdout || "{}");
  const envH = run(licenroute, ["env", app]);
  if (e.mode === "demo" && e.simulator?.state === "running" && e.app?.state === "running" && !secretsIn(env.stdout + envH.stdout, secrets).length && !/bg_dev_|bgdevadmin_/.test(env.stdout + envH.stdout)) ok("env: modo DEMO, simulador y app en marcha; ningún token, clave ni contraseña en la salida"); else ko(`env: ${env.stdout.slice(0, 400)}`);
  const dj = run(licenroute, ["doctor", app, "--json"]); const findings = JSON.parse(dj.stdout || "{}").findings ?? [];
  const lvl = (id) => findings.find((f) => f.id === id || f.id.startsWith(id))?.level;
  if (dj.status === 0 && lvl("simulador") === "ok" && lvl("atestacion") === "ok" && lvl("ruta-de-pago") === "ok" && lvl("credenciales-demo") === "ok" && !secretsIn(dj.stdout, secrets).length) ok("doctor (proveedor demo): simulador, credenciales, atestación y ruta de pago (402) correctos; sin secretos"); else ko(`doctor: ${JSON.stringify(findings.filter((f) => f.level !== "ok")).slice(0, 500)}`);
  const allOut = [devOut, tj.stdout, run(licenroute, ["dev", app, "--status"]).stdout].join("\n");
  if (!secretsIn(allOut, secrets).length && !/bgdev_[a-z2-7]{8}_/.test(allOut)) ok("dev, test y --status no muestran tokens ni claves"); else ko("hay secretos en la salida");

  // 6. Rechazos: sesión duplicada, puerto falso, puerto equivocado, credenciales cruzadas, órdenes sin autorizar.
  const dup = run(licenroute, ["dev", app]);
  const busy = createServer((_q, r) => r.end("otro servicio")); await new Promise((r) => busy.listen(0, "127.0.0.1", r));
  const busyPort = busy.address().port;
  const port = run(licenroute, ["dev", app, "--port", String(busyPort)]);
  if (dup.status === 6 && port.status === 6) ok("dev: segunda sesión y puerto ocupado rechazados (salida 6)"); else ko(`dev rechazos: ${dup.status} ${port.status}`);
  // El impostor va en OTRO proceso: run() es síncrono y bloquearía un servidor de este proceso (parecería caído).
  const impostorPort = await freePort(); const authLog = join(work, "impostor-auth.log");
  const impostor = spawn(process.execPath, ["-e", `require("http").createServer((q, r) => { if (q.headers.authorization) require("fs").appendFileSync(${JSON.stringify(authLog)}, "auth\\n"); r.setHeader("botgate-mode", "simulation"); r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ schema: "botgate.simulator/v1", run_id: "run_AAAAAAAAAAAAAAAA" })); }).listen(${impostorPort}, "127.0.0.1")`], { stdio: "ignore" });
  procs.push(impostor);
  await until(async () => (await status(`http://127.0.0.1:${impostorPort}/`)) === 200, 8_000);
  writeFileSync(join(app, ".licenroute/demo-admin.json"), JSON.stringify({ ...admin, url: `http://127.0.0.1:${impostorPort}` }), { mode: 0o600 });
  const fakeStop = run(licenroute, ["dev", app, "--stop"]); const fakeTest = run(licenroute, ["test", app, "--base-url", appUrl]);
  writeFileSync(join(app, ".licenroute/demo-admin.json"), adminText, { mode: 0o600 });
  impostor.kill(); busy.close();
  const sawAuth = existsSync(authLog);
  if (fakeStop.status === 6 && fakeTest.status !== 0 && !sawAuth) ok("impostor en el puerto del simulador: ni dev --stop ni test le envían el token"); else ko(`impostor: ${fakeStop.status} ${fakeTest.status} token=${sawAuth}`);
  writeFileSync(join(app, ".env.licenroute"), envText.replace(/^LICENROUTE_ENDPOINT=.*$/m, `LICENROUTE_ENDPOINT=http://127.0.0.1:${busyPort}`));
  const wrongPort = JSON.parse(run(licenroute, ["doctor", app, "--json"]).stdout || "{}").findings?.find((f) => f.id === "puerto")?.level;
  writeFileSync(join(app, ".env.licenroute"), envText, { mode: 0o600 });
  const mixed = run(licenroute, ["env", app, "--json"], { env: { LICENROUTE_API_KEY: `bg_live_abcdefgh_${"R".repeat(43)}` } });
  const crossPort = await freePort();
  const crossed = start(process.execPath, ["server.js"], { cwd: app, env: { PORT: String(crossPort), LICENROUTE_API_KEY: `bg_test_abcdefgh_${"k".repeat(43)}`, LICENROUTE_SITE_ID: "site_REAL1234", LICENROUTE_ENDPOINT: admin.url } });
  await until(async () => (await status(`http://127.0.0.1:${crossPort}/health`)) === 200, 8_000);
  const crossPaid = await status(`http://127.0.0.1:${crossPort}/api/informes`, { "botgate-access-token": `bgat_abcdefgh_${"x".repeat(43)}` });
  crossed.p.kill("SIGINT");
  if (wrongPort === "fail" && mixed.status === 1 && JSON.parse(mixed.stdout || "{}").mode === "mixed" && !mixed.stdout.includes("R".repeat(43)) && crossPaid === 503) ok("puerto equivocado (doctor), credenciales mezcladas (env, sin mostrar la clave) y credenciales reales contra el simulador (503)");
  else ko(`cruzadas: puerto=${wrongPort} env=${mixed.status} 503=${crossPaid}`);
  const badEntry = run(licenroute, ["dev", app, "--start-app", "--entry", "../fuera.js"]);
  const asst = JSON.parse(run(licenroute, ["assistant", app, "--claude-code", "--json"]).stdout || "{}");
  const asstNoTty = run(licenroute, ["assistant", app, "--claude-code", "--approve", asst.approval_code ?? "asst_x"]);
  if (badEntry.status !== 0 && asstNoTty.status === 5 && !existsSync(join(app, ".claude"))) ok("órdenes sin autorizar: --entry fuera del proyecto y assistant sin terminal, rechazadas"); else ko(`sin autorizar: entry=${badEntry.status} assistant=${asstNoTty.status}`);

  // 7. Reinicio controlado y parada: credenciales nuevas en cada sesión; la app se para con la sesión.
  const stop1 = run(licenroute, ["dev", app, "--stop"]); await dev.done;
  const stopped = !existsSync(join(app, ".licenroute/demo-admin.json")) && !existsSync(appFile) && (await status(`${appUrl}/health`)) === null;
  const s2 = start(licenroute, ["dev", app]);
  await until(() => existsSync(join(app, ".licenroute/demo-admin.json")), 20_000);
  const admin2 = (() => { try { return JSON.parse(readFileSync(join(app, ".licenroute/demo-admin.json"), "utf8")); } catch { return {}; } })();
  const key2 = /^LICENROUTE_API_KEY=(.*)$/m.exec(readFileSync(join(app, ".env.licenroute"), "utf8"))?.[1];
  const stop2 = run(licenroute, ["dev", app, "--stop"]); await s2.exit;
  if (stop1.status === 0 && stopped && admin2.run_id && admin2.run_id !== admin.run_id && key2 && key2 !== apiKey && stop2.status === 0 && !existsSync(join(app, ".licenroute/demo-admin.json"))) ok("reinicio controlado: nueva sesión con credenciales y run_id nuevos; parada limpia (simulador, app y administración)");
  else ko(`reinicio: stop1=${stop1.status} parado=${stopped} run=${admin2.run_id} stop2=${stop2.status}`);

  // 8. Skill de Claude Code con el reto; nunca pisa un fichero.
  const inst = await withTty(licenroute, ["assistant", app, "--claude-code", "--approve", asst.approval_code]).done;
  const again = JSON.parse(run(licenroute, ["assistant", app, "--claude-code", "--json"]).stdout || "{}");
  if (T.confirmed.test(inst) && T.skill.test((() => { try { return readFileSync(join(app, ".claude/skills/licenroute/SKILL.md"), "utf8"); } catch { return ""; } })()) && existsSync(join(app, ".claude/skills/licenroute/SKILL.md")) && existsSync(join(app, ".claude/settings.json")) && again.approval_code === null) ok(`assistant --claude-code: Skill (${LANG}), guarda y settings.json creados con el reto; una segunda vez no hay nada que crear`);
  else ko(`assistant: ${inst.slice(-300)}`);

  // 9. undo exacto (los ficheros del asistente no son de apply: se informan, no se borran).
  const undo = run(licenroute, ["undo", app]);
  const same = Object.entries(snap).filter(([f, t]) => readFileSync(join(app, f), "utf8") !== t).map(([f]) => f);
  if (undo.status === 0 && !same.length) ok("undo: server.js, package.json y .gitignore idénticos a antes de init --write"); else ko(`undo: ${undo.status} difieren ${same.join(", ")} ${undo.stdout.slice(-200)}`);
  // 0.2.2: sin avisos falsos (el SDK lo instaló npm, así que package.json SIGUE declarándolo; sin Sandbox en demo).
  if (!T.falseDep.test(undo.stdout) && T.declared.test(undo.stdout)) ok("undo: «Queda» dice la verdad sobre package.json y no menciona ningún Sandbox"); else ko(`avisos de undo: ${undo.stdout.split("\n").filter((l) => /dependencia|sandbox|Sandbox/.test(l)).join(" / ")}`);

  // 10. Existing authentication and HTTP methods (F-D4-1) on a second app: Express 4, CommonJS, its own Bearer check
  //     on POST /coupons/redeem under the paid prefix /coupons/**. The licence applies to GET and HEAD only; the POST
  //     keeps answering with the app's own authentication (201 / 401), never 402.
  const app2 = join(work, "coupons-api");
  cpSync(join(repoRoot, "test/fixtures/coupons-api"), app2, { recursive: true });
  run("git", ["init", "-q"], { cwd: app2 }); run("git", ["add", "-A"], { cwd: app2 }); run("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base", "--no-gpg-sign"], { cwd: app2 });
  const j1 = run("npm", ["install", "--save-dev", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", cliTgz], { cwd: app2 });
  const j2 = run("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund", "--ignore-scripts", sdkTgz], { cwd: app2 });
  const bg2 = join(app2, "node_modules/.bin/licenroute");
  if (j1.status !== 0 || j2.status !== 0) { ko(`coupons-api install: ${(j1.stderr || j2.stderr).slice(-300)}`); throw new Error("install 2"); }
  const before2 = readFileSync(join(app2, "server.js"), "utf8");
  const plans2 = run(bg2, ["init", app2]);
  if (/\n\s+1\s+coupons\s+\/coupons\/\*\*/.test(plans2.stdout) && T.methodsOnly.test(plans2.stdout) && new RegExp(`${T.decision.source}[\\s\\S]*POST /coupons/redeem`).test(plans2.stdout)) ok("existing auth: plan /coupons/** proposed for GET and HEAD only; the authenticated POST /coupons/redeem is left for the developer's decision");
  else ko(`coupons-api init: ${plans2.stdout.slice(-500)}`);
  const code2 = JSON.parse(run(bg2, ["init", app2, "--plans", "coupons", "--app", "coupons-api", "--json"]).stdout || "{}").preview?.approval_code;
  const w2 = await withTty(bg2, ["init", app2, "--plans", "coupons", "--app", "coupons-api", "--write", "--approve", code2]).done;
  const integrated = readFileSync(join(app2, "server.js"), "utf8");
  if (T.confirmed.test(w2) && integrated.includes('licensedPaths: [{ path: "/coupons/**", methods: ["GET", "HEAD"] }]') && /require\("@licenroute\/connect-express"\)/.test(integrated)) ok("F-D4-1: the written middleware declares { path: \"/coupons/**\", methods: [\"GET\", \"HEAD\"] } (CommonJS require)");
  else { ko(`coupons-api write: ${w2.slice(-300)} ${integrated.slice(0, 600)}`); throw new Error("write 2"); }
  const dev2 = withTty(bg2, ["dev", app2, "--start-app"]);
  if (!(await until(() => existsSync(join(app2, ".licenroute/demo-app.json")), 40_000))) { ko(`coupons-api dev: ${dev2.out().slice(-500)}`); throw new Error("dev 2"); }
  const url2 = JSON.parse(readFileSync(join(app2, ".licenroute/demo-app.json"), "utf8")).url;
  const t2 = run(bg2, ["test", app2, "--json"], { timeout: 600_000 });
  const doc2 = JSON.parse(t2.stdout.slice(t2.stdout.indexOf("{")) || "{}");
  const passed2 = (doc2.checks ?? []).filter((c) => c.result === "simulated_pass").map((c) => c.id);
  const want2 = ["coupons:metodos-codigo", "coupons:metodos-servicio", "coupons:sin-licencia /coupons", "coupons:licencia-valida", "coupons:cuota", "coupons:revocada"];
  if (t2.status === 0 && doc2.result === "simulated_pass" && want2.every((w) => passed2.includes(w))) ok(`licenroute test (coupons-api): ${passed2.length} SIMULATED PASS, including code and service methods, quota and revocation`);
  else ko(`coupons-api test: ${t2.status} ${doc2.result} missing ${want2.filter((w) => !passed2.includes(w)).join(", ")} · ${JSON.stringify((doc2.checks ?? []).filter((c) => c.result !== "simulated_pass")).slice(0, 400)}`);
  // After licenroute test: the SDK has attested and the plan is active (before that, a paid route answers 403, BL-11).
  const call = (path, init = {}) => fetch(`${url2}${path}`, init).then(async (r) => ({ status: r.status, body: await r.text() })).catch(() => ({ status: null, body: "" }));
  const unlicensed = await call("/coupons"); const head = await call("/coupons", { method: "HEAD" });
  const ownOk = await call("/coupons/redeem", { method: "POST", headers: { authorization: "Bearer user-token-123" } });
  const ownNo = await call("/coupons/redeem", { method: "POST" });
  const health = await call("/health");
  if (unlicensed.status === 402 && head.status === 402 && ownOk.status === 201 && ownNo.status === 401 && /login required/.test(ownNo.body) && health.status === 200) ok("existing auth + methods against the running app: GET/HEAD /coupons without licence 402; POST /coupons/redeem with the app's own token 201, without it the app's own 401 (never 402); /health 200");
  else ko(`coupons-api HTTP: GET ${unlicensed.status} HEAD ${head.status} POST+token ${ownOk.status} POST ${ownNo.status} health ${health.status}`);
  run(bg2, ["dev", app2, "--stop"]); await dev2.done;
  const undo2 = run(bg2, ["undo", app2]);
  if (undo2.status === 0 && readFileSync(join(app2, "server.js"), "utf8") === before2) ok("coupons-api undo: server.js identical to before init --write"); else ko(`coupons-api undo: ${undo2.status} ${undo2.stdout.slice(-200)}`);
} catch (e) {
  if (!fails.length) ko(e.message);
} finally {
  cleanup();
  rmSync(work, { recursive: true, force: true });
  process.stdout.write(`\nTiempos automáticos (no incluyen leer, decidir ni teclear): instalación ${timings.install ?? "-"} · init→app en demo ${timings.flow ?? "-"} · init→primer SIMULATED PASS ${timings.firstPass ?? "-"} · total ${secs()}\n`);
  process.stdout.write(`${fails.length ? `${fails.length} failures (${LANG})` : `ACCEPTANCE (${LANG}; built packages, example app and existing-auth app): ALL OK`}\n`);
  process.exitCode = fails.length ? 1 : 0;
}
