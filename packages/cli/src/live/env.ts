/**
 * `licenroute env` (S10.2-B): en qué modo arrancaría la app desde este terminal y qué falta. Solo lectura.
 * Nunca muestra claves, licencias, tokens ni contraseñas: solo su CLASE (demo, real, falta) y si están presentes.
 * Red: un GET sin credenciales a /_botgate/hello (simulador), a la app de demo y, si el endpoint es local o https,
 * a <endpoint>/health/ready. Nada más.
 */
import { loopbackOrigin, probeSimulator, type ProbeState } from "../../bin/demo-common.mjs";
import { demoState, effectiveMode, ENV_FILE, shellState, type DemoState, type Mode } from "../demo-state.ts";
import { t } from "../../bin/i18n.mjs";

export const ENV_SCHEMA = "licenroute.cli.env/v1";
export interface EnvReport {
  schema: typeof ENV_SCHEMA; mode: Mode; reasons: string[];
  endpoint: { url: string | null; reachable: boolean | null; kind: "simulator" | "local" | "remote" | null };
  credentials: { api_key: string; site_id: string; source: "terminal" | "fichero" | null };
  simulator: { state: ProbeState | "absent"; url: string | null; app: string | null };
  app: { state: "running" | "down" | "absent"; url: string | null };
  files: { path: string; state: string }[];
  warnings: string[]; next: string[];
}

const kindText = () => ({ missing: t("env.key_missing"), demo: t("env.key_demo"), real: t("env.key_real"), unknown: t("env.key_unknown") }) as const;

async function reachable(url: string): Promise<boolean> {
  try { const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(2500) }); await r.body?.cancel(); return true; } catch { return false; }
}

export async function runEnv(dir: string, env: NodeJS.ProcessEnv, state: DemoState = demoState(dir)): Promise<EnvReport> {
  const shell = shellState(env);
  const f = state.envFile;
  const { mode, reasons } = effectiveMode(f, shell);
  const warnings: string[] = []; const next: string[] = [];
  // S10.2-D3.1: credenciales reales DENTRO del árbol del proyecto. El Dev Preview no está preparado para ellas: un
  // asistente (o su cliente, como el registro local de Claude Code) puede copiar los ficheros que cambian aunque estén
  // en .gitignore.
  if (f.key === "real" || shell.key === "real") warnings.push(t(f.key === "real" ? "env.real_in_file" : "env.real_in_terminal", { file: ENV_FILE }));
  if (shell.productionSignals.length) warnings.push(t("env.production_signals", { p1: shell.productionSignals.join(", ") }));
  if (f.modeAssigned) warnings.push(t("env.mode_in_file", { ENV_FILE }));
  if (f.symlink) warnings.push(t("env.symlink", { ENV_FILE }));
  if (f.exists && f.mode && f.mode !== "600") warnings.push(t("env.permissions", { ENV_FILE, mode: f.mode }));
  if (f.exists && !state.gitignore.envFile) warnings.push(t("env.not_ignored", { ENV_FILE }));
  if (shell.testProvider) warnings.push(t("env.test_provider", { p1: shell.testProvider.slice(0, 20) }));

  const sim = state.simulator ? await probeSimulator(state.simulator.url, state.simulator.run_id) : null;
  if (sim?.state === "impostor") warnings.push(t("env.impostor", { detail: sim.detail }));
  if (sim?.state === "other-run") warnings.push(t("env.stale_admin_other_run", { detail: sim.detail, p2: ".licenroute/demo-admin.json" }));
  if (sim?.state === "down") warnings.push(t("env.stale_admin"));
  const app = state.demoApp ? ((await reachable(state.demoApp.url)) ? "running" : "down") : "absent";

  const endpoint = f.endpoint;
  let kind: EnvReport["endpoint"]["kind"] = null; let ok: boolean | null = null;
  if (endpoint) {
    const origin = loopbackOrigin(endpoint.replace(/\/+$/, "") + "/");
    const isSim = origin !== null && origin === state.simulator?.url;
    kind = isSim ? "simulator" : f.endpointLoopback ? "local" : "remote";
    if (isSim) ok = sim?.state === "running";
    else if (f.endpointLoopback || endpoint.startsWith("https://")) { try { ok = await reachable(new URL("/health/ready", endpoint).toString()); } catch { ok = false; } }
  }
  if (mode === "demo" && kind === "simulator" && !ok) warnings.push(t("env.demo_simulator_down"));
  if (mode === "none") next.push(t("env.next_dev_credentials"));
  if (mode === "demo" && sim?.state !== "running") next.push("licenroute dev .");
  if (!state.journal) next.unshift(t("env.next_init"));

  const fileState = (exists: boolean, extra: string) => (exists ? extra : t("env.missing"));
  return {
    schema: "licenroute.cli.env/v1", mode, reasons,
    endpoint: { url: endpoint ? endpoint.replace(/\/\/[^/@]*@/, "//***@") : null, reachable: ok, kind },
    credentials: { api_key: kindText()[shell.key !== "missing" ? shell.key : f.key], site_id: kindText()[shell.site !== "missing" ? shell.site : f.site].replace(t("env.present_hidden"), ""), source: shell.key !== "missing" ? "terminal" : f.key !== "missing" ? "fichero" : null },
    simulator: { state: sim?.state ?? "absent", url: state.simulator?.url ?? null, app: state.simulator?.app ?? null },
    app: { state: app, url: state.demoApp?.url ?? null },
    files: [
      { path: ENV_FILE, state: fileState(f.exists, `${f.generatedBySimulator ? t("env.by_simulator") : t("env.by_other")} · permisos ${f.mode ?? "?"} · ${state.gitignore.envFile ? t("env.in_gitignore") : t("env.not_in_gitignore")}`) },
      { path: ".licenroute/demo-admin.json", state: fileState(state.simulator !== null, t("env.admin_token")) },
      { path: ".licenroute/demo-app.json", state: fileState(state.demoApp !== null, t("env.demo_app", { url: state.demoApp?.url })) },
      { path: ".licenroute/journal", state: state.journal ? t("env.integration", { app: state.journal.app, p2: state.journal.plans.map((p) => p.key).join(", ") }) : t("env.no_integration") },
    ],
    warnings, next,
  };
}

export function renderEnv(r: EnvReport): string {
  const MODE = { demo: t("env.mode.demo"), real: t("env.mode.real"), mixed: t("env.mode.mixed"), none: t("env.mode.none") } as const;
  return [
    t("env.header", { p1: MODE[r.mode] }),
    ...r.reasons.map((x) => `  ✗ ${x}`),
    `  endpoint     ${r.endpoint.url ?? "—"}${r.endpoint.kind ? ` (${t(r.endpoint.kind === "simulator" ? "env.endpoint.simulator" : r.endpoint.kind === "local" ? "env.endpoint.local" : "env.endpoint.remote")}${r.endpoint.reachable === null ? t("env.not_checked_suffix") : r.endpoint.reachable ? ", responde" : t("env.not_responding_suffix")})` : ""}`,
    t(r.credentials.source === "terminal" ? "env.key_line_terminal" : "env.key_line", { key: r.credentials.api_key }),
    t("env.site_line", { site_id: r.credentials.site_id }),
    t("env.simulator_line", { value: r.simulator.state === "absent" ? t("env.not_started") : `${r.simulator.state === "running" ? t("dev.state_running") : r.simulator.state} · ${r.simulator.url}` }),
    t("env.app_line", { value: r.app.state === "absent" ? t("env.app_not_started") : `${r.app.state === "running" ? t("dev.app_responds") : t("dev.app_not_responding_short")} · ${r.app.url}` }),
    "", t("env.files_header"), ...r.files.map((f) => `  ${f.path.padEnd(26)} ${f.state}`),
    ...(r.warnings.length ? ["", t("env.warnings_header"), ...r.warnings.map((w) => `  ! ${w}`)] : []),
    ...(r.next.length ? ["", t("env.next_header"), ...r.next.map((n) => `  ${n}`)] : []),
    "", t("env.never_shows"),
  ].join("\n");
}
