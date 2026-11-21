// S10.1: botgate.test-admin/v1 y sus proveedores, sin Docker. La prueba de extremo a extremo usa el simulador real,
// el SDK real en modo demo y Express: los mismos escenarios de S9, marcados SIMULATED PASS.
import { licenroute } from "@licenroute/connect-express";
import express from "express";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startSimulator, type Simulator } from "../../simulator/src/index.ts";
import { DEMO_ACCESS_TOKEN_FORMAT, isLoopbackHost } from "../src/live/demo-formats.ts";
import { demoTestAdmin, selectTestAdmin, TEST_ADMIN_CONTRACT, type TestAdmin } from "../src/live/test-admin.ts";
import { RESULT_LABEL, runTests, scenarioResult } from "../src/live/test.ts";

const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });
const token = `bgdevadmin_${"a".repeat(43)}`;

describe("contrato y selección del proveedor", () => {
  test("la copia de los formatos de demo coincide con policy-contracts", () => {
    const original = readFileSync(new URL("../../policy-contracts/src/demo.ts", import.meta.url), "utf8");
    expect(original).toContain(`DEMO_ACCESS_TOKEN_FORMAT = ${DEMO_ACCESS_TOKEN_FORMAT.toString()};`);
    for (const h of ["127.0.0.1", "[::1]", "localhost", "LOCALHOST"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["0.0.0.0", "127.0.0.2", "127.0.0.1.nip.io", "localhost.evil.test", "example.com"]) expect(isLoopbackHost(h), h).toBe(false);
  });
  test("repositorio público (L6): el único proveedor es el simulador; sin él no hay proveedor, ni Sandbox ni Central remoto", () => {
    expect(selectTestAdmin("default", {})).toEqual({ code: "unavailable", message: expect.stringContaining("licenroute dev") });
    for (const p of ["sandbox", "remote", "otro"]) expect(selectTestAdmin("default", { BOTGATE_TEST_PROVIDER: p }), p).toEqual({ code: "invalid", message: expect.stringContaining(p) });
    const env = selectTestAdmin("default", { BOTGATE_TEST_PROVIDER: "demo", LICENROUTE_DEMO_ADMIN_URL: "http://127.0.0.1:1", LICENROUTE_DEMO_ADMIN_TOKEN: token }) as TestAdmin;
    expect([env.contract, env.provider, env.verification]).toEqual([TEST_ADMIN_CONTRACT, "demo", "simulated"]);
    const file = selectTestAdmin("default", {}, { url: "http://127.0.0.1:1", admin_token: token }) as TestAdmin;
    expect([file.provider, file.verification]).toEqual(["demo", "simulated"]);
  });
  test("demo: solo una URL de loopback http sin ruta ni credenciales, y el token del simulador", () => {
    for (const url of ["https://127.0.0.1:1", "http://10.0.0.1:1", "http://127.0.0.1.nip.io:1", "http://127.0.0.1:1/otra", "http://u:p@127.0.0.1:1", "http://127.0.0.1:1/?x=1", "no-es-url"]) {
      expect("code" in (demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: url, LICENROUTE_DEMO_ADMIN_TOKEN: token }) as object), url).toBe(true);
    }
    expect("code" in (demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: "http://127.0.0.1:1", LICENROUTE_DEMO_ADMIN_TOKEN: `bg_live_abcdefgh_${"k".repeat(43)}` }) as object)).toBe(true);
    const d = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: "http://127.0.0.1:1", LICENROUTE_DEMO_ADMIN_TOKEN: token }) as TestAdmin;
    expect([d.provider, d.verification]).toEqual(["demo", "simulated"]);
    expect(d.forgedToken()).toMatch(DEMO_ACCESS_TOKEN_FORMAT);
  });
  test("demo: quien responde sin la marca de simulación no se acepta (impostor en el puerto)", async () => {
    const impostor = createServer((_q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ token: `bgdev_abcdefgh_${"x".repeat(43)}` })); });
    await new Promise<void>((ok) => impostor.listen(0, "127.0.0.1", () => ok())); servers.push(impostor);
    const d = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: `http://127.0.0.1:${(impostor.address() as AddressInfo).port}`, LICENROUTE_DEMO_ADMIN_TOKEN: token }) as TestAdmin;
    expect(await d.license("app", "plan")).toEqual({ ok: false, error: { code: "refused", message: expect.stringContaining("no es el simulador") } });
  });
  test("un escenario que pasa contra el simulador nunca es VERIFIED", () => {
    expect(scenarioResult({ id: "x", ok: true, detail: "" }, "simulated")).toBe("simulated_pass");
    expect(scenarioResult({ id: "x", ok: true, detail: "" }, "verified")).toBe("verified_pass");
    expect(scenarioResult({ id: "x", ok: false, detail: "" }, "simulated")).toBe("fail");
    expect(scenarioResult({ id: "x", ok: null, detail: "" }, "verified")).toBe("info");
    expect(RESULT_LABEL.simulated_pass).toBe("SIMULATED PASS");
  });
});

describe("extremo a extremo sin Docker: simulador + SDK real en demo + Express + licenroute test", () => {
  let sim: Simulator; let baseUrl: string;
  beforeAll(async () => {
    sim = await startSimulator({ sites: [{ app: "demo-express", plans: [{ key: "api-informes", pattern: "/api/informes/**", quota: 3 }, { key: "api-catalogo", pattern: "/api/catalogo/**", quota: 3 }] }] });
    const c = sim.sites[0]!;
    process.env.LICENROUTE_MODE = "demo";
    const a = express();
    a.use(licenroute({ apiKey: c.api_key, siteId: c.site_id, endpoint: c.endpoint, licensedPaths: ["/api/informes/**", "/api/catalogo/**"], logger: { warn: () => {}, error: () => {} } }));
    delete process.env.LICENROUTE_MODE;
    a.get("/health", (_q, r) => { r.json({ ok: true }); });
    a.get("/", (_q, r) => { r.json({ home: true }); });
    a.get("/api/informes", (_q, r) => { r.json([1]); });
    a.get("/api/informes/:id", (q, r) => { r.json({ id: q.params.id }); });
    a.get("/api/catalogo", (_q, r) => { r.json([2]); });
    const s = await new Promise<Server>((ok) => { const srv = a.listen(0, "127.0.0.1", () => ok(srv)); }); servers.push(s);
    baseUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });
  afterAll(() => sim.close());

  test("los escenarios de S9 pasan como SIMULATED PASS (no como VERIFIED)", async () => {
    const admin = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: sim.url, LICENROUTE_DEMO_ADMIN_TOKEN: sim.adminToken }) as TestAdmin;
    const journal = { app: "demo-express", instance: "default", public_checks: ["/health", "/"], plans: [
      { key: "api-informes", pattern: "/api/informes/**", methods: [], routes: [{ method: "GET", path: "/api/informes" }, { method: "GET", path: "/api/informes/:id" }] },
      { key: "api-catalogo", pattern: "/api/catalogo/**", methods: [], routes: [{ method: "GET", path: "/api/catalogo" }] },
    ] };
    const checks = await runTests({ app: "demo-express", instance: "default", baseUrl, journal, admin });
    const failed = checks.filter((c) => c.ok === false);
    expect(failed, JSON.stringify(failed)).toEqual([]);
    const ids = checks.filter((c) => c.ok).map((c) => c.id);
    for (const id of ["demo", "activacion", "api-informes:sin-licencia /api/informes", "api-informes:licencia-valida", "api-informes:licencia-de-otro-plan", "api-informes:licencia-inventada", "api-informes:cuota", "api-informes:revocada", "publica /health", "central-caido:api-informes", "central-caido:publica /", "central-recuperado"]) expect(ids, id).toContain(id);
    expect(new Set(checks.filter((c) => c.ok !== null).map((c) => scenarioResult(c, admin.verification)))).toEqual(new Set(["simulated_pass"]));
  }, 120_000);

  test("la CLI real (lanzador, permisos y dos fases) con BOTGATE_TEST_PROVIDER=demo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "licenroute-s101-"));
    try {
      mkdirSync(join(dir, ".licenroute", "journal"), { recursive: true });
      writeFileSync(join(dir, ".licenroute", "journal", "20261021T000000Z-abcdef12.json"), JSON.stringify({
        schema: "licenroute.cli.journal/v1", id: "20261021T000000Z-abcdef12", created_at: new Date().toISOString(), status: "applied", plan_sha256: "0".repeat(64), approval_code: "apr_x", consent: "tty-challenge",
        app: "demo-express", instance: "default", target: "express", sdk: null, public_checks: ["/health", "/"], files: [],
        plans: [{ key: "api-informes", pattern: "/api/informes/**", methods: [], routes: [{ method: "GET", path: "/api/informes" }] }, { key: "api-catalogo", pattern: "/api/catalogo/**", methods: [], routes: [{ method: "GET", path: "/api/catalogo" }] }],
      }));
      const run = (json: boolean, bin = new URL("../bin/licenroute.mjs", import.meta.url).pathname) => new Promise<{ code: number | null; out: string }>((ok) => {
        const env: NodeJS.ProcessEnv = { ...process.env, BOTGATE_TEST_PROVIDER: "demo", LICENROUTE_DEMO_ADMIN_URL: sim.url, LICENROUTE_DEMO_ADMIN_TOKEN: sim.adminToken };
        delete env.LICENROUTE_APPROVAL;
        const p = spawn(process.execPath, [bin, "test", dir, "--app", "demo-express", "--base-url", baseUrl, ...(json ? ["--json"] : [])], { env });
        let out = ""; p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { out += c; });
        p.on("close", (code) => ok({ code, out }));
      });
      const j = await run(true);
      expect(j.code, j.out).toBe(0);
      const doc = JSON.parse(j.out.slice(j.out.indexOf("{")));
      expect([doc.schema, doc.ok, doc.result, doc.test_admin.provider, doc.test_admin.verification]).toEqual(["licenroute.cli.test/v1", true, "simulated_pass", "demo", "simulated"]);
      expect(doc.checks.some((c: { result: string }) => c.result === "verified_pass")).toBe(false);
      const h = await run(false);
      expect(h.out).toMatch(/^MODO DEMO · SIMULACIÓN LOCAL/m);
      expect(h.out).toMatch(/^SIMULATED PASS api-informes:licencia-valida/m);
      expect(h.out).toMatch(/No certifica la seguridad de Central/);
      expect(h.out).not.toMatch(/VERIFIED PASS|TODO OK/);
      expect(h.out).not.toMatch(/bgdev_[a-z2-7]{8}_/); // ningún token en la salida
      // El paquete compilado (lo que recibe un desarrollador), si está construido: mismo resultado.
      const tgz = new URL(`../.pack/licenroute-cli-${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}.tgz`, import.meta.url).pathname;
      const { existsSync } = await import("node:fs");
      const { spawnSync } = await import("node:child_process");
      if (existsSync(tgz)) {
        const prefix = join(dir, "prefix");
        const inst = spawnSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, "--cache", join(dir, "npm-cache"), tgz], { encoding: "utf8" });
        expect(inst.status, inst.stderr).toBe(0);
        const c = await run(true, join(prefix, "node_modules/@licenroute/cli/bin/licenroute.mjs"));
        expect(c.code, c.out).toBe(0);
        expect(JSON.parse(c.out.slice(c.out.indexOf("{"))).result).toBe("simulated_pass");
        // Regresión: con la CLI en node_modules DEL proyecto (instalación normal de un desarrollador), Node 24 denegaba
        // operar sobre el proyecto porque el paquete (hijo) se concedía antes que el proyecto (padre).
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { express: "^5.0.0" } }));
        writeFileSync(join(dir, "server.js"), 'import express from "express";\nconst app = express();\napp.get("/api/informes", (q, r) => r.json([]));\napp.listen(3000);\n');
        for (const cmd of ["detect", "plan"]) {
          const r = spawnSync(process.execPath, [join(prefix, "node_modules/@licenroute/cli/bin/licenroute.mjs"), cmd, dir, "--json"], { encoding: "utf8" });
          expect(r.status, `${cmd}: ${r.stderr}`).toBe(0);
          expect(r.stderr).not.toMatch(/ERR_ACCESS_DENIED/);
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});
