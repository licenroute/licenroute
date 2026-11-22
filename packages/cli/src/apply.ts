/**
 * `licenroute apply` (S6): genera EN MEMORIA los cambios mínimos para integrar LicenRoute según los planes elegidos, los
 * verifica volviendo a analizar el resultado y calcula un código de aprobación ligado a todo lo relevante. Escribir
 * es una fase aparte (write.ts), que solo ocurre con ese código. Nada de lo que hay en el proyecto puede aprobar.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { detect } from "./detect.ts";
import { applyEdits, type Edit, splitLines, unifiedDiff } from "./edits.ts";
import { literalDeclaration } from "./express.ts";
import { plan as makePlan } from "./plan.ts";
import { unsupportedTarget, WRITE_TARGETS } from "./targets.ts";
import { ProjectReader } from "./reader.ts";
import type { DetectResult, Plan } from "./schema.ts";
import { canonicalJson, isWildcardRoute, sdkSpecLabel, sha256, unplannablePath } from "./util.ts";
import { t } from "../bin/i18n.mjs";

export interface ApplyRequest {
  dir: string;
  planKeys: string[];
  planSha: string;
  app: string;
  instance: string;
  sdk: string | null;
  target?: "express" | "rails";
}

export interface FileChange {
  path: string;
  action: "modify" | "create";
  before: string | null;
  after: string;
  beforeSha: string | null;
  afterSha: string;
  edits: Edit[];
  diff: string;
}

export interface Prepared {
  ok: boolean;
  refusals: string[];
  warnings: string[];
  plan: Plan | null;
  /** methods: los que exigirán licencia (D4.1); vacío = todos (Rails, cuyo SDK aún no admite métodos). */
  selected: { key: string; pattern: string; methods: string[]; routes: { method: string; path: string }[] }[];
  changes: FileChange[];
  approvalCode: string | null;
  publicChecks: string[];
  sdkSpec: string | null;
  /** S10.2-D2: rutas y construcciones que esta integración NO cubre (sin resolver o dinámicas). 0 = nada pendiente. */
  uncovered: number;
}

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const list = (items: string[]) => `[${items.map((p) => JSON.stringify(p)).join(", ")}]`;
/** Entrada de licensedPaths con métodos (SDK ≥ 0.7.0): `{ path: "/x/**", methods: ["GET", "HEAD"] }`. */
const declaration = (s: { pattern: string; methods: string[] }) => `{ path: ${JSON.stringify(s.pattern)}, methods: ${list(s.methods)} }`;
/** Primera versión del SDK de Express que entiende `{ path, methods }` en licensedPaths. */
export const SDK_METHODS_MIN = "0.7.0";
const older = (v: string, min: string) => { const a = v.split(".").map(Number); const b = min.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0); } return false; };
export const covers = (pattern: string, path: string) => (pattern.endsWith("/**") ? path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2)) : path === pattern);

/**
 * Segunda barrera (D4.4.2): comprueba cada plan elegido CONTRA EL ANÁLISIS, no contra lo que dice el plan. Una ruta
 * comodín, con prefijo incierto, condicional o desconocida nunca se aplica, aunque un plan (manipulado o de otra
 * versión) la incluya. Decide por datos de la ruta; las notas y el idioma no intervienen.
 */
export function selectPlans(plan: Plan, detected: DetectResult, planKeys: string[]): { selected: Prepared["selected"]; refusals: string[]; warnings: string[] } {
  const refusals: string[] = []; const warnings: string[] = [];
  const byId = new Map(detected.routes.map((r) => [r.id, r]));
  const selected: Prepared["selected"] = [];
  for (const key of planKeys) {

    const p = plan.proposed_plans.find((x) => x.key === key);
    if (!p) { refusals.push(t("apply.plan_not_proposed", { keyValue: key, p2: plan.proposed_plans.map((x) => x.key).join(", ") || t("common.none_m") })); continue; }
    const missing = p.routes.filter((id) => !byId.has(id));
    if (missing.length) { refusals.push(t("apply.plan_unclear", { plan: key, routes: missing.join("; ") })); continue; }
    const routes = p.routes.map((id) => byId.get(id)!);
    const unclear = routes.filter((r) => r.resolution !== "static" || r.signals.conditional || isWildcardRoute(r)); // D4.4.1: por la ruta, nunca por una nota
    if (unclear.length) { refusals.push(t("apply.plan_unclear", { plan: key, routes: unclear.map((r) => `${r.method} ${r.path ?? "?"} ${r.source.file}:${r.source.line} [${r.resolution}${r.signals.conditional ? `, ${t("apply.conditional")}` : ""}]`).join("; ") })); continue; }
    // Defensa adicional (S10.2-D2): un patrón que el SDK no compararía igual que la ruta real nunca se escribe.
    const bad = unplannablePath(p.route_pattern);
    if (bad !== null) { refusals.push(t("apply.plan_unsafe_pattern", { keyValue: key, bad })); continue; }
    if (p.already_licensed) { warnings.push(t("apply.plan_already", { keyValue: key, route_pattern: p.route_pattern })); continue; }
    selected.push({ key, pattern: p.route_pattern, methods: plan.target === "express" ? [...p.methods] : [], routes: routes.map((r) => ({ method: r.method, path: r.path! })) });
  }
  return { selected, refusals, warnings };
}

export function prepareApply(req: ApplyRequest): Prepared {
  const refusals: string[] = []; const warnings: string[] = [];
  const out = (extra: Partial<Prepared> = {}): Prepared => ({ ok: false, refusals, warnings, plan: null, selected: [], changes: [], approvalCode: null, publicChecks: [], sdkSpec: null, uncovered: 0, ...extra });
  if (!APP_NAME.test(req.app)) refusals.push(t("apply.app_invalid"));
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(req.instance)) refusals.push(t("apply.instance_invalid"));
  if (req.planKeys.length === 0) refusals.push(t("apply.plans_required"));
  if (refusals.length) return out();

  const detected = detect(req.dir);
  let plan: Plan;
  try { plan = makePlan(detected, req.target); } catch (e) { refusals.push((e as Error).message); return out(); }
  if (!WRITE_TARGETS.includes(plan.target)) { refusals.push(unsupportedTarget(plan.target)); return out(); }
  // 1. El plan que se aprueba es exactamente el revisado: mismo análisis, mismos ficheros.
  if (plan.approval.plan_sha256 !== req.planSha) {
    refusals.push(t("apply.plan_changed", { p1: plan.approval.plan_sha256.slice(0, 16), p2: req.planSha.slice(0, 16) }));
    return out({ plan });
  }
  // 2. Planes elegidos: existen y todas sus rutas se entienden del todo (B: nada ambiguo se aplica solo).
  const selection = selectPlans(plan, detected, req.planKeys);
  refusals.push(...selection.refusals); warnings.push(...selection.warnings);
  const selected = selection.selected;
  // Integración PARCIAL (S10.2-D2): lo que el análisis no entiende no queda cubierto, y se dice así, no como integración completa.
  const dynamicNearby = detected.routes.filter((r) => r.framework === plan.target && r.path === null);
  const uncovered = new Set([...dynamicNearby.map((r) => `${r.source.file}:${r.source.line}`), ...plan.unresolved.map((u) => `${u.file}:${u.line}`)]).size;
  if (uncovered) warnings.push(t("apply.partial_warning", { uncovered }));
  if (refusals.length) return out({ plan });
  if (selected.length === 0) { refusals.push(t("apply.nothing_to_apply")); return out({ plan }); }

  // 3. Cambios en memoria.
  const reader = new ProjectReader(req.dir);
  const patterns = selected.map((s) => s.pattern);
  const planShort = plan.approval.plan_sha256.slice(0, 12);
  const changes: FileChange[] = [];
  const addChange = (path: string, action: "modify" | "create", before: string | null, edits: Edit[]) => {
    const after = before === null ? edits.flatMap((e) => e.added).join("\n") : applyEdits(before, edits);
    changes.push({ path, action, before, after, beforeSha: before === null ? null : sha256(before), afterSha: sha256(after), edits, diff: unifiedDiff(path, before, edits) });
  };
  const fileOf = (path: string) => { const text = reader.read(path); if (text === null) refusals.push(t("apply.cannot_read", { path })); return text; };
  let sdkSpec: string | null = null;

  const integrated = plan.integration.already_integrated;
  if (plan.target === "express") {
    // D4.1: la declaración con métodos solo la entiende el SDK ≥ 0.7.0. Con uno anterior instalado, la app no
    // arrancaría (LicenRouteConfigError): se rechaza antes de escribir, con la versión vista.
    // Si aún no está instalado, la versión del nombre del paquete declarado (file:…/licenroute-connect-express-X.Y.Z.tgz).
    const declaredSpec = (() => { try { const d = (JSON.parse(reader.read("package.json") ?? "{}") as { dependencies?: Record<string, unknown> }).dependencies?.["@licenroute/connect-express"]; return typeof d === "string" ? d : null; } catch { return null; } })();
    const tgzVersion = (spec: string | null) => /licenroute-connect-express-(\d+\.\d+\.\d+)\.tgz$/.exec(spec ?? "")?.[1] ?? null;
    const installed = sdkInstalledVersion(req.dir) ?? tgzVersion(declaredSpec) ?? (declaredSpec === null ? tgzVersion(req.sdk) : null);
    if (installed !== null && older(installed, SDK_METHODS_MIN)) refusals.push(t("apply.sdk_too_old", { p1: installed.slice(0, 20), SDK_METHODS_MIN }));
    if (integrated) {
      for (const loc of [...new Set(detected.licenroute.locations.map((l) => l.file))]) {
        const text = fileOf(loc); if (text === null) continue;
        const e = extendLicensedPathsTs(text, loc, selected);
        if (typeof e === "string") refusals.push(e); else if (e) addChange(loc, "modify", text, [e]);
      }
    } else {
      // Si package.json ya declara el SDK (p. ej. el desarrollador hizo npm install del tarball antes), no se toca ni se
      // exige --sdk: se respeta su versión y solo se inserta el middleware.
      const declared = (() => { try { const d = (JSON.parse(fileOf("package.json") ?? "{}") as { dependencies?: Record<string, unknown> }).dependencies; return d && typeof d === "object" && typeof d["@licenroute/connect-express"] === "string" ? d["@licenroute/connect-express"] as string : null; } catch { return null; } })();
      if (declared !== null) warnings.push(t("apply.sdk_declared", { p1: sdkSpecLabel(declared) }));
      else sdkSpec = sdkDependency(req, "express", refusals);
      const fw = detected.frameworks.find((f) => f.name === "express")!;
      if (fw.entry_files.length !== 1) refusals.push(fw.entry_files.length === 0 ? t("apply.no_app_creation") : t("apply.several_apps", { p1: fw.entry_files.join(", ") }));
      else {
        const entry = fw.entry_files[0]!;
        const text = fileOf(entry);
        if (text !== null) { const e = expressInsert(text, entry, selected, planShort); if (typeof e === "string") refusals.push(e); else addChange(entry, "modify", text, e); }
      }
      const pkg = fileOf("package.json");
      if (pkg !== null && sdkSpec) { const e = packageJsonDependency(pkg, sdkSpec); if (typeof e === "string") refusals.push(e); else addChange("package.json", "modify", pkg, [e]); }
    }
  } else {
    if (integrated) {
      for (const loc of [...new Set(detected.licenroute.locations.map((l) => l.file))]) {
        const text = fileOf(loc); if (text === null) continue;
        const e = extendLicensedPathsRuby(text, patterns);
        if (typeof e === "string") refusals.push(`${loc}: ${e}`); else if (e) addChange(loc, "modify", text, [e]);
      }
    } else {
      sdkSpec = sdkDependency(req, "rails", refusals);
      if (!reader.exists("config/application.rb")) refusals.push(t("apply.rails_no_application"));
      else if (!isDir(req.dir, "config/initializers")) refusals.push(t("apply.rails_no_initializers"));
      else if (reader.exists("config/initializers/botgate.rb") || existsSync(resolve(req.dir, "config/initializers/botgate.rb"))) refusals.push(t("apply.rails_initializer_exists"));
      else addChange("config/initializers/botgate.rb", "create", null, [{ start: 0, removed: [], added: railsInitializer(patterns, planShort) }]);
      const gemfile = fileOf("Gemfile");
      if (gemfile !== null && sdkSpec) {
        if (/^\s*gem\s+["']botgate-connect["']/m.test(gemfile)) refusals.push(t("apply.rails_gem_declared"));
        else { const lines = splitLines(gemfile); const endsNl = gemfile.endsWith("\n"); addChange("Gemfile", "modify", gemfile, [{ start: endsNl ? lines.length - 1 : lines.length, removed: endsNl ? [""] : [], added: ["", "# LicenRoute (added by licenroute apply)", `gem "botgate-connect", path: ${JSON.stringify(sdkSpec)}`, ""] }]); }
      }
    }
  }
  // .gitignore: credenciales y diario nunca en git.
  const gi = reader.read(".gitignore");
  const giLines = gi === null ? [] : splitLines(gi).map((l) => l.trim());
  const missing = [".env.licenroute", ".licenroute/"].filter((p) => !giLines.includes(p) && !(p === ".env.licenroute" && giLines.some((l) => l === ".env*" || l === ".env.*")) && !(p === ".licenroute/" && giLines.includes(".licenroute")));
  if (missing.length) {
    if (gi === null) addChange(".gitignore", "create", null, [{ start: 0, removed: [], added: ["# LicenRoute: test credentials and licenroute apply journal (never in git)", ...missing, ""] }]);
    else { const lines = splitLines(gi); const endsNl = gi.endsWith("\n"); addChange(".gitignore", "modify", gi, [{ start: endsNl ? lines.length - 1 : lines.length, removed: endsNl ? [""] : [], added: ["# LicenRoute: test credentials and licenroute apply journal (never in git)", ...missing, ""] }]); }
  }
  // Ningún fichero fuera de los que anuncia el plan revisado (defensa en profundidad).
  const announced = new Set(plan.integration.file_changes.map((c) => c.file));
  for (const c of changes) if (!announced.has(c.path)) refusals.push(t("apply.file_not_in_plan", { path: c.path }));
  if (refusals.length) return out({ plan, selected });

  // 4. Verificación: se analiza el resultado en memoria. Mismas rutas, misma autenticación, y todas las rutas de los
  //    planes elegidos detrás de LicenRoute. Si no, la posición del middleware no es segura.
  const after = detect(req.dir, { overrides: new Map(changes.map((c) => [c.path, c.after])) });
  verifyAfter(detected, after, plan.target, selected, refusals, warnings);
  if (refusals.length) return out({ plan, selected, changes });

  const publicChecks = [...new Set(detected.routes.filter((r) => r.framework === plan.target && r.method === "GET" && r.path && r.resolution === "static" && (r.category === "health" || r.category === "docs" || r.path === "/") && !patterns.some((p) => covers(p, r.path!))).map((r) => r.path!))];
  const approvalCode = `apr_${sha256(canonicalJson({ plan_sha256: plan.approval.plan_sha256, plans: [...req.planKeys].sort(), patterns, methods: selected.map((s) => s.methods), app: req.app, instance: req.instance, sdk: sdkSpec, changes: changes.map((c) => ({ path: c.path, action: c.action, before: c.beforeSha, after: c.afterSha })) })).slice(0, 20)}`;
  return { ok: true, refusals, warnings, plan, selected, changes, approvalCode, publicChecks, sdkSpec, uncovered };
}

function verifyAfter(before: DetectResult, after: DetectResult, target: string, selected: Prepared["selected"], refusals: string[], warnings: string[]) {
  const patterns = selected.map((s) => s.pattern);
  const key = (r: DetectResult["routes"][number]) => `${r.method} ${r.path}`;
  const b = before.routes.filter((r) => r.framework === target && r.path !== null); const a = after.routes.filter((r) => r.framework === target && r.path !== null);
  const bs = b.map(key).sort().join("\n"); const as = a.map(key).sort().join("\n");
  if (bs !== as) refusals.push(t("apply.verify.routes_changed"));
  const authBefore = new Map(b.map((r) => [key(r), r.signals.auth_middleware.join(",")]));
  for (const r of a) if (authBefore.has(key(r)) && authBefore.get(key(r)) !== r.signals.auth_middleware.join(",")) refusals.push(t("apply.verify.auth_changed", { p1: key(r) }));
  if (!after.licenroute.present) refusals.push(t("apply.verify.no_middleware"));
  const lp = after.licenroute.licensed_paths;
  if (!lp || !patterns.every((p) => lp.includes(p))) refusals.push(t("apply.verify.patterns_missing"));
  // D4.1: y cada patrón con exactamente los métodos aprobados (vacío = todos, solo en Rails).
  const routesAfter = after.licenroute.licensed_routes ?? [];
  const wrongMethods = target === "express" ? selected.filter((s) => !routesAfter.some((r) => r.pattern === s.pattern && r.methods.join(",") === s.methods.join(","))) : [];
  if (wrongMethods.length) refusals.push(t("apply.verify.methods_missing", { p1: wrongMethods.map((s) => s.pattern).join(", ") }));
  const exposed = a.filter((r) => patterns.some((p) => covers(p, r.path!)) && !r.signals.behind_licenroute);
  if (exposed.length) refusals.push(t(exposed.length > 1 ? "apply.unsafe_position_many" : "apply.unsafe_position_one", { routes: exposed.map((r) => `${key(r)} (${r.source.file}:${r.source.line})`).join(", ") }));
  const others = a.filter((r) => !r.signals.behind_licenroute && !patterns.some((p) => covers(p, r.path!)));
  if (others.length) warnings.push(t("apply.verify.others_before", { length: others.length }));
}

function isDir(root: string, rel: string) { try { return statSync(resolve(root, rel)).isDirectory(); } catch { return false; } }

/** Dependencia del SDK, local (nada publicado): Express = tarball de `npm pack`; Rails = directorio sdks/ruby-rails. */
function sdkDependency(req: ApplyRequest, fw: "express" | "rails", refusals: string[]): string | null {
  if (!req.sdk) { refusals.push(fw === "express" ? t("apply.sdk_required_express") : t("apply.sdk_required_rails")); return null; }
  const abs = resolve(req.sdk);
  // Una ruta que el lanzador no ha podido conceder (no existe) se trata como inexistente.
  const exists = (p: string) => { try { return existsSync(p); } catch { return false; } };
  if (fw === "express" && !(/\.tgz$/.test(abs) && exists(abs))) { refusals.push(t("apply.sdk_missing", { sdk: req.sdk })); return null; }
  if (fw === "rails" && !exists(resolve(abs, "botgate-connect.gemspec"))) { refusals.push(t("apply.sdk_no_gemspec", { sdk: req.sdk })); return null; }
  const rel = relative(resolve(req.dir), abs).split(sep).join("/");
  return fw === "express" ? `file:${rel}` : rel;
}

function packageJsonDependency(text: string, spec: string): Edit | string {
  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(text) as Record<string, unknown>; } catch { return t("apply.pkg_invalid"); }
  if (!pkg.dependencies || typeof pkg.dependencies !== "object") return t("apply.pkg_no_deps");
  if ("@licenroute/connect-express" in (pkg.dependencies as object)) return t("apply.pkg_already");
  const lines = splitLines(text);
  const at = lines.flatMap((l, i) => (/^\s*"dependencies"\s*:\s*\{\s*$/.test(l) ? [i] : []));
  // S10.2-D2: "dependencies": { "express": "^4.21.2" } en UNA línea (package.json escrito a mano). Se reescribe solo esa
  // línea, sin llaves anidadas; la comprobación de abajo exige que el JSON resultante solo difiera en la dependencia.
  const oneLine = lines.flatMap((l, i) => (/^\s*"dependencies"\s*:\s*\{[^{}]*\}\s*,?\s*$/.test(l) ? [i] : []));
  let edit: Edit;
  if (at.length === 1 && oneLine.length === 0) {
    const i = at[0]!; const next = lines[i + 1] ?? "";
    const empty = /^\s*\}/.test(next);
    const indent = empty ? `${/^(\s*)/.exec(lines[i]!)![1]}  ` : /^(\s*)/.exec(next)![1]!;
    edit = { start: i + 1, removed: [], added: [`${indent}"@licenroute/connect-express": ${JSON.stringify(spec)}${empty ? "" : ","}`] };
  } else if (at.length === 0 && oneLine.length === 1) {
    const i = oneLine[0]!; const line = lines[i]!;
    const m = /^(\s*"dependencies"\s*:\s*\{)([^{}]*?)(\s*)\}(\s*,?\s*)$/.exec(line);
    if (!m) return t("apply.pkg_deps_ambiguous");
    const inner = m[2]!; const entry = `"@licenroute/connect-express": ${JSON.stringify(spec)}`;
    const added = inner.trim() === "" ? `${m[1]} ${entry} }${m[4]}` : `${m[1]}${inner}, ${entry}${m[3] || " "}}${m[4]}`;
    edit = { start: i, removed: [line], added: [added] };
  } else return t("apply.pkg_deps_ambiguous");
  const after = applyEdits(text, [edit]);
  try {
    const p2 = JSON.parse(after) as Record<string, unknown>;
    const deps = p2.dependencies as Record<string, unknown>;
    const { ["@licenroute/connect-express"]: added, ...rest } = deps;
    if (added !== spec || canonicalJson(rest) !== canonicalJson(pkg.dependencies) || canonicalJson({ ...p2, dependencies: null }) !== canonicalJson({ ...pkg, dependencies: null })) return t("apply.pkg_edit_inexact");
  } catch { return t("apply.pkg_edit_invalid"); }
  return edit;
}

/** Versión del SDK de Express instalado en el proyecto (node_modules), o null si no está instalado o no se lee. */
function sdkInstalledVersion(dir: string): string | null {
  try { const v = (JSON.parse(readFileSync(resolve(dir, "node_modules/@licenroute/connect-express/package.json"), "utf8")) as { version?: unknown }).version; return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null; } catch { return null; }
}

/** Express sin integración: import + middleware justo tras `const app = express()` (nivel superior, inequívoco). */
function expressInsert(text: string, file: string, selected: Prepared["selected"], planShort: string): Edit[] | string {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.tsx?$|\.[cm]ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
  const expressLocal = new Set<string>(); let esm = false; let lastImport = -1; let requireStmt = -1;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) { esm = true; lastImport = lineOf(st.getEnd()); if (ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "express" && st.importClause?.name) expressLocal.add(st.importClause.name.text); }
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      if (d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && d.initializer.expression.text === "require" && (d.initializer.arguments[0] as ts.StringLiteral | undefined)?.text === "express" && ts.isIdentifier(d.name)) { expressLocal.add(d.name.text); requireStmt = lineOf(st.getEnd()); }
    }
  }
  if (/@licenroute\/connect-express/.test(text)) return t("apply.already_imports", { file });
  if (/\b(?:const|let|var|function|import)\s+[^;]*\blicenroute(?:Protection)?\b/.test(text)) return t("apply.name_taken", { file });
  const creations = sf.statements.flatMap((st) => (ts.isVariableStatement(st) ? st.declarationList.declarations.filter((d) => d.initializer && ts.isCallExpression(d.initializer) && ts.isIdentifier(d.initializer.expression) && expressLocal.has(d.initializer.expression.text) && ts.isIdentifier(d.name)).map((d) => ({ st, name: (d.name as ts.Identifier).text })) : []));
  if (creations.length !== 1) return creations.length === 0 ? t("apply.app_not_top_level", { file }) : t("apply.several_apps_file", { file });
  const { st, name } = creations[0]!;
  const afterApp = lineOf(st.getEnd()) + 1;
  const env = (v: string, fallback = '""') => `process.env.${v} ?? ${fallback}`;
  const block = [
    "",
    // Código escrito en el proyecto: en inglés y SIN depender del idioma elegido (forma parte del diff aprobado, D4.4).
    `// LicenRoute (added by licenroute apply, plan ${planShort}): in front of every route. Each licensedPaths entry requires`,
    "// a licence only on its methods (HEAD goes with GET); other methods on those routes stay as before. Paid routes",
    "// close (503) if LicenRoute does not respond; everything else stays open (fallback: \"allow\").",
    "const licenRouteProtection = licenroute({",
    `  apiKey: ${env("LICENROUTE_API_KEY")},`,
    `  siteId: ${env("LICENROUTE_SITE_ID")},`,
    `  endpoint: ${env("LICENROUTE_ENDPOINT")},`,
    `  licensedPaths: [${selected.map(declaration).join(", ")}],`,
    "  withoutPolicy: \"deny\",",
    "  fallback: \"allow\",",
    `  instanceId: ${env("LICENROUTE_INSTANCE_ID", "undefined")},`,
    "  allowInsecureEndpoint: process.env.LICENROUTE_ALLOW_INSECURE_ENDPOINT === \"true\",",
    "});",
    `${name}.use(licenRouteProtection);`,
    "",
  ];
  const importLine = esm ? 'import { licenroute } from "@licenroute/connect-express";' : 'const { licenroute } = require("@licenroute/connect-express");';
  const importAt = esm ? lastImport + 1 : requireStmt + 1;
  if (importAt <= 0) return t("apply.no_express_import", { file });
  return [{ start: importAt, removed: [], added: [importLine] }, { start: afterApp, removed: [], added: block }];
}

/** Integración Express existente: añade los planes a un licensedPaths LITERAL de licenroute({...}) (cadenas u objetos). */
function extendLicensedPathsTs(text: string, file: string, selected: Prepared["selected"]): Edit | string | null {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.tsx?$|\.[cm]ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const arrays: ts.ArrayLiteralExpression[] = []; let nonLiteral = false;
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "licensedPaths") {
      if (ts.isArrayLiteralExpression(n.initializer) && n.initializer.elements.every((e) => literalDeclaration(e) !== null)) arrays.push(n.initializer); else nonLiteral = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (nonLiteral) return t("apply.licensed_not_literal", { file });
  if (arrays.length === 0) return null;
  if (arrays.length > 1) return t("apply.licensed_several", { file });
  // Las entradas existentes se conservan tal cual (texto original); solo se añaden las de los planes nuevos.
  return replaceSpan(text, sf, arrays[0]!, (current, sources) => `[${[...sources, ...selected.filter((s) => !current.includes(s.pattern)).map(declaration)].join(", ")}]`);
}

function replaceSpan(text: string, sf: ts.SourceFile, arr: ts.ArrayLiteralExpression, make: (current: string[], sources: string[]) => string): Edit | null {
  const current = arr.elements.map((e) => literalDeclaration(e)!.pattern);
  const sources = arr.elements.map((e) => e.getText(sf));
  const startLine = sf.getLineAndCharacterOfPosition(arr.getStart(sf)).line; const endLine = sf.getLineAndCharacterOfPosition(arr.getEnd()).line;
  const lines = splitLines(text);
  const lineStart = text.split("\n").slice(0, startLine).join("\n").length + (startLine > 0 ? 1 : 0);
  const block = lines.slice(startLine, endLine + 1).join("\n");
  const newBlock = block.slice(0, arr.getStart(sf) - lineStart) + make(current, sources) + block.slice(arr.getEnd() - lineStart);
  if (newBlock === block) return null;
  return { start: startLine, removed: lines.slice(startLine, endLine + 1), added: newBlock.split("\n") };
}

/** Integración Rails existente: añade patrones a un licensed_paths LITERAL. */
function extendLicensedPathsRuby(text: string, patterns: string[]): Edit | string | null {
  const lines = splitLines(text);
  const idx = lines.flatMap((l, i) => (/licensed_paths:\s*\[/.test(l) ? [i] : []));
  if (idx.length === 0) return /licensed_paths:/.test(text) ? t("apply.rails_licensed_not_literal") : null;
  if (idx.length > 1) return t("apply.rails_licensed_several");
  const line = lines[idx[0]!]!;
  const m = /licensed_paths:\s*\[([^\]]*)\]/.exec(line);
  if (!m || m[1]!.replace(/["'][^"']*["']|[\s,]/g, "") !== "") return t("apply.rails_licensed_not_literal");
  const current = [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
  const merged = [...current, ...patterns.filter((p) => !current.includes(p))];
  const newLine = line.replace(m[0], `licensed_paths: [ ${merged.map((p) => JSON.stringify(p)).join(", ")} ]`);
  return newLine === line ? null : { start: idx[0]!, removed: [line], added: [newLine] };
}

function railsInitializer(patterns: string[], planShort: string): string[] {
  return [
    `# BotGate (created by botgate apply, plan ${planShort}): middleware in front of the app's routes.`,
    "# licensed_paths routes close (503) if BotGate does not respond; everything else stays open (fallback: :allow).",
    "require \"botgate\"",
    "",
    "Rails.application.config.middleware.use Botgate::Middleware,",
    "  api_key: ENV.fetch(\"BOTGATE_API_KEY\"),",
    "  site_id: ENV.fetch(\"BOTGATE_SITE_ID\"),",
    "  endpoint: ENV.fetch(\"BOTGATE_ENDPOINT\"),",
    `  licensed_paths: [ ${patterns.map((p) => JSON.stringify(p)).join(", ")} ],`,
    "  without_policy: :deny,",
    "  fallback: :allow,",
    "  instance_id: ENV.fetch(\"BOTGATE_INSTANCE_ID\", \"rails\"),",
    "  allow_insecure_endpoint: ENV[\"BOTGATE_ALLOW_INSECURE_ENDPOINT\"] == \"true\"",
    "",
  ];
}
