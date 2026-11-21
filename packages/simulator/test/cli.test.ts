// S10.2-A: licenroute-simulator (la orden que arranca el simulador desde el paquete).
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ADMIN_FILE, assertEnvWritable, main, parseArgs } from "../src/cli.ts";
import { HELLO_PATH, startSimulator, TEST_ADMIN_PREFIX } from "../src/index.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "licenroute-simcli-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("licenroute-simulator", () => {
  test("argumentos: app y planes obligatorios; cuota por defecto 3; formatos estrictos", () => {
    expect(parseArgs(["--app", "mi-api", "--plan", "p=/api/**"]).plans).toEqual([{ key: "p", pattern: "/api/**", quota: 3 }]);
    expect(parseArgs(["--app", "mi-api", "--plan", "p=/api/**:7"]).plans[0]!.quota).toBe(7);
    expect(() => parseArgs(["--plan", "p=/api/**"])).toThrow(/--app/);
    expect(() => parseArgs(["--app", "mi-api"])).toThrow(/--plan/);
    expect(() => parseArgs(["--app", "Mi API", "--plan", "p=/a"])).toThrow(/--app/);
    expect(() => parseArgs(["--app", "x", "--plan", "p=api"])).toThrow(/--plan inválido/);
    expect(() => parseArgs(["--app", "x", "--plan", "p=/a;rm"])).toThrow(/--plan inválido/);
    expect(() => parseArgs(["--app", "x", "--plan", "p=/a", "--otra"])).toThrow(/no reconocido/);
  });

  test("nunca pisa credenciales reales, ficheros ajenos ni enlaces", () => {
    const d = dir();
    const env = join(d, ".env.licenroute");
    expect(() => assertEnvWritable(env)).not.toThrow(); // no existe
    writeFileSync(env, `LICENROUTE_API_KEY=bg_live_abcdefgh_${"k".repeat(43)}\n`);
    expect(() => assertEnvWritable(env)).toThrow(/credenciales REALES/);
    writeFileSync(env, "OTRA=1\n");
    expect(() => assertEnvWritable(env)).toThrow(/no lo generó el simulador/);
    writeFileSync(env, "# Generado por el simulador de LicenRoute (MODO DEMO, no productivo)\nLICENROUTE_API_KEY=bg_dev_x\n");
    expect(() => assertEnvWritable(env)).not.toThrow();
    const d2 = dir(); symlinkSync("/etc/hosts", join(d2, ".env.licenroute"));
    expect(() => assertEnvWritable(join(d2, ".env.licenroute"))).toThrow(/enlace/);
  });

  test("escribe credenciales de demo (0600) y la administración; la borra al parar", async () => {
    const d = dir();
    const run = main(["--app", "mi-api", "--plan", "p=/api/**", "--dir", d]);
    const admin = join(d, ADMIN_FILE);
    for (let i = 0; i < 50 && !(() => { try { statSync(admin); return true; } catch { return false; } })(); i++) await new Promise((r) => setTimeout(r, 50));
    const env = readFileSync(join(d, ".env.licenroute"), "utf8");
    expect(env).toMatch(/^# Generado por el simulador de LicenRoute \(MODO DEMO/);
    expect(env).toMatch(/^LICENROUTE_API_KEY=bg_dev_[a-z2-7]{8}_[A-Za-z0-9]{43}$/m);
    expect(env).not.toMatch(/^\s*LICENROUTE_MODE\s*=/m);
    expect((statSync(join(d, ".env.licenroute")).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(admin).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(readFileSync(admin, "utf8")).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    process.emit("SIGINT");
    expect(await run).toBe(0);
    expect(() => statSync(admin)).toThrow();
  });

  test("--port: validado; si está ocupado, error claro y no se escribe nada", async () => {
    expect(parseArgs(["--app", "a", "--plan", "p=/a", "--port", "4317"]).port).toBe(4317);
    for (const bad of ["80", "70000", "12ab", "-1"]) expect(() => parseArgs(["--app", "a", "--plan", "p=/a", "--port", bad])).toThrow(/--port/);
    const other = await startSimulator({ sites: [{ app: "otra", plans: [{ key: "p", pattern: "/a", quota: 1 }] }] });
    const port = new URL(other.url).port;
    const d = dir();
    try {
      expect(await main(["--app", "mi-api", "--plan", "p=/api/**", "--dir", d, "--port", port])).toBe(6);
      expect(() => statSync(join(d, ".env.licenroute"))).toThrow();
      expect(() => statSync(join(d, ADMIN_FILE))).toThrow();
    } finally { await other.close(); }
  });

  test("hello: identificación pública sin secretos; shutdown solo con el token, y borra la administración", async () => {
    const d = dir();
    const run = main(["--app", "mi-api", "--plan", "p=/api/**", "--dir", d]);
    const admin = join(d, ADMIN_FILE);
    for (let i = 0; i < 50 && !(() => { try { statSync(admin); return true; } catch { return false; } })(); i++) await new Promise((r) => setTimeout(r, 50));
    const a = JSON.parse(readFileSync(admin, "utf8")) as { url: string; admin_token: string; run_id: string };
    expect(a.run_id).toMatch(/^run_[A-Za-z0-9]{16}$/);
    const hello = await fetch(`${a.url}${HELLO_PATH}`);
    expect(hello.headers.get("botgate-mode")).toBe("simulation");
    const body = await hello.text();
    expect(JSON.parse(body)).toMatchObject({ schema: "botgate.simulator/v1", run_id: a.run_id, apps: ["mi-api"] });
    expect(body).not.toContain(a.admin_token);
    expect(body).not.toMatch(/bg_dev_|site_dev_/);
    expect((await fetch(`${a.url}${TEST_ADMIN_PREFIX}/shutdown`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${a.url}${TEST_ADMIN_PREFIX}/shutdown`, { method: "POST", headers: { authorization: `Bearer ${a.admin_token}` } })).status).toBe(200);
    expect(await run).toBe(0);
    expect(() => statSync(admin)).toThrow();
  });
});
