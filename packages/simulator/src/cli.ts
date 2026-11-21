/**
 * licenroute-simulator (S10.2-A): arranca el simulador del modo demo para UNA app y deja preparados sus ficheros.
 * Orden de bajo nivel; S10.2-B la envolverá como `licenroute dev`.
 *
 *   licenroute-simulator --app <nombre> --plan <clave>=<patrón>[:<cuota>][@<MÉTODO,…>] [--plan …] [--dir <proyecto>] [--port <1024-65535>]
 *   (sin @métodos, la licencia se exige en todos los métodos, como un plan de Central sin métodos)
 *
 *  - <proyecto>/.env.licenroute         credenciales de DEMO (0600). Nunca sobrescribe un fichero con credenciales reales.
 *  - <proyecto>/.licenroute/demo-admin.json   URL y token de administración de esta ejecución (0600); se borra al salir.
 * El segundo factor NO va en .env.licenroute: la app se arranca con LICENROUTE_MODE=demo en su entorno.
 * Sigue en primer plano hasta Ctrl+C. Solo escucha en 127.0.0.1.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEMO_MODE_ENV, REAL_API_KEY_FORMAT } from "@licenroute/policy-contracts";
import { SIMULATOR_SCHEMA, startSimulator, type PlanConfig } from "./index.ts";
import { t } from "../../cli/bin/i18n.mjs";

const APP = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PLAN = /^([a-z0-9][a-z0-9-]{0,39})=(\/[A-Za-z0-9/_*?.-]{0,200})(?::(\d{1,7}))?(?:@([A-Za-z]{3,7}(?:,[A-Za-z]{3,7}){0,5}))?$/;
export const ADMIN_FILE = join(".licenroute", "demo-admin.json");

export function parseArgs(argv: string[]): { app: string; plans: PlanConfig[]; dir: string; port?: number } {
  let app: string | null = null; let dir = "."; const plans: PlanConfig[] = []; let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; const value = argv[i + 1];
    if (flag === "--app" && value) { app = value; i++; }
    else if (flag === "--dir" && value) { dir = value; i++; }
    else if (flag === "--port" && value) {
      if (!/^\d{4,5}$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error(t("simulator.port_invalid", { p1: value.slice(0, 20) }));
      port = Number(value); i++;
    }
    else if (flag === "--plan" && value) {
      const m = PLAN.exec(value);
      if (!m) throw new Error(t("simulator.plan_invalid", { value }));
      plans.push({ key: m[1]!, pattern: m[2]!, quota: Number(m[3] ?? 3), ...(m[4] ? { methods: m[4].split(",").map((x) => x.toUpperCase()) } : {}) });
      i++;
    } else throw new Error(t("simulator.unknown_argument", { flag }));
  }
  if (!app || !APP.test(app)) throw new Error(t("simulator.app_required"));
  if (!plans.length) throw new Error(t("simulator.plan_required"));
  return { app, plans, dir: resolve(dir), ...(port ? { port } : {}) };
}

/** No pisa credenciales reales ni un fichero que no sea del simulador. */
export function assertEnvWritable(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error(t("simulator.env_link", { path }));
  const text = readFileSync(path, "utf8");
  const key = /^LICENROUTE_API_KEY=(.*)$/m.exec(text)?.[1]?.trim() ?? "";
  if (REAL_API_KEY_FORMAT.test(key)) throw new Error(t("simulator.env_real", { path }));
  if (!text.startsWith("# Generado por el simulador de LicenRoute")) throw new Error(t("simulator.env_foreign", { path }));
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export async function main(argv: string[]): Promise<number> {
  let args;
  try { args = parseArgs(argv); } catch (e) { process.stderr.write(`licenroute-simulator: ${(e as Error).message}\n`); return 2; }
  const envPath = join(args.dir, ".env.licenroute");
  const adminPath = join(args.dir, ADMIN_FILE);
  try { assertEnvWritable(envPath); } catch (e) { process.stderr.write(`licenroute-simulator: ${(e as Error).message}\n`); return 5; }
  let stop = () => {};
  let sim;
  try { sim = await startSimulator({ sites: [{ app: args.app, plans: args.plans }], ...(args.port ? { port: args.port } : {}), onShutdown: () => stop() }); }
  catch (e) {
    const code = (e as { code?: string }).code;
    process.stderr.write(`licenroute-simulator: ${code === "EADDRINUSE" ? t("simulator.port_busy", { port: args.port }) : (e as Error).message}\n`);
    return code === "EADDRINUSE" ? 6 : 1;
  }
  const c = sim.sites[0]!;
  const cleanup = () => { try { rmSync(adminPath, { force: true }); } catch { /* ya no está */ } };
  try {
    // Escritura directa (no temporal + rename): el lanzador solo concede escribir este fichero exacto.
    writeFileSync(envPath, [
      `# Generado por el simulador de LicenRoute (MODO DEMO, no productivo) · instancia=default · app=${args.app}`,
      `# Credenciales de demo de ESTA ejecución: solo valen contra el simulador local. Arranca la app con ${DEMO_MODE_ENV}=demo.`,
      `LICENROUTE_SITE_ID=${c.site_id}`,
      `LICENROUTE_API_KEY=${c.api_key}`,
      `LICENROUTE_ENDPOINT=${c.endpoint}`,
      `LICENROUTE_LICENSED_PATHS='${JSON.stringify(args.plans.map((p) => p.pattern))}'`,
      `LICENROUTE_INSTANCE_ID=demo-${args.app}`,
      "",
    ].join("\n"), { mode: 0o600 });
    chmodSync(envPath, 0o600);
    if (!existsSync(join(args.dir, ".licenroute"))) mkdirSync(join(args.dir, ".licenroute"), { mode: 0o700 });
    writePrivate(adminPath, `${JSON.stringify({ schema: SIMULATOR_SCHEMA, url: sim.url, admin_token: sim.adminToken, run_id: sim.runId, app: args.app, pid: process.pid, created_at: new Date().toISOString() }, null, 2)}\n`);
  } catch (e) {
    cleanup(); await sim.close();
    process.stderr.write(t("simulator.write_failed", { message: (e as Error).message }));
    return 1;
  }
  const canRead = (p: string) => { try { return (process as unknown as { permission?: { has(s: string, r?: string): boolean } }).permission?.has("fs.read", p) ?? null; } catch { return null; } };
  process.stdout.write([
    t("simulator.banner", { url: sim.url, app: args.app, p3: args.plans.map((p) => `${p.key}=${p.pattern}:${p.quota}`).join(", ") }),
    t("simulator.banner_files", { ADMIN_FILE }),
    t(canRead("/etc") === false ? "simulator.permissions_on" : "simulator.permissions_off"),
    t("simulator.banner_start_app", { DEMO_MODE_ENV }),
    t("simulator.banner_check", { app: args.app }),
    t("simulator.banner_stop"),
    "",
  ].join("\n"));
  await new Promise<void>((done) => {
    let stopped = false;
    stop = () => { if (stopped) return; stopped = true; clearInterval(orphan); cleanup(); sim.close().then(done, done); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    // Si quien lo lanzó (licenroute dev, npx o el terminal) desaparece sin avisar, p. ej. con SIGKILL, el simulador no se
    // queda huérfano con credenciales vivas: se para y borra su administración.
    const parent = process.ppid;
    const orphan = setInterval(() => { if (process.ppid !== parent) stop(); }, 1000);
    orphan.unref();
  });
  process.stdout.write(t("simulator.stopped"));
  return 0;
}
