/**
 * `licenroute plan`: a partir de `detect`, propone qué rutas podrían licenciarse, cuáles nunca se protegen
 * automáticamente, cuáles necesitan una decisión humana, qué cambiaría S6 y qué pruebas lo verificarían.
 * No escribe nada. El plan lleva el hash de cada fichero en que se basa: S6 se negará a aplicar si alguno cambia.
 */
import type { DetectResult, Plan, Route } from "./schema.ts";
import { canonicalJson, isWildcardRoute, sha256, unplannablePath } from "./util.ts";
import { tc } from "../bin/i18n.mjs";

// D4.4.2: la exclusión se decide por la categoría; el motivo es solo texto (se calcula al usarlo).
const EXCLUDED_CATEGORIES = new Set(["health", "auth", "webhook", "static"]);
const excludeReason = (category: string): string => ({
  health: () => tc("plan.exclude.health"),
  auth: () => tc("plan.exclude.auth"),
  webhook: () => tc("plan.exclude.webhook"),
  static: () => tc("plan.exclude.static"),
} as Record<string, () => string>)[category]!();

/** Prefijo estático de una ruta: los segmentos anteriores al primer parámetro o comodín. */
function staticPrefix(path: string): string {
  const segs = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (const s of segs) { if (/[:*({]/.test(s)) break; out.push(s); }
  return `/${out.join("/")}`;
}

/** Endpoints cortos de estado o diagnóstico (/estado, /api/status, /v1/ping): suelen ser públicos, pero no se asume. */
const STATUS_LIKE = /^(?:estado|estatus|status|salud|ping|pong|version|versión|info|uptime|heartbeat)$/i;
const statusLike = (path: string) => { const segs = path.split("/").filter(Boolean); return segs.length > 0 && segs.length <= 2 && !segs.some((x) => /[:*({]/.test(x)) && STATUS_LIKE.test(segs[segs.length - 1]!); };

/**
 * ¿Puede el patrón (glob del SDK: `*` un segmento, `**` el resto) coincidir con alguna URL de la plantilla de ruta
 * (`/cupones/:codigo`, `/archivo/*ruta`)? Conservadora: ante la duda (parámetros, comodines, sintaxis rara), sí.
 */
export function patternCoversTemplate(pattern: string, template: string): boolean {
  const pat = pattern.toLowerCase().split("/").filter(Boolean); const tpl = template.toLowerCase().split("/").filter(Boolean);
  const dynamic = (seg: string) => /[:*({?]/.test(seg);
  const go = (i: number, j: number): boolean => {
    if (i === pat.length) return j === tpl.length;
    if (pat[i] === "**") return true;
    if (j === tpl.length) return false;
    const t = tpl[j]!;
    if (/^\*/.test(t) || /\(\.\*\)|\*$/.test(t)) return true; // comodín de Express: puede abarcar varios segmentos
    const segOk = pat[i] === "*" || dynamic(t) || pat[i]!.includes("*") || pat[i] === t;
    return segOk && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/**
 * ¿Está la ruta declarada DENTRO del espacio del patrón (su parte estática empieza por el prefijo del patrón)? Una
 * ruta de fuera (p. ej. un comodín final `/*splat` que responde 404) puede coincidir con alguna URL del patrón, pero el
 * plan no se apropia de ella: las URL de ese prefijo ya eran del plan.
 */
function insidePrefix(pattern: string, template: string): boolean {
  const prefix = pattern.replace(/\/\*\*$/, "").toLowerCase(); const own = staticPrefix(template).toLowerCase();
  return own === prefix || own.startsWith(`${prefix}/`);
}

function examplePath(path: string): string {
  return path.replace(/\{[^}]*\}/g, "").replace(/\([^)]*\)/g, "").replace(/:(\w+)/g, (_m, n: string) => (/id$/.test(n) ? "1" : "ejemplo")).replace(/\*\w*/g, "x").replace(/\/{2,}/g, "/");
}

export function plan(detected: DetectResult, target?: "express" | "rails"): Plan {
  const fw = target ? detected.frameworks.find((f) => f.name === target) : detected.frameworks[0];
  if (!fw) throw new PlanError(target ? tc("plan.not_detected", { target }) : tc("plan.no_framework"));
  if (!target && detected.frameworks.length > 1) throw new PlanError(tc("plan.several_frameworks", { p1: detected.frameworks.map((f) => f.name).join(", ") }));
  const routes = detected.routes.filter((r) => r.framework === fw.name);
  const ref = (r: Route, reason: string) => ({ route_id: r.id, method: r.method, path: r.path, source: r.source, reason });
  const excluded: Plan["excluded"] = [];
  const needs: Plan["needs_decision"] = [];
  const candidates: Route[] = [];
  const licensed = detected.licenroute.licensed_paths ?? [];

  for (const r of routes) {
    if (r.path === null) continue; // ya está en unresolved
    // S10.2-D2: solo una ruta completamente resuelta puede dar un plan aplicable; nunca una con el prefijo incierto.
    if (r.resolution !== "static") { needs.push(ref(r, tc("plan.review.uncertain_prefix"))); continue; }
    const unplannable = unplannablePath(r.path);
    if (unplannable !== null) { needs.push(ref(r, tc("plan.review.unplannable", { unplannable }))); continue; }
    if (EXCLUDED_CATEGORIES.has(r.category)) { excluded.push(ref(r, excludeReason(r.category))); continue; }
    if (r.category === "admin") { needs.push(ref(r, tc("plan.review.admin"))); continue; }
    if (!["GET", "HEAD"].includes(r.method)) { needs.push(ref(r, r.method === "ALL" ? tc("plan.review.any_method") : tc("plan.review.write"))); continue; }
    // D4.4.1: por la ruta (isWildcardRoute), nunca por el texto de una nota.
    if (isWildcardRoute(r)) { needs.push(ref(r, tc("plan.review.wildcard"))); continue; }
    if (staticPrefix(r.path) === "/") { needs.push(ref(r, r.path === "/" ? tc("plan.review.home") : tc("plan.review.root_param"))); continue; }
    if (statusLike(r.path)) { needs.push(ref(r, tc("plan.review.status"))); continue; }
    if (r.signals.auth_middleware.length > 0) { needs.push(ref(r, tc("plan.review.has_auth", { p1: r.signals.auth_middleware.join(", ") }))); continue; }
    candidates.push(r);
  }

  // Un plan por prefijo estático (p. ej. /api/informes/** cubre /api/informes y /api/informes/:id).
  // Una ruta de colección (/informes/buscar) se une al plan de su recurso (/informes), salvo que el prefijo sea genérico
  // (/api, /v1…): un plan para todo /api sería demasiado amplio.
  const groups = new Map<string, Route[]>();
  const generic = (p: string) => /^(?:api|v\d+|graphql|rpc)$/i.test(p.split("/").pop() ?? "");
  const prefixes = [...new Set(candidates.map((r) => staticPrefix(r.path!)))].sort((a, b) => a.length - b.length);
  const groupOf = new Map<string, string>();
  for (const p of prefixes) groupOf.set(p, prefixes.find((q) => q !== "/" && !generic(q) && (q === p || p.startsWith(`${q}/`)) && groupOf.get(q) === q) ?? p);
  for (const r of candidates) { const g = groupOf.get(staticPrefix(r.path!))!; groups.set(g, [...(groups.get(g) ?? []), r]); }
  // D4.1 (F-D4-1): la licencia se declara con RUTA Y MÉTODOS. En Express, GET va siempre con HEAD (Express atiende HEAD
  // con el controlador de GET: sin HEAD, sería una vía gratuita al mismo controlador). El SDK de Rails aún no admite
  // métodos: allí la declaración cubre todos, y así se comprueba.
  const effectiveMethods = (rs: Route[]): Route["method"][] => [...new Set(rs.flatMap((r): Route["method"][] => (r.method === "GET" ? ["GET", "HEAD"] : [r.method])))].sort();
  // Un patrón nunca puede cubrir, con alguno de sus métodos, una ruta que el plan deja fuera (autenticación propia,
  // estado, administración, comodín, otro método «ALL»…): esa ruta pasaría a exigir licencia sin haberlo decidido nadie.
  const conflictsOf = (pattern: string, methods: Route["method"][], members: Set<string>) => routes.filter((r) => r.path !== null && !members.has(r.id)
    && (fw.name === "rails" || r.method === "ALL" || methods.includes(r.method)) && insidePrefix(pattern, r.path) && patternCoversTemplate(pattern, r.path));
  // Defensa adicional: ningún patrón que no supere la validación sale del plan.
  const proposed: Plan["proposed_plans"] = [...groups.entries()].filter(([prefix]) => unplannablePath(`${prefix}/**`) === null).sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([prefix, rs]) => {
    const pattern = `${prefix}/**`;
    const methods = effectiveMethods(rs);
    const conflicts = conflictsOf(pattern, methods, new Set(rs.map((r) => r.id)));
    if (conflicts.length) {
      const list = conflicts.slice(0, 5).map((c) => `${c.method} ${c.path}`).join(", ");
      for (const r of rs) needs.push(ref(r, tc("plan.withheld_covers", { pattern, p2: methods.join(", "), list })));
      return [];
    }
    const pages = rs.filter((r) => r.category === "page").length;
    return [{
      key: prefix.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "raiz",
      route_pattern: pattern,
      methods: fw.name === "rails" ? [...new Set(rs.map((r) => r.method))].sort() : methods,
      routes: rs.map((r) => r.id),
      reason: pages === rs.length ? tc("plan.reason.page") : tc("plan.reason.api"),
      already_licensed: licensed.some((l) => l === pattern || (l.endsWith("/**") && `${prefix}/`.startsWith(l.slice(0, -2)))),
      requires_confirmation: true as const,
    }];
  });

  // --- cambios que haría S6 (ninguno se aplica ahora) ---------------------------------------------------------------
  const hash = (file: string) => detected.files.find((f) => f.path === file)?.sha256 ?? null;
  const changes: Plan["integration"]["file_changes"] = [];
  // Integrada = middleware en el CÓDIGO. Tener el SDK solo en package.json (instalado antes, S10.2-A) no lo es: se inserta.
  const integrated = detected.licenroute.present && detected.licenroute.sdk === fw.name && detected.licenroute.locations.length > 0;
  const deps: Plan["integration"]["dependencies"] = [];
  if (integrated) {
    const byFile = new Map<string, number[]>();
    for (const loc of detected.licenroute.locations) byFile.set(loc.file, [...(byFile.get(loc.file) ?? []), loc.line]);
    for (const [file, lines] of byFile) changes.push({ file, action: "modify", sha256: hash(file), description: tc(lines.length > 1 ? "plan.change.existing_many" : "plan.change.existing_one", { lines: [...new Set(lines)].join(", ") }) });
  } else if (fw.name === "express") {
    deps.push({ ecosystem: "npm", name: "@licenroute/connect-express", source: tc("plan.sdk.express_local") });
    changes.push({ file: "package.json", action: "modify", sha256: hash("package.json"), description: tc("plan.change.add_dependency") });
    for (const f of fw.entry_files) changes.push({ file: f, action: "modify", sha256: hash(f), description: tc("plan.change.express_middleware") });
    if (fw.entry_files.length === 0) changes.push({ file: tc("plan.to_be_decided"), action: "modify", sha256: null, description: tc("plan.app_not_found") });
  } else {
    deps.push({ ecosystem: "rubygems", name: "botgate-connect", source: tc("plan.sdk.rails_local") });
    changes.push({ file: "Gemfile", action: "modify", sha256: hash("Gemfile"), description: tc("plan.change.add_gem") });
    changes.push({ file: "config/initializers/botgate.rb", action: "create", sha256: null, description: tc("plan.change.rails_middleware") });
  }
  // También con una integración existente: apply añade .env.licenroute y .licenroute/ a .gitignore si le faltan.
  changes.push({ file: ".gitignore", action: detected.files.some((f) => f.path === ".gitignore") ? "modify" : "create", sha256: hash(".gitignore"), description: tc("plan.change.gitignore") });
  const behind = routes.filter((r) => r.signals.behind_licenroute).length;
  const orderWarning = integrated && behind > 0 && behind < routes.filter((r) => r.path !== null).length
    ? tc("plan.warn.before_middleware", { length: routes.filter((r) => r.path !== null && !r.signals.behind_licenroute).length })
    : null;

  // --- pruebas propuestas ------------------------------------------------------------------------------------------
  const tests: Plan["tests"] = [];
  const health = routes.find((r) => r.category === "health" && r.path && r.method !== "POST");
  const home = routes.find((r) => r.path === "/" && r.method === "GET");
  if (health) tests.push({ id: "health-central-down", description: tc("plan.test.health_down"), request: { method: "GET", path: examplePath(health.path!), license: "none", central: "down" }, expect_status: [200] });
  if (home) tests.push({ id: "public-central-down", description: tc("plan.test.public_down"), request: { method: "GET", path: "/", license: "none", central: "down" }, expect_status: [200] });
  proposed.forEach((p, i) => {
    const r = routes.find((x) => x.id === p.routes[0])!;
    const path = examplePath(r.path!);
    const t = (id: string, description: string, license: Plan["tests"][number]["request"]["license"], central: "up" | "down", expect: number[]) =>
      tests.push({ id: `${p.key}-${id}`, description, request: { method: "GET", path, license, central }, expect_status: expect });
    t("no-license", tc("plan.test.no_licence", { route_pattern: p.route_pattern }), "none", "up", [402]);
    t("valid", tc("plan.test.valid_licence", { route_pattern: p.route_pattern }), "valid", "up", [200, 204, 304]);
    if (proposed.length > 1) t("other-plan", tc("plan.test.other_plan", { route_pattern: p.route_pattern }), "other_plan", "up", [402]);
    t("forged", tc("plan.test.invented", { route_pattern: p.route_pattern }), "forged", "up", [403]);
    t("revoked", tc("plan.test.revoked", { route_pattern: p.route_pattern }), "revoked", "up", [403]);
    t("quota", tc("plan.test.quota", { route_pattern: p.route_pattern }), "exhausted", "up", [402]);
    t("central-down", tc("plan.test.down", { route_pattern: p.route_pattern }), "valid", "down", [503]);
    void i;
  });

  // --- avisos ------------------------------------------------------------------------------------------------------
  const unresolved = detected.unresolved.filter((u) => fw.name === "rails" ? u.file.endsWith(".rb") : !u.file.endsWith(".rb"));
  const warnings = [
    tc("plan.note.proposal"),
    tc("plan.note.static_analysis"),
    tc("plan.note.behind_middleware"),
  ];
  if (!fw.supported) warnings.push(tc("plan.unsupported_version", { name: fw.name, version: fw.version ?? tc("doctor.version_unknown") }));
  if (unresolved.length > 0) warnings.push(tc("plan.note.unresolved", { length: unresolved.length }));
  if (proposed.length === 0) warnings.push(tc("plan.note.no_plan"));
  if (detected.skipped.sensitive_files.length > 0) warnings.push(tc("plan.note.sensitive", { length: detected.skipped.sensitive_files.length }));
  if (integrated) warnings.push(tc("plan.note.existing"));
  if (orderWarning) warnings.push(orderWarning);

  const body = {
    schema: "licenroute.cli.plan/v1" as const,
    tool: detected.tool,
    target: fw.name,
    writes_files: false as const,
    summary: { routes: routes.length, candidates: candidates.length, excluded: excluded.length, needs_decision: needs.length, unresolved: unresolved.length + routes.filter((r) => r.path === null).length },
    proposed_plans: proposed,
    excluded,
    needs_decision: needs,
    unresolved,
    integration: {
      already_integrated: integrated,
      dependencies: deps,
      file_changes: changes,
      env: [
        { name: "LICENROUTE_API_KEY", secret: true }, { name: "LICENROUTE_SITE_ID", secret: false }, { name: "LICENROUTE_ENDPOINT", secret: false },
        { name: "LICENROUTE_LICENSED_PATHS", secret: false }, { name: "LICENROUTE_INSTANCE_ID", secret: false },
      ],
      order_warning: orderWarning,
    },
    tests,
    warnings,
  };
  const basis = new Set<string>([...routes.map((r) => r.source.file), ...changes.map((c) => c.file).filter((f) => hash(f) !== null), "package.json", "Gemfile", "Gemfile.lock", "package-lock.json"]);
  const files = detected.files.filter((f) => basis.has(f.path));
  return { ...body, approval: { required: true, plan_sha256: sha256(canonicalJson({ ...body, files })), files } };
}

export class PlanError extends Error {}
