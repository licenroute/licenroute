#!/usr/bin/env node
// Builds the two installable packages from source into dist-packages/, with SHA256SUMS. Publishes nothing.
//   node scripts/build-packages.mjs
//   dist-packages/<scope>-cli-<version>.tgz              CLI + bundled simulator, Skill and Cursor rules
//   dist-packages/<scope>-connect-express-<version>.tgz  Express SDK, ESM and CommonJS (no runtime dependencies)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist-packages");
const npm = (args, cwd = root) => execFileSync("npm", args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const pkg = (rel) => JSON.parse(readFileSync(join(root, rel, "package.json"), "utf8"));
const tgzName = (p) => `${p.name.replace("@", "").replace("/", "-")}-${p.version}.tgz`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const cli = pkg("packages/cli"); const sdk = pkg("sdks/node-express");
npm(["run", "build", "-w", pkg("packages/policy-contracts").name]);
npm(["run", "build", "-w", sdk.name]);
npm(["pack", "-w", sdk.name, "--pack-destination", out]);
npm(["run", "pack", "-w", cli.name]);
cpSync(join(root, "packages/cli/.pack", tgzName(cli)), join(out, tgzName(cli)));

const files = readdirSync(out).filter((f) => f.endsWith(".tgz")).sort();
if (JSON.stringify(files) !== JSON.stringify([tgzName(cli), tgzName(sdk)].sort())) throw new Error(`unexpected packages: ${files.join(", ")}`);
const sums = files.map((f) => `${createHash("sha256").update(readFileSync(join(out, f))).digest("hex")}  ${f}`);
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
process.stdout.write(`${sums.join("\n")}\n`);
