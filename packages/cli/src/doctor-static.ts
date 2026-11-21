/**
 * `licenroute doctor`, parte ESTÁTICA (S6): todo lo que necesita leer o analizar el proyecto. Corre sin permiso para
 * lanzar procesos ni red; entrega a la parte activa (src/live/doctor.ts) solo un contexto pequeño y validado, de modo
 * que el parser de un proyecto ajeno nunca se ejecuta con capacidades que no necesita.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { covers } from "./apply.ts";
import { detect } from "./detect.ts";
import { readJournals } from "./journal.ts";
import { credentialHint } from "./sandbox-hint.ts";
import { demoState, effectiveMode, readDemoAdmin, shellState } from "./demo-state.ts";
import { t } from "../bin/i18n.mjs";

export interface Finding { id: string; level: "ok" | "warn" | "fail" | "info"; message: string }
/** Lo único que pasa de la parte estática a la activa. */
export interface DoctorContext { framework: "express" | "rails" | null; licensedPaths: string[]; exampleRoute: string | null; endpoint: string | null; envInstance: string | null; demo?: DemoDoctorContext | null }
/** Modo demo (S10.2-B): solo si el proveedor elegido es el simulador, como en `licenroute test`. */
export interface DemoDoctorContext {
  simulator: { url: string; run_id: string | null; admin_token: string } | null;
  appUrl: string | null; journalApp: string | null; envEndpoint: string | null;
  mode: "demo" | "real" | "mixed" | "none"; reasons: string[]; productionSignals: string[]; modeAssigned: boolean;
}

/** Igual que `licenroute test`: BOTGATE_TEST_PROVIDER manda; si no, hay demo si el proyecto tiene un simulador o credenciales de demo. */
export function demoSelected(dir: string, env: NodeJS.ProcessEnv): boolean {
  if (env.BOTGATE_TEST_PROVIDER) return env.BOTGATE_TEST_PROVIDER === "demo";
  const st = demoState(dir);
  return st.simulator !== null || st.envFile.key === "demo";
}

/** Del .env de la app, SOLO metadatos (instancia, endpoint, sitio, permisos). La clave nunca sale de aquí. */
export function envMeta(file: string): { exists: boolean; mode: string | null; instance: string | null; endpoint: string | null; siteId: string | null } {
  let text: string; let mode: string;
  try { text = readFileSync(file, "utf8"); mode = (statSync(file).mode & 0o777).toString(8); } catch { return { exists: false, mode: null, instance: null, endpoint: null, siteId: null }; }
  const v = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;
  return { exists: true, mode, instance: /instancia=([a-z0-9-]+)/.exec(text.split("\n")[0] ?? "")?.[1] ?? v("BOTGATE_SANDBOX_INSTANCE"), endpoint: v("LICENROUTE_ENDPOINT"), siteId: v("LICENROUTE_SITE_ID") };
}

export function staticDoctor(opts: { dir: string; app: string | null; instance: string; envFile: string }): { findings: Finding[]; ctx: DoctorContext } {
  const f: Finding[] = [];
  const add = (id: string, level: Finding["level"], message: string) => f.push({ id, level, message });
  const ctx: DoctorContext = { framework: null, licensedPaths: [], exampleRoute: null, endpoint: null, envInstance: null };
  const d = detect(opts.dir);
  const fw = d.frameworks[0];
  if (!fw) { add("framework", "fail", t("doctor.no_framework")); return { findings: f, ctx }; }
  ctx.framework = fw.name;
  add("framework", fw.supported ? "ok" : "fail", `${fw.name} ${fw.version ?? t("doctor.version_unknown")}${fw.supported ? "" : t("doctor.unsupported_suffix")}`);

  if (fw.name === "express") {
    const pkg = (() => { try { return JSON.parse(readFileSync(join(opts.dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }; } catch { return null; } })();
    const declared = Boolean(pkg?.dependencies?.["@licenroute/connect-express"]);
    add("sdk", declared ? "ok" : "fail", declared ? t("doctor.sdk_declared") : t("doctor.sdk_not_declared"));
    const installed = existsSync(join(opts.dir, "node_modules", "@licenroute", "connect-express", "package.json"));
    if (declared) add("sdk-instalado", installed ? "ok" : "warn", installed ? t("doctor.sdk_installed") : t("doctor.sdk_not_installed"));
  } else {
    const gem = (() => { try { return readFileSync(join(opts.dir, "Gemfile"), "utf8"); } catch { return ""; } })();
    const lock = (() => { try { return readFileSync(join(opts.dir, "Gemfile.lock"), "utf8"); } catch { return ""; } })();
    const declared = /gem\s+["']botgate-connect["']/.test(gem);
    add("sdk", declared ? "ok" : "fail", declared ? t("doctor.gem_declared") : t("doctor.gem_not_declared"));
    if (declared) add("sdk-instalado", lock.includes("botgate-connect") ? "ok" : "warn", lock.includes("botgate-connect") ? t("doctor.gem_locked") : t("doctor.gem_not_locked"));
  }

  const lp = d.licenroute.licensed_paths;
  if (!d.licenroute.present) add("integracion", "fail", t("doctor.no_middleware"));
  else if (!lp) add("integracion", "warn", t("doctor.licensed_not_literal"));
  else {
    ctx.licensedPaths = lp;
    add("integracion", "ok", t("doctor.middleware_present", { p1: lp.join(", ") }));
    const routes = d.routes.filter((r) => r.framework === fw.name);
    const exposed = routes.filter((r) => r.path && lp.some((p) => covers(p, r.path!)) && !r.signals.behind_licenroute);
    if (exposed.length) add("proteccion", "fail", t("doctor.exposed", { p1: exposed.map((r) => `${r.method} ${r.path} (${r.source.file}:${r.source.line})`).join(", ") }));
    else add("proteccion", "ok", t("doctor.all_behind"));
    const dyn = routes.filter((r) => r.path === null).length;
    if (dyn) add("rutas-dinamicas", "warn", t("doctor.dynamic_routes", { dyn }));
    ctx.exampleRoute = routes.find((r) => r.path && r.method === "GET" && r.resolution === "static" && lp.some((p) => covers(p, r.path!)))?.path ?? null;
  }
  const j = readJournals(opts.dir).filter((x) => x.status === "applied").pop();
  if (j) {
    const sha = (p: string) => { try { return createHash("sha256").update(readFileSync(join(opts.dir, p), "utf8")).digest("hex"); } catch { return null; } };
    const changed = j.files.filter((x) => { const h = sha(x.path); return h !== null && h !== x.after_sha256; });
    add("diario", changed.length ? "info" : "ok", changed.length ? t("doctor.modified_after", { p1: changed.map((x) => x.path).join(", ") }) : t("doctor.integration", { id: j.id }));
  }

  const gi = (() => { try { return readFileSync(join(opts.dir, ".gitignore"), "utf8").split("\n").map((l) => l.trim()); } catch { return []; } })();
  const ignored = gi.includes(".env.licenroute") || gi.includes(".env*") || gi.includes(".env.*");
  add("gitignore", ignored ? "ok" : "fail", ignored ? t("doctor.env_ignored") : t("doctor.env_not_ignored"));
  const meta = envMeta(join(opts.dir, opts.envFile));
  if (!meta.exists) add("credenciales", "warn", credentialHint(opts.envFile, opts.app ?? "<app>"));
  else {
    add("credenciales", meta.mode === "600" ? "ok" : "warn", t(meta.mode === "600" ? "doctor.env_file_ok" : "doctor.env_file_perms", { file: opts.envFile, mode: meta.mode, site: meta.siteId ?? "?" }));
    if (meta.instance && meta.instance !== opts.instance) add("instancia", "fail", t("doctor.env_other_instance", { envFile: opts.envFile, instance: meta.instance, instance_: opts.instance }));
    ctx.endpoint = meta.endpoint; ctx.envInstance = meta.instance;
  }
  if (demoSelected(opts.dir, process.env)) {
    const st = demoState(opts.dir); const admin = readDemoAdmin(opts.dir);
    const { mode, reasons } = effectiveMode(st.envFile, shellState(process.env));
    ctx.demo = {
      simulator: admin ? { url: admin.url, run_id: admin.run_id, admin_token: admin.admin_token } : null,
      appUrl: st.demoApp?.url ?? null, journalApp: st.journal?.app ?? null, envEndpoint: st.envFile.endpoint,
      mode, reasons, productionSignals: shellState(process.env).productionSignals, modeAssigned: st.envFile.modeAssigned,
    };
  }
  return { findings: f, ctx };
}
