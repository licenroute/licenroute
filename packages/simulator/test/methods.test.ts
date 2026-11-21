// D4.1 (F-D4-1): simulador + SDK real + Express con planes por método. Un plan GET+HEAD sobre /cupones/** no toca
// POST /cupones/canjear (autenticación propia); un plan POST explícito sí lo cobra. Cuota y revocación, por método.
import { licenroute } from "@licenroute/connect-express";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli.ts";
import { startSimulator, TEST_ADMIN_PREFIX, type Simulator } from "../src/index.ts";

const quiet = { warn: () => {}, error: () => {} };
const servers: Server[] = [];
afterAll(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

async function cupones(options: Parameters<typeof licenroute>[0]): Promise<string> {
  const a = express();
  a.use(licenroute(options));
  const verifyToken: express.RequestHandler = (q, r, next) => { if (q.get("x-token") === "ok") next(); else r.status(403).json({ error: "token" }); };
  a.get("/health", (_q, r) => { r.json({ ok: true }); });
  a.get("/cupones", (_q, r) => { r.json({ ok: true }); });
  a.get("/cupones/:codigo", (_q, r) => { r.json({ ok: true }); });
  a.post("/cupones/canjear", verifyToken, (_q, r) => { r.json({ ok: true, canjeado: true }); });
  a.post("/pedidos", verifyToken, (_q, r) => { r.status(201).json({ ok: true }); });
  const s = await new Promise<Server>((ok) => { const srv = a.listen(0, "127.0.0.1", () => ok(srv)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const admin = (sim: Simulator, method: string, path: string, body?: unknown) =>
  fetch(`${sim.url}${TEST_ADMIN_PREFIX}${path}`, { method, headers: { authorization: `Bearer ${sim.adminToken}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) as Record<string, unknown> }));
const call = (url: string, method: string, headers: Record<string, string> = {}) => fetch(url, { method, headers }).then((r) => r.status);
const until = async (fn: () => Promise<boolean>, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

describe("planes por método en el simulador", () => {
  let sim: Simulator; let base: string;
  beforeAll(async () => {
    sim = await startSimulator({ sites: [{ app: "cupones", plans: [
      { key: "cupones", pattern: "/cupones/**", quota: 2, methods: ["GET", "HEAD"] },
      { key: "pedidos", pattern: "/pedidos", quota: 2, methods: ["POST"] },
    ] }] });
    const c = sim.sites[0]!;
    process.env.LICENROUTE_MODE = "demo";
    base = await cupones({ apiKey: c.api_key, siteId: c.site_id, endpoint: c.endpoint, logger: quiet, withoutPolicy: "deny", fallback: "allow",
      licensedPaths: [{ path: "/cupones/**", methods: ["GET", "HEAD"] }, { path: "/pedidos", methods: ["POST"] }] });
    delete process.env.LICENROUTE_MODE;
    expect(await until(async () => ((await admin(sim, "GET", "/sites/cupones/status")).json.attestations as unknown[]).length > 0)).toBe(true);
    const act = await admin(sim, "POST", "/sites/cupones/activate");
    expect((act.json.activation as { state: string }[]).map((a) => a.state)).toEqual(["activated", "activated"]);
    await admin(sim, "POST", "/sites/cupones/grants");
  });
  afterAll(() => sim.close());
  const tok = async (n: string) => (await admin(sim, "GET", `/sites/cupones/licenses/${n}`)).json.token as string;

  test("la política publica los métodos de cada plan y el estado los muestra", async () => {
    const st = await admin(sim, "GET", "/sites/cupones/status");
    expect((st.json.plans as { pattern: string; methods: string[] }[]).map((p) => [p.pattern, p.methods])).toEqual([["/cupones/**", ["GET", "HEAD"]], ["/pedidos", ["POST"]]]);
  });

  test("F-D4-1: GET y HEAD de pago; POST /cupones/canjear conserva su autenticación (403 / 200)", async () => {
    expect(await call(`${base}/cupones/OTONO`, "GET")).toBe(402);
    expect(await call(`${base}/cupones/OTONO`, "HEAD")).toBe(402);
    expect(await call(`${base}/cupones/canjear`, "POST")).toBe(403);
    expect(await call(`${base}/cupones/canjear`, "POST", { "x-token": "ok" })).toBe(200);
    const valid = await tok("cupones");
    expect(await call(`${base}/cupones/OTONO`, "GET", { "botgate-access-token": valid })).toBe(200);
    expect(await call(`${base}/cupones/OTONO`, "HEAD", { "botgate-access-token": valid })).toBe(200);
  });

  test("plan POST explícito: POST /pedidos exige licencia aunque la app autorice; la licencia de otro plan no vale", async () => {
    expect(await call(`${base}/pedidos`, "POST", { "x-token": "ok" })).toBe(402);
    expect(await call(`${base}/pedidos`, "POST", { "x-token": "ok", "botgate-access-token": await tok("cupones") })).toBe(402);
    expect(await call(`${base}/pedidos`, "POST", { "x-token": "ok", "botgate-access-token": await tok("pedidos") })).toBe(201);
  });

  test("cuota y revocación por método: GET y HEAD gastan la misma cuota; POST de otra ruta no la toca", async () => {
    const q = await tok("cupones-cuota");
    const seq = [await call(`${base}/cupones`, "GET", { "botgate-access-token": q }), await call(`${base}/cupones/canjear`, "POST", { "x-token": "ok", "botgate-access-token": q }), await call(`${base}/cupones`, "HEAD", { "botgate-access-token": q }), await call(`${base}/cupones`, "GET", { "botgate-access-token": q })];
    expect(seq).toEqual([200, 200, 200, 402]);
    const rev = await tok("cupones-revocable");
    expect(await call(`${base}/cupones`, "HEAD", { "botgate-access-token": rev })).toBe(200);
    await admin(sim, "POST", "/sites/cupones/licenses/cupones-revocable/revoke");
    expect(await call(`${base}/cupones`, "GET", { "botgate-access-token": rev })).toBe(403);
    expect(await call(`${base}/cupones`, "HEAD", { "botgate-access-token": rev })).toBe(403);
    expect(await call(`${base}/cupones/canjear`, "POST", { "x-token": "ok" })).toBe(200);
  });

  test("decisión de administración sin pasar por la app: POST /cupones/canjear allow, GET payment_required", async () => {
    const d = async (method: string, path: string) => (await admin(sim, "POST", "/sites/cupones/decide", { method, path })).json;
    expect((await d("POST", "/cupones/canjear")).action).toBe("allow");
    expect((await d("OPTIONS", "/cupones/x")).action).toBe("allow");
    expect((await d("GET", "/cupones/x")).action).toBe("payment_required");
    expect((await d("HEAD", "/cupones")).action).toBe("payment_required");
    expect((await d("POST", "/pedidos")).action).toBe("payment_required");
    expect((await admin(sim, "POST", "/sites/cupones/decide", { method: "TRACE", path: "/x" })).status).toBe(400);
  });

  test("caída simulada: GET de pago cerrado (503); POST /cupones/canjear con su token sigue (no es de pago)", async () => {
    await admin(sim, "POST", "/outage", { state: "on" });
    try {
      expect(await call(`${base}/cupones/OTONO`, "GET", { "botgate-access-token": await tok("cupones") })).toBe(503);
      expect(await call(`${base}/cupones/canjear`, "POST", { "x-token": "ok" })).toBe(200);
      expect(await call(`${base}/pedidos`, "POST", { "x-token": "ok" })).toBe(503);
      expect(await call(`${base}/health`, "GET")).toBe(200);
    } finally { await admin(sim, "POST", "/outage", { state: "off" }); }
  });
});

describe("licenroute-simulator --plan con métodos", () => {
  test("@MÉTODOS opcional; sin él, todos los métodos (como un plan de Central sin métodos)", () => {
    expect(parseArgs(["--app", "x", "--plan", "c=/cupones/**:5@GET,head"]).plans).toEqual([{ key: "c", pattern: "/cupones/**", quota: 5, methods: ["GET", "HEAD"] }]);
    expect(parseArgs(["--app", "x", "--plan", "c=/cupones/**@POST"]).plans[0]).toEqual({ key: "c", pattern: "/cupones/**", quota: 3, methods: ["POST"] });
    expect(parseArgs(["--app", "x", "--plan", "c=/cupones/**"]).plans[0]!.methods).toBeUndefined();
    expect(() => parseArgs(["--app", "x", "--plan", "c=/a@GET;rm"])).toThrow(/--plan inválido/);
  });
  test("un método no licenciable (OPTIONS, inventado) no arranca el simulador", async () => {
    await expect(startSimulator({ sites: [{ app: "x", plans: [{ key: "p", pattern: "/a/**", quota: 1, methods: ["OPTIONS"] }] }] })).rejects.toThrow(/invalid demo plan/);
    await expect(startSimulator({ sites: [{ app: "x", plans: [{ key: "p", pattern: "/a/**", quota: 1, methods: ["FETCH"] }] }] })).rejects.toThrow(/invalid demo plan/);
  });
});
