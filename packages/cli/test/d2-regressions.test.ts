// S10.2-D2: regresiones de los hallazgos del laboratorio (laboratorio interno D1).
//  1. Prefijo calculado tomado por la raíz → la ruta queda sin resolver y nunca da un plan.
//  2. Caracteres de control saneados en el patrón → el valor nunca se sanea; rutas ambiguas, sin plan.
//  3-6. Fábrica de app, carpetas hermanas, package.json en una línea, /estado, Express 4 CommonJS, idempotencia.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { prepareApply } from "../src/apply.ts";
import { detect } from "../src/detect.ts";
import { revertEdits } from "../src/edits.ts";
import { plan } from "../src/plan.ts";
import { displayPath, safePath, unplannablePath } from "../src/util.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "licenroute-d2-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
/** Proyecto Express 5 (ESM salvo que se indique) con los ficheros dados. */
function project(files: Record<string, string>, pkg: Record<string, unknown> = {}): string {
  const dir = join(work, `p${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: `p${n}`, version: "1.0.0", type: "module", dependencies: { express: "^5.1.0" }, ...pkg }, null, 2)}\n`);
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); }
  return dir;
}
const analyze = (dir: string) => { const d = detect(dir); return { d, p: plan(d) }; };
const patterns = (dir: string) => analyze(dir).p.proposed_plans.map((x) => x.route_pattern).sort();
const head = 'import express from "express";\nconst app = express();\n';
const tail = "\napp.listen(3000);\n";

describe("1. prefijos que no se pueden resolver (nunca la raíz ni el prefijo del padre)", () => {
  test("reproduce D1: const PREFIJO = process.env… ?? \"/api/v2\" ya no da /indicadores/**", () => {
    const dir = project({ "server.js": `${head}const PREFIJO = process.env.API_PREFIX ?? "/api/v2";\nconst v2 = express.Router();\nv2.get("/indicadores", (_q, r) => r.json({}));\napp.use(PREFIJO, v2);\napp.get("/api/estadisticas", (_q, r) => r.json({}));${tail}` });
    const { d, p } = analyze(dir);
    expect(p.proposed_plans.map((x) => x.route_pattern)).toEqual(["/api/estadisticas/**"]);
    const ind = d.routes.find((r) => r.notes.some((x) => x.includes("/indicadores")));
    expect(ind).toMatchObject({ path: null, resolution: "dynamic" });
    expect(d.routes.some((r) => r.path === "/indicadores")).toBe(false);
    expect(d.unresolved.map((u) => u.reason).join(" ")).toMatch(/GET \/indicadores is under a prefix that cannot be resolved \("PREFIJO"\)|"PREFIJO"/) // D4.4: dato, inglés canónico;
  });

  test("otras formas de prefijo calculado: propiedad, plantilla, concatenación con variable, import relativo de un texto", () => {
    const cases: Record<string, string> = {
      propiedad: `${head}const config = { prefijo: "/api" };\nconst r = express.Router();\nr.get("/datos", (_q, s) => s.json({}));\napp.use(config.prefijo, r);${tail}`,
      plantilla: `${head}const ver = process.env.V;\nconst r = express.Router();\nr.get("/datos", (_q, s) => s.json({}));\napp.use(\`/api/\${ver}\`, r);${tail}`,
      concatenacion: `${head}const r = express.Router();\nr.get("/datos", (_q, s) => s.json({}));\napp.use("/api" + process.env.V, r);${tail}`,
    };
    for (const [name, src] of Object.entries(cases)) {
      const dir = project({ "server.js": src });
      const { d, p } = analyze(dir);
      expect(p.proposed_plans, name).toEqual([]);
      expect(d.routes.filter((r) => r.path !== null && r.path.includes("datos")), name).toEqual([]);
    }
    const imported = project({ "config.js": 'export const PREFIJO = process.env.P ?? "/api";\n', "server.js": `import { PREFIJO } from "./config.js";\n${head}const r = express.Router();\nr.get("/datos", (_q, s) => s.json({}));\napp.use(PREFIJO, r);${tail}` });
    expect(patterns(imported)).toEqual([]);
    expect(detect(imported).routes.some((r) => r.path === "/datos")).toBe(false);
  });

  test("router sin montar (o montado de forma no resuelta): sus rutas no se listan como si colgaran de /", () => {
    const dir = project({ "rutas.js": 'import { Router } from "express";\nexport const r = Router();\nr.get("/informes", (_q, s) => s.json({}));\n', "server.js": `import * as m from "./rutas.js";\n${head}app.use("/api", m.r);${tail}` });
    const { d, p } = analyze(dir);
    expect(p.proposed_plans).toEqual([]);
    expect(d.routes.some((r) => r.path === "/informes")).toBe(false);
  });

  test("lo que SÍ se resuelve sigue igual: routers importados, prefijos estáticos anidados y middleware de paquetes", () => {
    const dir = project({
      "routes/informes.js": 'import { Router } from "express";\nimport mensuales from "./mensuales.js";\nconst r = Router();\nr.get("/", (_q, s) => s.json([]));\nr.use("/mensuales", mensuales);\nexport default r;\n',
      "routes/mensuales.js": 'import { Router } from "express";\nconst r = Router();\nr.get("/:mes", (q, s) => s.json({}));\nexport default r;\n',
      "routes/catalogo.js": 'import { Router } from "express";\nconst r = Router();\nr.get("/api/catalogo", (_q, s) => s.json([]));\nexport default r;\n',
      "server.js": `import helmet from "helmet";\nimport informes from "./routes/informes.js";\nimport catalogo from "./routes/catalogo.js";\n${head}app.use(helmet, catalogo);\napp.use("/api/v1/informes", informes);${tail}`,
    });
    const { d } = analyze(dir);
    const statics = d.routes.filter((r) => r.resolution === "static").map((r) => `${r.method} ${r.path}`);
    expect(statics).toEqual(expect.arrayContaining(["GET /api/catalogo", "GET /api/v1/informes", "GET /api/v1/informes/mensuales/:mes"]));
    expect(patterns(dir)).toEqual(["/api/catalogo/**", "/api/v1/informes/**"]);
  });
});

describe("2. caracteres de control, escapes, separadores y Unicode: el valor nunca se sanea", () => {
  const variants: Record<string, string> = {
    esc: "\\u001b", bel: "\\u0007", nul: "\\u0000", bidi: "\\u202e", separador: "\\u2028", c1: "\\u0085",
    porcentaje: "%2F", interrogacion: "?x", almohadilla: "#x", barra_invertida: "\\\\x", punto_y_coma: ";x", espacio: " x",
    nfc: "a\\u00f1o", nfd: "an\\u0303o", emoji: "\\ud83d\\ude00", tabulador: "\\t",
  };
  test("ninguna variante da un plan; todas quedan sin resolver o para decisión, con motivo", () => {
    const routes = Object.entries(variants).map(([k, v]) => `app.get("/api/${k}${v}", (_q, r) => r.json({}));`).join("\n");
    const dir = project({ "server.js": `${head}${routes}\napp.get("/api/limpia", (_q, r) => r.json({}));${tail}` });
    const { d, p } = analyze(dir);
    expect(p.proposed_plans.map((x) => x.route_pattern)).toEqual(["/api/limpia/**"]);
    // Cada variante aparece como sin resolver o para decisión: ninguna desaparece en silencio.
    const listed = [...p.needs_decision.map((x) => x.path ?? ""), ...d.unresolved.map((u) => u.snippet)].join("\n");
    for (const k of Object.keys(variants)) expect(listed, k).toContain(k);
    // Ningún valor funcional lleva caracteres de control ni «?» de sustitución.
    // eslint-disable-next-line no-control-regex -- se buscan justamente caracteres de control
    for (const r of d.routes) if (r.path !== null) expect(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(r.path), r.path).toBe(false);
    for (const x of p.proposed_plans) expect(unplannablePath(x.route_pattern)).toBeNull();
    // La salida JSON (detect y plan) no lleva caracteres de control crudos ni rutas ambiguas en planes.
    // eslint-disable-next-line no-control-regex -- se buscan justamente caracteres de control
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(JSON.stringify(d) + JSON.stringify(p))).toBe(false);
  });

  test("safePath, displayPath y unplannablePath separan valor y pantalla", () => {
    expect(safePath("/api/x\u001b")).toEqual({ path: null, rejected: expect.stringMatching(/control or direction characters/) }); // D4.4: dato, inglés canónico
    expect(safePath("/api/ok")).toEqual({ path: "/api/ok", rejected: null });
    expect(safePath(`/${"a".repeat(600)}`).path).toBeNull();
    expect(displayPath("/api/x\u001b[31m")).toBe("/api/x?[31m");
    for (const ok of ["/api/informes/**", "/api/v1/:id", "/a-b_c.d~e/**", "/api/archivo/*"]) expect(unplannablePath(ok), ok).toBeNull();
    for (const bad of ["/api/x?y", "/api/x%2F", "/api/x#y", "/api/x\\y", "/api/x;y", "/api/x y", "/api/año", "/api/\u202ex", "api/x"]) expect(unplannablePath(bad), bad).not.toBeNull();
  });
});

describe("3. integración parcial: se dice, y es todo o nada", () => {
  test("con rutas sin resolver, apply avisa INTEGRACIÓN PARCIAL y cuenta lo que no cubre", () => {
    const dir = project({ "server.js": `${head}for (const r of ["a", "b"]) app.get(\`/api/\${r}\`, (_q, s) => s.json({}));\napp.get("/api/estadisticas", (_q, s) => s.json({}));${tail}` });
    const { p } = analyze(dir);
    const pr = prepareApply({ dir, planKeys: ["api-estadisticas"], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: null });
    expect(pr.refusals).toEqual(["indica --sdk <ruta al .tgz de @licenroute/connect-express> (npm pack -w @licenroute/connect-express en el repositorio)"]);
    const tgz = join(work, "sdk.tgz"); writeFileSync(tgz, "x");
    const ok = prepareApply({ dir, planKeys: ["api-estadisticas"], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: tgz });
    expect(ok.ok).toBe(true);
    expect(ok.uncovered).toBeGreaterThan(0);
    expect(ok.warnings.join(" ")).toMatch(/INTEGRACIÓN PARCIAL: \d+ rutas o construcciones/);
  });

  test("sin nada pendiente no hay aviso; un plan inexistente junto a uno válido cancela todo", () => {
    const tgz = join(work, "sdk2.tgz"); writeFileSync(tgz, "x");
    const dir = project({ "server.js": `${head}app.get("/api/estadisticas", (_q, s) => s.json({}));${tail}` });
    const { p } = analyze(dir);
    const ok = prepareApply({ dir, planKeys: ["api-estadisticas"], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: tgz });
    expect([ok.ok, ok.uncovered, ok.warnings.some((w) => /PARCIAL/.test(w))]).toEqual([true, 0, false]);
    const mixed = prepareApply({ dir, planKeys: ["api-estadisticas", "indicadores"], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: tgz });
    expect([mixed.ok, mixed.changes.length]).toEqual([false, 0]);
  });
});

describe("4. otros hallazgos", () => {
  test("Express 4 + CommonJS con arranque separado: require() en app.js y sintaxis válida", () => {
    const dir = project({
      "app.js": 'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.json({ ok: true }));\napp.get("/api/informes/ventas", (req, res) => res.json([]));\nmodule.exports = app;\n',
      "server.js": 'const app = require("./app");\napp.listen(3000);\n',
    }, { type: undefined, main: "server.js", dependencies: { express: "^4.21.2", "@licenroute/connect-express": "file:../sdk.tgz" } });
    const { d, p } = analyze(dir);
    expect(d.frameworks[0]).toMatchObject({ name: "express", major: 4, entry_files: ["app.js"] });
    const pr = prepareApply({ dir, planKeys: [p.proposed_plans[0]!.key], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: null });
    expect(pr.ok, pr.refusals.join()).toBe(true);
    const app = pr.changes.find((c) => c.path === "app.js")!;
    expect(app.after).toMatch(/require\("@licenroute\/connect-express"\)/);
    expect(app.after).not.toMatch(/^\s*import\s/m);
    writeFileSync(join(dir, "app.check.js"), app.after);
    expect(spawnSync(process.execPath, ["--check", join(dir, "app.check.js")]).status).toBe(0);
  });

  test("app creada por una función fábrica: rechazo seguro, sin cambios y con orientación", () => {
    const dir = project({ "src/app.js": 'import express from "express";\nexport function crearApp() {\n  const app = express();\n  app.get("/api/datos", (_q, r) => r.json({}));\n  return app;\n}\n', "src/index.js": 'import { crearApp } from "./app.js";\ncrearApp().listen(3000);\n' });
    const { p } = analyze(dir);
    const tgz = join(work, "sdk3.tgz"); writeFileSync(tgz, "x");
    const pr = prepareApply({ dir, planKeys: [p.proposed_plans[0]!.key], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: tgz });
    expect(pr.ok).toBe(false);
    expect(pr.changes).toEqual([]);
    expect(pr.refusals.join(" ")).toMatch(/dentro de una función.*integra a mano/);
  });

  test("package.json con dependencies en una línea: solo se añade la dependencia y undo lo deja exacto", () => {
    const dir = project({ "server.js": `${head}app.get("/api/informes", (_q, r) => r.json([]));${tail}` });
    const original = '{\n  "name": "a-mano",\n  "type": "module",\n  "scripts": { "start": "node server.js" },\n  "dependencies": { "express": "^5.1.0" },\n  "license": "MIT"\n}\n';
    writeFileSync(join(dir, "package.json"), original);
    const { p } = analyze(dir);
    const tgz = join(work, "sdk4.tgz"); writeFileSync(tgz, "x");
    const pr = prepareApply({ dir, planKeys: ["api-informes"], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: tgz });
    expect(pr.ok, pr.refusals.join()).toBe(true);
    const c = pr.changes.find((x) => x.path === "package.json")!;
    const after = JSON.parse(c.after) as { dependencies: Record<string, string>; scripts: unknown; license: string };
    expect(Object.keys(after.dependencies)).toEqual(["express", "@licenroute/connect-express"]);
    expect([after.scripts, after.license]).toEqual([{ start: "node server.js" }, "MIT"]);
    expect(c.after.split("\n").filter((l, i) => l !== original.split("\n")[i])).toEqual(['  "dependencies": { "express": "^5.1.0", "@licenroute/connect-express": "file:../sdk4.tgz" },']);
    expect(revertEdits(c.after, c.edits)).toBe(original);
    // Formas que no se tocan: llaves anidadas o dos «dependencies».
    writeFileSync(join(dir, "package.json"), '{ "name": "x", "dependencies": { "express": "^5.1.0" }, "devDependencies": {} }\n');
    const { p: p2 } = analyze(dir);
    const nested = prepareApply({ dir, planKeys: ["api-informes"], planSha: p2.approval.plan_sha256, app: "x", instance: "default", sdk: tgz });
    expect(nested.ok).toBe(false);
  });

  test("/estado y equivalentes cortos: para decisión, no excluidos ni propuestos; /api/pedidos/:id/estado sigue siendo del plan", () => {
    const dir = project({ "server.js": `${head}app.get("/estado", (_q, r) => r.json({}));\napp.get("/api/status", (_q, r) => r.json({}));\napp.get("/v1/ping", (_q, r) => r.json({}));\napp.get("/api/pedidos/:id/estado", (_q, r) => r.json({}));\napp.get("/api/pedidos", (_q, r) => r.json([]));${tail}` });
    const { p } = analyze(dir);
    expect(p.proposed_plans.map((x) => x.route_pattern)).toEqual(["/api/pedidos/**"]);
    const decided = p.needs_decision.map((x) => x.path);
    for (const r of ["/estado", "/api/status", "/v1/ping"]) expect(decided, r).toContain(r);
    expect(p.excluded.map((x) => x.path)).not.toContain("/estado");
  });

  test("SDK ya declarado y middleware ya puesto: el plan no vuelve a proponerlo y apply no duplica nada", () => {
    const dir = project({ "server.js": 'import express from "express";\nimport { licenroute } from "@licenroute/connect-express";\nconst app = express();\nconst licenRouteProtection = licenroute({ licensedPaths: ["/api/informes/**"] });\napp.use(licenRouteProtection);\napp.get("/api/informes", (_q, r) => r.json([]));\napp.listen(3000);\n' }, { dependencies: { express: "^5.1.0", "@licenroute/connect-express": "file:../sdk.tgz" } });
    const { p } = analyze(dir);
    expect(p.integration.already_integrated).toBe(true);
    expect(p.proposed_plans.every((x) => x.already_licensed)).toBe(true);
    const pr = prepareApply({ dir, planKeys: ["api-informes"], planSha: p.approval.plan_sha256, app: "x", instance: "default", sdk: null });
    expect([pr.ok, pr.changes.length]).toEqual([false, 0]);
    expect(pr.refusals.join()).toMatch(/ya están integrados/);
  });

  test("CLI en una carpeta hermana con el mismo prefijo: se para con un mensaje claro y sin ampliar permisos", () => {
    // El lanzador del repositorio concede la CLI (…/packages/cli). Un proyecto en …/packages/cl comparte su prefijo.
    const cliRoot = realpathSync(new URL("..", import.meta.url).pathname);
    const sibling = cliRoot.slice(0, -1); // …/packages/cl
    if (existsSync(sibling)) return; // no se toca nada que no sea nuestro
    mkdirSync(sibling);
    try {
      writeFileSync(join(sibling, "server.js"), `${head}${tail}`);
      const r = spawnSync(process.execPath, [join(cliRoot, "bin/licenroute.mjs"), "detect", sibling, "--json"], { encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/start with the same name[\s\S]*Nothing was run/); // --json: inglés (D4.4)
      expect(r.stderr).not.toMatch(/ERR_ACCESS_DENIED/);
      expect(readFileSync(join(sibling, "server.js"), "utf8")).toBe(`${head}${tail}`);
    } finally { rmSync(sibling, { recursive: true, force: true }); }
  });
});
