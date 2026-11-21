/**
 * D4.1 (F-D4-1): la autorización comercial respeta la combinación MÉTODO + RUTA declarada. Un plan GET sobre
 * `/cupones/**` no puede exigir licencia en `POST /cupones/canjear`, que tiene autenticación propia.
 *
 * Central falso con la semántica del motor real (el motor de decisión de Central, no incluido): una ruta licenciada coincide si su
 * lista de métodos está vacía o contiene EXACTAMENTE el método de la petición. Oráculo: la app responde {"ok":true,…}.
 */
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalSha256, compileGlob, matchGlob, normalizePath, type PolicyDocumentBody } from "@licenroute/policy-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { licenroute, type LicenRouteMiddleware } from "../src/index.ts";
import { LicenRouteConfigError } from "../src/options.ts";
import { API_KEY, raw, SITE_ID, silentLogger } from "./helpers.ts";

const VALID = "bgat_abcdefgh_" + "V".repeat(43);
const OTHER = "bgat_abcdefgh_" + "O".repeat(43);
type Licensed = { route_pattern: string; methods: string[]; plan_id: string };

/** Central falso: política firmada, atestación y decisiones por método y ruta. */
class FakeCentral {
  licensed: Licensed[] = [];
  down = false;
  decisions: { method: string; path: string }[] = [];
  private server!: Server;
  port = 0;
  async start() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const send = (status: number, b: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b)); };
        if (this.down) return send(503, { error: "down" });
        if (req.url?.startsWith("/v1/policies/current")) {
          const d: PolicyDocumentBody = {
            site_id: SITE_ID, version: 7, published_at: "2026-10-26T00:00:00.000Z",
            defaults: { fallback: "fail_open", score_thresholds: { observe: 30, rate_limit: 60, block: 80 }, excluded_paths: [] }, rules: [],
            licensed_routes: this.licensed.map((l, i) => ({ plan_id: l.plan_id, plan_uuid: `00000000-0000-7000-8000-00000000000${i}`, route_pattern: l.route_pattern, methods: l.methods, checkout_url: "https://licenroute.example/p", currency: "EUR", unit_price_minor: 1, unit_size: 1 })),
          } as PolicyDocumentBody;
          return send(200, { ...d, checksum: canonicalSha256(d) });
        }
        if (req.url?.startsWith("/v1/sdk/attestations")) { res.statusCode = 204; return res.end(); }
        if (req.url === "/v1/decisions") {
          const b = JSON.parse(body) as { method: string; path: string; access_token?: string };
          const path = normalizePath(b.path); this.decisions.push({ method: b.method, path });
          const hit = this.licensed.find((l) => (l.methods.length === 0 || l.methods.includes(b.method)) && matchGlob(compileGlob(l.route_pattern), path));
          const base = { request_id: "x", risk_score: 0, policy_version: 7, ttl_seconds: 0 };
          if (!hit) return send(200, { ...base, action: "allow", reason_codes: [] });
          if (b.access_token === VALID) return send(200, { ...base, action: "allow", reason_codes: ["LICENSE_VALID"] });
          if (b.access_token === OTHER) return send(200, { ...base, action: "block", reason_codes: ["LICENSE_INVALID"] });
          return send(200, { ...base, action: "payment_required", reason_codes: ["LICENSE_REQUIRED"], payment: { plan_id: hit.plan_id, checkout_url: "https://licenroute.example/p", currency: "EUR", unit_price_minor: 1, unit_size: 1 } });
        }
        send(404, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
  }
  get endpoint() { return `http://127.0.0.1:${this.port}`; }
  close() { this.server.closeAllConnections(); return new Promise<void>((r) => this.server.close(() => r())); }
}

const require = createRequire(import.meta.url);
type Handler = (req: { get: (h: string) => string | undefined; path: string }, res: { status: (n: number) => { json: (b: unknown) => void }; json: (b: unknown) => void }, next?: () => void) => void;
type App = { use: (...a: unknown[]) => void; get: (...a: unknown[]) => void; post: (...a: unknown[]) => void; put: (...a: unknown[]) => void; delete: (...a: unknown[]) => void; listen: (...a: unknown[]) => Server };

/** cupones-cjs en miniatura: lectura vendible, canje con token propio, un router montado y una ruta comodín. */
async function cuponesApp(version: 4 | 5, mw: unknown) {
  const express = require(version === 5 ? "express5" : "express4") as (() => App) & { Router: () => App };
  const app = express();
  app.use(mw);
  const ok: Handler = (req, res) => res.json({ ok: true, path: req.path });
  const verifyToken: Handler = (req, res, next) => (req.get("x-token") === "ok" ? next!() : res.status(403).json({ error: "token inválido" }));
  app.get("/health", ok);
  app.get("/cupones", ok);
  app.get("/cupones/:codigo", ok);
  app.post("/cupones/canjear", verifyToken, ok);
  app.put("/cupones/:codigo", verifyToken, ok);
  app.delete("/cupones/:codigo", verifyToken, ok);
  const campanas = express.Router();
  campanas.get("/activas", ok);
  campanas.post("/activas", verifyToken, ok);
  app.use("/campanas", campanas);
  app.get(version === 5 ? "/archivo/*ruta" : "/archivo/*", ok);
  const server: Server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const central = new FakeCentral();
const mws: LicenRouteMiddleware[] = [];
const apps: { close: () => Promise<void> }[] = [];
beforeAll(() => central.start());
afterEach(async () => {
  for (const m of mws.splice(0)) m.close();
  await Promise.all(apps.splice(0).map((a) => a.close()));
  central.licensed = []; central.down = false; central.decisions = [];
});
afterAll(() => central.close());

type Decl = string | { path: string; methods: string[] };
async function start(licensedPaths: Decl[], licensed: Licensed[], version: 4 | 5 = 5, extra: Record<string, unknown> = {}) {
  central.licensed = licensed;
  const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: central.endpoint, licensedPaths: licensedPaths as never, withoutPolicy: "deny", fallback: "allow", logger: silentLogger, policySync: { intervalMs: 150 }, ...extra });
  mws.push(mw);
  await expect.poll(() => mw.policy?.version ?? null, { timeout: 3_000 }).toBe(7);
  const a = await cuponesApp(version, mw); apps.push(a);
  const call = (method: string, path: string, headers: Record<string, string> = {}) => raw(a.port, method, path, headers);
  return { mw, call };
}
const reached = (body: string) => body.includes('"ok":true');
const GET_PLAN = { route_pattern: "/cupones/**", methods: ["GET", "HEAD"], plan_id: "cupones" };
const GET_DECL = { path: "/cupones/**", methods: ["GET", "HEAD"] };

describe("F-D4-1: plan GET sobre /cupones/** y escrituras con autenticación propia", () => {
  for (const version of [4, 5] as const) {
    it(`Express ${version}: GET y HEAD exigen licencia; POST/PUT/DELETE conservan su autenticación (403 sin token, 200 con token)`, async () => {
      const { mw, call } = await start([GET_DECL], [GET_PLAN], version);
      expect(mw.ready()).toBe(true);
      expect((await call("GET", "/cupones")).status).toBe(402);
      expect((await call("GET", "/cupones/OTONO")).status).toBe(402);
      expect((await call("HEAD", "/cupones/OTONO")).status).toBe(402);
      const paid = await call("GET", "/cupones/OTONO", { authorization: `Bearer ${VALID}` });
      expect([paid.status, reached(paid.body)]).toEqual([200, true]);
      expect((await call("HEAD", "/cupones/OTONO", { authorization: `Bearer ${VALID}` })).status).toBe(200);
      for (const [method, path] of [["POST", "/cupones/canjear"], ["PUT", "/cupones/OTONO"], ["DELETE", "/cupones/OTONO"]] as const) {
        const without = await call(method, path);
        // raw() lee en latin1: se compara el prefijo ASCII del error de la propia app.
        expect([method, without.status, String(JSON.parse(without.body).error).startsWith("token inv")]).toEqual([method, 403, true]);
        const withToken = await call(method, path, { "x-token": "ok" });
        expect([method, withToken.status, reached(withToken.body)]).toEqual([method, 200, true]);
      }
    });
  }

  it("OPTIONS no se cobra: llega a la app (respuesta automática de Express), nunca un rechazo de LicenRoute", async () => {
    const { call } = await start([GET_DECL], [GET_PLAN]);
    const r = await call("OPTIONS", "/cupones/OTONO");
    expect(r.status).toBe(200);
    expect(r.body).not.toMatch(/payment_required|licensed_route_not_covered|request_id/);
  });

  it("rutas fuera del patrón (router montado, comodín, salud) no cambian: mismas respuestas que sin LicenRoute", async () => {
    const { call } = await start([GET_DECL], [GET_PLAN]);
    for (const [method, path, headers, status] of [
      ["GET", "/campanas/activas", {}, 200], ["POST", "/campanas/activas", {}, 403], ["POST", "/campanas/activas", { "x-token": "ok" }, 200],
      ["GET", "/archivo/a/b", {}, 200], ["GET", "/health", {}, 200],
    ] as const) expect([method, path, (await call(method, path, headers)).status]).toEqual([method, path, status]);
  });

  it("Central caído: GET de pago cerrado (503), POST /cupones/canjear con su token sigue funcionando (no es de pago)", async () => {
    const { call } = await start([GET_DECL], [GET_PLAN]);
    central.down = true;
    expect((await call("GET", "/cupones/OTONO", { authorization: `Bearer ${VALID}` })).status).toBe(503);
    const w = await call("POST", "/cupones/canjear", { "x-token": "ok" });
    expect([w.status, reached(w.body)]).toEqual([200, true]);
    expect((await call("POST", "/cupones/canjear")).status).toBe(403);
  });

  it("licencia inválida o de otro plan en GET: rechazada; en POST el token de comprador no cambia nada", async () => {
    const { call } = await start([GET_DECL], [GET_PLAN]);
    expect((await call("GET", "/cupones/OTONO", { authorization: `Bearer ${OTHER}` })).status).toBe(403);
    expect((await call("POST", "/cupones/canjear", { "x-token": "ok", "botgate-access-token": OTHER })).status).toBe(200);
  });
});

describe("planes con métodos distintos", () => {
  it("un plan que protege explícitamente POST y otro GET: cada uno solo su método", async () => {
    const { mw, call } = await start(
      [{ path: "/cupones/canjear", methods: ["POST"] }, { path: "/campanas/**", methods: ["GET", "HEAD"] }],
      [{ route_pattern: "/cupones/canjear", methods: ["POST"], plan_id: "canje" }, { route_pattern: "/campanas/**", methods: ["GET", "HEAD"], plan_id: "campanas" }],
    );
    expect(mw.ready()).toBe(true);
    expect((await call("POST", "/cupones/canjear", { "x-token": "ok" })).status).toBe(402);
    expect((await call("POST", "/cupones/canjear", { "x-token": "ok", authorization: `Bearer ${VALID}` })).status).toBe(200);
    expect((await call("GET", "/campanas/activas")).status).toBe(402);
    expect((await call("POST", "/campanas/activas", { "x-token": "ok" })).status).toBe(200);
    expect((await call("GET", "/cupones")).status).toBe(200);
  });

  it("declaración con métodos que la política no cubre (Central solo GET): HEAD se cierra (503) y ready() es false", async () => {
    const { mw, call } = await start([GET_DECL], [{ route_pattern: "/cupones/**", methods: ["GET"], plan_id: "cupones" }]);
    expect(mw.ready()).toBe(false);
    expect((await call("HEAD", "/cupones/OTONO")).status).toBe(503);
    expect((await call("GET", "/cupones/OTONO")).status).toBe(402);
  });

  it("declaración antigua (cadena) = todos los métodos, como en 0.6.0: POST bajo el patrón también se cierra", async () => {
    const { call } = await start(["/cupones/**"], [GET_PLAN]);
    // La política solo cubre GET y HEAD: el POST declarado de pago no está cubierto -> 503 (F2), nunca abierto gratis.
    expect((await call("POST", "/cupones/canjear", { "x-token": "ok" })).status).toBe(503);
  });

});

describe("validación de licensedPaths con métodos", () => {
  // policySync activo (con licensedPaths no puede desactivarse): el error debe venir de la declaración, no de eso.
  const make = (licensedPaths: unknown) => () => licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: "http://127.0.0.1:9", licensedPaths: licensedPaths as never, logger: silentLogger, policySync: { intervalMs: 60_000 } }).close();
  it("una declaración válida con métodos se acepta (control positivo)", () => { expect(make([{ path: "/a/**", methods: ["get", "HEAD"] }])).not.toThrow(); });
  it.each([
    { decl: [{ path: "/a/**", methods: [] }], why: "sin métodos" },
    { decl: [{ path: "/a/**", methods: ["OPTIONS"] }], why: "OPTIONS" },
    { decl: [{ path: "/a/**", methods: ["FETCH"] }], why: "método desconocido" },
    { decl: [{ path: "a/**", methods: ["GET"] }], why: "ruta sin /" },
    { decl: [{ path: "/a/**" }], why: "sin la clave methods" },
    { decl: [42], why: "tipo inválido" },
  ])("$why: se rechaza", ({ decl }) => {
    expect(make(decl)).toThrow(LicenRouteConfigError);
  });
});
