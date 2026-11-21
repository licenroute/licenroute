/**
 * F2 (EVAL-01/02): una ruta DECLARADA de pago (`licensedPaths`) solo se sirve si la política publicada, vigente y
 * verificada la protege efectivamente. Si no: 503 sin ejecutar la app y ready() = false. Oráculo: la app de prueba
 * responde {"ok":true,…}; si aparece en el cuerpo, la petición llegó al controlador.
 */
import { canonicalSha256, type PolicyDocumentBody } from "@licenroute/policy-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { licenroute, type LicenRouteMiddleware } from "../src/index.ts";
import { LicenRouteConfigError } from "../src/options.ts";
import { allow, API_KEY, FakeApi, raw, SITE_ID, silentLogger, startApp } from "./helpers.ts";

const TOKEN = "bgat_abcdefgh_" + "A".repeat(43);
const route = (route_pattern: string, methods: string[] = []) => ({
  plan_id: "plan_p1", plan_uuid: "00000000-0000-7000-8000-000000000001", route_pattern, methods,
  checkout_url: "https://licenroute.example/plans/plan_p1", currency: "EUR", unit_price_minor: 150, unit_size: 1000,
});
const doc = (licensed_routes: ReturnType<typeof route>[], version = 3): PolicyDocumentBody => ({
  site_id: SITE_ID, version, published_at: "2026-10-14T00:00:00.000Z",
  defaults: { fallback: "fail_open", score_thresholds: { observe: 30, rate_limit: 60, block: 80 }, excluded_paths: [] },
  rules: [], licensed_routes,
});
const signed = (d: PolicyDocumentBody) => ({ status: 200, body: { ...d, checksum: canonicalSha256(d) } });
const paymentRequired = () => ({ action: "payment_required", risk_score: 0, reason_codes: ["LICENSE_REQUIRED"], policy_version: 3, ttl_seconds: 0,
  payment: { plan_id: "plan_p1", checkout_url: "https://licenroute.example/plans/plan_p1", currency: "EUR", unit_price_minor: 150, unit_size: 1000 } });
const reachedApp = (body: string) => body.includes('"ok":true');

const api = new FakeApi();
let policy: { status: number; body: unknown } = { status: 404, body: {} };
let decision: Record<string, unknown> = allow();
const decisionCalls = () => api.received.filter((r) => r.url === "/v1/decisions").length;
const open: { close: () => Promise<void> }[] = [];
const mws: LicenRouteMiddleware[] = [];

beforeAll(async () => {
  await api.start();
  api.reply = (url) => (url.startsWith("/v1/policies/current") ? policy : url.startsWith("/v1/sdk/attestations") ? { status: 204, body: {} } : { status: 200, body: decision });
});
afterEach(async () => {
  for (const m of mws.splice(0)) m.close();
  await Promise.all(open.splice(0).map((a) => a.close()));
  api.received.length = 0;
  policy = { status: 404, body: {} };
  decision = allow();
});
afterAll(() => api.close());

async function app(licensedPaths: string[], extra: Record<string, unknown> = {}) {
  const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths, logger: silentLogger, policySync: { intervalMs: 150 }, ...extra });
  mws.push(mw);
  await expect.poll(() => mw.policy?.version ?? null, { timeout: 3_000 }).not.toBeNull();
  const a = await startApp(5, mw);
  open.push(a);
  return { mw, get: (path: string, headers: Record<string, string> = {}) => raw(a.port, "GET", path, headers), port: a.port };
}

describe("F2: rutas declaradas de pago sin cobertura de la política", () => {
  it("primera instalación (sin política publicada): 503 sin ejecutar la app y ready() = false; las rutas públicas, normales", async () => {
    const { mw, get } = await app(["/datos/**"]);
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }] as Record<string, string>[]) {
      const r = await get("/datos/1", headers);
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body).error).toBe("licensed_route_not_covered");
      expect(r.headers["retry-after"]).toBeDefined();
      expect(reachedApp(r.body)).toBe(false);
    }
    expect(decisionCalls()).toBe(0); // ni siquiera se pregunta: no hay nada que lo proteja
    expect(mw.ready()).toBe(false);
    expect(reachedApp((await get("/publica")).body)).toBe(true);
  });

  it("plan creado pero política sin publicar (política vigente sin la ruta): 503 y ready() = false", async () => {
    policy = signed(doc([]));
    const { mw, get } = await app(["/datos/**"]);
    const r = await get("/datos/1");
    expect([r.status, reachedApp(r.body)]).toEqual([503, false]);
    expect(mw.ready()).toBe(false);
  });

  it("política publicada que la cubre: LicenRoute decide (402 sin licencia; con licencia válida se sirve) y ready() = true", async () => {
    policy = signed(doc([route("/datos/**")]));
    const { mw, get } = await app(["/datos/**"]);
    expect(mw.ready()).toBe(true);
    decision = paymentRequired();
    const r = await get("/datos/1");
    expect([r.status, reachedApp(r.body)]).toEqual([402, false]);
    decision = allow({ reason_codes: ["LICENSE_VALID"] });
    expect(reachedApp((await get("/datos/1", { authorization: `Bearer ${TOKEN}` })).body)).toBe(true);
  });

  it("copia local desfasada (el propietario retiró el plan): LicenRoute permite SIN licencia válida -> 503, nunca la app", async () => {
    policy = signed(doc([route("/datos/**")]));
    const { get } = await app(["/datos/**"]);
    decision = allow(); // la API ya no tiene ruta de pago: permite
    for (const headers of [{}, { authorization: `Bearer ${TOKEN}` }] as Record<string, string>[]) {
      const r = await get("/datos/1", headers);
      expect([r.status, JSON.parse(r.body).error, reachedApp(r.body)]).toEqual([503, "licensed_route_not_covered", false]);
    }
  });

  it("las rutas declaradas de pago no usan la caché de decisiones", async () => {
    policy = signed(doc([route("/datos/**")]));
    const { get } = await app(["/datos/**"], { decisionCache: { maxEntries: 100, maxTtlSeconds: 60 } });
    decision = allow({ ttl_seconds: 60 });
    await get("/datos/1");
    await get("/datos/1");
    expect(decisionCalls()).toBe(2);
  });

  it("patrones solapados: el plan cubre solo /datos/precios/**: lo cubierto lo decide LicenRoute; el resto, 503; ready() = false", async () => {
    policy = signed(doc([route("/datos/precios/**")]));
    const { mw, get } = await app(["/datos/**"]);
    decision = paymentRequired();
    expect((await get("/datos/precios/1")).status).toBe(402);
    const r = await get("/datos/otros/1");
    expect([r.status, reachedApp(r.body)]).toEqual([503, false]);
    expect(mw.ready()).toBe(false);
  });

  it("plan restringido a GET: un POST a la ruta declarada no está cubierto -> 503; ready() = false", async () => {
    policy = signed(doc([route("/datos/**", ["GET"])]));
    const { mw, port } = await app(["/datos/**"]);
    decision = paymentRequired();
    const r = await raw(port, "POST", "/datos/1", { "content-length": "0" });
    expect([r.status, reachedApp(r.body)]).toEqual([503, false]);
    expect(mw.ready()).toBe(false);
  });

  it("publicación posterior: 503 mientras no hay política; al publicarse y verificarse, ready() = true y LicenRoute decide", async () => {
    const { mw, get } = await app(["/datos/**"]);
    expect((await get("/datos/1")).status).toBe(503);
    policy = signed(doc([route("/datos/**")]));
    await expect.poll(() => mw.ready(), { timeout: 3_000 }).toBe(true);
    decision = paymentRequired();
    expect((await get("/datos/1")).status).toBe(402);
    // Y si después el propietario retira el plan y publica, deja de estar listo y vuelve a cerrarse.
    policy = signed(doc([], 4));
    await expect.poll(() => mw.ready(), { timeout: 3_000 }).toBe(false);
    expect((await get("/datos/1")).status).toBe(503);
  });

  it("con LicenRoute inaccesible (reinicio sin caché): 503 y ready() = false", async () => {
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: "http://127.0.0.1:9", licensedPaths: ["/datos/**"], logger: silentLogger, timeoutMs: 200, policySync: { intervalMs: 60_000 } });
    mws.push(mw);
    const a = await startApp(5, mw);
    open.push(a);
    const r = await raw(a.port, "GET", "/datos/1");
    expect([r.status, reachedApp(r.body)]).toEqual([503, false]);
    expect(mw.ready()).toBe(false);
  });

  it("sin rutas declaradas de pago, ready() solo exige una política verificada (compatibilidad)", async () => {
    const { mw } = await app([]);
    expect(mw.ready()).toBe(true);
  });

  it("policySync desactivado con licensedPaths: error de configuración al arrancar (no se podría verificar la cobertura)", () => {
    expect(() => licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: ["/datos/**"], logger: silentLogger, policySync: false }))
      .toThrow(LicenRouteConfigError);
    expect(() => licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: [], logger: silentLogger, policySync: false })).not.toThrow();
  });
});
