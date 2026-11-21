/**
 * `licenroute test` (S6): comprueba FUNCIONALMENTE la integración aplicada, contra el Sandbox y la app local que el
 * desarrollador ha arrancado: cada ruta de los planes rechaza sin licencia, la licencia válida entra, la de otro plan
 * no, la inventada y la revocada se rechazan, la cuota se agota, y con Central caído las rutas de pago se cierran y
 * las públicas siguen. Solo peticiones GET a 127.0.0.1/localhost. Nunca imprime tokens.
 * S10.2-D3.1: la caída se prueba en TODAS las rutas de TODOS los planes (con cobertura declarada) y las rutas que ya
 * tienen autenticación propia se comprueban: LicenRoute nunca debe ser quien las rechace.
 * D4.1 (F-D4-1): método y ruta. HEAD se prueba como GET (licencia, cuota compartida, revocación); OPTIONS nunca debe
 * cobrarse. Los métodos con efectos secundarios (POST, PUT, PATCH, DELETE) NUNCA se envían a la app: se pregunta al
 * simulador qué decidiría y se compara con lo que declara el código; si no se puede, cobertura parcial. Una
 * declaración sin métodos (integración de 0.2.2) que cobra métodos que el plan no incluía es un FALLO.
 */
import type { Journal } from "../journal.ts";
import { quotaHint } from "../sandbox-hint.ts";
import { appUrl, errorOf, example, get, type Hit, loopbackUrl, planKey, type SafeMethod } from "./sandbox.ts";
import type { TestAdmin, Verification } from "./test-admin.ts";
import { t } from "../../bin/i18n.mjs";

export interface Check { id: string; ok: boolean | null; detail: string }
/** Detalle del controlador en una línea: ya viene redactado y limitado por él. */
const firstLines = (s: string) => s.replace(/\s*\n\s*/g, " · ").replace(/^sandbox: /, "").slice(0, 700);
const ok2xx = (h: Hit) => h.status !== null && h.status >= 200 && h.status < 300;
const show = (h: Hit) => (h.status === null ? t("test.no_response", { error: h.error }) : `${h.status}${errorOf(h) ? ` ${errorOf(h)}` : ""}`);

async function until(fn: () => Promise<Hit>, pred: (h: Hit) => boolean, seconds: number): Promise<Hit> {
  let h = await fn();
  for (let i = 0; i < seconds && !pred(h); i++) { await new Promise((r) => setTimeout(r, 1000)); h = await fn(); }
  return h;
}

/** Lo único que la fase activa recibe de la estática (que es la que lee el diario del proyecto). */
export interface MethodCheck { method: string; path: string; plan: string; auth: string[] }
export type TestContext = Pick<Journal, "app" | "instance" | "public_checks"> & {
  /** methods vacío = todos (diario de 0.2.2, que escribió licensedPaths sin métodos). */
  plans: { key: string; pattern: string; methods: string[]; routes: { method: string; path: string }[] }[];
  auth_checks?: string[];
  /** Rutas bajo un patrón con métodos que el plan NO incluye: no deben cobrarse (se preguntan, no se envían). */
  method_checks?: MethodCheck[];
  /** Rutas bajo un patrón SIN métodos con métodos que el plan no aprobó: se cobran sin que nadie lo decidiera. */
  overreach?: MethodCheck[];
  /** Lo que declara el código (licensedPaths): patrón y métodos; null si no se pudo leer. */
  declared?: { pattern: string; methods: string[] }[] | null;
};
const METHOD = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|ALL)$/;
const PATTERN = /^\/[A-Za-z0-9/_.*-]{0,200}$/; const PATH = /^\/[^\s\u0000-\u001f\u007f]{0,500}$/; const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** El contexto viene de otro proceso: se valida como cualquier entrada externa. */
export function validTestContext(raw: unknown): TestContext | null {
  const c = raw as Partial<TestContext> | null;
  if (!c || typeof c.app !== "string" || !NAME.test(c.app) || typeof c.instance !== "string" || !NAME.test(c.instance) || !Array.isArray(c.plans) || c.plans.length === 0 || c.plans.length > 20) return null;
  const methodsOf = (m: unknown) => (Array.isArray(m) ? m.filter((x): x is string => typeof x === "string" && METHOD.test(x)).slice(0, 7) : []);
  const plans = c.plans.map((p) => ({ key: String(p?.key ?? ""), pattern: String(p?.pattern ?? ""), methods: methodsOf((p as { methods?: unknown })?.methods), routes: Array.isArray(p?.routes) ? p.routes.filter((r) => r && typeof r.path === "string" && PATH.test(r.path)).slice(0, 100).map((r) => ({ method: String(r.method).slice(0, 7), path: r.path })) : [] }));
  if (plans.some((p) => !PATTERN.test(p.pattern) || p.routes.length === 0)) return null;
  const checksOf = (l: unknown): MethodCheck[] => (Array.isArray(l) ? l.filter((x) => x && typeof x.method === "string" && METHOD.test(x.method) && typeof x.path === "string" && PATH.test(x.path) && typeof x.plan === "string" && PATTERN.test(x.plan)).slice(0, 20).map((x) => ({ method: x.method, path: x.path, plan: x.plan, auth: Array.isArray(x.auth) ? x.auth.filter((a: unknown): a is string => typeof a === "string").map((a: string) => a.slice(0, 40)).slice(0, 5) : [] })) : []);
  const declared = Array.isArray(c.declared) ? c.declared.filter((d) => d && typeof d.pattern === "string" && PATTERN.test(d.pattern)).slice(0, 50).map((d) => ({ pattern: d.pattern, methods: methodsOf(d.methods) })) : null;
  const public_checks = Array.isArray(c.public_checks) ? c.public_checks.filter((p): p is string => typeof p === "string" && PATH.test(p)).slice(0, 20) : [];
  const auth_checks = Array.isArray(c.auth_checks) ? c.auth_checks.filter((p): p is string => typeof p === "string" && PATH.test(p)).slice(0, 20) : [];
  return { app: c.app, instance: c.instance, plans, public_checks, auth_checks, method_checks: checksOf(c.method_checks), overreach: checksOf(c.overreach), declared };
}

/** Respuesta de rechazo del PROPIO SDK de LicenRoute: uno de sus códigos y su request_id (una app no lleva los dos). */
const LICENROUTE_CODES = new Set(["payment_required", "forbidden", "licensed_route_not_covered", "rate_limited", "service_unavailable"]);
export function isLicenRouteDenial(h: Hit): boolean {
  try { const b = JSON.parse(h.body) as { error?: unknown; request_id?: unknown }; return typeof b.error === "string" && LICENROUTE_CODES.has(b.error) && typeof b.request_id === "string"; } catch { return false; }
}

/** Pide una ruta del diario. Si la ruta no es del origen autorizado, no hay petición ni credencial. */
export function routeRequest(base: URL, path: string, token?: string, method: SafeMethod = "GET"): Promise<Hit> {
  try { return get(appUrl(base, path).toString(), token, base.origin, method); }
  catch (e) { return Promise.resolve({ status: null, error: (e as Error).message, body: "", ms: 0 }); }
}

export async function runTests(opts: { app: string; instance: string; baseUrl: string; journal: TestContext | null; admin: TestAdmin }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean | null, detail: string) => { checks.push({ id, ok, detail }); };
  const base = loopbackUrl(opts.baseUrl);
  const request = (p: string, token?: string, method: SafeMethod = "GET") => routeRequest(base, p, token, method);
  const journal = opts.journal;
  const admin = opts.admin;
  const why = (r: { ok: false; error: { message: string } }) => firstLines(r.error.message);
  if (!journal) { add("integracion", false, t("test.no_integration")); return checks; }
  if (journal.app !== opts.app || journal.instance !== opts.instance) add("aviso", null, t("test.integration_for", { app: journal.app, instance: journal.instance }));

  // 0. Servicio de decisiones y sitio de la app.
  const status = await admin.siteStatus(opts.app);
  if (!status.ok) { add(admin.provider, false, why(status)); return checks; }
  const st = status.value;
  const missing = journal.plans.filter((p) => !st.plans.some((x) => x.pattern === p.pattern));
  if (missing.length) { add(`${admin.provider}-planes`, false, t("test.site_missing_plans", { app: opts.app, p2: missing.map((m) => m.pattern).join(", "), p3: missing.map((m) => `${planKey(m.pattern)}=${m.pattern}:3`).join(" --plan ") })); return checks; }
  add(admin.provider, true, t("test.site_demo", { app: opts.app, length: st.plans.length }));
  // D4.1: el plan aprobado, el código y el servicio deben exigir licencia en los MISMOS métodos.
  for (const p of journal.plans) {
    const key = planKey(p.pattern); const want = p.methods.join(","); // "" = todos los métodos (diario de 0.2.2)
    const shown = (m: string) => m || t("test.all_methods");
    const code = journal.declared === undefined || journal.declared === null ? null : journal.declared.find((d) => d.pattern === p.pattern);
    if (code === null) add(`${key}:metodos-codigo`, null, t("test.code_unreadable"));
    else if (code === undefined) add(`${key}:metodos-codigo`, false, t("test.code_missing_pattern", { pattern: p.pattern }));
    else add(`${key}:metodos-codigo`, code.methods.join(",") === want, t("test.methods_code", { plan: shown(want), code: shown(code.methods.join(",")) }));
    const served = st.plans.find((x) => x.pattern === p.pattern)?.methods;
    if (served === undefined) add(`${key}:metodos-servicio`, null, t("test.provider_no_methods", { provider: admin.provider }));
    else add(`${key}:metodos-servicio`, served.join(",") === want, t("test.methods_service", { plan: shown(want), provider: admin.provider, served: shown(served.join(",")) }));
  }

  // 1. La app responde.
  const first = journal.plans[0]!; const firstPath = example(first.routes[0]!.path);
  const alive = await until(() => request(firstPath), (h) => h.status !== null, 30);
  if (alive.status === null) { add("app", false, t("test.app_down", { origin: base.origin })); return checks; }

  // 2. Activación (BL-11): exige que el SDK de la app haya atestado los patrones.
  let active: string[] = [];
  for (let i = 0; i < 30; i++) {
    const r = await admin.activate(opts.app);
    active = r.ok ? r.value.filter((a) => a.state === "activated" || a.state === "already_active").map((a) => a.pattern) : [];
    if (journal.plans.every((p) => active.includes(p.pattern))) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  const notActive = journal.plans.filter((p) => !active.includes(p.pattern));
  add("activacion", notActive.length === 0, notActive.length ? t("test.not_active", { p1: notActive.map((p) => p.pattern).join(", ") }) : t("test.activated"));
  if (notActive.length) return checks;

  // 3. Licencias de prueba nuevas (los tokens nunca se imprimen).
  const issued = await admin.issueLicenses(opts.app);
  if (!issued.ok) { add("licencias", false, t("test.licences_failed", { p1: why(issued) })); return checks; }
  const absent: string[] = [];
  const token = async (name: string) => {
    const r = await admin.license(opts.app, name);
    if (r.ok) return r.value;
    absent.push(`${name}: ${why(r)}`);
    return null;
  };
  const forged = admin.forgedToken();

  for (const p of journal.plans) {
    const key = planKey(p.pattern); const path = example(p.routes[0]!.path);
    const valid = await token(key); const rev = await token(`${key}-revocable`); const quotaTok = await token(`${key}-cuota`);
    if (!valid || !rev || !quotaTok) { add(`${key}`, false, t("test.licences_missing", { p1: absent.splice(0).join(" | ") })); continue; }
    const head = p.methods.length === 0 || p.methods.includes("HEAD");
    // Protección efectiva de TODAS las rutas del plan, no solo de la configuración.
    for (const r of p.routes) { const h = await request(example(r.path)); add(`${key}:sin-licencia ${r.path}`, h.status === 402, show(h)); }
    if (head) { const h = await request(path, undefined, "HEAD"); add(`${key}:sin-licencia HEAD ${path}`, h.status === 402, show(h)); }
    const v = await until(() => request(path, valid), (h) => ok2xx(h) || (h.status !== 403 && h.status !== 503), 20);
    add(`${key}:licencia-valida`, ok2xx(v), show(v));
    if (head) { const h = await request(path, valid, "HEAD"); add(`${key}:licencia-valida HEAD`, ok2xx(h), show(h)); }
    // OPTIONS (p. ej. la petición previa de CORS) no lleva licencia: nunca debe rechazarla LicenRoute.
    if (p.methods.length > 0) { const h = await request(path, undefined, "OPTIONS"); add(`${key}:options-sin-cobro`, h.status !== null && !isLicenRouteDenial(h) && h.status !== 402, show(h)); }
    const other = journal.plans.find((x) => x !== p);
    if (other) { const ot = await token(planKey(other.pattern)); const h = await request(path, ot ?? forged); add(`${key}:licencia-de-otro-plan`, h.status === 402, show(h)); }
    else add(`${key}:licencia-de-otro-plan`, null, t("test.not_applicable_one_plan"));
    const f = await request(path, forged); add(`${key}:licencia-inventada`, f.status === 403, show(f));
    const quota = st.plans.find((x) => x.pattern === p.pattern)!.quota;
    if (quota <= 20) {
      // Con HEAD en el plan, GET y HEAD alternados: gastan la MISMA cuota.
      const seq: SafeMethod[] = Array.from({ length: quota + 1 }, (_, i) => (head && i % 2 === 1 ? "HEAD" : "GET"));
      const hits: Hit[] = []; for (const m of seq) hits.push(await request(path, quotaTok, m));
      add(`${key}:cuota`, hits.slice(0, quota).every(ok2xx) && hits[quota]!.status === 402, t("test.quota_detail", { p1: hits.map((h, i) => `${seq[i]} ${h.status ?? "-"}`).join(" · "), quota }));
    } else add(`${key}:cuota`, null, quotaHint(key, p.pattern, quota));
    const before = await request(path, rev);
    const revoked = (await admin.revoke(opts.app, `${key}-revocable`)).ok;
    const after = revoked ? await until(() => request(path, rev), (h) => h.status === 403, 10) : before;
    add(`${key}:revocada`, ok2xx(before) && revoked && after.status === 403, t("test.revoked_detail", { p1: show(before), p2: show(after) }));
    if (head && revoked) { const h = await request(path, rev, "HEAD"); add(`${key}:revocada HEAD`, h.status === 403, show(h)); }
  }
  // D4.1: métodos que el plan NO incluye bajo sus patrones. Nunca se envían a la app (pueden escribir): se pregunta al
  // servicio de decisiones, sin licencia, y el código ya se comparó arriba (metodos-codigo).
  const unchecked: string[] = [];
  for (const m of journal.method_checks ?? []) {
    const id = `metodo-no-cubierto ${m.method} ${m.path}`; const own = m.auth.length ? t("test.own_auth", { p1: m.auth.join(", ") }) : "";
    if (m.method === "ALL" || !admin.decide) { unchecked.push(`${m.method} ${m.path}`); add(id, null, t(m.method === "ALL" ? "test.any_method_unchecked" : "test.cannot_ask_unchecked", { provider: admin.provider, own })); continue; }
    const d = await admin.decide(opts.app, m.method, example(m.path));
    if (!d.ok) { unchecked.push(`${m.method} ${m.path}`); add(id, null, t("test.not_checked", { p1: why(d) })); continue; }
    add(id, d.value === "allow", t("test.method_not_charged", { plan: m.plan, provider: admin.provider, value: d.value, own }));
  }
  for (const m of journal.overreach ?? []) {
    add(`metodo-no-aprobado ${m.method} ${m.path}`, false, t(m.auth.length ? "test.method_not_approved_auth" : "test.method_not_approved", { plan: m.plan, method: m.method, path: m.path, auth: m.auth.join(", ") }));
  }
  if ((journal.method_checks ?? []).length) add("metodos:cobertura", unchecked.length ? null : true, unchecked.length ? t("test.partial_coverage", { p1: unchecked.join(", ") }) : t("test.methods_checked", { length: journal.method_checks!.length }));
  for (const pub of journal.public_checks) { const h = await request(example(pub)); add(`publica ${pub}`, ok2xx(h), show(h)); }
  // Autenticación propia (rutas que quedaron para decisión): LicenRoute no la sustituye ni la cambia. Sin credenciales,
  // debe responder LA APP (401/403 o una redirección al login), nunca un rechazo de LicenRoute.
  for (const path of journal.auth_checks ?? []) {
    const h = await request(example(path));
    const verdict = h.status === null ? false : isLicenRouteDenial(h) ? false : [401, 403].includes(h.status) || (h.status >= 300 && h.status < 400) ? true : ok2xx(h) ? null : false;
    add(`autenticacion ${path}`, verdict, isLicenRouteDenial(h) ? t("test.auth_licenroute_rejects", { p1: show(h) }) : ok2xx(h) ? t("test.auth_own", { p1: show(h) }) : show(h));
  }

  // 4. Central caído: TODAS las rutas de TODOS los planes cerradas (aunque la licencia sea válida), públicas abiertas;
  //    y vuelta. Lo que no se puede probar se declara (cobertura parcial), nunca se da por bueno.
  const tokens = new Map<string, string | null>();
  for (const p of journal.plans) tokens.set(p.pattern, await token(planKey(p.pattern)));
  absent.splice(0);
  const down = await admin.outage("on");
  if (!down.ok) { add("central-caido", false, t("test.outage_failed", { p1: why(down) })); return checks; }
  const untested: string[] = [];
  try {
    for (const p of journal.plans) {
      const k = planKey(p.pattern); const tok = tokens.get(p.pattern);
      if (!tok) { untested.push(t("test.no_test_licence", { pattern: p.pattern })); add(`central-caido:${k}`, null, t("test.not_checked_no_licence")); continue; }
      const hits: [string, Hit][] = [];
      for (const r of p.routes) hits.push([r.path, await request(example(r.path), tok)]);
      if (p.methods.length === 0 || p.methods.includes("HEAD")) hits.push([`HEAD ${p.routes[0]!.path}`, await request(example(p.routes[0]!.path), tok, "HEAD")]);
      add(`central-caido:${k}`, hits.every(([, h]) => h.status === 503), hits.map(([r, h]) => `${r} ${show(h)}`).join(" · "));
    }
    for (const pub of journal.public_checks) { const h = await request(example(pub)); add(`central-caido:publica ${pub}`, ok2xx(h), show(h)); }
  } finally {
    const started = (await admin.outage("off")).ok;
    const back: string[] = []; let allBack = started;
    for (const p of journal.plans) {
      const tok = tokens.get(p.pattern); if (!tok) continue;
      const h = started ? await until(() => request(example(p.routes[0]!.path), tok), ok2xx, 40) : { status: null, error: t("test.recover_failed"), body: "", ms: 0 };
      back.push(`${p.pattern} ${show(h)}`); allBack &&= ok2xx(h);
    }
    add("central-recuperado", allBack, back.join(" · ") || t("test.recover_failed"));
  }
  add("central-caido:cobertura", untested.length ? null : true, untested.length ? t("test.partial_coverage", { p1: untested.join(", ") }) : t("test.outage_checked", { length: journal.plans.length }));
  return checks;
}

/**
 * Resultado de un escenario según el servicio que lo respondió. Un escenario que pasa contra el simulador es SIMULATED
 * PASS: comprueba la integración, no certifica la seguridad de Central. Solo contra Central real es VERIFIED PASS.
 */
export type ScenarioResult = "verified_pass" | "simulated_pass" | "fail" | "info";
export function scenarioResult(check: Check, verification: Verification): ScenarioResult {
  if (check.ok === null) return "info";
  if (!check.ok) return "fail";
  return verification === "verified" ? "verified_pass" : "simulated_pass";
}
export const RESULT_LABEL: Record<ScenarioResult, string> = { verified_pass: "VERIFIED PASS", simulated_pass: "SIMULATED PASS", fail: "FAIL", info: "--" };
