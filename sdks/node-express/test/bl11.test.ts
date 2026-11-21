/**
 * BL-11 (Fase 8): las rutas de pago nunca se sirven gratis cuando LicenRoute no responde, tampoco en la
 * primera instalación (sin política) ni con una política corrupta, caducada o de otro sitio.
 * Fixture compartido con el SDK de Rails: policy-fallback.json.
 */
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256, compileGlob, type Fallback, type PolicyDocumentBody } from "@licenroute/policy-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { licenroute, type LicenRouteMiddleware } from "../src/index.ts";
import { coversLicensed, resolveFallback, type FallbackState } from "../src/fallback.ts";
import { normalizeFallback } from "../src/options.ts";
import { SDK_VERSION } from "../src/api-client.ts";
import { allow, API_KEY, FakeApi, fixture, freePort, raw, SITE_ID, silentLogger, startApp } from "./helpers.ts";

type PolicyFx = { trusted: boolean; licensed_routes: { route_pattern: string; methods: string[] }[]; rules: { path_pattern: string; methods: string[]; priority: number; fallback: Fallback }[]; default_fallback: Fallback };
type CaseFx = {
  name: string; local_licensed: string[]; without_policy: "fallback" | "deny"; policy: PolicyFx | null;
  route_fallbacks: Record<string, "allow" | "deny">; fallback: "fail_open" | "fail_closed" | null;
  request: { method: string; path: string; token: boolean }; expect: { fallback: Fallback; reason: string };
};
const fx = fixture<{ cases: CaseFx[]; covers: { local: string[]; pattern: string; expect: boolean }[] }>("policy-fallback.json");

describe("policy-fallback.json: resolución del fallback (paridad con Rails)", () => {
  it.each(fx.cases)("$name", (c) => {
    const local = c.local_licensed.map(compileGlob);
    const p = c.policy;
    const state: FallbackState = {
      // Las cadenas del fixture compartido con Rails son declaraciones de todos los métodos (D4.1).
      localLicensed: local.map((glob) => ({ glob, methods: new Set<string>() })),
      knownLicensed: (p?.licensed_routes ?? []).map((r) => ({ glob: compileGlob(r.route_pattern), methods: new Set(r.methods) })),
      trusted: p?.trusted
        ? { ruleFallbacks: [...p.rules].sort((a, b) => a.priority - b.priority).map((r) => ({ glob: compileGlob(r.path_pattern), methods: new Set(r.methods), fallback: r.fallback })), defaultFallback: p.default_fallback }
        : null,
      withoutPolicy: c.without_policy,
      unsafeConfig: c.without_policy !== "deny" && (p?.licensed_routes ?? []).some((r) => !coversLicensed(local, r.route_pattern)),
      routeFallbacks: Object.entries(c.route_fallbacks).map(([g, f]) => ({ glob: compileGlob(g), fallback: normalizeFallback(f) })),
      fallback: c.fallback,
    };
    expect(resolveFallback(state, { path: c.request.path, method: c.request.method, hasToken: c.request.token })).toEqual(c.expect);
  });

  it.each(fx.covers)("cubre $local -> $pattern: $expect", (c) => {
    expect(coversLicensed(c.local.map(compileGlob), c.pattern)).toBe(c.expect);
  });
});

const TOKEN = "bgat_abcdefgh_" + "A".repeat(43);
const doc = (overrides: Partial<PolicyDocumentBody> = {}): PolicyDocumentBody => ({
  site_id: SITE_ID, version: 7, published_at: "2026-10-11T00:00:00.000Z",
  defaults: { fallback: "fail_open", score_thresholds: { observe: 30, rate_limit: 60, block: 80 }, excluded_paths: [] },
  rules: [],
  licensed_routes: [{ plan_id: "plan_p1", plan_uuid: "00000000-0000-7000-8000-000000000001", route_pattern: "/informes/**", methods: [], checkout_url: "https://licenroute.example/plans/plan_p1", currency: "EUR", unit_price_minor: 150, unit_size: 1000 }],
  ...overrides,
});

describe("integración: API caída al arrancar (primera instalación y política en disco)", () => {
  const api = new FakeApi();
  let dead: string;
  const apps: { close: () => Promise<void> }[] = [];
  const mws: LicenRouteMiddleware[] = [];
  const dir = mkdtempSync(join(tmpdir(), "licenroute-bl11-"));
  beforeAll(async () => {
    await api.start();
    dead = `http://127.0.0.1:${await freePort()}`;
  });
  afterAll(async () => {
    for (const m of mws) m.close();
    await Promise.all(apps.map((a) => a.close()));
    await api.close();
  });

  async function start(options: Partial<Parameters<typeof licenroute>[0]>) {
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: dead, licensedPaths: ["/datos/**"], fallback: "allow", timeoutMs: 300, policySync: { intervalMs: 60_000 }, logger: silentLogger, ...options });
    mws.push(mw);
    const app = await startApp(5, mw);
    apps.push(app);
    return app.port;
  }
  const status = async (port: number, path: string, headers: Record<string, string> = {}) => (await raw(port, "GET", path, headers)).status;

  it("primera instalación: ruta de pago declarada SIN token -> 503; con token -> 503; ruta libre -> fail_open", async () => {
    const port = await start({});
    expect(await status(port, "/datos/1")).toBe(503);
    expect(await status(port, "/datos/1", { "botgate-access-token": TOKEN })).toBe(503);
    expect(await status(port, "/catalogo")).toBe(200);
  });

  it("primera instalación: un token en una ruta no declarada tampoco se sirve gratis", async () => {
    const port = await start({ licensedPaths: [] });
    expect(await status(port, "/otra", { "botgate-access-token": TOKEN })).toBe(503);
  });

  it("modo estricto (withoutPolicy: deny): sin política, todas las rutas protegidas -> 503", async () => {
    const port = await start({ withoutPolicy: "deny" });
    expect(await status(port, "/catalogo")).toBe(503);
  });

  it("política guardada en disco (0600): al arrancar con la API caída protege sus rutas de pago", async () => {
    const cachePath = join(dir, "valida.json");
    api.reply = (url) => (url.startsWith("/v1/policies/current") ? { status: 200, body: { ...doc(), checksum: canonicalSha256(doc()) }, headers: { etag: '"v7"' } } : { status: 200, body: allow() });
    const online = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: ["/datos/**", "/informes/**"], policyCachePath: cachePath, policySync: { intervalMs: 60_000 }, logger: silentLogger });
    mws.push(online);
    expect(await online.policy!.refresh()).toBe(true);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);

    const port = await start({ policyCachePath: cachePath, licensedPaths: ["/datos/**"] });
    expect(await status(port, "/informes/9")).toBe(503); // ruta de pago que solo conoce la política guardada
    expect(await status(port, "/catalogo")).toBe(200); // política confiable: su fallback (fail_open)
  });

  it("política guardada CORRUPTA (checksum) o de OTRO sitio: se ignora; lo declarado en local sigue cerrado", async () => {
    const good = { site_id: SITE_ID, verified_at: Date.now(), etag: null, checksum: canonicalSha256(doc()), document: doc() };
    const corrupt = join(dir, "corrupta.json");
    writeFileSync(corrupt, JSON.stringify({ ...good, document: doc({ licensed_routes: [] }) })); // contenido alterado
    let port = await start({ policyCachePath: corrupt });
    expect(await status(port, "/datos/1")).toBe(503);
    expect(await status(port, "/informes/1")).toBe(200); // la política corrupta no aporta nada (ni para abrir ni para cerrar)

    const other = join(dir, "otro-sitio.json");
    const foreign = doc({ site_id: "site_otrositio00001" });
    writeFileSync(other, JSON.stringify({ ...good, site_id: "site_otrositio00001", checksum: canonicalSha256(foreign), document: foreign }));
    port = await start({ policyCachePath: other });
    expect(await status(port, "/informes/1")).toBe(200);

    writeFileSync(join(dir, "basura.json"), "{no es json");
    port = await start({ policyCachePath: join(dir, "basura.json") });
    expect(await status(port, "/datos/1")).toBe(503);
  });

  it("política guardada CADUCADA: sus rutas de pago siguen cerradas; si falta alguna en licensedPaths, todo lo protegido se cierra", async () => {
    const stale = join(dir, "caducada.json");
    writeFileSync(stale, JSON.stringify({ site_id: SITE_ID, verified_at: Date.now() - 2 * 3_600_000, etag: null, checksum: canonicalSha256(doc()), document: doc() }));
    let port = await start({ policyCachePath: stale, policyMaxAgeMs: 3_600_000 });
    expect(await status(port, "/informes/1")).toBe(503);
    expect(await status(port, "/catalogo")).toBe(503); // configuración insegura: /informes no está declarada
    port = await start({ policyCachePath: stale, policyMaxAgeMs: 3_600_000, licensedPaths: ["/datos/**", "/informes/**"] });
    expect(await status(port, "/catalogo")).toBe(200);
  });

  it("una ruta de pago nunca queda fuera de LicenRoute por una exclusión o protectedPaths", async () => {
    const port = await start({ excludedPaths: ["/datos/**"], protectedPaths: ["/api/**"] });
    expect(await status(port, "/datos/1")).toBe(503);
  });
});

describe("sincronización tras arrancar con la API caída", () => {
  const api = new FakeApi();
  beforeAll(() => api.start());
  afterAll(() => api.close());

  it("sin política confiable reintenta cada 5 s (no espera el intervalo de 60 s)", async () => {
    let up = false;
    api.reply = (url) => (url.startsWith("/v1/policies/current") && up ? { status: 200, body: { ...doc(), checksum: canonicalSha256(doc()) } } : { status: 503, body: {} });
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: [], policySync: { intervalMs: 60_000 }, logger: silentLogger });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(mw.policy!.version).toBeNull();
      up = true;
      await expect.poll(() => mw.policy!.version, { timeout: 7_000, interval: 200 }).toBe(7);
    } finally {
      mw.close();
    }
  }, 10_000);
});

describe("configuración insegura detectada con la API disponible", () => {
  const api = new FakeApi();
  beforeAll(() => api.start());
  afterAll(() => api.close());

  it("la política trae rutas de pago no declaradas -> aviso a la API en cada decisión (métrica y alerta)", async () => {
    api.reply = (url) => (url.startsWith("/v1/policies/current") ? { status: 200, body: { ...doc(), checksum: canonicalSha256(doc()) } } : { status: 200, body: allow() });
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: ["/datos/**"], policySync: { intervalMs: 60_000 }, logger: silentLogger });
    await mw.policy!.refresh();
    const app = await startApp(5, mw);
    try {
      await raw(app.port, "GET", "/catalogo");
      expect(api.decisionRequests().at(-1)!.headers["botgate-sdk-warning"]).toBe("licensed-paths-missing");
    } finally {
      mw.close();
      await app.close();
    }
    const ok = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: ["/datos/**", "/informes/**"], policySync: { intervalMs: 60_000 }, logger: silentLogger });
    await ok.policy!.refresh();
    const app2 = await startApp(5, ok);
    try {
      await raw(app2.port, "GET", "/catalogo2");
      expect(api.decisionRequests().at(-1)!.headers["botgate-sdk-warning"]).toBeUndefined();
    } finally {
      ok.close();
      await app2.close();
    }
  });
});

describe("atestación del SDK y ready() (BL-11, endurecimiento)", () => {
  const api = new FakeApi();
  beforeAll(() => api.start());
  afterAll(() => api.close());
  const attestations = () => api.received.filter((r) => r.url === "/v1/sdk/attestations").map((r) => ({ headers: r.headers, body: JSON.parse(r.body) as Record<string, unknown> }));

  it("se envía al arrancar y en cada sincronización, con la declaración local y el modo; el sitio no va en el cuerpo", async () => {
    api.received.length = 0;
    api.reply = (url) => (url.startsWith("/v1/policies/current") ? { status: 200, body: { ...doc(), checksum: canonicalSha256(doc()) } } : { status: 204, raw: "" });
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: ["/datos/**"], withoutPolicy: "deny", instanceId: "web 1/a", policySync: { intervalMs: 300 }, logger: silentLogger });
    try {
      await expect.poll(() => attestations().length, { timeout: 3_000 }).toBeGreaterThanOrEqual(2);
      const [first, second] = attestations();
      expect(first!.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(first!.body).toEqual({ instance_id: "web-1-a", boot_id: expect.stringMatching(/^[0-9a-f-]{36}$/), sdk: "express", sdk_version: SDK_VERSION, licensed_paths: ["/datos/**"], without_policy: "deny" });
      expect(second!.body.boot_id).toBe(first!.body.boot_id); // mismo arranque
    } finally {
      mw.close();
    }
  });

  it("si la atestación falla, el tráfico no se ve afectado", async () => {
    api.reply = (url) => (url.startsWith("/v1/sdk/attestations") ? { status: 500, body: {} } : url.startsWith("/v1/policies/current") ? { status: 404, body: {} } : { status: 200, body: allow() });
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: [], policySync: { intervalMs: 60_000 }, logger: silentLogger });
    const app = await startApp(5, mw);
    try {
      expect(await mw.policy!.attest()).toBe(false);
      expect((await raw(app.port, "GET", "/catalogo")).status).toBe(200);
    } finally {
      mw.close();
      await app.close();
    }
  });

  it("ready(): false hasta tener una política confiable; true con política (o sitio sin política publicada)", async () => {
    let up = false;
    api.reply = (url) => (url.startsWith("/v1/policies/current") && up ? { status: 200, body: { ...doc(), checksum: canonicalSha256(doc()) } } : { status: 503, body: {} });
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: [], policySync: { intervalMs: 60_000 }, logger: silentLogger });
    try {
      await mw.policy!.refresh();
      expect(mw.ready()).toBe(false);
      up = true;
      await mw.policy!.refresh();
      expect(mw.ready()).toBe(true);
    } finally {
      mw.close();
    }
  });

  it("con la API caída, una ruta de pago PENDIENTE de la política guardada también se cierra", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "licenroute-pend-"));
    const pending = doc({ licensed_routes: [{ ...doc().licensed_routes[0]!, status: "pending" }] });
    const cache = join(dir2, "p.json");
    writeFileSync(cache, JSON.stringify({ site_id: SITE_ID, verified_at: Date.now(), etag: null, checksum: canonicalSha256(pending), document: pending }));
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: `http://127.0.0.1:${await freePort()}`, licensedPaths: [], fallback: "allow", timeoutMs: 300, policyCachePath: cache, policySync: { intervalMs: 60_000 }, logger: silentLogger });
    const app = await startApp(5, mw);
    try {
      expect((await raw(app.port, "GET", "/informes/1")).status).toBe(503);
    } finally {
      mw.close();
      await app.close();
    }
  });
});
