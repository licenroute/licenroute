// S10.2-B: init, dev, env, doctor (demo), connect y assistant con el lanzador real del repositorio (modelo de permisos y
// fases). El simulador es el real; la app de Express usa el SDK real en modo demo. Sin Docker ni red externa.
import { licenroute } from "@licenroute/connect-express";
import express from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import * as common from "../bin/demo-common.mjs";
import { appCommand, appEnv } from "../bin/dev-command.mjs";
import { HELLO_PATH, SIMULATOR_SCHEMA } from "../../simulator/src/index.ts";
import { mergeSettings } from "../src/assistant.ts";
import { effectiveMode, envFileState, shellState } from "../src/demo-state.ts";
import { runInit, selectPlans } from "../src/init.ts";
import { demoTestAdmin, type TestAdmin } from "../src/live/test-admin.ts";
import { withChallenge } from "./pty.ts";

const CLI = new URL("../bin/licenroute.mjs", import.meta.url).pathname;
const FIXTURE = new URL("./fixtures/demo-express", import.meta.url).pathname;
const work = realpathSync(mkdtempSync(join(tmpdir(), "licenroute-s102b-")));
const TGZ = join(work, "licenroute-connect-express-0.7.0.tgz"); // D4.1: el SDK que entiende { path, methods }
writeFileSync(TGZ, "paquete de prueba");
const children: ChildProcess[] = []; const servers: Server[] = [];
afterAll(() => { for (const c of children) if (c.exitCode === null) c.kill("SIGKILL"); for (const s of servers) s.close(); rmSync(work, { recursive: true, force: true }); });

let n = 0;
const project = () => { const d = join(work, `p${++n}`); cpSync(FIXTURE, d, { recursive: true }); writeFileSync(join(d, ".gitignore"), "node_modules/\n.env.licenroute\n.licenroute/\n"); return d; };
const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^(?:LICENROUTE|BOTGATE)_/.test(k) && k !== "LICENROUTE_LANG") delete e[k]; return { ...e, ...extra }; };
/** Sin terminal de control (detached = sesión nueva): así no se puede responder ningún reto. */
// Asíncrono: la app de Express de algunas pruebas corre en este mismo proceso y debe poder responder.
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ status: number | null; out: string; stdout: string }>((ok) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: cleanEnv(env), detached: true });
  let stdout = ""; let stderr = ""; p.stdout.on("data", (c) => { stdout += c; }); p.stderr.on("data", (c) => { stderr += c; });
  const kill = setTimeout(() => p.kill("SIGKILL"), 240_000);
  p.on("close", (status) => { clearTimeout(kill); ok({ status, out: stdout + stderr, stdout }); });
});
const journal = (dir: string, app = "mi-api") => {
  mkdirSync(join(dir, ".licenroute", "journal"), { recursive: true });
  writeFileSync(join(dir, ".licenroute", "journal", "20261021T000000Z-abcdef12.json"), JSON.stringify({
    schema: "licenroute.cli.journal/v1", id: "20261021T000000Z-abcdef12", created_at: new Date().toISOString(), status: "applied", plan_sha256: "0".repeat(64), approval_code: "apr_x", consent: "tty-challenge",
    app, instance: "default", target: "express", sdk: null, public_checks: ["/health", "/"], files: [],
    plans: [{ key: "api-informes", pattern: "/api/informes/**", routes: [{ method: "GET", path: "/api/informes" }, { method: "GET", path: "/api/informes/:id" }] }, { key: "api-catalogo", pattern: "/api/catalogo/**", routes: [{ method: "GET", path: "/api/catalogo" }] }],
  }));
};
const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const devStart = (dir: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) => {
  const p = spawn(process.execPath, [CLI, "dev", dir, ...extra], { env: cleanEnv(env), detached: true });
  let out = ""; p.stdout.on("data", (c) => { out += c; }); p.stderr.on("data", (c) => { out += c; });
  children.push(p);
  return { p, out: () => out, exit: new Promise<number | null>((ok) => p.on("close", (c) => ok(c))) };
};
const listen = async (handler: Parameters<typeof createServer>[1]) => { const s = createServer(handler); await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok())); servers.push(s); return (s.address() as AddressInfo).port; };
const envValue = (dir: string, k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(readFileSync(join(dir, ".env.licenroute"), "utf8"))?.[1] ?? "";

describe("formatos compartidos (bin/demo-common.mjs)", () => {
  test("coinciden con policy-contracts y con el simulador", () => {
    const original = readFileSync(new URL("../../policy-contracts/src/demo.ts", import.meta.url), "utf8");
    for (const k of ["DEMO_API_KEY_FORMAT", "DEMO_SITE_ID_FORMAT", "DEMO_ACCESS_TOKEN_FORMAT", "REAL_API_KEY_FORMAT"] as const) expect(original, k).toContain(`${k} = ${(common[k] as RegExp).toString()};`);
    expect(original).toContain(`PRODUCTION_SIGNALS = ${JSON.stringify(common.PRODUCTION_SIGNALS).replaceAll(",", ", ")} as const;`);
    expect([common.HELLO_PATH, common.SIMULATOR_SCHEMA]).toEqual([HELLO_PATH, SIMULATOR_SCHEMA]);
    expect(common.loopbackOrigin("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000");
    for (const bad of ["https://127.0.0.1:4000", "http://10.0.0.1:4000", "http://u:p@127.0.0.1:4000", "http://127.0.0.1:4000/x", "http://127.0.0.1"]) expect(common.loopbackOrigin(bad), bad).toBeNull();
  });
});

describe("licenroute init", () => {
  test("planes numerados; solo se eligen planes propuestos (nunca rutas que requieren decisión o dinámicas)", () => {
    const dir = project();
    const r = runInit({ dir, instance: "default" });
    expect(r.plans.map((p) => [p.n, p.key])).toEqual([[1, "api-catalogo"], [2, "api-informes"]]);
    expect(r.needsDecision.join(" ")).toMatch(/POST \/api\/pedidos/);
    expect(r.app).toBe("demo-express");
    expect(selectPlans("2,api-catalogo,2", r.plans)).toEqual({ keys: ["api-informes", "api-catalogo"], errors: [] });
    for (const bad of ["3", "api-pedidos", "/api/**", ""]) expect(selectPlans(bad, r.plans).errors.length, bad).toBeGreaterThan(0);
  });

  test("vista previa sin escribir; --write sin terminal o con insecure-test no escribe", async () => {
    const dir = project(); const before = readFileSync(join(dir, "server.js"), "utf8");
    const pre = await cli(["init", dir, "--plans", "2", "--app", "mi-api", "--sdk", TGZ]);
    expect(pre.status, pre.out).toBe(0);
    expect(pre.out).toMatch(/Vista previa de api-informes/);
    expect(pre.out).toMatch(/\+.*@licenroute\/connect-express/);
    expect(pre.out).toMatch(/--write/);
    expect((await cli(["init", dir, "--plans", "2", "--app", "mi-api", "--sdk", TGZ, "--write"])).status).toBe(5);
    expect((await cli(["init", dir, "--plans", "2", "--app", "mi-api", "--sdk", TGZ, "--write"], { LICENROUTE_APPROVAL: "insecure-test" })).status).toBe(5);
    expect((await cli(["init", dir, "--plans", "2", "--app", "mi-api", "--sdk", TGZ, "--write", "--approve", "apr_x"])).status).toBe(5); // D3.1: código de otro diff
    expect((await cli(["init", dir, "--plans", "api-pedidos", "--app", "mi-api", "--sdk", TGZ, "--write"])).status).toBe(5);
    expect(readFileSync(join(dir, "server.js"), "utf8")).toBe(before);
    expect(existsSync(join(dir, ".licenroute"))).toBe(false);
  });

  test("--write con el reto tecleado en el terminal aplica exactamente lo previsto; undo lo revierte", async () => {
    const dir = project(); const before = readFileSync(join(dir, "server.js"), "utf8");
    const wrong = await withChallenge(process.execPath, [CLI, "init", dir, "--plans", "1,2", "--app", "mi-api", "--sdk", TGZ, "--write"], cleanEnv(), "NO-VALE").done;
    expect(wrong).toMatch(/No confirmado/);
    expect(readFileSync(join(dir, "server.js"), "utf8")).toBe(before);
    const tty = await withChallenge(process.execPath, [CLI, "init", dir, "--plans", "1,2", "--app", "mi-api", "--sdk", TGZ, "--write"], cleanEnv()).done;
    expect(tty).toMatch(/LicenRoute va a escribir/);
    expect(tty).toMatch(/Aprobación confirmada/);
    expect(tty).toMatch(/aplicado/);
    const after = readFileSync(join(dir, "server.js"), "utf8");
    expect(after).toContain('licensedPaths: [{ path: "/api/catalogo/**", methods: ["GET", "HEAD"] }, { path: "/api/informes/**", methods: ["GET", "HEAD"] }]');
    expect(readdirSync(join(dir, ".licenroute", "journal")).length).toBe(1);
    const u = await cli(["undo", dir]);
    expect(u.status, u.out).toBe(0);
    expect(readFileSync(join(dir, "server.js"), "utf8")).toBe(before);
  }, 120_000);
});

describe("licenroute connect", () => {
  test("solo estados: demo disponible, Central propio y Cloud aún no; no guarda nada", async () => {
    const dir = project(); const files = readdirSync(dir).sort();
    const all = await cli(["connect", dir, "--json"]);
    expect(all.status).toBe(0);
    expect(JSON.parse(all.stdout).targets.map((t: { id: string; state: string }) => `${t.id}:${t.state}`)).toEqual(["demo:available", "self-hosted:not_implemented", "cloud:unavailable"]);
    expect((await cli(["connect", dir, "--cloud"])).status).toBe(3);
    const sh = await cli(["connect", dir, "--self-hosted", "https://u:p@central.example", "--json"]);
    expect(sh.status).toBe(3);
    expect(JSON.parse(sh.stdout).url_check).toMatch(/user or password/); // --json: inglés (D4.4)
    expect(sh.stdout).not.toContain("u:p@");
    expect((await cli(["connect", dir, "--demo", "--cloud"])).status).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(files);
  });
});

describe("licenroute assistant", () => {
  test("vista previa; nunca sobrescribe; propone la fusión de settings.json sin duplicar; escribe solo con el reto", async () => {
    const dir = project();
    mkdirSync(join(dir, ".claude", "skills", "licenroute"), { recursive: true });
    const settings = `${JSON.stringify({ permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)"] } }, null, 2)}\n`;
    writeFileSync(join(dir, ".claude", "settings.json"), settings);
    writeFileSync(join(dir, ".claude", "skills", "licenroute", "SKILL.md"), "mi versión\n");
    const pre = await cli(["assistant", dir, "--claude-code", "--json"]);
    expect(pre.status, pre.out).toBe(0);
    const doc = JSON.parse(pre.stdout) as { approval_code: string; files: { path: string; action: string; proposal?: string }[] };
    const by = Object.fromEntries(doc.files.map((f) => [f.path, f]));
    expect(by[".claude/skills/licenroute/SKILL.md"]!.action).toBe("conflict");
    expect(by[".claude/settings.json"]!.action).toBe("merge-proposal");
    const proposal = JSON.parse(by[".claude/settings.json"]!.proposal!);
    expect(proposal.permissions.allow).toEqual(["Bash(npm test)"]);
    expect(proposal.permissions.deny.filter((x: string) => x === "Read(./.env)").length).toBe(1);
    expect(proposal.permissions.deny).toContain("Bash(*LICENROUTE_APPROVAL=insecure-test*)");
    expect(proposal.permissions.ask).toContain("Bash(*licenroute* init * --write*)");
    expect(mergeSettings("claude-code", proposal, proposal)).toBeNull(); // ya fusionado: nada que añadir
    expect(by[".claude/hooks/licenroute-guard.mjs"]!.action).toBe("create");
    expect((await cli(["assistant", dir, "--claude-code", "--approve", doc.approval_code])).status).toBe(5); // sin terminal
    expect((await cli(["assistant", dir, "--claude-code", "--approve", "asst_otro"])).status).toBe(5);
    const tty = await withChallenge(process.execPath, [CLI, "assistant", dir, "--claude-code", "--approve", doc.approval_code], cleanEnv()).done;
    expect(tty).toMatch(/Aprobación confirmada/);
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(join(dir, ".claude", "skills", "licenroute", "SKILL.md"), "utf8")).toBe("mi versión\n");
    expect(existsSync(join(dir, ".claude", "hooks", "licenroute-guard.mjs"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "skills", "licenroute", "reference", "http-codes.md"))).toBe(true);
    const again = JSON.parse((await cli(["assistant", dir, "--claude-code", "--json"])).stdout) as { approval_code: string | null };
    expect(again.approval_code).toBeNull();
  }, 120_000);

  test("Cursor en un proyecto limpio: crea reglas y hooks.json", async () => {
    const dir = project();
    const pre = JSON.parse((await cli(["assistant", dir, "--cursor", "--json"])).stdout) as { files: { path: string; action: string }[] };
    expect(pre.files.every((f) => f.action === "create")).toBe(true);
    expect(pre.files.map((f) => f.path)).toEqual(expect.arrayContaining([".cursor/hooks.json", ".cursor/rules/licenroute.mdc"]));
    expect(existsSync(join(dir, ".cursor"))).toBe(false);
  });
});

describe("licenroute env y estado de demo", () => {
  test("modos: ninguno, mezclado (terminal real sobre fichero de demo) y producción; nunca muestra secretos", async () => {
    const dir = project();
    const none = await cli(["env", dir, "--json"]);
    expect(JSON.parse(none.stdout).mode).toBe("none");
    const key = `bg_dev_abcdefgh_${"K".repeat(43)}`; const real = `bg_live_abcdefgh_${"R".repeat(43)}`;
    writeFileSync(join(dir, ".env.licenroute"), `# Generado por el simulador de LicenRoute (MODO DEMO, no productivo) · instancia=default · app=mi-api\nLICENROUTE_SITE_ID=site_dev_ABCDEFGH12345678\nLICENROUTE_API_KEY=${key}\nLICENROUTE_ENDPOINT=http://127.0.0.1:9\n`, { mode: 0o600 });
    const demo = await cli(["env", dir]);
    expect(demo.out).toMatch(/modo DEMO/);
    const mixed = await cli(["env", dir, "--json"], { LICENROUTE_API_KEY: real, NODE_ENV: "production" });
    expect(mixed.status).toBe(1);
    const m = JSON.parse(mixed.stdout);
    expect(m.mode).toBe("mixed");
    expect(m.warnings.join(" ")).toMatch(/production signals/);
    for (const out of [demo.out, mixed.out]) { expect(out).not.toContain(key); expect(out).not.toContain(real); expect(out).not.toContain("site_dev_ABCDEFGH12345678"); }
    const st = envFileState(dir);
    expect(effectiveMode(st, shellState({ LICENROUTE_MODE: "otro" })).mode).toBe("mixed");
    expect(effectiveMode({ ...st, endpoint: "https://central.example", endpointLoopback: false }, shellState({})).reasons.join()).toMatch(/no es local/);
  });
});

describe("licenroute dev (simulador real, lanzador real)", () => {
  test("rechazos: sin integración, credenciales ajenas, producción, puerto ocupado, --start-app sin terminal", async () => {
    const d0 = project();
    expect((await cli(["dev", d0])).status).toBe(3);
    const d1 = project(); journal(d1);
    const realEnv = `LICENROUTE_API_KEY=bg_live_abcdefgh_${"k".repeat(43)}\n`;
    writeFileSync(join(d1, ".env.licenroute"), realEnv);
    expect((await cli(["dev", d1])).status).toBe(5);
    expect(readFileSync(join(d1, ".env.licenroute"), "utf8")).toBe(realEnv);
    const d2 = project(); journal(d2);
    expect((await cli(["dev", d2], { KUBERNETES_SERVICE_HOST: "10.0.0.1" })).status).toBe(5);
    const busy = await listen((_q, r) => r.end("ocupado"));
    const b = await cli(["dev", d2, "--port", String(busy)]);
    expect(b.status, b.out).toBe(6);
    for (const bad of ["80", "abc", "70000"]) expect((await cli(["dev", d2, "--port", bad])).status).toBe(2);
    expect((await cli(["dev", d2, "--start-app", "--entry", "server.js"])).status).toBe(5);
    expect(existsSync(join(d2, ".licenroute", "demo-admin.json"))).toBe(false);
    expect(existsSync(join(d2, ".env.licenroute"))).toBe(false);
  }, 60_000);

  test("sesión completa: arranque, estado, duplicado, env, doctor, test SIMULATED PASS e impostor; parada limpia", async () => {
    const dir = project(); journal(dir);
    // El código del proyecto, integrado como lo deja apply (para el análisis estático de doctor). La app que responde
    // es la de Express de esta prueba, con el SDK real.
    const src = readFileSync(join(dir, "server.js"), "utf8").replace("const app = express();\n", 'const app = express();\napp.use(licenroute({ licensedPaths: ["/api/informes/**", "/api/catalogo/**"] }));\n');
    writeFileSync(join(dir, "server.js"), `import { licenroute } from "@licenroute/connect-express";\n${src}`);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); pkg.dependencies["@licenroute/connect-express"] = "file:x.tgz"; writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    const s = devStart(dir);
    const adminFile = join(dir, ".licenroute", "demo-admin.json");
    expect(await until(() => existsSync(adminFile)), s.out()).toBe(true);
    await until(() => /MODO DEMO · SIMULACIÓN LOCAL/.test(s.out()));
    const admin = JSON.parse(readFileSync(adminFile, "utf8")) as { url: string; admin_token: string; run_id: string };
    expect((statSync(adminFile).mode & 0o777).toString(8)).toBe("600");
    expect(s.out()).not.toContain(admin.admin_token);
    expect(s.out()).toMatch(/permisos: modelo de Node activo/);
    expect((await cli(["dev", dir, "--status"])).out).toMatch(/simulador\s+en marcha/);
    expect((await cli(["dev", dir])).status).toBe(6); // una sesión por proyecto

    // doctor en demo, antes de arrancar la app: la app no ha atestado y no responde.
    const d1 = await cli(["doctor", dir, "--json"]);
    const f1 = JSON.parse(d1.stdout).findings as { id: string; level: string }[];
    expect(f1.find((x) => x.id === "simulador")?.level).toBe("ok");
    expect(f1.find((x) => x.id === "atestacion")?.level).toBe("fail");
    expect(d1.stdout).not.toContain(admin.admin_token);

    // La app (Express + SDK real en demo) con las credenciales que escribió dev.
    process.env.LICENROUTE_MODE = "demo";
    const a = express();
    a.use(licenroute({ apiKey: envValue(dir, "LICENROUTE_API_KEY"), siteId: envValue(dir, "LICENROUTE_SITE_ID"), endpoint: envValue(dir, "LICENROUTE_ENDPOINT"), licensedPaths: ["/api/informes/**", "/api/catalogo/**"], logger: { warn: () => {}, error: () => {} } }));
    delete process.env.LICENROUTE_MODE;
    for (const p of ["/health", "/", "/api/informes", "/api/informes/:id", "/api/catalogo"]) a.get(p, (_q, r) => { r.json({ ok: true }); });
    const srv = await new Promise<Server>((ok) => { const x = a.listen(0, "127.0.0.1", () => ok(x)); }); servers.push(srv);
    const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const env = await cli(["env", dir, "--json"]);
    const e = JSON.parse(env.stdout);
    expect([e.mode, e.endpoint.kind, e.endpoint.reachable, e.simulator.state]).toEqual(["demo", "simulator", true, "running"]);
    for (const secret of [admin.admin_token, envValue(dir, "LICENROUTE_API_KEY")]) expect(env.stdout).not.toContain(secret);

    const t = await cli(["test", dir, "--base-url", baseUrl, "--json"]); // --app sale del diario
    expect(t.status, t.out).toBe(0);
    expect(JSON.parse(t.stdout).result).toBe("simulated_pass");
    const d2 = JSON.parse((await cli(["doctor", dir, "--base-url", baseUrl, "--json"])).stdout).findings as { id: string; level: string }[];
    expect(d2.filter((x) => x.level === "fail" && x.id !== "sdk-instalado"), JSON.stringify(d2)).toEqual([]);
    expect(d2.find((x) => x.id.startsWith("ruta-de-pago"))?.level).toBe("ok");

    // Puerto equivocado en .env.licenroute: doctor lo detecta.
    const envText = readFileSync(join(dir, ".env.licenroute"), "utf8");
    writeFileSync(join(dir, ".env.licenroute"), envText.replace(/^LICENROUTE_ENDPOINT=.*$/m, "LICENROUTE_ENDPOINT=http://127.0.0.1:1"));
    expect((JSON.parse((await cli(["doctor", dir, "--json"])).stdout).findings as { id: string; level: string }[]).find((x) => x.id === "puerto")?.level).toBe("fail");
    writeFileSync(join(dir, ".env.licenroute"), envText, { mode: 0o600 });

    // Impostor: el fichero de administración apunta a otro servicio. Ni stop ni test le envían el token.
    let sawAuth = false;
    const fake = await listen((q, r) => { if (q.headers.authorization) sawAuth = true; r.setHeader("botgate-mode", "simulation"); r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ schema: SIMULATOR_SCHEMA, run_id: "run_AAAAAAAAAAAAAAAA" })); });
    const realAdmin = readFileSync(adminFile, "utf8");
    writeFileSync(adminFile, JSON.stringify({ ...admin, url: `http://127.0.0.1:${fake}` }), { mode: 0o600 });
    expect((await cli(["dev", dir, "--stop"])).status).toBe(6);
    expect((await cli(["test", dir, "--base-url", baseUrl])).status).not.toBe(0);
    expect(sawAuth).toBe(false);
    writeFileSync(adminFile, realAdmin, { mode: 0o600 });

    const stop = await cli(["dev", dir, "--stop"]);
    expect(stop.status, stop.out).toBe(0);
    expect(await s.exit).toBe(0);
    expect(existsSync(adminFile)).toBe(false);
    expect(existsSync(join(dir, ".licenroute", "dev-session.json"))).toBe(false);
    expect(JSON.parse((await cli(["doctor", dir, "--json"])).stdout).findings.find((x: { id: string }) => x.id === "simulador").level).toBe("fail");
  }, 120_000);

  test("--start-app: comando construido por LicenRoute, reto en el terminal, entorno mínimo y permisos; se para con la sesión", async () => {
    const dir = project(); journal(dir);
    // App sin dependencias que informa de lo que ve (nombres de variables, no valores) y de lo que puede hacer.
    writeFileSync(join(dir, "probe.mjs"), `import { createServer } from "node:http"; import { readFileSync } from "node:fs";
const can = (f) => { try { f(); return true; } catch { return false; } };
createServer((q, r) => r.end(JSON.stringify({ keys: Object.keys(process.env).sort(), mode: process.env.LICENROUTE_MODE, key: /^bg_dev_/.test(process.env.LICENROUTE_API_KEY ?? ""), etc: can(() => readFileSync("/etc/hosts")) }))).listen(Number(process.env.PORT), "127.0.0.1");\n`);
    const secretEnv = cleanEnv({ LICENROUTE_DEMO_ADMIN_TOKEN: `bgdevadmin_${"z".repeat(43)}`, MY_SECRET: "s3cr3t", NODE_OPTIONS: "--max-old-space-size=300", HTTPS_PROXY: "http://proxy:1" });
    const run = withChallenge(process.execPath, [CLI, "dev", dir, "--start-app", "--entry", "probe.mjs"], secretEnv);
    const appFile = join(dir, ".licenroute", "demo-app.json");
    expect(await until(() => existsSync(appFile), 30_000), run.output()).toBe(true);
    const out = run.output();
    expect(out).toMatch(/no se usa ningún script de package\.json/);
    expect(out).toMatch(/--permission --allow-fs-read=/);
    expect(out).not.toMatch(/--allow-child-process|--allow-fs-write/);
    const { url } = JSON.parse(readFileSync(appFile, "utf8")) as { url: string };
    const seen = await (await fetch(url)).json() as { keys: string[]; mode: string; key: boolean; etc: boolean };
    expect(seen.mode).toBe("demo");
    expect(seen.key).toBe(true); // .env.licenroute cargado
    expect(seen.etc).toBe(false); // no lee fuera del proyecto
    for (const k of ["LICENROUTE_DEMO_ADMIN_TOKEN", "MY_SECRET", "NODE_OPTIONS", "HTTPS_PROXY"]) expect(seen.keys).not.toContain(k);
    expect((await cli(["env", dir, "--json"])).stdout).toMatch(/"app": \{\s*"state": "running"/);
    expect((await cli(["dev", dir, "--stop"])).status).toBe(0);
    await run.done;
    expect(await until(async () => { try { await fetch(url, { signal: AbortSignal.timeout(300) }); return false; } catch { return true; } })).toBe(true);
    expect(existsSync(appFile)).toBe(false);
  }, 120_000);

  test("unidades: el comando de la app solo admite un fichero del proyecto; el entorno es una lista blanca", () => {
    const dir = project();
    expect(appCommand(dir, "server.js", 3400).args).toEqual(["--permission", `--allow-fs-read=${dir}`, `--env-file=${join(dir, ".env.licenroute")}`, "--disable-warning=ExperimentalWarning", join(dir, "server.js")]);
    for (const bad of ["../x.js", "/etc/x.js", "server.sh", "npm run dev", "a.js; rm -rf /", "node_modules/../../x.js"]) expect(() => appCommand(dir, bad, 3400), bad).toThrow();
    const env = appEnv({ PATH: "/bin", HOME: "/h", LC_ALL: "C", LICENROUTE_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y", NODE_OPTIONS: "z" }, 3401);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", PORT: "3401", LICENROUTE_MODE: "demo" });
  });

  test("test-admin demo con run_id: un simulador de otra ejecución no recibe el token", async () => {
    let sawAuth = false;
    const port = await listen((q, r) => { if (q.headers.authorization) sawAuth = true; r.setHeader("botgate-mode", "simulation"); r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ schema: SIMULATOR_SCHEMA, run_id: "run_BBBBBBBBBBBBBBBB", token: "x" })); });
    const admin = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: `http://127.0.0.1:${port}`, LICENROUTE_DEMO_ADMIN_TOKEN: `bgdevadmin_${"a".repeat(43)}`, LICENROUTE_DEMO_ADMIN_RUN_ID: "run_AAAAAAAAAAAAAAAA" }) as TestAdmin;
    expect(await admin.license("app", "plan")).toEqual({ ok: false, error: { code: "refused", message: expect.stringContaining("otra ejecución") } });
    expect(sawAuth).toBe(false);
  });
});
