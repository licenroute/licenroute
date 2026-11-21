/**
 * Estado del modo demo de un proyecto (S10.2-B), leído sin red ni procesos: lo usan `dev`, `env`, `doctor` y `test`.
 * Solo devuelve CLASES de credenciales (demo, real, falta…), nunca sus valores. La única excepción es el token de
 * administración del simulador (readDemoAdmin), que no sale nunca por pantalla: lo usan `dev --stop` y `test`.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEMO_ADMIN_TOKEN_FORMAT, isLoopbackHost, keyKind, loopbackOrigin, productionSignals, RUN_ID_FORMAT, siteKind, type CredentialKind } from "../bin/demo-common.mjs";
import { detect } from "./detect.ts";
import { readJournals } from "./journal.ts";
import { t } from "../bin/i18n.mjs";

export const DEMO_ADMIN_FILE = join(".licenroute", "demo-admin.json");
export const DEMO_APP_FILE = join(".licenroute", "demo-app.json");
export const ENV_FILE = ".env.licenroute";
const ENTRY = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.(c|m)?(j|t)s$/;

const readJson = (path: string): Record<string, unknown> | null => {
  try { if (lstatSync(path).isSymbolicLink()) return null; const v = JSON.parse(readFileSync(path, "utf8")) as unknown; return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; }
};

export interface DemoAdmin { url: string; run_id: string | null; admin_token: string; app: string | null }
/** .licenroute/demo-admin.json validado: URL de loopback y token con el formato del simulador. Si no, null. */
export function readDemoAdmin(dir: string): DemoAdmin | null {
  const j = readJson(join(dir, DEMO_ADMIN_FILE));
  const url = loopbackOrigin(j?.url);
  if (!j || !url || typeof j.admin_token !== "string" || !DEMO_ADMIN_TOKEN_FORMAT.test(j.admin_token)) return null;
  return { url, admin_token: j.admin_token, run_id: typeof j.run_id === "string" && RUN_ID_FORMAT.test(j.run_id) ? j.run_id : null, app: typeof j.app === "string" ? j.app.slice(0, 40) : null };
}
export function readDemoApp(dir: string): { url: string; run_id: string | null } | null {
  const j = readJson(join(dir, DEMO_APP_FILE));
  const url = loopbackOrigin(j?.url);
  return j && url ? { url, run_id: typeof j.run_id === "string" && RUN_ID_FORMAT.test(j.run_id) ? j.run_id : null } : null;
}

export interface EnvFileState {
  exists: boolean; symlink: boolean; mode: string | null; generatedBySimulator: boolean;
  key: CredentialKind; site: CredentialKind; endpoint: string | null; endpointLoopback: boolean; modeAssigned: boolean;
}
export function envFileState(dir: string): EnvFileState {
  const path = join(dir, ENV_FILE);
  const none: EnvFileState = { exists: false, symlink: false, mode: null, generatedBySimulator: false, key: "missing", site: "missing", endpoint: null, endpointLoopback: false, modeAssigned: false };
  try { if (lstatSync(path).isSymbolicLink()) return { ...none, exists: true, symlink: true }; } catch { return none; }
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { ...none, exists: true }; }
  const v = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1]?.trim().replace(/^'(.*)'$/, "$1") ?? null;
  const endpoint = v("LICENROUTE_ENDPOINT");
  let host = ""; try { host = endpoint ? new URL(endpoint).hostname : ""; } catch { /* no es URL */ }
  return {
    exists: true, symlink: false, mode: (statSync(path).mode & 0o777).toString(8),
    generatedBySimulator: text.startsWith("# Generado por el simulador de LicenRoute"),
    key: keyKind(v("LICENROUTE_API_KEY")), site: siteKind(v("LICENROUTE_SITE_ID")),
    endpoint: endpoint ? endpoint.slice(0, 200) : null, endpointLoopback: host !== "" && isLoopbackHost(host),
    modeAssigned: /^\s*LICENROUTE_MODE\s*=/m.test(text),
  };
}

/** Lo que el terminal del usuario añadiría a la app: `node --env-file` NO sobrescribe variables ya definidas. */
export function shellState(env: NodeJS.ProcessEnv) {
  return {
    key: keyKind(env.LICENROUTE_API_KEY), site: siteKind(env.LICENROUTE_SITE_ID), endpoint: env.LICENROUTE_ENDPOINT ? env.LICENROUTE_ENDPOINT.slice(0, 200) : null,
    mode: env.LICENROUTE_MODE === undefined ? null : env.LICENROUTE_MODE === "demo" ? "demo" : "other",
    testProvider: env.BOTGATE_TEST_PROVIDER ?? null, productionSignals: productionSignals(env),
  };
}

export interface DemoState {
  /** methods (D4.1): los aprobados; vacío = todos (diario de 0.2.2). */
  journal: { app: string; plans: { key: string; pattern: string; methods: string[] }[] } | null;
  simulator: { url: string; run_id: string | null; app: string | null } | null;
  demoApp: { url: string; run_id: string | null } | null;
  envFile: EnvFileState;
  gitignore: { envFile: boolean; licenRouteDir: boolean };
  entry: { file: string | null; candidates: string[] };
  sdk: { declared: boolean; installed: boolean };
  integration: { present: boolean; licensedPaths: string[] | null };
}

export function demoState(dir: string): DemoState {
  const j = readJournals(dir).filter((x) => x.status === "applied").pop();
  const admin = readDemoAdmin(dir);
  const d = detect(dir);
  const fw = d.frameworks.find((f) => f.name === "express");
  const pkg = readJson(join(dir, "package.json")) as { dependencies?: Record<string, unknown> } | null;
  const gi = (() => { try { return readFileSync(join(dir, ".gitignore"), "utf8").split("\n").map((l) => l.trim()); } catch { return []; } })();
  const candidates = (fw?.entry_files ?? []).filter((f) => ENTRY.test(f) && !f.includes("..")).slice(0, 10);
  return {
    journal: j ? { app: j.app, plans: j.plans.map((p) => ({ key: p.key, pattern: p.pattern, methods: Array.isArray(p.methods) ? p.methods.filter((m) => /^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(m)) : [] })) } : null,
    simulator: admin ? { url: admin.url, run_id: admin.run_id, app: admin.app } : null,
    demoApp: readDemoApp(dir),
    envFile: envFileState(dir),
    gitignore: { envFile: gi.some((l) => [ENV_FILE, ".env*", ".env.*"].includes(l)), licenRouteDir: gi.some((l) => [".licenroute", ".licenroute/", "/.licenroute", "/.licenroute/"].includes(l)) },
    entry: { file: candidates.length === 1 ? candidates[0]! : null, candidates },
    sdk: { declared: typeof pkg?.dependencies?.["@licenroute/connect-express"] === "string", installed: (() => { try { return statSync(join(dir, "node_modules", "@licenroute", "connect-express", "package.json")).isFile(); } catch { return false; } })() },
    integration: { present: d.licenroute.present, licensedPaths: d.licenroute.licensed_paths ?? null },
  };
}

export type Mode = "demo" | "real" | "mixed" | "none";
/** Qué credenciales recibiría la app con `node --env-file=.env.licenroute` desde este terminal, y por qué. */
export function effectiveMode(file: EnvFileState, shell: ReturnType<typeof shellState>): { mode: Mode; reasons: string[] } {
  const reasons: string[] = [];
  const key = shell.key !== "missing" ? shell.key : file.key;
  const site = shell.site !== "missing" ? shell.site : file.site;
  if (shell.key !== "missing" && file.key !== "missing" && shell.key !== file.key) reasons.push(t("demo.shell_key_wins", { keyValue: shell.key, ENV_FILE, keyValue_: file.key }));
  if (shell.site !== "missing" && file.site !== "missing" && shell.site !== file.site) reasons.push(t("demo.shell_site_wins", { site: shell.site, ENV_FILE, site_: file.site }));
  if (key === "missing" && site === "missing") return { mode: "none", reasons };
  if (key !== site) reasons.push(t("demo.mixed", { keyValue: key, site }));
  if (key === "demo" && file.endpoint && !file.endpointLoopback) reasons.push(t("demo.demo_not_local"));
  if (key === "demo" && shell.mode === "other") reasons.push(t("demo.mode_not_demo"));
  if (key === "real" && shell.mode === "demo") reasons.push(t("demo.mode_demo_real"));
  if (key === "unknown" || site === "unknown") reasons.push(t("demo.unknown_format"));
  if (reasons.length) return { mode: "mixed", reasons };
  return { mode: key === "demo" ? "demo" : "real", reasons };
}
