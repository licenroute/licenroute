import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalSha256, type PolicyDocumentBody } from "@licenroute/policy-contracts";
import { licenroute, LicenRouteConfigError, type LicenRouteMiddleware } from "../src/index.ts";
import { CircuitBreaker } from "../src/circuit-breaker.ts";
import { DecisionCache } from "../src/decision-cache.ts";
import { requestIdFor, uuidv7 } from "../src/request-id.ts";
import { allow, API_KEY, FakeApi, raw, SITE_ID, silentLogger, startApp } from "./helpers.ts";

const api = new FakeApi();
beforeAll(() => api.start());
afterAll(() => api.close());

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.map((f) => f()));
  cleanup = [];
  api.received.length = 0;
  api.reply = { status: 200, body: allow() };
});

async function setup(options: Partial<Parameters<typeof licenroute>[0]> = {}, version: 4 | 5 = 5) {
  // timeoutMs 1000 en pruebas: una respuesta inmediata no debe convertirse en fallback en un runner lento.
  const mw: LicenRouteMiddleware = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: [], timeoutMs: 1000, policySync: false, logger: silentLogger, ...options });
  const app = await startApp(version, mw);
  cleanup.push(async () => { mw.close(); await app.close(); });
  return { mw, port: app.port };
}

describe("configuración", () => {
  const base = { apiKey: API_KEY, siteId: SITE_ID, endpoint: "https://api.licenroute.example", licensedPaths: [] as string[], policySync: false as const };
  it.each([
    ["apiKey inválida", { apiKey: "nope" }],
    ["siteId inválido", { siteId: "demo" }],
    ["endpoint http no local (solo TLS)", { endpoint: "http://api.licenroute.example" }],
    ["endpoint inválido", { endpoint: "no-url" }],
    ["fallback desconocido", { fallback: "maybe" as never }],
    ["timeout absurdo", { timeoutMs: 0 }],
    ["sin licensedPaths (BL-11: obligatorio, [] si no hay rutas de pago)", { licensedPaths: undefined as never }],
    ["withoutPolicy desconocido", { withoutPolicy: "maybe" as never }],
  ])("%s -> error de configuración al arrancar", (_n, patch) => {
    expect(() => licenroute({ ...base, ...patch })).toThrow(LicenRouteConfigError);
  });

  it("acepta http en localhost o con allowInsecureEndpoint explícito", () => {
    expect(() => licenroute({ ...base, endpoint: "http://localhost:4000" })).not.toThrow();
    expect(() => licenroute({ ...base, endpoint: "http://decision.internal.example:4000", allowInsecureEndpoint: true })).not.toThrow();
  });
});

describe("rutas excluidas y protegidas (F3-01)", () => {
  it("health/static excluidos por defecto no llaman a la API", async () => {
    const { port } = await setup();
    for (const p of ["/health/live", "/up", "/assets/app.css", "/favicon.ico", "/HEALTH/live"]) await raw(port, "GET", p);
    expect(api.decisionRequests()).toHaveLength(0);
  });

  it("solo se consultan las protectedPaths", async () => {
    const { port } = await setup({ protectedPaths: ["/login", "/api/**"] });
    await raw(port, "GET", "/catalogo");
    await raw(port, "POST", "/login");
    await raw(port, "GET", "/API/items");
    expect(api.decisionRequests().map((r) => JSON.parse(r.body).path)).toEqual(["/login", "/API/items"]);
  });

  it("las variantes codificadas de una ruta protegida también se consultan", async () => {
    const { port } = await setup({ protectedPaths: ["/admin/**"] });
    for (const p of ["/ADMIN", "/admin.json", "/%61dmin", "//admin/x", "/x/../admin"]) await raw(port, "GET", p);
    expect(api.decisionRequests()).toHaveLength(5);
  });
});

describe("privacidad (F3-07)", () => {
  it("envía solo metadatos: sin cookies, Authorization, cuerpo ni query string", async () => {
    const { port } = await setup({ sessionCookies: ["_app_session"] });
    await raw(port, "POST", "/login?password=secreta&token=abc", {
      cookie: "_app_session=VALOR-SECRETO; other=1", authorization: "Bearer TOKEN-USUARIO", "content-type": "application/x-www-form-urlencoded", "content-length": "17",
      "user-agent": "Mozilla/5.0 Prueba",
    });
    const [req] = api.decisionRequests();
    const sent = JSON.parse(req!.body);
    expect(Object.keys(sent).sort()).toEqual(["client", "method", "path", "request_id", "signals", "site_id", "timestamp"]);
    expect(sent).toMatchObject({ method: "POST", path: "/login", site_id: SITE_ID, client: { ip: "127.0.0.1", user_agent: "Mozilla/5.0 Prueba" }, signals: { session_present: true } });
    for (const secret of ["VALOR-SECRETO", "TOKEN-USUARIO", "secreta", "abc", "password"]) expect(req!.body).not.toContain(secret);
    expect(req!.headers.authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("isAuthenticated añade la señal sin enviar datos del usuario", async () => {
    const { port } = await setup({ isAuthenticated: () => true });
    await raw(port, "GET", "/x");
    expect(JSON.parse(api.decisionRequests()[0]!.body).signals).toEqual({ authenticated_user: true });
  });
});

describe("request ID (F3-06)", () => {
  it("propaga un X-Request-Id válido y lo usa en la decisión", async () => {
    const { port } = await setup();
    const id = "11111111-2222-4333-8444-555555555555";
    const res = await raw(port, "GET", "/x", { "x-request-id": id });
    expect(res.headers["x-request-id"]).toBe(id);
    expect(JSON.parse(api.decisionRequests()[0]!.body).request_id).toBe(id);
  });

  it("genera un UUIDv7 si falta o es inválido (no se refleja entrada arbitraria)", async () => {
    const { port } = await setup();
    const res = await raw(port, "GET", "/x", { "x-request-id": "<script>alert(1)</script>" });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestIdFor(undefined)).not.toBe(requestIdFor(undefined));
    expect(uuidv7(0).startsWith("00000000-0000-7")).toBe(true);
  });
});

describe("IP del cliente detrás de proxies (F3-05)", () => {
  it("sin proxies de confianza, X-Forwarded-For se ignora", async () => {
    const { port } = await setup();
    await raw(port, "GET", "/x", { "x-forwarded-for": "6.6.6.6" });
    expect(JSON.parse(api.decisionRequests()[0]!.body).client.ip).toBe("127.0.0.1");
  });

  it("con el proxy local como de confianza, se usa la IP del cliente de XFF", async () => {
    const { port } = await setup({ trustedProxies: ["127.0.0.1/32"] });
    await raw(port, "GET", "/x", { "x-forwarded-for": "6.6.6.6, 198.51.100.7" });
    expect(JSON.parse(api.decisionRequests()[0]!.body).client.ip).toBe("198.51.100.7");
  });
});

describe("fallback por ruta y circuit breaker (F3-03, F3-04)", () => {
  it("routeFallbacks: fail_closed solo en la ruta sensible", async () => {
    api.reply = { status: 500, body: {} };
    const { port } = await setup({ fallback: "allow", routeFallbacks: { "/login": "deny" } });
    expect((await raw(port, "GET", "/catalogo")).status).toBe(200);
    const login = await raw(port, "POST", "/login");
    expect(login.status).toBe(503);
    expect(login.headers["retry-after"]).toBe("5");
  });

  it("tras 5 fallos el breaker se abre y deja de llamar a la API", async () => {
    api.reply = { status: 503, body: {} };
    const { port } = await setup({ circuitBreaker: { failureThreshold: 5, windowMs: 10_000, openMs: 60_000 } });
    for (let i = 0; i < 12; i++) expect((await raw(port, "GET", `/p${i}`)).status).toBe(200);
    expect(api.decisionRequests()).toHaveLength(5);
  });

  it("máquina de estados: cerrado -> abierto -> medio abierto (una prueba) -> cerrado/abierto", () => {
    const b = new CircuitBreaker({ failureThreshold: 2, windowMs: 1000, openMs: 500 });
    b.failure(0);
    expect(b.state(0)).toBe("closed");
    b.failure(100);
    expect(b.state(100)).toBe("open");
    expect(b.allowRequest(200)).toBe(false);
    expect(b.allowRequest(700)).toBe(true); // prueba en medio abierto
    expect(b.allowRequest(700)).toBe(false); // solo una a la vez
    b.failure(710);
    expect(b.state(710)).toBe("open");
    expect(b.allowRequest(1300)).toBe(true);
    b.success();
    expect(b.state(1300)).toBe("closed");
    // fallos fuera de la ventana no se acumulan
    b.failure(2000);
    b.failure(3500);
    expect(b.state(3500)).toBe("closed");
  });
});

describe("timeout de rutas licenciadas (Fase 7)", () => {
  it("con token de comprador espera hasta licensedTimeoutMs; sin token, timeoutMs", async () => {
    api.reply = { status: 200, body: allow(), delay_ms: 400 };
    const { port } = await setup({ timeoutMs: 200, licensedTimeoutMs: 1000, fallback: "deny" });
    const token = "bgat_abcdefgh_" + "A".repeat(43);
    expect((await raw(port, "GET", "/datos/1", { "botgate-access-token": token })).status).toBe(200);
    expect((await raw(port, "GET", "/catalogo")).status).toBe(503);
  });

  it("por defecto, licensedTimeoutMs = 1000 ms (y nunca menor que timeoutMs)", async () => {
    const { resolveOptions } = await import("../src/options.ts");
    const base = { apiKey: API_KEY, siteId: SITE_ID, endpoint: "https://api.example.com", licensedPaths: [] };
    expect(resolveOptions(base).licensedTimeoutMs).toBe(1000);
    expect(resolveOptions({ ...base, timeoutMs: 3000 }).licensedTimeoutMs).toBe(3000);
    expect(() => resolveOptions({ ...base, licensedTimeoutMs: 0 })).toThrow(/licensedTimeoutMs/);
  });
});

describe("breaker con backoff (Fase 7)", () => {
  it("cada prueba fallida duplica la apertura hasta maxOpenMs; un éxito vuelve a la apertura inicial", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, windowMs: 1000, openMs: 2000, maxOpenMs: 10_000 });
    let t = 0;
    b.failure(t);
    const opens: number[] = [];
    for (let i = 0; i < 5; i++) {
      opens.push(b.openDurationMs);
      t += b.openDurationMs;
      expect(b.allowRequest(t - 1)).toBe(false);
      expect(b.allowRequest(t)).toBe(true);
      b.failure(t);
    }
    expect(opens).toEqual([2000, 4000, 8000, 10_000, 10_000]);
    t += b.openDurationMs;
    expect(b.allowRequest(t)).toBe(true);
    b.success();
    b.failure(t);
    expect(b.openDurationMs).toBe(2000);
  });

  it("por defecto, un pico de fallos deja el breaker abierto 2 s, no 30 s", async () => {
    api.reply = { status: 503, body: {} };
    const { port } = await setup({ circuitBreaker: { windowMs: 10_000 } });
    for (let i = 0; i < 6; i++) await raw(port, "GET", `/p${i}`);
    expect(api.decisionRequests()).toHaveLength(5);
    api.reply = { status: 200, body: allow() };
    await new Promise((r) => setTimeout(r, 2100));
    await raw(port, "GET", "/despues");
    expect(api.decisionRequests()).toHaveLength(6);
  });
});

describe("caché de decisiones (F3-14)", () => {
  it("cachea allow con ttl por cliente y ruta, respetando el TTL", async () => {
    api.reply = { status: 200, body: allow({ ttl_seconds: 2 }) };
    const { port } = await setup();
    await raw(port, "GET", "/a");
    await raw(port, "GET", "/a");
    await raw(port, "GET", "/b");
    await raw(port, "GET", "/a", { "user-agent": "otro" });
    expect(api.decisionRequests()).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 2100));
    await raw(port, "GET", "/a");
    expect(api.decisionRequests()).toHaveLength(4);
  });

  it("LRU acotado y nunca cachea block ni rate_limit aunque traigan ttl", () => {
    const cache = new DecisionCache(2, 60);
    const d = (action: string) => ({ ...allow({ ttl_seconds: 30 }), action, request_id: "r" }) as never;
    cache.set("block", d("block"));
    cache.set("rl", d("rate_limit"));
    expect(cache.size).toBe(0);
    cache.set("a", d("allow"));
    cache.set("b", d("allow"));
    cache.get("a");
    cache.set("c", d("allow"));
    expect([cache.get("a"), cache.get("b"), cache.get("c")].map(Boolean)).toEqual([true, false, true]);
  });

  it("decisionCache: false desactiva la caché", async () => {
    api.reply = { status: 200, body: allow({ ttl_seconds: 60 }) };
    const { port } = await setup({ decisionCache: false });
    await raw(port, "GET", "/a");
    await raw(port, "GET", "/a");
    expect(api.decisionRequests()).toHaveLength(2);
  });
});

describe("sincronización de política (F3-08)", () => {
  const doc = (overrides: Partial<PolicyDocumentBody> = {}): PolicyDocumentBody => ({
    site_id: SITE_ID, version: 3, published_at: "2026-10-11T00:00:00.000Z",
    defaults: { fallback: "fail_closed", score_thresholds: { observe: 30, rate_limit: 60, block: 80 }, excluded_paths: ["/status"] },
    rules: [
      { id: "r1", priority: 10, path_pattern: "/catalogo/**", methods: [], conditions: {}, action: "rate_limit", mode: "enforce", rate_limit: { limit: 5, period_seconds: 60, burst: 0, dimension: "ip" }, fallback: "fail_open" },
    ],
    licensed_routes: [{ plan_id: "plan_p1", plan_uuid: "00000000-0000-7000-8000-0000000000p1".replace("p1", "01"), route_pattern: "/datos/**", methods: [], checkout_url: "https://licenroute.example/plans/plan_p1", currency: "EUR", unit_price_minor: 150, unit_size: 1000 }],
    ...overrides,
  });
  const serve = (document: PolicyDocumentBody, checksum = canonicalSha256(document), decisionStatus = 500) => {
    api.reply = (url) => url.startsWith("/v1/policies/current")
      ? { status: 200, body: { ...document, checksum }, headers: { etag: `"v${document.version}"` } }
      : { status: decisionStatus, body: {} };
  };

  it("aplica fallbacks de la política: regla > local > sitio; rutas licenciadas siempre cerradas", async () => {
    serve(doc());
    const { mw, port } = await setup({ policySync: { intervalMs: 60_000 } });
    expect(await mw.policy!.refresh()).toBe(true);
    expect(mw.policy!.version).toBe(3);
    expect((await raw(port, "GET", "/catalogo/x")).status).toBe(200); // regla: fail_open
    expect((await raw(port, "GET", "/otra")).status).toBe(503); // defecto del sitio: fail_closed
    expect((await raw(port, "GET", "/datos/1")).status).toBe(503); // licenciada
    expect((await raw(port, "GET", "/status")).status).toBe(200); // excluida por el servidor
    expect(api.decisionRequests().map((r) => JSON.parse(r.body).path)).not.toContain("/status");
  });

  it("un fallback local explícito prevalece sobre el del sitio, pero no sobre el de una regla", async () => {
    serve(doc());
    const { mw, port } = await setup({ fallback: "allow", routeFallbacks: { "/catalogo/**": "deny" }, policySync: { intervalMs: 60_000 } });
    await mw.policy!.refresh();
    expect((await raw(port, "GET", "/otra")).status).toBe(200);
    expect((await raw(port, "GET", "/catalogo/x")).status).toBe(200);
  });

  it("usa If-None-Match y conserva la política ante 304", async () => {
    serve(doc());
    const { mw } = await setup({ policySync: { intervalMs: 60_000 } });
    await mw.policy!.refresh();
    api.reply = { status: 304 };
    expect(await mw.policy!.refresh()).toBe(true);
    const last = api.received.filter((r) => r.url === "/v1/policies/current").at(-1)!;
    expect(last.headers["if-none-match"]).toBe('"v3"');
    expect(mw.policy!.version).toBe(3);
  });

  it("rechaza una política con checksum inválido o de otro sitio y mantiene la anterior", async () => {
    serve(doc());
    const { mw } = await setup({ policySync: { intervalMs: 60_000 } });
    await mw.policy!.refresh();
    serve(doc({ version: 4 }), "0".repeat(64));
    expect(await mw.policy!.refresh()).toBe(false);
    serve(doc({ version: 5, site_id: "site_otrositio00001" }));
    expect(await mw.policy!.refresh()).toBe(false);
    expect(mw.policy!.version).toBe(3);
  });
});

describe("robustez", () => {
  it("métodos no soportados por el contrato no rompen: se aplica el fallback", async () => {
    const { port } = await setup();
    expect((await raw(port, "PROPFIND", "/x")).status).not.toBe(500);
    expect(api.decisionRequests()).toHaveLength(0);
  });

  it("Express 4 y 5 dan el mismo resultado ante un block", async () => {
    api.reply = { status: 200, body: { ...allow(), action: "block" } };
    const results = [];
    for (const v of [4, 5] as const) {
      const { port } = await setup({}, v);
      const r = await raw(port, "GET", "/admin");
      results.push([r.status, JSON.parse(r.body).error]);
    }
    expect(results).toEqual([[403, "forbidden"], [403, "forbidden"]]);
  });
});

describe("rutas licenciadas (Fase 5)", () => {
  const token = `bgat_abcdefgh_${"A".repeat(43)}`;
  it("con token no se usa la caché de decisiones: cada petición llega al ledger", async () => {
    api.reply = { status: 200, body: allow({ ttl_seconds: 60 }) };
    const { port } = await setup();
    for (let i = 0; i < 3; i++) await raw(port, "GET", "/datos/1", { authorization: `Bearer ${token}` });
    expect(api.decisionRequests()).toHaveLength(3);
  });

  it("402 con la información de pago de la API", async () => {
    api.reply = { status: 200, body: { ...allow(), action: "payment_required", reason_codes: ["LICENSE_REQUIRED"], payment: { plan_id: "plan_x", checkout_url: "https://licenroute.example/plans/plan_x", currency: "EUR", unit_price_minor: 150, unit_size: 1000 } } };
    const { port } = await setup();
    const res = await raw(port, "GET", "/datos/1");
    expect(res.status).toBe(402);
    expect(JSON.parse(res.body)).toMatchObject({ error: "payment_required", payment: { plan_id: "plan_x", checkout_url: "https://licenroute.example/plans/plan_x" } });
  });
});
