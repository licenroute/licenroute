#!/usr/bin/env node
// Test harness only (public repository, D4.3). Runs `node <cli> <args…>` in a real pseudo-terminal and types the
// one-time challenge the CLI shows there, exactly as a person would. It grants nothing the human path does not: the CLI
// has no test mode in this repository, so this is how the automated tests approve a write. Never shipped in a package.
//   node test/support/answer-challenge.mjs <cli> <args…>   → prints the session output; exit code = the CLI's
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ptyScript } from "../../../../test/platform.mjs";

const [cli, ...args] = process.argv.slice(2);
const work = mkdtempSync(join(tmpdir(), "licenroute-answer-"));
const fifo = join(work, "tty.fifo"); const outFile = join(work, "tty.out");
spawnSync("mkfifo", [fifo]); writeFileSync(outFile, "");
const fd = openSync(fifo, "r+");
const [sh, shArgs] = ptyScript();
// The exit code travels as a marker line: BSD and util-linux script report it differently.
const proc = spawn(sh, [...shArgs, "sh", "-c", '"$@"; echo "__LICENROUTE_EXIT=$?"', "sh", process.execPath, cli, ...args], { stdio: "ignore", env: { ...process.env, IN: fifo, OUT: outFile } });
let answered = false; let closed = false;
const close = () => { if (!closed) { closed = true; try { closeSync(fd); } catch { /* closed */ } } };
const read = () => readFileSync(outFile, "utf8");
const tick = setInterval(() => {
  const t = read(); const m = /(?:type|escribe) ([A-Z0-9]{4}-[A-Z0-9]{4}) (?:and press Enter|y pulsa Intro)/.exec(t); // en or es
  if (m && !answered) { answered = true; writeSync(fd, `${m[1]}\n`); }
  if (/__LICENROUTE_EXIT=\d+/.test(t)) close();
}, 50);
const timer = setTimeout(() => proc.kill("SIGKILL"), 120_000);
proc.on("close", () => {
  clearInterval(tick); clearTimeout(timer); close();
  const t = read().replace(/\r\n/g, "\n"); rmSync(work, { recursive: true, force: true });
  const code = /__LICENROUTE_EXIT=(\d+)/.exec(t)?.[1];
  process.stdout.write(t.replace(/__LICENROUTE_EXIT=\d+\n?/, ""));
  process.exit(code === undefined ? 1 : Number(code));
});
