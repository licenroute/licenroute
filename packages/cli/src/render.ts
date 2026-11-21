/** Salida legible para personas. Todo texto del proyecto ya viene saneado; aquí se presenta como dato, entre comillas. */
import type { DetectResult, Plan } from "./schema.ts";
import { t } from "../bin/i18n.mjs";

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

export function renderDetect(d: DetectResult): string {
  const out: string[] = [];
  out.push(t("detect.header"));
  if (d.frameworks.length === 0) out.push(t("detect.no_framework"));
  for (const f of d.frameworks) {
    out.push(`Framework: ${f.name === "express" ? "Express" : "Rails"} ${f.version ?? t("doctor.version_unknown")}${f.supported ? "" : t("detect.not_supported_suffix")} · ${f.language}${f.api_only ? " · API" : ""}${f.entry_files.length ? ` · ${f.entry_files.join(", ")}` : ""}`);
  }
  out.push(t("detect.integration", { value: d.licenroute.present ? t("detect.integration_yes", { where: d.licenroute.locations.map((l) => `${l.file}:${l.line}`).join(", ") || t("detect.dependency_declared") }) : t("detect.integration_no") }));
  const by = (k: string) => d.routes.filter((r) => r.resolution === k).length;
  out.push(``, t("detect.routes_found", { length: d.routes.length, p2: by("static"), p3: by("partial"), p4: by("dynamic") }));
  for (const r of d.routes) {
    const flags = [r.signals.auth_middleware.length ? "auth" : "", r.signals.behind_licenroute ? "licenroute" : "", r.signals.conditional ? "condicional" : "", r.resolution !== "static" ? r.resolution : ""].filter(Boolean).join(",");
    out.push(`  ${pad(r.method, 7)}${pad(r.path === null ? t("detect.unresolved_route") : `"${r.path}"`, 36)} ${pad(r.category, 8)} ${r.source.file}:${r.source.line}${flags ? `  [${flags}]` : ""}`);
  }
  if (d.unresolved.length) {
    out.push("", t("detect.unresolved_header", { length: d.unresolved.length }));
    for (const u of d.unresolved) out.push(`  ${u.file}:${u.line}  ${u.kind}: ${u.reason}\n      «${u.snippet}»`);
  }
  const s = d.skipped;
  if (s.sensitive_files.length) out.push("", t("detect.sensitive", { p1: s.sensitive_files.join(", ") }));
  if (s.unparseable.length) out.push("", t("detect.unparseable", { p1: s.unparseable.map((u) => `${u.file} (${u.error})`).join("; ") }));
  if (s.symlinks.length) out.push(t("detect.symlinks", { p1: s.symlinks.join(", ") }));
  if (s.too_large.length) out.push(t("detect.too_large", { p1: s.too_large.join(", ") }));
  if (s.limit_reached) out.push(t("detect.file_limit"));
  for (const n of d.notes) out.push(`Nota: ${n}`);
  out.push("", t("detect.warning", { message: d.completeness.message }));
  return out.join("\n");
}

export function renderPlan(p: Plan, routes: DetectResult["routes"]): string {
  const byId = new Map(routes.map((r) => [r.id, r]));
  const out: string[] = [];
  const nCand = p.summary.candidates;
  out.push(t("plan.header", { target: p.target }));
  out.push(t(nCand === 0 ? "plan.summary_none" : nCand === 1 ? "plan.summary_one" : "plan.summary_many", { routes: p.summary.routes, count: nCand }));
  if (p.proposed_plans.length) {
    out.push("", t("plan.plans_header"));
    for (const pl of p.proposed_plans) {
      out.push(`  ${pl.key}  →  ${pl.route_pattern}${pl.already_licensed ? t("plan.already_licensed_suffix") : ""}`);
      for (const id of pl.routes) { const r = byId.get(id); if (r) out.push(`      ${pad(r.method, 6)} "${r.path}"  ${r.source.file}:${r.source.line}`); }
      out.push(t("plan.reason_line", { reason: pl.reason }));
    }
  }
  if (p.excluded.length) {
    out.push("", t("plan.excluded_header"));
    for (const e of p.excluded) out.push(`  ${pad(e.method, 6)} "${e.path}"  — ${e.reason}`);
  }
  if (p.needs_decision.length) {
    out.push("", t("plan.decision_header"));
    for (const e of p.needs_decision) out.push(`  ${pad(e.method, 6)} "${e.path}"  ${e.source.file}:${e.source.line}  — ${e.reason}`);
  }
  if (p.unresolved.length) {
    out.push("", t("plan.unresolved_header"));
    for (const u of p.unresolved) out.push(`  ${u.file}:${u.line}  ${u.reason}  «${u.snippet}»`);
  }
  out.push("", t(p.integration.already_integrated ? "plan.changes_header_extend" : "plan.changes_header"));
  for (const d of p.integration.dependencies) out.push(t("plan.dependency_line", { ecosystem: d.ecosystem, name: d.name, source: d.source }));
  for (const c of p.integration.file_changes) out.push(`  ${c.action === "create" ? t("files.label_create") : t("files.label_modify")} ${c.file}${c.sha256 ? ` (sha256 ${c.sha256.slice(0, 12)}…)` : ""} — ${c.description}`);
  out.push(`  variables: ${p.integration.env.map((e) => `${e.name}${e.secret ? " (secreto)" : ""}`).join(", ")}`);
  if (p.tests.length) {
    out.push("", t("plan.tests_header"));
    for (const x of p.tests) out.push(`  ${pad(x.id, 34)} GET ${x.request.path}  ${t("plan.test_request", { license: x.request.license, central: x.request.central })} → ${x.expect_status.join("/")}`);
  }
  out.push("", ...p.warnings.map((w) => `Aviso: ${w}`));
  out.push("", t("plan.authorise", { p1: p.approval.plan_sha256.slice(0, 16), length: p.approval.files.length }));
  return out.join("\n");
}
