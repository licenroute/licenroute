// S10.2-D4.1: regresiones de F-D4-1 (laboratorio interno D4). Un plan GET sobre /cupones/** exigía
// licencia también en POST /cupones/canjear, que tiene autenticación propia: licensedPaths no llevaba métodos.
// Ahora plan, apply, diario, simulador, SDK y licenroute test usan RUTA Y MÉTODOS. Ningún agente real.
import { licenroute } from "@licenroute/connect-express";
import express from "express";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { startSimulator } from "../../simulator/src/index.ts";
import { prepareApply } from "../src/apply.ts";
import { detect } from "../src/detect.ts";
import { demoTestAdmin, type TestAdmin } from "../src/live/test-admin.ts";
import { runTests, type TestContext } from "../src/live/test.ts";
import { plan } from "../src/plan.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "licenroute-d41-")));
const TGZ = join(work, "licenroute-connect-express-0.7.0.tgz"); writeFileSync(TGZ, "paquete de prueba");
const servers: Server[] = [];
afterAll(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } rmSync(work, { recursive: true, force: true }); });
let n = 0;
function project(files: Record<string, string>, deps: Record<string, string> = { express: "^5.1.0" }): string {
  const d = join(work, `p${++n}`);
  for (const [f, text] of Object.entries({ "package.json": `${JSON.stringify({ name: "x", version: "1.0.0", private: true, dependencies: deps }, null, 2)}\n`, ...files })) {
    mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), text);
  }
  return d;
}
const CUPONES = `const express = require("express");
function verifyToken(req, res, next) { if (req.get("x-token") === "ok") return next(); res.status(403).json({ error: "token" }); }
const app = express();
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/cupones", (req, res) => res.json([]));
app.get("/cupones/:codigo", (req, res) => res.json({}));
app.post("/cupones/canjear", verifyToken, (req, res) => res.json({ canjeado: true }));
app.listen(3000);
`;
const planned = (dir: string) => plan(detect(dir), "express");
const applyTo = (dir: string, keys: string[]) => prepareApply({ dir, planKeys: keys, planSha: planned(dir).approval.plan_sha256, app: "cupones", instance: "default", sdk: TGZ });

describe("plan y apply: ruta Y métodos", () => {
  test("F-D4-1: /cupones/** se propone con GET y HEAD; el canje (POST, autenticado) queda para decisión", () => {
    const p = planned(project({ "index.js": CUPONES }));
    expect(p.proposed_plans.map((x) => [x.route_pattern, x.methods])).toEqual([["/cupones/**", ["GET", "HEAD"]]]);
    expect(p.needs_decision.map((x) => `${x.method} ${x.path}`)).toContain("POST /cupones/canjear");
  });

  test("F-D4-1: apply escribe { path, methods } y lo verifica; el diario guarda los métodos (antes: cadena = todos)", () => {
    const dir = project({ "index.js": CUPONES });
    const r = applyTo(dir, ["cupones"]);
    expect(r.refusals).toEqual([]);
    expect(r.selected.map((s) => [s.pattern, s.methods])).toEqual([["/cupones/**", ["GET", "HEAD"]]]);
    const after = r.changes.find((c) => c.path === "index.js")!.after;
    expect(after).toContain('licensedPaths: [{ path: "/cupones/**", methods: ["GET", "HEAD"] }]');
    expect(after).not.toMatch(/licensedPaths: \["\/cupones/);
    const d = detect(dir, { overrides: new Map(r.changes.map((c) => [c.path, c.after])) });
    expect(d.licenroute.licensed_routes).toEqual([{ pattern: "/cupones/**", methods: ["GET", "HEAD"] }]);
    expect(d.licenroute.licensed_paths).toEqual(["/cupones/**"]);
  });

  test("el código de aprobación cambia si cambian los métodos aprobados (van en el hash)", () => {
    const dir = project({ "index.js": CUPONES });
    const a = applyTo(dir, ["cupones"]).approvalCode;
    expect(a).toMatch(/^apr_[0-9a-f]{20}$/);
    expect(applyTo(dir, ["cupones"]).approvalCode).toBe(a);
  });

  test("una ruta GET con autenticación propia DENTRO del prefijo impide el plan (lo cubriría): a decisión, con motivo", () => {
    const p = planned(project({ "index.js": CUPONES.replace('app.post("/cupones/canjear"', 'app.get("/cupones/mios", verifyToken, (req, res) => res.json([]));\napp.post("/cupones/canjear"') }));
    expect(p.proposed_plans).toEqual([]);
    expect(p.needs_decision.find((x) => x.path === "/cupones")?.reason).toMatch(/would also require a licence on GET \/cupones\/mios/); // D4.4: dato, inglés canónico
  });

  test("app.all dentro del prefijo (cualquier método) también lo impide", () => {
    const p = planned(project({ "index.js": CUPONES.replace("app.listen", 'app.all("/cupones/admin", (req, res) => res.end());\napp.listen') }));
    expect(p.proposed_plans).toEqual([]);
  });

  test("un comodín final fuera del prefijo (404) no impide el plan; PUT y DELETE autenticados tampoco (otro método)", () => {
    const p = planned(project({ "index.js": CUPONES.replace("app.listen", 'app.put("/cupones/:codigo", verifyToken, (req, res) => res.json({}));\napp.delete("/cupones/:codigo", verifyToken, (req, res) => res.json({}));\napp.get("/*splat", (req, res) => res.status(404).end());\napp.listen') }));
    expect(p.proposed_plans.map((x) => x.route_pattern)).toEqual(["/cupones/**"]);
  });

  test("routers montados: los métodos se conservan a través del montaje", () => {
    const dir = project({
      "src/libros.js": 'import { Router } from "express";\nexport const libros = Router();\nfunction requireLogin(req, res, next) { next(); }\nlibros.get("/", (q, r) => r.json([]));\nlibros.route("/:isbn").get((q, r) => r.json({})).put(requireLogin, (q, r) => r.json({}));\n',
      "src/server.js": 'import express from "express";\nimport { libros } from "./libros.js";\nconst app = express();\napp.use("/v1/libros", libros);\napp.listen(3000);\n',
    });
    const p = planned(dir);
    expect(p.proposed_plans.map((x) => [x.route_pattern, x.methods])).toEqual([["/v1/libros/**", ["GET", "HEAD"]]]);
    expect(p.needs_decision.map((x) => `${x.method} ${x.path}`)).toContain("PUT /v1/libros/:isbn");
  });

  test("SDK anterior instalado (0.6.0, sin métodos): apply se niega antes de escribir, con la versión vista", () => {
    const dir = project({ "index.js": CUPONES, "node_modules/@licenroute/connect-express/package.json": '{ "name": "@licenroute/connect-express", "version": "0.6.0" }\n' }, { express: "^5.1.0", "@licenroute/connect-express": "file:../licenroute-connect-express-0.6.0.tgz" });
    const r = applyTo(dir, ["cupones"]);
    expect(r.ok).toBe(false);
    expect(r.refusals.join(" ")).toMatch(/0\.6\.0\) no admite métodos en licensedPaths; instala el del kit \(≥ 0\.7\.0\)/);
  });

  test("SDK anterior declarado pero aún sin instalar (file:…-0.6.0.tgz): también se niega", () => {
    const dir = project({ "index.js": CUPONES }, { express: "^5.1.0", "@licenroute/connect-express": "file:vendor/licenroute-connect-express-0.6.0.tgz" });
    expect(applyTo(dir, ["cupones"]).refusals.join(" ")).toMatch(/0\.6\.0\) no admite métodos/);
  });

  test("integración existente con una cadena (0.2.2): se conserva tal cual y el plan nuevo se añade con sus métodos", () => {
    const dir = project({ "index.js": CUPONES.replace("const app = express();\n", 'const app = express();\nconst { licenroute } = require("@licenroute/connect-express");\napp.use(licenroute({ licensedPaths: ["/health/x/**"] }));\n') }, { express: "^5.1.0", "@licenroute/connect-express": "file:../sdk.tgz" });
    const r = applyTo(dir, ["cupones"]);
    expect(r.refusals).toEqual([]);
    expect(r.changes.find((c) => c.path === "index.js")!.after).toContain('licensedPaths: ["/health/x/**", { path: "/cupones/**", methods: ["GET", "HEAD"] }]');
  });
});

// --- licenroute test, extremo a extremo (simulador + SDK real + Express), sin enviar escrituras a la app ---------------
async function cuponesApp(licensedPaths: Parameters<typeof licenroute>[0]["licensedPaths"], c: { api_key: string; site_id: string; endpoint: string }) {
  process.env.LICENROUTE_MODE = "demo";
  const a = express();
  a.use(licenroute({ apiKey: c.api_key, siteId: c.site_id, endpoint: c.endpoint, licensedPaths, withoutPolicy: "deny", fallback: "allow", logger: { warn: () => {}, error: () => {} } }));
  delete process.env.LICENROUTE_MODE;
  const verifyToken: express.RequestHandler = (q, r, nx) => { if (q.get("x-token") === "ok") nx(); else r.status(403).json({ error: "token" }); };
  let writes = 0;
  a.get("/health", (_q, r) => { r.json({ ok: true }); });
  a.get("/cupones", (_q, r) => { r.json([]); });
  a.get("/cupones/:codigo", (_q, r) => { r.json({}); });
  a.post("/cupones/canjear", verifyToken, (_q, r) => { writes++; r.json({ canjeado: true }); });
  const s = await new Promise<Server>((ok) => { const x = a.listen(0, "127.0.0.1", () => ok(x)); }); servers.push(s);
  return { baseUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, writes: () => writes };
}
const ctxOf = (methods: string[], extra: Partial<TestContext> = {}): TestContext => ({
  app: "cupones", instance: "default", public_checks: ["/health"], auth_checks: [],
  plans: [{ key: "cupones", pattern: "/cupones/**", methods, routes: [{ method: "GET", path: "/cupones" }, { method: "GET", path: "/cupones/:codigo" }] }],
  ...extra,
});
const CANJE = { method: "POST", path: "/cupones/canjear", plan: "/cupones/**", auth: ["verifyToken"] };

describe("licenroute test: métodos y rutas protegidos de verdad", () => {
  test("integración 0.2.3: HEAD, OPTIONS, cuota GET/HEAD, revocación HEAD y el canje sin cobrar — sin enviar el POST a la app", async () => {
    const sim = await startSimulator({ sites: [{ app: "cupones", plans: [{ key: "cupones", pattern: "/cupones/**", quota: 3, methods: ["GET", "HEAD"] }] }] });
    try {
      const app = await cuponesApp([{ path: "/cupones/**", methods: ["GET", "HEAD"] }], sim.sites[0]!);
      const admin = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: sim.url, LICENROUTE_DEMO_ADMIN_TOKEN: sim.adminToken }) as TestAdmin;
      const checks = await runTests({ app: "cupones", instance: "default", baseUrl: app.baseUrl, admin, journal: ctxOf(["GET", "HEAD"], { method_checks: [CANJE], declared: [{ pattern: "/cupones/**", methods: ["GET", "HEAD"] }] }) });
      const by = Object.fromEntries(checks.map((c) => [c.id, c]));
      expect(checks.filter((c) => c.ok === false), JSON.stringify(checks.filter((c) => c.ok === false))).toEqual([]);
      for (const id of ["cupones:metodos-codigo", "cupones:metodos-servicio", "cupones:sin-licencia HEAD /cupones", "cupones:licencia-valida HEAD", "cupones:options-sin-cobro", "cupones:cuota", "cupones:revocada HEAD", "metodo-no-cubierto POST /cupones/canjear", "metodos:cobertura", "central-caido:cupones"]) expect(by[id]?.ok, `${id}: ${JSON.stringify(by[id])}`).toBe(true);
      expect(by["cupones:cuota"]?.detail).toMatch(/GET 200 · HEAD 200 · GET 200 · HEAD 402/);
      expect(by["metodo-no-cubierto POST /cupones/canjear"]?.detail).toMatch(/allow \(petición NO enviada a tu app\)/);
      expect(app.writes()).toBe(0); // licenroute test nunca envía la escritura
    } finally { await sim.close(); }
  }, 120_000);

  test("integración de 0.2.2 (cadena sin métodos): el canje se cobraría sin aprobarlo -> FALLO, nunca SIMULATED PASS", async () => {
    const sim = await startSimulator({ sites: [{ app: "cupones", plans: [{ key: "cupones", pattern: "/cupones/**", quota: 3 }] }] });
    try {
      const app = await cuponesApp(["/cupones/**"], sim.sites[0]!);
      const admin = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: sim.url, LICENROUTE_DEMO_ADMIN_TOKEN: sim.adminToken }) as TestAdmin;
      const checks = await runTests({ app: "cupones", instance: "default", baseUrl: app.baseUrl, admin, journal: ctxOf([], { overreach: [CANJE], declared: [{ pattern: "/cupones/**", methods: [] }] }) });
      const bad = checks.find((c) => c.id === "metodo-no-aprobado POST /cupones/canjear");
      expect(bad?.ok).toBe(false);
      expect(bad?.detail).toMatch(/sin métodos .*exige licencia también en POST \/cupones\/canjear.*autenticación propia \(verifyToken\)/);
      expect(app.writes()).toBe(0);
    } finally { await sim.close(); }
  }, 120_000);

  test("el plan del simulador no coincide con el aprobado (todos frente a GET,HEAD): FALLO de métodos del servicio", async () => {
    const sim = await startSimulator({ sites: [{ app: "cupones", plans: [{ key: "cupones", pattern: "/cupones/**", quota: 3 }] }] });
    try {
      const app = await cuponesApp([{ path: "/cupones/**", methods: ["GET", "HEAD"] }], sim.sites[0]!);
      const admin = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: sim.url, LICENROUTE_DEMO_ADMIN_TOKEN: sim.adminToken }) as TestAdmin;
      const checks = await runTests({ app: "cupones", instance: "default", baseUrl: app.baseUrl, admin, journal: ctxOf(["GET", "HEAD"], { method_checks: [CANJE], declared: [{ pattern: "/cupones/**", methods: ["GET", "HEAD"] }] }) });
      const by = Object.fromEntries(checks.map((c) => [c.id, c]));
      expect(by["cupones:metodos-servicio"]).toMatchObject({ ok: false, detail: expect.stringMatching(/plan GET,HEAD · demo todos/) });
      expect(by["metodo-no-cubierto POST /cupones/canjear"]?.ok).toBe(false); // el simulador lo cobraría
    } finally { await sim.close(); }
  }, 120_000);

  test("sin forma de preguntar la decisión (proveedor sin decide): COBERTURA PARCIAL, nunca un OK", async () => {
    const sim = await startSimulator({ sites: [{ app: "cupones", plans: [{ key: "cupones", pattern: "/cupones/**", quota: 3, methods: ["GET", "HEAD"] }] }] });
    try {
      const app = await cuponesApp([{ path: "/cupones/**", methods: ["GET", "HEAD"] }], sim.sites[0]!);
      const full = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: sim.url, LICENROUTE_DEMO_ADMIN_TOKEN: sim.adminToken }) as TestAdmin;
      const admin: TestAdmin = { ...full, decide: undefined };
      const checks = await runTests({ app: "cupones", instance: "default", baseUrl: app.baseUrl, admin, journal: ctxOf(["GET", "HEAD"], { method_checks: [CANJE], declared: null }) });
      const by = Object.fromEntries(checks.map((c) => [c.id, c]));
      expect(by["metodo-no-cubierto POST /cupones/canjear"]?.ok).toBeNull();
      expect(by["metodos:cobertura"]).toMatchObject({ ok: null, detail: expect.stringMatching(/COBERTURA PARCIAL: sin comprobar POST \/cupones\/canjear/) });
      expect(by["cupones:metodos-codigo"]?.ok).toBeNull();
    } finally { await sim.close(); }
  }, 120_000);
});

describe("F-D4-3: la ruta del SDK se muestra corta", () => {
  test("file: relativo muy largo -> file:…/<fichero>; el resto, igual", async () => {
    const { sdkSpecLabel } = await import("../src/util.ts");
    expect(sdkSpecLabel("file:../../../../../../../../Users/alguien/kit/packages/licenroute-connect-express-0.7.0.tgz")).toBe("file:…/licenroute-connect-express-0.7.0.tgz");
    expect(sdkSpecLabel("file:sdk.tgz")).toBe("file:sdk.tgz");
    expect(sdkSpecLabel("^0.7.0")).toBe("^0.7.0");
  });
});
