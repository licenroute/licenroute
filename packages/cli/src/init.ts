/**
 * `licenroute init` (S10.2-B): la entrada guiada. SOLO LECTURA: reutiliza detect, plan y prepareApply.
 *  - sin --plans: enumera los planes propuestos (numerados), lo que no se toca y lo que requiere revisión manual;
 *  - con --plans 1,2 (o por nombre): muestra la vista previa completa de apply, sin escribir;
 *  - con --write: el LANZADOR lo convierte en `apply --approve <código>`, que exige el reto en el terminal.
 * Solo se pueden elegir planes propuestos: nunca rutas dinámicas, parciales, ambiguas o que requieren decisión.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { prepareApply, type Prepared } from "./apply.ts";
import { detect } from "./detect.ts";
import { plan, PlanError } from "./plan.ts";
import { unsupportedTarget, WRITE_TARGETS } from "./targets.ts";
import { sdkSpecLabel } from "./util.ts";
import { t } from "../bin/i18n.mjs";

export const INIT_SCHEMA = "licenroute.cli.init/v1";
const APP = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Nombre de la app para LicenRoute: el de package.json (o del directorio), normalizado. Se puede cambiar con --app. */
export function defaultAppName(dir: string): string {
  let raw = "";
  try { raw = String((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name ?? ""); } catch { /* sin package.json */ }
  const norm = (s: string) => s.toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const name = norm(raw) || norm(basename(dir));
  return APP.test(name) ? name : "mi-api";
}

export interface InitPlan { n: number; key: string; pattern: string; methods: string[]; routes: string[]; reason: string }
export interface InitResult {
  ok: boolean; errors: string[]; framework: string | null; app: string; sdk: { declared: string | null; tgz: string | null };
  plans: InitPlan[]; untouched: string[]; needsDecision: string[]; unresolved: string[];
  selection: string[]; planSha: string | null; preview: Prepared | null;
}

/** Convierte «1,2» o «api-informes,2» en claves de planes PROPUESTOS. Cualquier otra cosa es un error. */
export function selectPlans(spec: string, plans: InitPlan[]): { keys: string[]; errors: string[] } {
  const keys: string[] = []; const errors: string[] = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const p = /^\d{1,3}$/.test(raw) ? plans.find((x) => x.n === Number(raw)) : plans.find((x) => x.key === raw);
    if (!p) { errors.push(t("init.plan_unknown", { p1: raw.slice(0, 60), p2: plans.map((x) => `${x.n}=${x.key}`).join(", ") || t("common.none_m") })); continue; }
    if (!keys.includes(p.key)) keys.push(p.key);
  }
  if (!keys.length && !errors.length) errors.push(t("init.pick_plan"));
  return { keys, errors };
}

export function runInit(opts: { dir: string; plans?: string; app?: string; sdk?: string | null; instance: string; target?: "express" | "rails" }): InitResult {
  const d = detect(opts.dir);
  const app = opts.app ?? defaultAppName(opts.dir);
  const pkgDeclared = (() => { try { const v = (JSON.parse(readFileSync(join(opts.dir, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> }).dependencies?.["@licenroute/connect-express"]; return typeof v === "string" ? v.slice(0, 120) : null; } catch { return null; } })();
  const base: InitResult = { ok: false, errors: [], framework: null, app, sdk: { declared: pkgDeclared, tgz: opts.sdk ?? null }, plans: [], untouched: [], needsDecision: [], unresolved: [], selection: [], planSha: null, preview: null };
  if (!APP.test(app)) return { ...base, errors: [t("init.app_invalid")] };
  let p;
  try { p = plan(d, opts.target); } catch (e) { if (e instanceof PlanError) return { ...base, errors: [e.message] }; throw e; }
  const fw = d.frameworks.find((f) => f.name === p.target) ?? d.frameworks[0];
  if (!WRITE_TARGETS.includes(p.target)) return { ...base, framework: fw ? `${fw.name} ${fw.version ?? ""}`.trim() : null, errors: [unsupportedTarget(p.target)] };
  const routeOf = new Map(d.routes.map((r) => [r.id, `${r.method} ${r.path ?? t("init.dynamic_route")}`]));
  const describe = (x: { method?: string; path?: string | null; route_id?: string; source?: { file: string; line: number }; reason?: string }) =>
    `${x.method ?? ""} ${x.path ?? routeOf.get(x.route_id ?? "") ?? t("init.dynamic_route")}${x.source ? ` (${x.source.file}:${x.source.line})` : ""}${x.reason ? ` — ${x.reason}` : ""}`.trim();
  const plans: InitPlan[] = p.proposed_plans.filter((x) => !x.already_licensed).map((x, i) => ({ n: i + 1, key: x.key, pattern: x.route_pattern, methods: x.methods, routes: x.routes.map((id) => routeOf.get(id) ?? id), reason: x.reason }));
  const result: InitResult = {
    ...base, ok: true, framework: fw ? `${fw.name} ${fw.version ?? ""}`.trim() : null, plans, planSha: p.approval.plan_sha256,
    untouched: p.excluded.map(describe), needsDecision: p.needs_decision.map(describe), unresolved: p.unresolved.map((u) => `${u.file}:${u.line} — ${u.reason}`),
  };
  if (opts.plans === undefined) return result;
  const sel = selectPlans(opts.plans, plans);
  if (sel.errors.length) return { ...result, ok: false, errors: sel.errors };
  const preview = prepareApply({ dir: opts.dir, planKeys: sel.keys, planSha: p.approval.plan_sha256, app, instance: opts.instance, sdk: opts.sdk ?? null, ...(opts.target ? { target: opts.target } : {}) });
  return { ...result, ok: preview.ok, errors: preview.refusals, selection: sel.keys, preview };
}

export function renderInit(r: InitResult): string {
  const out: string[] = [];
  if (!r.plans.length && r.errors.length) return [t("init.cannot_continue"), ...r.errors.map((e) => `  ✗ ${e}`)].join("\n");
  out.push(t("init.header", { p1: r.framework ?? t("init.unknown_framework"), app: r.app }));
  out.push(r.sdk.declared ? t("init.sdk_declared", { p1: sdkSpecLabel(r.sdk.declared) }) : r.sdk.tgz ? `  SDK: ${sdkSpecLabel(`file:${r.sdk.tgz}`).replace(/^file:/, "")}` : t("init.sdk_missing"));
  out.push("", r.plans.length ? t("init.plans_header") : t("init.no_candidates"));
  for (const p of r.plans) out.push(`  ${String(p.n).padStart(2)}  ${p.key.padEnd(24)} ${p.pattern.padEnd(28)} ${p.routes.join(", ")}`);
  // D4.1: la licencia se exige solo en estos métodos; otros métodos en esas rutas no cambian.
  if (r.plans.length) out.push(r.framework?.startsWith("rails")
    ? t("init.methods_all_rails")
    : t("init.methods_only", { p1: [...new Set(r.plans.map((p) => p.methods.join(", ")))].join(" / ") }));
  if (r.untouched.length) out.push("", t("init.untouched_header"), ...r.untouched.map((x) => `      ${x}`));
  if (r.needsDecision.length) out.push("", t("init.decision_header"), ...r.needsDecision.map((x) => `      ${x}`));
  if (r.unresolved.length) out.push("", t("init.unresolved_header"), ...r.unresolved.map((x) => `      ${x}`));
  if (!r.selection.length) {
    if (r.errors.length) out.push("", ...r.errors.map((e) => `  ✗ ${e}`));
    else if (r.plans.length) out.push("", t("init.next", { p1: r.plans.map((p) => p.n).join(",") }));
    return out.join("\n");
  }
  const pr = r.preview!;
  out.push("", t("init.preview_of", { p1: r.selection.join(", ") }), ...pr.refusals.map((x) => `  ✗ ${x}`), ...pr.warnings.map((w) => `  aviso: ${w}`), "", ...pr.changes.map((c) => c.diff), "");
  if (!pr.ok) { out.push(t("init.cannot_apply")); return out.join("\n"); }
  // S10.2-D3.1: el código fija ESTE diff. Si al escribir el diff ya no es el mismo (p. ej. tras instalar el SDK), la CLI
  // no escribe y hay que volver a revisarlo.
  out.push(t("init.nothing_written", { approvalCode: pr.approvalCode }));
  out.push(`  licenroute init . --plans ${r.selection.join(",")} --app ${r.app} --write --approve ${pr.approvalCode}`);
  out.push(t("init.challenge_hint"));
  return out.join("\n");
}
