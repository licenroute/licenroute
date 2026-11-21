// Responde al reto de LicenRoute en un pseudoterminal real (script), como lo haría una persona: lee el reto que aparece
// en /dev/tty y lo teclea. Lo usan las pruebas de init --write, assistant --approve y dev --start-app.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ptyScript } from "../../../test/platform.mjs";

export interface PtyRun { proc: ChildProcess; output(): string; done: Promise<string> }

/** answer: "challenge" teclea el reto mostrado; cualquier otro texto se teclea tal cual (para comprobar el rechazo). */
export function withChallenge(cmd: string, args: string[], env: NodeJS.ProcessEnv, answer = "challenge"): PtyRun {
  const work = mkdtempSync(join(tmpdir(), "licenroute-pty-"));
  const fifo = join(work, "tty.fifo"); const outFile = join(work, "tty.out");
  spawnSync("mkfifo", [fifo]); writeFileSync(outFile, "");
  const fd = openSync(fifo, "r+");
  const [sh, shArgs] = ptyScript() as [string, string[]];
  const proc = spawn(sh, [...shArgs, cmd, ...args], { stdio: "ignore", env: { ...env, IN: fifo, OUT: outFile } });
  const output = () => readFileSync(outFile, "utf8");
  let answered = false; let closed = false;
  const close = () => { if (!closed) { closed = true; try { closeSync(fd); } catch { /* cerrado */ } } };
  const tick = setInterval(() => {
    const t = output();
    const m = /(?:escribe|type) ([A-Z0-9]{4}-[A-Z0-9]{4}) (?:y pulsa Intro|and press Enter)/.exec(t); // es o en (D4.4)
    if (m && !answered) { answered = true; writeSync(fd, `${answer === "challenge" ? m[1] : answer}\n`); }
    if (answered && /Aprobación confirmada\.|No confirmado|Approval confirmed\.|Not confirmed/.test(t)) close(); // como la prueba de aceptación: fin de la entrada
  }, 100);
  const kill = setTimeout(() => proc.kill(), 90_000);
  const done = new Promise<string>((ok) => proc.on("close", () => { clearInterval(tick); clearTimeout(kill); close(); ok(output()); }));
  return { proc, output, done };
}
