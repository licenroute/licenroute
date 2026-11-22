#!/usr/bin/env node
// Publication audit of this repository (or of a built tarball tree). Read-only. Exit code 1 on any finding.
//   node scripts/audit-public.mjs <dir> [--tarballs]
// Checks: private code and internal names, real-format credentials and common secret formats, telemetry SDKs,
// personal paths, unexpected files (symlinks, binaries, hidden files, setuid), package manifests, CI pinning and,
// when a .git directory exists, the published history (linear; every commit audited). A positive control proves every
// scanner still fires.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const root = process.argv[2];
if (!root) { process.stderr.write("usage: audit-public.mjs <dir>\n"); process.exit(2); }

// Identifiers that only exist in the private monorepo or in LicenRoute Central. Some are split so that this file does
// not match itself.
const PRIVATE = [
  ["services/", "decision-api"], ["apps/", "admin-rails"], ["publish-", "connector"], ["publish-", "core"],
  ["sandbox", ".sh"], ["BOTGATE_", "HOME"], ["require(\"", "pg\")"], ["require(\"", "ioredis\")"], ["this.", "pepper"],
  ["db-", "roles"], ["rails ", "runner"], ["lab/", "evaluator"], ["evaluator/", "cases"], ["INFORME-", "D"],
  ["PROTOCOLO-", "D"], ["never_", "licensed"], ["unresolved_", "min"], ["8-", "rubrica"], ["4-hoja-", "evaluacion"],
  ["10-", "encuesta"], ["IDENTIDAD-", "0."], ["lab-", "canario"], ["christian", "vargas"], ["Projects/", "BotGate"],
  ["@gmail", ".com"], ["cursor", "agent@"], ["BotGate_MVP_", "Vibe"], ["docker-", "compose"],
  ["ADR", "-00"], ["docs/", "s10-"], ["docs/", "adr"],
].map((p) => p.join(""));
const SECRET = [
  [/bg_(?:live|test)_[a-z2-7]{8}_[A-Za-z0-9]{43}(?![A-Za-z0-9])/, "LicenRoute API key with a real format"],
  [/bgat_[a-z2-7]{8}_[A-Za-z0-9]{43}(?![A-Za-z0-9])/, "LicenRoute access token with a real format"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, "private key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}/, "GitHub token"],
  [/xox[abposr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}/, "Stripe live key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/npm_[A-Za-z0-9]{36}/, "npm token"],
];
const TELEMETRY = ["posthog", "@segment/", "analytics-node", "@sentry/", "mixpanel", "amplitude", "google-analytics", "googletagmanager", "datadog", "newrelic", "bugsnag", "honeycomb"];
// Exact, reviewed exceptions: [file, needle, why].
const ALLOW = [
  ["packages/cli/test/d41-regressions.test.ts", "/Users/", "synthetic relative path in a display test (file:../../Users/alguien/...)"],
  ["packages/cli/scripts/pack.mjs", "*", "the packer's own lists of strings it refuses to ship"],
  ["packages/cli/test/apply.test.ts", "Stripe live key", "synthetic value in the test that proves diffs mask secrets"],
  ["scripts/audit-public.mjs", "*", "this file"],
];
const HIDDEN_OK = /^(?:\.gitignore|\.npmrc|\.github\/workflows\/[a-z0-9-]+\.yml|examples\/express-demo\/\.gitignore|integrations\/assistants\/generated\/(?:en|es)\/(?:claude-code\/\.claude|cursor\/\.cursor)\/.+|packages\/cli\/test\/fixtures\/.+\/\.(?:gitignore|keep)|test\/fixtures\/[^/]+\/\.gitignore|\.git\/.*)$/;
const TOP = new Set(["dist-packages", "package.json", "package-lock.json", "README.md", "LICENSE", "NOTICE", "SECURITY.md", "THIRD_PARTY_LICENSES.md", "SOURCE.txt", ".gitignore", ".npmrc", "tsconfig.base.json", ".github", "docs", "demo", "scripts", "test", "packages", "sdks", "integrations", "examples", ".git", "node_modules", "validation-results"]);
const SKIP_DIR = new Set(["dist-packages", "node_modules", ".git", ".pack", "dist", "validation-results"]);

// A filler such as bgat_abcdefgh_AAAA… (one or two distinct characters after the prefix) is a test value, not a secret.
const synthetic = (s) => new Set(s.replace(/^[a-z]+_(?:[a-z]+_)?[a-z2-7]{8}_|^[A-Za-z]+[-_]+/, "")).size <= 2;

function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n); const st = lstatSync(p);
    if (st.isDirectory()) { if (!SKIP_DIR.has(n)) walk(p, acc); } else acc.push([p, st]);
  }
  return acc;
}

export function audit(dir) {
  const found = [];
  for (const n of readdirSync(dir)) if (!TOP.has(n)) found.push(`${n}: unexpected top-level entry`);
  for (const [p, st] of walk(dir)) {
    const rel = relative(dir, p).split(sep).join("/");
    if (st.isSymbolicLink()) { found.push(`${rel}: symbolic link`); continue; }
    if (st.mode & 0o6000) found.push(`${rel}: setuid/setgid bit`);
    if (rel.split("/").some((s) => s.startsWith(".")) && !HIDDEN_OK.test(rel)) found.push(`${rel}: unexpected hidden file`);
    if (st.size > 2 * 1024 * 1024) found.push(`${rel}: larger than 2 MiB`);
    const buf = readFileSync(p);
    if (buf.subarray(0, 8192).includes(0)) { found.push(`${rel}: binary file`); continue; }
    const text = buf.toString("utf8");
    const allowed = (needle) => ALLOW.some(([f, n]) => f === rel && (n === "*" || n === needle));
    for (const n of [...PRIVATE, "/Users/", "/home/user/"]) if (text.includes(n) && !allowed(n)) found.push(`${rel}: private or personal marker «${n}»`);
    for (const [re, what] of SECRET) {
      const real = [...text.matchAll(new RegExp(re.source, "g"))].some((m) => !synthetic(m[0]));
      if (real && !allowed("*") && !allowed(what)) found.push(`${rel}: ${what}`);
    }
    if (!rel.endsWith("THIRD_PARTY_LICENSES.md")) for (const n of TELEMETRY) if (text.toLowerCase().includes(n) && !allowed("*")) found.push(`${rel}: telemetry SDK «${n}»`);
    if (/(?:^|\/)package\.json$/.test(rel) && !/(?:^|\/)test\/fixtures\//.test(rel) && !rel.startsWith("examples/")) {
      const pkg = JSON.parse(text);
      // npm phase (0.8.1): only the SDK may be publishable, and only pointing at the official repository.
      const publishable = rel === "sdks/node-express/package.json";
      if (pkg.private !== true && !publishable) found.push(`${rel}: "private": true is required until publication is authorised`);
      if (publishable && pkg.private !== true && pkg.repository?.url !== "git+https://github.com/licenroute/licenroute.git") found.push(`${rel}: a publishable package must point at the official repository`);
      if (pkg.license !== "Apache-2.0") found.push(`${rel}: license must be Apache-2.0`);
      for (const k of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"]) if (pkg.scripts?.[k]) found.push(`${rel}: lifecycle script «${k}»`);
    }
    if (rel.startsWith(".github/workflows/")) {
      for (const m of text.matchAll(/uses:\s*([^\s#]+)/g)) if (!/@[0-9a-f]{40}$/.test(m[1])) found.push(`${rel}: action not pinned to a commit SHA: ${m[1]}`);
    }
    if (rel === "package-lock.json") {
      const lock = JSON.parse(text);
      for (const [k, v] of Object.entries(lock.packages ?? {})) if (k && !v.link && v.resolved && !v.resolved.startsWith("https://registry.npmjs.org/")) found.push(`package-lock.json: ${k} resolved outside the public npm registry`);
    }
  }
  if (existsSync(join(dir, ".git"))) {
    const g = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
    // A linear history whose every commit passes this same audit: each release is one more commit on top of the last,
    // so a tag of an earlier release keeps pointing at what was published, and nothing private hides in an old tree.
    const commits = g("rev-list", "--all").split("\n").filter(Boolean);
    if (g("rev-list", "--all", "--merges")) found.push(".git: merge commits; publish a linear history");
    for (const id of new Set(g("log", "--all", "--format=%an <%ae>%n%cn <%ce>").split("\n"))) if (PRIVATE.some((n) => id.includes(n))) found.push(`.git: personal identity in history: ${id}`);
    for (const c of commits.slice(1)) {
      const t = mkdtempSync(join(tmpdir(), "licenroute-audit-commit-"));
      try {
        execFileSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", dir, c, t]);
        for (const f of audit(t)) found.push(`.git: commit ${c.slice(0, 7)}: ${f}`);
      } finally { rmSync(t, { recursive: true, force: true }); }
    }
    if (g("remote").length) found.push(".git: a remote is configured");
  }
  return found;
}

// Positive control: a scratch tree with one example of every class of finding.
function control() {
  const d = mkdtempSync(join(tmpdir(), "licenroute-audit-control-"));
  try {
    writeFileSync(join(d, "README.md"), `${PRIVATE.join("\n")}\nbg_live_abcdefgh_${"Zx9Kq2Lm".repeat(5)}abc\n-----BEGIN RSA PRIVATE KEY\nposthog\n`);
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", license: "MIT", scripts: { postinstall: "x" } }));
    writeFileSync(join(d, "stray.bin"), Buffer.from([0, 1, 2]));
    const f = audit(d);
    const missing = [...PRIVATE.map((n) => `«${n}»`), "real format", "private key", "telemetry", "\"private\": true", "license must", "lifecycle", "stray.bin"].filter((m) => !f.some((x) => x.includes(m)));
    return missing;
  } finally { rmSync(d, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = control();
  if (missing.length) { process.stdout.write(`FAIL audit positive control did not detect: ${missing.join(", ")}\n`); process.exit(1); }
  const found = audit(root);
  if (found.length) { process.stdout.write(`FAIL audit (${found.length}):\n  ${found.join("\n  ")}\n`); process.exit(1); }
  process.stdout.write(`OK   audit: no private code or internal names, no real-format credentials or secrets, no telemetry SDKs, no unexpected files; manifests private + Apache-2.0; positive control detected (${PRIVATE.length} private markers, ${SECRET.length} secret formats)\n`);
}
