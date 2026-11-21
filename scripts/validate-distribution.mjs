#!/usr/bin/env node
// Full local validation of this repository. No CI service needed. Exit code 0 only if every step passes.
//   npm run validate:distribution [-- --skip-install] [-- --allow-root]
// Results: validation-results/<UTC timestamp>/ (environment, one log per step, summary.txt, summary.json).
//
// Steps: environment · install (npm ci --ignore-scripts) · publication audit (secrets, private code, telemetry,
// unexpected files, manifests, CI pinning) · licences · independence from any other checkout · typecheck · build +
// integrity + reproducibility · unit/e2e suites (contracts, SDK, simulator, CLI, assistants) · acceptance on the built
// packages (example app + existing-authentication app), once in English and once in Spanish (D4.4). Then a
// requirement → evidence matrix.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release, userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const flags = new Set(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(root, "validation-results", stamp);
mkdirSync(outDir, { recursive: true });
const steps = [];
const say = (m) => process.stdout.write(`${m}\n`);
const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
// LicenRoute 0.3.0: also the former BOTGATE_ prefix (the CLI still reads BOTGATE_SANDBOX_* and BOTGATE_TEST_PROVIDER).
// Only in this copy of the environment: the developer's own environment is not changed.
for (const k of Object.keys(env)) if (/^(?:LICENROUTE|BOTGATE)_/.test(k)) delete env[k];
delete env.NODE_OPTIONS;

// Every step runs in a NEW SESSION with no controlling terminal, whoever launches the validation (an interactive
// terminal, an IDE or an agent): "no terminal" checks must not turn into a prompt. Tests that need a terminal create
// their own pseudo-terminal. (spawnSync cannot detach, so a tiny wrapper does.)
// On timeout spawnSync signals the wrapper, which kills the whole detached process group (no orphan keeps ports busy).
const DETACH = "const p=require('node:child_process').spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:'inherit'});const stop=()=>{try{process.kill(-p.pid,'SIGKILL')}catch{}process.exit(124)};process.on('SIGTERM',stop);process.on('SIGINT',stop);p.on('error',()=>process.exit(127));p.on('close',(c)=>process.exit(c??1));";
function run(cmd, args, { cwd = root, timeout = 900_000 } = {}) {
  const r = spawnSync(process.execPath, ["-e", DETACH, cmd, ...args], { cwd, env, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` };
}
function step(id, title, fn) {
  const t = Date.now();
  let res;
  try { res = fn(); } catch (e) { res = { ok: false, detail: e.message, log: e.stack ?? "" }; }
  const s = { id, title, ok: !!res.ok, detail: res.detail ?? "", seconds: Math.round((Date.now() - t) / 100) / 10, notes: res.notes ?? [] };
  writeFileSync(join(outDir, `${String(steps.length + 1).padStart(2, "0")}-${id}.log`), res.log ?? "");
  steps.push(s);
  say(`${s.ok ? "OK  " : "FAIL"} ${title}: ${s.detail} (${s.seconds} s)`);
  for (const n of s.notes) say(`     note: ${n}`);
  return s.ok;
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const walk = (d, acc = []) => { for (const n of readdirSync(d)) { if (["node_modules", ".git", "validation-results", "dist-packages", ".pack", "dist"].includes(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p, acc); else acc.push(p); } return acc; };

// 1. Environment.
const nodeMajor = Number(process.versions.node.split(".")[0]);
const tools = ["npm", "git", "bash", "tar", "mkfifo", "script", platform() === "darwin" ? "shasum" : "sha256sum"];
const missingTools = tools.filter((t) => run("sh", ["-c", `command -v ${t}`]).status !== 0);
const osRelease = existsSync("/etc/os-release") ? (/^PRETTY_NAME="?([^"\n]*)/m.exec(readFileSync("/etc/os-release", "utf8"))?.[1] ?? "") : "";
const hasRuby = run("ruby", ["-v"]).status === 0;
const uid = userInfo().uid;
const envText = [
  `date        ${new Date().toISOString()}`,
  `os          ${platform()} ${release()} ${arch()} ${osRelease}`,
  `uname       ${run("uname", ["-a"]).out.trim()}`,
  `node        ${process.version} · npm ${run("npm", ["-v"]).out.trim()}`,
  `user        uid=${uid}`,
  `ruby        ${hasRuby ? run("ruby", ["-v"]).out.trim() : "not installed (Ruby syntax of generated Rails files is not checked; Rails is unsupported in this preview)"}`,
  `repository  ${root}`,
].join("\n");
writeFileSync(join(outDir, "environment.txt"), `${envText}\n`);
const envOk = step("environment", "Environment", () => {
  const problems = [];
  if (nodeMajor < 24) problems.push(`Node ${process.version} (24+ required)`);
  if (missingTools.length) problems.push(`missing tools: ${missingTools.join(", ")}`);
  if (uid === 0 && !flags.has("--allow-root")) problems.push("running as root: file-permission tests cannot fail as they should (root bypasses chmod); run as a normal user or pass --allow-root to accept their failures");
  return { ok: !problems.length, detail: problems.join("; ") || `${platform()} ${arch()}${osRelease ? ` (${osRelease})` : ""}, Node ${process.version}`, log: envText, notes: hasRuby ? [] : ["ruby not installed: the CLI tests skip the Ruby syntax check of generated Rails files"] };
});
if (!envOk) finish();

// 2. Install.
if (!flags.has("--skip-install")) step("install", "Install (npm ci --ignore-scripts)", () => {
  const r = run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  return { ok: r.status === 0, detail: r.status === 0 ? (/added \d+ packages/.exec(r.out)?.[0] ?? "done") : r.out.trim().split("\n").slice(-3).join(" | "), log: r.out };
});

// 3. Publication audit.
step("audit", "Secrets and private code (publication audit)", () => {
  const r = run(process.execPath, [join(root, "scripts/audit-public.mjs"), root]);
  return { ok: r.status === 0, detail: r.out.trim().split("\n").slice(0, 3).map((l) => l.trim()).join(" ").replace(/^(OK|FAIL)\s+/, ""), log: r.out };
});

// 4. Licences.
step("licenses", "Licences (own and third-party)", () => {
  const problems = [];
  if (sha(join(root, "LICENSE")) !== "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30") problems.push("LICENSE is not the canonical Apache-2.0 text");
  if (!existsSync(join(root, "NOTICE"))) problems.push("NOTICE missing");
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const listed = readFileSync(join(root, "THIRD_PARTY_LICENSES.md"), "utf8");
  const allowed = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Python-2.0", "MIT-0", "Unlicense"]);
  let n = 0;
  for (const [k, v] of Object.entries(lock.packages)) {
    if (!k.startsWith("node_modules/") || v.link) continue;
    n++;
    const name = k.slice(k.lastIndexOf("node_modules/") + 13);
    if (!listed.includes(`| ${name} | ${v.version} | ${v.license} |`)) problems.push(`${name}@${v.version} not in THIRD_PARTY_LICENSES.md`);
    if (!allowed.has(v.license) && !(v.license === "MPL-2.0" && v.dev)) problems.push(`${name}@${v.version}: ${v.license}`);
  }
  for (const p of ["packages/cli", "packages/simulator", "packages/policy-contracts", "sdks/node-express"]) if (JSON.parse(readFileSync(join(root, p, "package.json"), "utf8")).license !== "Apache-2.0") problems.push(`${p}: license field`);
  return { ok: !problems.length, detail: problems.join("; ") || `LICENSE = canonical Apache-2.0; NOTICE present; ${n} lockfile packages listed, all permissive (MPL-2.0 only as a dev-only tool)`, log: problems.join("\n") };
});

// 5. Independence: nothing in the sources reaches outside this repository.
step("independence", "Independence from any other checkout", () => {
  const problems = [];
  const spec = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|new URL\(\s*)["'](\.{1,2}\/[^"']*)["']/g;
  let checked = 0;
  for (const f of walk(root)) {
    if (!/\.(?:[cm]?[jt]s)$/.test(f) || f.includes(`${sep}test${sep}fixtures${sep}`)) continue;
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(spec)) {
      checked++;
      const target = resolve(dirname(f), m[1]);
      if (target !== root && !target.startsWith(root + sep)) problems.push(`${relative(root, f)}: «${m[1]}» resolves outside the repository`);
    }
  }
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  for (const [k, v] of Object.entries(lock.packages)) if (v.link && !resolve(root, v.resolved).startsWith(root + sep)) problems.push(`package-lock: ${k} links outside the repository`);
  const ws = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces;
  for (const w of ws) if (!existsSync(join(root, w, "package.json"))) problems.push(`workspace ${w} missing`);
  return { ok: !problems.length, detail: problems.join("; ") || `${checked} relative module specifiers resolve inside the repository; workspaces and lockfile links are local; built packages are checked for build paths after the build`, log: problems.join("\n") };
});

// 6. Typecheck.
step("typecheck", "Typecheck (tsc, all workspaces)", () => {
  const r = run("npm", ["run", "typecheck"]);
  return { ok: r.status === 0, detail: r.status === 0 ? "4 workspaces, no errors" : (r.out.match(/error TS\d+[^\n]*/g) ?? ["failed"]).slice(0, 3).join(" | "), log: r.out };
});

// 7. Build, integrity and reproducibility.
const dist = join(root, "dist-packages");
step("build", "Build, package integrity and reproducibility", () => {
  const b1 = run("npm", ["run", "build"]);
  if (b1.status !== 0) return { ok: false, detail: b1.out.trim().split("\n").slice(-3).join(" | "), log: b1.out };
  const sums1 = readFileSync(join(dist, "SHA256SUMS"), "utf8");
  const files = sums1.trim().split("\n").map((l) => l.split(/\s+/));
  const bad = files.filter(([h, f]) => sha(join(dist, f)) !== h).map(([, f]) => f);
  const b2 = run("npm", ["run", "build"]);
  const sums2 = existsSync(join(dist, "SHA256SUMS")) ? readFileSync(join(dist, "SHA256SUMS"), "utf8") : "";
  const leaks = [];
  for (const [, f] of files) {
    const listing = run("tar", ["-xOzf", join(dist, f)]).out;
    for (const p of [root, homedir()]) if (p.length > 1 && listing.includes(p)) leaks.push(`${f} contains the build path ${p}`);
  }
  const ok = b2.status === 0 && !bad.length && sums1 === sums2 && files.length === 2 && !leaks.length;
  return { ok, detail: ok ? `${files.map(([h, f]) => `${f} ${h.slice(0, 12)}…`).join(", ")}; SHA256SUMS verified; a second build is byte-identical; no build-machine paths inside` : `checksum mismatch ${bad.join(",") || "-"} · reproducible ${sums1 === sums2} · ${leaks.join("; ")}`, log: `${b1.out}\n--- second build ---\n${b2.out}\n${sums1}\n${sums2}` };
});

// 8. Test suites.
const suites = {};
function vitest(id, title, ws) {
  return step(id, title, () => {
    const json = join(outDir, `${id}.json`);
    const r = run(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--reporter=default", "--reporter=json", `--outputFile.json=${json}`], { cwd: join(root, ws) });
    const j = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : null;
    suites[id] = Object.fromEntries((j?.testResults ?? []).map((t) => [t.name.split("/").pop(), { status: t.status, tests: t.assertionResults.length, failed: t.assertionResults.filter((a) => a.status === "failed").length }]));
    const ok = r.status === 0 && j?.success === true;
    return { ok, detail: j ? `${j.numPassedTests} passed, ${j.numFailedTests} failed, ${j.numPendingTests} skipped (${j.testResults.length} files)` : "no report", log: r.out };
  });
}
vitest("contracts", "Contracts (policy-contracts)", "packages/policy-contracts");
vitest("sdk", "Express SDK (Express 4 and 5)", "sdks/node-express");
vitest("simulator", "Simulator", "packages/simulator");
vitest("cli", "CLI (unit + end-to-end, real launcher)", "packages/cli");
step("assistants", "Claude Code / Cursor hook and Skill", () => {
  const r = run(process.execPath, ["--test", join(root, "integrations/assistants/test/assistants.test.mjs")]);
  const pass = /(?:#|ℹ) pass (\d+)/.exec(r.out)?.[1]; const fail = /(?:#|ℹ) fail (\d+)/.exec(r.out)?.[1];
  return { ok: r.status === 0, detail: `${pass ?? "?"} passed, ${fail ?? "?"} failed`, log: r.out };
});

// 9. Acceptance on the built packages, in each language (the human output samples go to samples/).
const acceptance = { en: "", es: "" };
for (const lang of ["en", "es"]) {
  step(`acceptance-${lang}`, `Acceptance on the built packages, ${lang} (example app + existing-auth app)`, () => {
    const r = run(process.execPath, [join(root, "test/acceptance.mjs"), dist, "--lang", lang, "--samples", join(outDir, "samples")], { timeout: 1_200_000 });
    acceptance[lang] = r.out;
    const okN = (r.out.match(/^OK /gm) ?? []).length; const failN = (r.out.match(/^FAIL /gm) ?? []).length;
    return { ok: r.status === 0 && failN === 0 && okN > 0, detail: `${okN} checks OK, ${failN} failed`, log: r.out };
  });
}

finish();

function finish() {
  const by = Object.fromEntries(steps.map((s) => [s.id, s.ok]));
  const file = (suite, name) => suites[suite]?.[name]?.status === "passed";
  // An acceptance line counts only if it passed in BOTH languages.
  const line = (re) => ["en", "es"].every((lang) => acceptance[lang].split("\n").some((l) => l.startsWith("OK ") && re.test(l)));
  const REQ = [
    ["Express 4 and 5", by.sdk && file("cli", "apply.test.ts") && line(/licenroute test \(app y URL de licenroute dev\)/) && line(/existing auth \+ methods against the running app/)],
    ["HTTP methods and F-D4-1 regression", file("cli", "d41-regressions.test.ts") && file("sdk", "methods.test.ts") && file("simulator", "methods.test.ts") && line(/F-D4-1: the written middleware/)],
    ["Existing authentication", file("cli", "d31-regressions.test.ts") && line(/^OK\s+existing auth:/) && line(/existing auth \+ methods/)],
    ["Quotas and revocation", line(/licenroute test \(app y URL de licenroute dev\)/) && line(/licenroute test \(coupons-api\).*quota and revocation/)],
    ["Partial integration declared", file("cli", "d31-regressions.test.ts") && file("cli", "d41-regressions.test.ts") && file("cli", "apply.test.ts")],
    ["Diff and approval", file("cli", "apply.test.ts") && file("cli", "d31-regressions.test.ts") && line(/código de otro diff: no escribe/) && line(/reto incorrecto no escribe/)],
    ["undo", file("cli", "apply.test.ts") && line(/^OK\s+undo: server\.js/) && line(/coupons-api undo/)],
    ["Unprotected write mode unreachable (source and package)", file("cli", "apply.test.ts") && line(/unprotected write unreachable from the package/) && line(/rechazos de init/)],
    ["Supported scope: Express only, Rails refused", line(/Rails out of scope/) && file("cli", "apply.test.ts") && by.assistants],
    ["Assistant files = distributed files", line(/assistants: the \d+ Skill and Cursor rule files in the package are identical/)],
    ["Reproducible packages and integrity", by.build && line(/packages intact/) && line(/^OK\s+packages:/)],
    ["Compilation", by.typecheck && by.build],
    ["CLI, SDK, simulator and contracts tests", by.cli && by.sdk && by.simulator && by.contracts && by.assistants],
    ["No secrets, private code or private paths", by.audit && by.build],
    ["Licences", by.licenses],
    ["Independence from the private monorepo", by.independence && by.build],
    ["Languages: en default, es complete; same keys, parameters and JSON", file("cli", "i18n.test.ts") && file("sdk", "messages.test.ts") && by.assistants && line(/languages: --json and the approval code identical/)],
    ["Security decisions independent of translated text (wildcards, rewritten notes, contract errors)", file("cli", "d441-regressions.test.ts") && file("cli", "i18n.test.ts") && file("sdk", "messages.test.ts") && by.assistants],
    ["Approval barriers in both languages", line(/unprotected write unreachable from the package/) && line(/languages: an approval prepared in (?:en|es) still needs the challenge/) && line(/reto incorrecto no escribe/) && line(/código de otro diff: no escribe/)],
    // 0.2.8: the Skill runs only the installed package; npx would fetch whatever unscoped `licenroute` package the npm registry has (not this one).
    ["No accidental download of third-party npm packages (local binary only, never npx)", line(/execution form of the Skill: \.\/node_modules\/\.bin\/licenroute is the installed package/) && by.assistants],
    // R10: the public documentation and the demo run only the installed binary, and their examples work from a clean install.
    ["Documentation and demo: no npx, examples run from a clean install", line(/^OK\s+documentation: no npx instruction/) && line(/^OK\s+demo\/demo\.sh: runs end to end/)],
  ].map(([name, ok]) => ({ name, ok: !!ok }));
  const allOk = steps.every((s) => s.ok) && (steps.length > 1 ? REQ.every((r) => r.ok) : false);
  const text = [
    `LicenRoute distribution validation · ${new Date().toISOString()}`,
    readFileSync(join(outDir, "environment.txt"), "utf8"),
    "Steps:",
    ...steps.map((s) => `  ${s.ok ? "OK  " : "FAIL"} ${s.title}: ${s.detail}`),
    "",
    ...(steps.length > 1 ? ["Requirements:", ...REQ.map((r) => `  ${r.ok ? "OK  " : "FAIL"} ${r.name}`), ""] : []),
    allOk ? "RESULT: PASS" : "RESULT: FAIL",
    "",
  ].join("\n");
  writeFileSync(join(outDir, "summary.txt"), text);
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify({ ok: allOk, steps, requirements: REQ, suites }, null, 2)}\n`);
  say("");
  if (steps.length > 1) for (const r of REQ) say(`${r.ok ? "OK  " : "FAIL"} requirement: ${r.name}`);
  say(`\n${allOk ? "RESULT: PASS" : "RESULT: FAIL"} · ${relative(root, outDir)}/summary.txt`);
  process.exit(allOk ? 0 : 1);
}
