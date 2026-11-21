// S10.1: el simulador con el SDK REAL y Express real, sin Docker. Demo funciona; los cruces entre modos, no.
import { licenroute } from "@licenroute/connect-express";
import { DEMO_MODE_HEADER, DEMO_REASON_CODE } from "@licenroute/policy-contracts";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { startSimulator, TEST_ADMIN_PREFIX, type Simulator } from "../src/index.ts";

const quiet = { warn: () => {}, error: () => {} };
const servers: { close: () => void }[] = [];
afterAll(() => { for (const s of servers) s.close(); });
afterEach(() => { delete process.env.LICENROUTE_MODE; delete process.env.KUBERNETES_SERVICE_HOST; delete process.env.NODE_ENV; });

async function app(options: Parameters<typeof licenroute>[0]): Promise<string> {
  const a = express();
  a.use(licenroute(options));
  a.get("/health", (_q, r) => { r.json({ ok: true }); });
  a.get("/", (_q, r) => { r.json({ home: true }); });
  a.get("/api/informes", (_q, r) => { r.json([1]); });
  a.get("/api/catalogo", (_q, r) => { r.json([2]); });
  const s = await new Promise<Server>((ok) => { const srv = a.listen(0, "127.0.0.1", () => ok(srv)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const admin = (sim: Simulator, method: string, path: string, body?: unknown) =>
  fetch(`${sim.url}${TEST_ADMIN_PREFIX}${path}`, { method, headers: { authorization: `Bearer ${sim.adminToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) as Record<string, unknown> }));
const get = (url: string, token?: string) => fetch(url, { headers: token ? { "botgate-access-token": token } : {} }).then((r) => ({ status: r.status, mode: r.headers.get("botgate-mode") }));
const until = async (fn: () => Promise<boolean>, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

describe("demo de principio a fin (simulador + SDK real + Express)", () => {
  let sim: Simulator; let base: string;
  beforeAll(async () => {
    sim = await startSimulator({ sites: [{ app: "demo", plans: [{ key: "informes", pattern: "/api/informes/**", quota: 3 }, { key: "catalogo", pattern: "/api/catalogo/**", quota: 3 }] }] });
    const c = sim.sites[0]!;
    process.env.LICENROUTE_MODE = "demo";
    base = await app({ apiKey: c.api_key, siteId: c.site_id, endpoint: c.endpoint, licensedPaths: ["/api/informes/**", "/api/catalogo/**"], logger: quiet });
    delete process.env.LICENROUTE_MODE;
  });
  afterAll(() => sim.close());

  test("activación, licencias, cuota, revocación, caída y recuperación", async () => {
    expect(await until(async () => ((await admin(sim, "GET", "/sites/demo/status")).json.attestations as unknown[]).length > 0)).toBe(true);
    expect((await get(`${base}/api/informes`)).status).toBe(403); // plan pendiente: LICENSE_NOT_ACTIVE
    const act = await admin(sim, "POST", "/sites/demo/activate");
    expect((act.json.activation as { state: string }[]).every((a) => a.state === "activated")).toBe(true);
    await admin(sim, "POST", "/sites/demo/grants");
    const tok = async (n: string) => (await admin(sim, "GET", `/sites/demo/licenses/${n}`)).json.token as string;
    const [valid, quota, rev, other] = [await tok("informes"), await tok("informes-cuota"), await tok("informes-revocable"), await tok("catalogo")];
    expect(valid).toMatch(/^bgdev_/);
    const r402 = await get(`${base}/api/informes`);
    expect(r402).toEqual({ status: 402, mode: "demo-simulation" });
    expect((await get(`${base}/api/informes`, valid)).status).toBe(200);
    expect((await get(`${base}/api/informes`, other)).status).toBe(402);
    expect((await get(`${base}/api/informes`, `bgdev_abcdefgh_${"x".repeat(43)}`)).status).toBe(403);
    const real = `bgat_abcdefgh_${"x".repeat(43)}`;
    expect((await get(`${base}/api/informes`, real)).status).toBe(402); // una licencia real ni se reenvía en demo
    const q = []; for (let i = 0; i < 4; i++) q.push((await get(`${base}/api/informes`, quota)).status);
    expect(q).toEqual([200, 200, 200, 402]);
    expect((await get(`${base}/api/informes`, rev)).status).toBe(200);
    await admin(sim, "POST", "/sites/demo/licenses/informes-revocable/revoke");
    expect((await get(`${base}/api/informes`, rev)).status).toBe(403);
    expect((await get(`${base}/`)).status).toBe(200);
    await admin(sim, "POST", "/outage", { state: "on" });
    expect((await get(`${base}/api/informes`, valid)).status).toBe(503);
    expect((await get(`${base}/health`)).status).toBe(200);
    await admin(sim, "POST", "/outage", { state: "off" });
    expect(await until(async () => (await get(`${base}/api/informes`, valid)).status === 200, 15_000)).toBe(true);
  });
});

describe("aislamiento entre demo y modo real", () => {
  test("el SDK no arranca en demo sin todas las condiciones", async () => {
    const sim = await startSimulator({ sites: [{ app: "x", plans: [{ key: "p", pattern: "/api/**", quota: 1 }] }] });
    const c = sim.sites[0]!;
    const base = { apiKey: c.api_key, siteId: c.site_id, endpoint: c.endpoint, licensedPaths: ["/api/**"], logger: quiet };
    expect(() => licenroute(base)).toThrow(/sin LICENROUTE_MODE=demo/);
    process.env.LICENROUTE_MODE = "demo";
    process.env.NODE_ENV = "production";
    expect(() => licenroute(base)).toThrow(/entorno de producción \(NODE_ENV=production\)/);
    delete process.env.NODE_ENV;
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    expect(() => licenroute(base)).toThrow(/KUBERNETES_SERVICE_HOST/);
    delete process.env.KUBERNETES_SERVICE_HOST;
    for (const endpoint of ["https://api.licenroute.example", "http://0.0.0.0:1234", "http://127.0.0.1.nip.io:1234", "http://localhost.evil.test"]) {
      expect(() => licenroute({ ...base, endpoint, allowInsecureEndpoint: true }), endpoint).toThrow(/no es local/);
    }
    expect(() => licenroute({ ...base, siteId: "site_REAL1234" })).toThrow(/mezcladas/);
    expect(() => licenroute({ ...base, apiKey: `bg_test_abcdefgh_${"k".repeat(43)}` })).toThrow(/mezcladas/);
    expect(() => licenroute({ ...base, apiKey: `bg_test_abcdefgh_${"k".repeat(43)}`, siteId: "site_REAL1234" })).toThrow(/LICENROUTE_MODE=demo con credenciales reales/);
    expect(() => licenroute(base)).not.toThrow();
    await sim.close();
  });

  test("credenciales reales contra el simulador: rechazadas y la ruta de pago queda cerrada", async () => {
    const sim = await startSimulator({ sites: [{ app: "x", plans: [{ key: "p", pattern: "/api/informes/**", quota: 1 }] }] });
    const r = await fetch(`${sim.url}/v1/policies/current`, { headers: { authorization: `Bearer bg_live_abcdefgh_${"k".repeat(43)}` } });
    expect(r.status).toBe(401);
    expect(r.headers.get(DEMO_MODE_HEADER)).toBe("simulation");
    // Un SDK real apuntado por error al simulador: nada le sirve y la ruta de pago no se abre.
    const base = await app({ apiKey: `bg_test_abcdefgh_${"k".repeat(43)}`, siteId: "site_REAL1234", endpoint: sim.url, licensedPaths: ["/api/informes/**"], logger: quiet });
    expect((await get(`${base}/api/informes`, `bgat_abcdefgh_${"x".repeat(43)}`)).status).toBe(503);
    await sim.close();
  });

  test("un SDK real rechaza una respuesta marcada como simulación aunque traiga una decisión «allow»", async () => {
    const fake = async (input: string | URL | Request) => {
      const url = String(input);
      const headers = { "content-type": "application/json", [DEMO_MODE_HEADER]: "simulation" };
      if (url.endsWith("/v1/decisions")) return new Response(JSON.stringify({ request_id: "r", action: "allow", risk_score: 0, reason_codes: ["LICENSE_VALID"], policy_version: 1, ttl_seconds: 0 }), { status: 200, headers });
      return new Response(null, { status: 404, headers }); // ¡404 «sin política» de un simulador!
    };
    const base = await app({ apiKey: `bg_test_abcdefgh_${"k".repeat(43)}`, siteId: "site_REAL1234", endpoint: "https://api.example.test", licensedPaths: ["/api/informes/**"], logger: quiet, fetch: fake as typeof fetch });
    expect((await get(`${base}/api/informes`, `bgat_abcdefgh_${"x".repeat(43)}`)).status).toBe(503);
  });

  test("un SDK en demo rechaza respuestas sin la marca (no se deja engañar por un Central real ni por un proxy)", async () => {
    process.env.LICENROUTE_MODE = "demo";
    const sim = await startSimulator({ sites: [{ app: "x", plans: [{ key: "p", pattern: "/api/informes/**", quota: 1 }] }] });
    const c = sim.sites[0]!;
    const stripped = async (input: string | URL | Request, init?: RequestInit) => {
      const r = await fetch(input, init);
      const h = new Headers(r.headers); h.delete(DEMO_MODE_HEADER);
      return new Response(r.status === 204 || r.status === 304 ? null : await r.text(), { status: r.status, headers: h });
    };
    const base = await app({ apiKey: c.api_key, siteId: c.site_id, endpoint: c.endpoint, licensedPaths: ["/api/informes/**"], logger: quiet, fetch: stripped as typeof fetch });
    delete process.env.LICENROUTE_MODE;
    expect((await get(`${base}/api/informes`)).status).toBe(503);
    await sim.close();
  });

  test("decisiones del simulador: siempre con DEMO_SIMULATOR y la cabecera de simulación", async () => {
    const sim = await startSimulator({ sites: [{ app: "x", plans: [{ key: "p", pattern: "/api/**", quota: 1 }] }] });
    const c = sim.sites[0]!;
    const r = await fetch(`${sim.url}/v1/decisions`, { method: "POST", headers: { authorization: `Bearer ${c.api_key}`, "content-type": "application/json" }, body: JSON.stringify({ request_id: crypto.randomUUID(), site_id: c.site_id, timestamp: new Date().toISOString(), method: "GET", path: "/otra", client: { ip: "127.0.0.1" } }) });
    const d = await r.json() as { reason_codes: string[]; action: string };
    expect(r.headers.get(DEMO_MODE_HEADER)).toBe("simulation");
    expect(d.reason_codes).toContain(DEMO_REASON_CODE);
    expect(d.reason_codes.some((x) => x.startsWith("SIM_"))).toBe(false); // SIM_ es otra cosa (reglas en observación)
    await sim.close();
  });

  test("solo loopback, Host de loopback y token de administración", async () => {
    const sim = await startSimulator({ sites: [{ app: "x", plans: [{ key: "p", pattern: "/api/**", quota: 1 }] }] });
    // fetch ignora una cabecera Host propia: se usa http.request, que sí la envía (DNS rebinding).
    const { request } = await import("node:http");
    const withHost = (host: string) => new Promise<number>((ok, ko) => { const u = new URL(`${sim.url}/health/ready`); const r = request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => { res.resume(); ok(res.statusCode ?? 0); }); r.on("error", ko); r.end(); });
    expect(await withHost("evil.example")).toBe(403);
    expect(await withHost(`127.0.0.1:${new URL(sim.url).port}`)).toBe(200);
    expect((await fetch(`${sim.url}${TEST_ADMIN_PREFIX}/sites/x/status`)).status).toBe(401);
    expect((await fetch(`${sim.url}${TEST_ADMIN_PREFIX}/sites/x/status`, { headers: { authorization: `Bearer ${sim.sites[0]!.api_key}` } })).status).toBe(401);
    expect(sim.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await sim.close();
  });
});
