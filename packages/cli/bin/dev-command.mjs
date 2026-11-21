// `licenroute dev` (S10.2-B), parte del LANZADOR: arranca y para el simulador del modo demo y, si se pide, la app.
// La CLI (fase estática, sin red ni procesos) solo le da el estado del proyecto. Reglas:
//   - todo en 127.0.0.1; puertos validados (1024-65535) y comprobados libres; una sesión por proyecto;
//   - el simulador corre con el modelo de permisos: lee el paquete y el proyecto, escribe SOLO .env.licenroute y
//     .licenroute/, sin procesos hijos. Sus credenciales son de demo y de esta ejecución; al parar borra su administración;
//   - antes de enviar el token de administración (--stop), se comprueba sin credenciales que quien escucha es ESTE
//     simulador (mismo run_id). Un impostor nunca recibe el token;
//   - la app (--start-app) NUNCA se arranca con un script de package.json: el comando lo construye LicenRoute
//     (node + el fichero de la app que detectó), se muestra entero y exige un reto en el terminal. Corre con el modelo
//     de permisos (lee solo el proyecto, sin escritura ni procesos hijos) y con un entorno mínimo: no hereda tokens,
//     claves, proxies ni NODE_OPTIONS del terminal, ni nada del simulador.
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import { portBusy, probeSimulator, validPort } from "./demo-common.mjs";
import { getLang, t } from "./i18n.mjs";

export const SESSION_FILE = join(".licenroute", "dev-session.json");
export const APP_FILE = join(".licenroute", "demo-app.json");
const ENTRY = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.(c|m)?(j|t)s$/;
const say = (m) => process.stdout.write(`${m}\n`);
const fail = (m, code = 2) => { process.stderr.write(t("dev.error", { m })); return code; };

/** Entorno de la app: lista blanca. Nada del terminal que no sea imprescindible para Node y la consola. */
export function appEnv(base, port) {
  const env = {};
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LICENROUTE_LANG", "TZ", "TMPDIR", "TERM", "SystemRoot", "WINDIR"]) if (base[k] !== undefined) env[k] = base[k];
  for (const k of Object.keys(base)) if (/^LC_[A-Z]+$/.test(k)) env[k] = base[k];
  env.PORT = String(port);
  env.LICENROUTE_MODE = "demo";
  return env;
}

/** El comando exacto de la app. Solo `node` y un fichero de la app dentro del proyecto. */
export function appCommand(real, entry, port) {
  if (!ENTRY.test(entry) || entry.split(/[\\/]/).includes("..")) throw new Error(t("dev.entry_invalid", { p1: String(entry).slice(0, 80) }));
  const abs = join(real, entry);
  if (!existsSync(abs)) throw new Error(t("dev.entry_missing", { entry }));
  const resolved = realpathSync(abs);
  if (!resolved.startsWith(real + sep) || lstatSync(abs).isSymbolicLink()) throw new Error(t("dev.entry_outside", { entry }));
  const args = ["--permission", `--allow-fs-read=${real}`, `--env-file=${join(real, ".env.licenroute")}`, "--disable-warning=ExperimentalWarning", resolved];
  return { file: process.execPath, args, display: `PORT=${port} LICENROUTE_MODE=demo ${process.execPath} ${args.join(" ")}` };
}

/** Reto en el terminal de control (/dev/tty). Sin terminal, o con cualquier otra respuesta, no se arranca nada. */
function ttyConfirm(lines) {
  let fd;
  try { fd = openSync("/dev/tty", "r+"); } catch { return false; }
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const challenge = Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + letters[randomInt(letters.length)]).join("");
  writeSync(fd, t("dev.prompt", { p1: lines.join("\n"), challenge }));
  const buf = Buffer.alloc(64); let line = "";
  for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; line += buf.subarray(0, n).toString("utf8"); if (line.includes("\n") || line.length > 60) break; }
  const ok = line.trim().toUpperCase() === challenge;
  writeSync(fd, ok ? t("consent.confirmed") : t("dev.not_confirmed")); closeSync(fd);
  return ok;
}

const removeOwn = (real, rel) => { const p = join(real, rel); try { if (!lstatSync(p).isSymbolicLink()) rmSync(p, { force: true }); } catch { /* no existe */ } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prefix = (stream, tag) => { let rest = ""; stream.setEncoding("utf8"); stream.on("data", (c) => { const parts = (rest + c).split("\n"); rest = parts.pop(); for (const l of parts) say(`${tag} ${l}`); }); };

async function status(info) {
  const lines = [t("dev.status_header")];
  if (!info.simulator) lines.push(t("dev.status_simulator_off"));
  else { const p = await probeSimulator(info.simulator.url, info.simulator.run_id); lines.push(t("dev.status_simulator", { state: p.state === "running" ? t("dev.state_running") : p.state === "down" ? t("dev.state_down") : t("dev.state_foreign", { detail: p.detail }), url: info.simulator.url })); }
  if (!info.demoApp) lines.push(t("dev.status_app_off"));
  else { let up = false; try { const r = await fetch(info.demoApp.url, { redirect: "error", signal: AbortSignal.timeout(1500) }); await r.body?.cancel(); up = true; } catch { /* no responde */ } lines.push(t("dev.status_app", { state: up ? t("dev.app_responds") : t("dev.app_not_responding_short"), url: info.demoApp.url })); }
  lines.push(t("dev.status_integration_line", { value: info.journal ? t("dev.status_integration", { app: info.journal.app, p2: info.journal.plans.map((p) => p.key).join(", ") }) : t("dev.status_no_integration") }));
  say(lines.join("\n"));
  return 0;
}

async function stop(real, info) {
  if (!info.simulator) { say(t("dev.stop_none")); return 0; }
  const p = await probeSimulator(info.simulator.url, info.simulator.run_id);
  if (p.state === "down") { removeOwn(real, ".licenroute/demo-admin.json"); removeOwn(real, APP_FILE); say(t("dev.stop_gone")); return 0; }
  if (p.state !== "running" || !info.admin_token) return fail(t("dev.stop_impostor", { detail: p.detail }), 6);
  const r = await fetch(`${info.simulator.url}/_botgate/test-admin/v1/shutdown`, { method: "POST", headers: { authorization: `Bearer ${info.admin_token}` }, redirect: "error", signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!r || r.status !== 200) return fail(t("dev.stop_refused"), 1);
  for (let i = 0; i < 30 && (await probeSimulator(info.simulator.url, info.simulator.run_id, 300)).state === "running"; i++) await sleep(100);
  say(t("dev.stopped"));
  return 0;
}

/**
 * opts: { real, flags:Set, values:{}, info (fase estática), simulator: { entry, read: [], nodeArgs: [] } }
 * Devuelve el código de salida (en primer plano, al terminar la sesión).
 */
export async function runDev(opts) {
  const { real, flags, values, info } = opts;
  if (flags.has("--status")) return status(info);
  if (flags.has("--stop")) return stop(real, info);
  if (info.production_signals?.length) return fail(t("dev.production_signals", { p1: info.production_signals.join(", ") }), 5);
  if (!info.journal) return fail(t("dev.no_integration"), 3);
  if (info.envFile?.key === "real" || (info.envFile?.exists && !info.envFile.generatedBySimulator)) return fail(t("dev.env_not_simulator"), 5);
  for (const k of ["--port", "--app-port"]) if (values[k] !== undefined && !validPort(values[k])) return fail(t("dev.port_range", { k }));
  if (values["--quota"] !== undefined && !/^\d{1,4}$/.test(values["--quota"])) return fail(t("dev.quota_invalid"));

  // Una sesión por proyecto.
  const lock = join(real, SESSION_FILE);
  try {
    const prev = JSON.parse(readFileSync(lock, "utf8"));
    if (Number.isInteger(prev.pid) && alive(prev.pid)) return fail(t("dev.session_exists", { pid: prev.pid }), 6);
    removeOwn(real, SESSION_FILE);
  } catch { /* no hay sesión */ }
  if (info.simulator) {
    const p = await probeSimulator(info.simulator.url, info.simulator.run_id);
    if (p.state === "running") return fail(t("dev.simulator_exists", { url: info.simulator.url }), 6);
    if (p.state !== "down") say(t("dev.ignore_impostor", { detail: p.detail }));
    removeOwn(real, ".licenroute/demo-admin.json");
  }
  removeOwn(real, APP_FILE);
  if (values["--port"] && (await portBusy(Number(values["--port"])))) return fail(t("dev.port_busy", { p1: values["--port"] }), 6);

  // App: se decide y se confirma ANTES de arrancar nada.
  let app = null;
  if (flags.has("--start-app")) {
    const entry = values["--entry"] ?? info.entry?.file;
    if (!entry) return fail(info.entry?.candidates?.length ? t("dev.several_apps", { p1: info.entry.candidates.join(", ") }) : t("dev.entry_unknown"));
    if (values["--entry"] && !info.entry?.candidates?.includes(values["--entry"])) say(t("dev.entry_not_detected", { p1: values["--entry"] }));
    let port = values["--app-port"] ? Number(values["--app-port"]) : null;
    if (port && (await portBusy(port))) return fail(t("dev.app_port_busy", { port }), 6);
    if (!port) { for (let p = 3400; p < 3420 && !port; p++) if (!(await portBusy(p))) port = p; }
    if (!port) return fail(t("dev.no_free_port"));
    try { app = { ...appCommand(real, entry, port), port }; } catch (e) { return fail(e.message, 5); }
    const ok = ttyConfirm([
      t("dev.start_app_header"),
      `  ${app.display}`,
      t("dev.start_app_env"),
      t("dev.start_app_permissions"),
      t("dev.start_app_stop"),
    ]);
    if (!ok) return fail(t("dev.start_app_refused"), 5);
  }

  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
  // D4.1: el simulador exige licencia solo en los métodos aprobados (sin @, en todos: diario de 0.2.2).
  const plans = info.journal.plans.map((p) => `${p.key}=${p.pattern}:${values["--quota"] ?? 3}${p.methods?.length ? `@${p.methods.join(",")}` : ""}`);
  const roots = (paths) => { const u = [...new Set(paths)]; return u.filter((p) => !u.some((q) => q !== p && p.startsWith(q.endsWith(sep) ? q : q + sep))); };
  // El simulador y la app hablan el idioma resuelto por la CLI (D4.4).
  const simEnv = { ...process.env, LICENROUTE_LANG: getLang() };
  for (const k of ["NODE_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete simEnv[k];
  const sim = spawn(process.execPath, [
    "--max-old-space-size=256", "--permission", ...roots([...opts.simulator.read, real]).map((d) => `--allow-fs-read=${d}`),
    `--allow-fs-write=${join(real, ".env.licenroute")}`, `--allow-fs-write=${join(real, ".licenroute")}`, `--allow-fs-write=${join(real, ".licenroute", "*")}`,
    "--disable-warning=ExperimentalWarning", "--disable-warning=SecurityWarning", ...opts.simulator.nodeArgs, opts.simulator.entry,
    "--app", info.journal.app, ...plans.flatMap((p) => ["--plan", p]), "--dir", real, ...(values["--port"] ? ["--port", values["--port"]] : []),
  ], { stdio: ["ignore", "pipe", "pipe"], env: simEnv });
  prefix(sim.stdout, t("dev.sim_prefix")); prefix(sim.stderr, t("dev.sim_prefix"));
  let appProc = null; let finished = false;
  const cleanup = () => { removeOwn(real, APP_FILE); removeOwn(real, SESSION_FILE); };
  const done = new Promise((resolveDone) => {
    const end = (code) => { if (finished) return; finished = true; if (appProc && appProc.exitCode === null) appProc.kill("SIGTERM"); if (sim.exitCode === null) sim.kill("SIGTERM"); cleanup(); resolveDone(code); };
    sim.on("exit", (code) => { say(code ? t("dev.simulator_ended_code", { code }) : t("dev.simulator_ended")); end(code ?? 0); });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { say(t("dev.stopping")); end(0); });
    opts.onEnd = end;
  });

  // Espera a que el simulador esté listo y sea el nuestro.
  const readDemoAdminFile = () => { try { return JSON.parse(readFileSync(join(real, ".licenroute", "demo-admin.json"), "utf8")); } catch { return null; } };
  let admin = null;
  for (let i = 0; i < 100 && !finished && !admin; i++) { const a = readDemoAdminFile(); if (a?.run_id && (await probeSimulator(a.url, a.run_id, 300)).state === "running") admin = a; else await sleep(100); }
  if (!admin) { if (!finished) { opts.onEnd(1); } await done; return fail(t("dev.simulator_failed"), 1); }

  if (app) {
    appProc = spawn(app.file, app.args, { cwd: real, stdio: ["ignore", "pipe", "pipe"], env: appEnv({ ...process.env, LICENROUTE_LANG: getLang() }, app.port) });
    prefix(appProc.stdout, "[app]"); prefix(appProc.stderr, "[app]");
    appProc.on("exit", (code, signal) => { if (!finished) say(t("dev.app_ended", { how: signal ?? t("dev.exit_code", { code }) })); });
    const url = `http://127.0.0.1:${app.port}`;
    let up = false;
    for (let i = 0; i < 100 && !up && appProc.exitCode === null; i++) { try { const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(300) }); await r.body?.cancel(); up = true; } catch { await sleep(150); } }
    if (up) writeFileSync(join(real, APP_FILE), `${JSON.stringify({ url, run_id: admin.run_id, started_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    else say(t("dev.app_not_responding", { url }));
  }
  say([
    "", t("dev.banner"),
    t("dev.banner_simulator", { url: admin.url }),
    app ? `  app        http://127.0.0.1:${app.port}` : t("dev.banner_app_manual"),
    app ? t("dev.banner_test") : t("dev.banner_test_manual"),
    t("dev.banner_stop"), "",
  ].join("\n"));
  return done;
}
