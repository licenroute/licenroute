// D4.4.1: ninguna decisión de seguridad o de negocio depende de un texto traducido. El idioma solo cambia la
// presentación. Se prueba en inglés y en español: rutas comodín (el fallo encontrado en D4.4), independencia de los
// textos (se reescriben todas las notas y motivos y las decisiones no cambian), apply y su código de aprobación, y el
// bypass de 0.2.3 (fase de escritura invocada directamente).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { CATALOGS, getLang, setLang, tc } from "../bin/i18n.mjs";
import { prepareApply, selectPlans } from "../src/apply.ts";
import { detect } from "../src/detect.ts";
import { plan } from "../src/plan.ts";
import type { DetectResult, Plan } from "../src/schema.ts";
import { isWildcardRoute, sha256 } from "../src/util.ts";

const LANGS = ["en", "es"] as const;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const CLI = new URL("../bin/licenroute.mjs", import.meta.url).pathname;
const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "licenroute-d441-"));
const TGZ = join(work, "licenroute-connect-express-0.7.1.tgz"); writeFileSync(TGZ, "paquete de prueba");
const savedLang = getLang();
/** Huella de un árbol (rutas y contenidos). */
const tree = (d: string): string => readdirSync(d).sort().map((n) => { const p = join(d, n); return statSync(p).isDirectory() ? `${n}/[${tree(p)}]` : `${n}:${sha256(readFileSync(p, "utf8"))}`; }).join(",");
afterEach(() => setLang(savedLang));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(work, "app-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "w", type: "module", dependencies: { express: "^5.1.0" } }));
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), body); }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
const server = (routes: string) => `import express from "express";\nconst app = express();\n${routes}\napp.get("/api/datos", (req, res) => res.json([]));\napp.listen(3000);\n`;
/** Lo que el plan DECIDE (sin textos): qué se propone, con qué métodos y rutas; qué queda a decisión, excluido o sin resolver. */
// (plan_sha256 aparte: cubre también los textos canónicos, que no dependen del idioma; ver la prueba de en/es.)
const decisions = (p: Plan, withHash = true) => JSON.stringify({
  proposed: p.proposed_plans.map((x) => [x.key, x.route_pattern, x.methods, x.routes, x.already_licensed, x.requires_confirmation]),
  needs: p.needs_decision.map((x) => x.route_id).sort(), excluded: p.excluded.map((x) => x.route_id).sort(),
  unresolved: p.unresolved.map((u) => `${u.file}:${u.line}:${u.kind}`).sort(), approval: withHash ? p.approval.plan_sha256 : null,
});
/** Reescribe TODO el texto humano del análisis (notas y motivos) con otra cosa: las decisiones no pueden cambiar. */
function scramble(d: DetectResult, mark: string): DetectResult {
  const c = structuredClone(d);
  for (const r of c.routes) r.notes = r.notes.map(() => mark);
  for (const u of c.unresolved) u.reason = mark;
  return c;
}

describe("rutas comodín: decididas por la ruta, nunca por una nota (fallo de D4.4)", () => {
  const SHAPES = [
    ['app.get("/api/archivo/*ruta", (req, res) => res.json({}));', "/api/archivo/*ruta"],
    ['app.get("/api/todo/*", (req, res) => res.json({}));', "/api/todo/*"],
    ['app.get("/api/regex/(.*)", (req, res) => res.json({}));', "/api/regex/(.*)"],
    ['const r = express.Router();\nr.get("/*resto", (req, res) => res.json({}));\napp.use("/api/montado", r);', "/api/montado/*resto"],
  ] as const;
  for (const [code, path] of SHAPES) {
    test(`${path}: a decisión y nunca dentro de un plan, igual en en y en es`, () => {
      const dir = app({ "server.js": server(code) });
      const plans = LANGS.map((l) => { setLang(l); return plan(detect(dir)); });
      expect(decisions(plans[0]!)).toBe(decisions(plans[1]!));
      expect(JSON.stringify(plans[0])).toBe(JSON.stringify(plans[1])); // y el JSON entero (textos canónicos)
      const p = plans[0]!;
      const route = detect(dir).routes.find((r) => r.path === path);
      expect(route, path).toBeDefined();
      expect(isWildcardRoute(route!)).toBe(true);
      expect(p.proposed_plans.some((x) => x.routes.includes(route!.id))).toBe(false);
      expect(p.needs_decision.some((x) => x.route_id === route!.id)).toBe(true);
      expect(p.proposed_plans.map((x) => x.route_pattern)).toContain("/api/datos/**");
      for (const mark of ["", "x"]) expect(decisions(plan(scramble(detect(dir), mark)), false)).toBe(decisions(p, false)); // sin la nota, igual
    });
  }

  test("la nota informativa y el predicado coinciden en todas las rutas de todos los ejemplos", () => {
    let wild = 0;
    for (const name of readdirSync(FIXTURES)) {
      let d: DetectResult; try { d = detect(join(FIXTURES, name)); } catch { continue; }
      for (const r of d.routes) {
        const note = r.notes.includes(tc("express.wildcard")); // la nota canónica que añade el análisis (solo informativa)
        if (isWildcardRoute(r)) wild++;
        expect(isWildcardRoute(r), `${name}: ${r.method} ${r.path}`).toBe(note);
      }
    }
    expect(wild).toBeGreaterThan(0);
  });

  test("apply se niega igual en los dos idiomas a un plan que incluya una ruta comodín", () => {
    const dir = app({ "server.js": server('app.get("/api/archivo/*ruta", (req, res) => res.json({}));') });
    for (const l of LANGS) {
      setLang(l);
      const p = plan(detect(dir));
      const r = prepareApply({ dir, planKeys: ["api-archivo"], planSha: p.approval.plan_sha256, app: "mi-app", instance: "default", sdk: TGZ });
      expect(r.ok).toBe(false);
      expect(r.changes).toEqual([]);
      expect(r.approvalCode).toBeNull();
    }
  });
});

describe("independencia de los textos: reescribir notas y motivos no cambia ninguna decisión", () => {
  for (const name of ["express4-js", "express5-ts", "partial-express", "integrated-express", "auth-only-express", "hostile-express", "rails7-api", "rails8", "demo-rails"]) {
    test(name, () => {
      for (const l of LANGS) {
        setLang(l);
        const d = detect(join(FIXTURES, name));
        const base = decisions(plan(d), false);
        for (const mark of ["", "comodín: x", "wildcard: x", "requireAuth", "PARTIAL INTEGRATION", "INTEGRACIÓN PARCIAL"]) {
          expect(decisions(plan(scramble(d, mark)), false), `${l} «${mark}»`).toBe(base);
        }
      }
    });
  }
});

describe("apply: mismas decisiones, mismo diff y mismo código de aprobación en en y en es", () => {
  for (const [name, keys] of [["express4-js", ["api-reports"]], ["express5-ts", ["v1-catalog"]], ["partial-express", null]] as const) {
    test(name, () => {
      const dir = join(work, `${name}-apply`); cpSync(join(FIXTURES, name), dir, { recursive: true });
      const res = LANGS.map((l) => {
        setLang(l);
        const p = plan(detect(dir));
        const r = prepareApply({ dir, planKeys: keys ? [...keys] : p.proposed_plans.map((x) => x.key), planSha: p.approval.plan_sha256, app: "mi-app", instance: "default", sdk: TGZ });
        return { ok: r.ok, code: r.approvalCode, changes: JSON.stringify(r.changes), selected: JSON.stringify(r.selected), uncovered: r.uncovered, refusals: r.refusals.length, warnings: r.warnings.length };
      });
      expect(res[1]).toEqual(res[0]);
    });
  }
});

describe("bypass de 0.2.3 en los dos idiomas: la fase de escritura invocada directamente no escribe sin el reto", () => {
  const cli = (args: string[], env: Record<string, string | undefined>) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, LICENROUTE_APPROVAL: undefined, LICENROUTE_INSECURE_TEST: undefined, ...env } });
  for (const lang of LANGS) {
    test(lang, async () => {
      const dir = join(work, `bypass-${lang}`); cpSync(join(FIXTURES, "express4-js"), dir, { recursive: true });
      const env = { LICENROUTE_LANG: lang }; const before = tree(dir);
      const sha = (JSON.parse(cli(["plan", dir, "--json"], env).stdout) as Plan).approval.plan_sha256;
      const args = ["apply", dir, "--plans", "api-reports", "--plan-sha", sha, "--app", "mi-app", "--sdk", TGZ];
      const code = (JSON.parse(cli([...args, "--json"], env).stdout) as { approval_code: string }).approval_code;
      const otherCode = (JSON.parse(cli([...args, "--json"], { LICENROUTE_LANG: lang === "en" ? "es" : "en" }).stdout) as { approval_code: string }).approval_code;
      expect(otherCode).toBe(code); // el código no depende del idioma
      const direct = (extra: string[], more: Record<string, string> = {}) => new Promise<number | null>((done) => {
        const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN, ...args, "--approve", code, "--phase", "write", ...extra],
          { detached: true, stdio: "ignore", env: { ...process.env, LICENROUTE_APPROVAL: undefined, LICENROUTE_INSECURE_TEST: undefined, ...env, ...more } });
        p.on("close", done);
      });
      expect(await direct(["--consent", "tty-challenge"])).toBe(2);
      expect(await direct(["--lang", lang === "en" ? "es" : "en", "--consent", "tty-challenge"])).toBe(2);
      expect(await direct([])).toBe(5);
      expect(await direct([], { LICENROUTE_APPROVAL: "host-gated" })).toBe(5);
      expect(await direct([], { LICENROUTE_APPROVAL: "insecure-test" })).toBe(5); // sin la segunda señal
      expect(cli([...args, "--approve", code], env).status).toBe(5); // por el lanzador, sin terminal
      expect(existsSync(join(dir, ".licenroute"))).toBe(false);
      expect(tree(dir)).toBe(before); // nada escrito
    });
  }
});

describe("segunda barrera de apply (D4.4.2): un plan manipulado, sin pasar por plan, nunca aplica rutas peligrosas", () => {
  const SERVER = server('app.get("/api/archivo/*ruta", (req, res) => res.json({}));\nif (process.env.X) app.get("/api/cond", (req, res) => res.json({}));');
  /** El plan real y el análisis, con las notas borradas o reescritas: la barrera no puede depender de ellas. */
  const fixture = (lang: string, mark: string | null) => {
    setLang(lang);
    const dir = app({ "server.js": SERVER });
    const detected = detect(dir);
    const p = plan(detected);
    return { dir, detected: mark === null ? detected : scramble(detected, mark), p };
  };
  const idOf = (d: DetectResult, path: string) => d.routes.find((r) => r.path === path)!.id;

  for (const lang of LANGS) for (const mark of [null, "", "x", "comodín: x", "wildcard: x"]) {
    test(`${lang}, notas ${mark === null ? "originales" : `«${mark}»`}`, () => {
      const { detected, p } = fixture(lang, mark);
      const datos = p.proposed_plans.find((x) => x.route_pattern === "/api/datos/**")!;
      expect(datos).toBeDefined();
      // Control: el plan sin tocar se selecciona.
      expect(selectPlans(p, detected, [datos.key]).selected.map((s) => s.key)).toEqual([datos.key]);
      const wild = idOf(detected, "/api/archivo/*ruta");
      expect(isWildcardRoute(detected.routes.find((r) => r.id === wild)!)).toBe(true);
      const manipulated = (edit: (q: Plan) => void) => { const q = structuredClone(p); edit(q); return q; };
      const cases: [string, Plan, string][] = [
        ["comodín añadido a un plan válido", manipulated((q) => q.proposed_plans.find((x) => x.key === datos.key)!.routes.push(wild)), datos.key],
        ["plan inventado solo con la ruta comodín", manipulated((q) => q.proposed_plans.push({ ...structuredClone(datos), key: "api-archivo", route_pattern: "/api/archivo/**", routes: [wild] })), "api-archivo"],
        ["ruta condicional añadida", manipulated((q) => q.proposed_plans.find((x) => x.key === datos.key)!.routes.push(idOf(detected, "/api/cond"))), datos.key],
        ["id de ruta inexistente", manipulated((q) => q.proposed_plans.find((x) => x.key === datos.key)!.routes.push("r_000000000000")), datos.key],
        ["patrón inseguro", manipulated((q) => { q.proposed_plans.find((x) => x.key === datos.key)!.route_pattern = "/api/datos?x/**"; }), datos.key],
      ];
      for (const [name, q, key] of cases) {
        let r: ReturnType<typeof selectPlans> | undefined;
        expect(() => { r = selectPlans(q, detected, [key]); }, name).not.toThrow();
        expect(r!.selected, name).toEqual([]);
        expect(r!.refusals.length, name).toBe(1);
      }
    });
  }

  test("la misma decisión en los dos idiomas", () => {
    const out = LANGS.map((l) => {
      const { detected, p } = fixture(l, null);
      const q = structuredClone(p); const datos = q.proposed_plans.find((x) => x.route_pattern === "/api/datos/**")!;
      datos.routes.push(idOf(detected, "/api/archivo/*ruta"));
      const r = selectPlans(q, detected, [datos.key]);
      return { selected: r.selected, refusals: r.refusals.length, warnings: r.warnings.length };
    });
    expect(out[1]).toEqual(out[0]);
  });
});

describe("los mensajes no deciden (D4.4.2): con TODOS los textos de los catálogos sustituidos, las decisiones no cambian", () => {
  /** Sustituye cada mensaje (en y es) por basura con los mismos {parámetros}; devuelve la función que lo deshace. */
  const scrambleCatalogs = (mark: string) => {
    const saved = structuredClone(CATALOGS);
    for (const lang of LANGS) for (const k of Object.keys(CATALOGS[lang])) CATALOGS[lang][k] = `${mark}${(CATALOGS[lang][k]!.match(/\{\w+\}/g) ?? []).join(" ")}`;
    return () => { for (const lang of LANGS) Object.assign(CATALOGS[lang], saved[lang]); };
  };
  const apply = (dir: string, p: Plan, keys: string[]) => {
    const r = prepareApply({ dir, planKeys: keys, planSha: p.approval.plan_sha256, app: "mi-app", instance: "default", sdk: TGZ });
    // La huella del plan escrita en el comentario cubre los textos canónicos (fijos en inglés): se normaliza, no decide.
    const edits = JSON.stringify(r.changes.map((c) => [c.path, c.action, c.edits])).replace(/plan [0-9a-f]{12}\b/g, "plan <hash>");
    return JSON.stringify({ ok: r.ok, selected: r.selected, edits, uncovered: r.uncovered, refusals: r.refusals.length, warnings: r.warnings.length });
  };
  const snapshot = (lang: string) => {
    setLang(lang);
    const out: string[] = [];
    for (const name of ["express4-js", "express5-ts", "partial-express", "integrated-express", "auth-only-express", "hostile-express", "rails8"]) {
      const dir = join(FIXTURES, name); const p = plan(detect(dir));
      out.push(`${name}:${decisions(p, false)}`);
      if (p.target === "express") out.push(`${name}:apply:${apply(dir, p, p.proposed_plans.map((x) => x.key))}`);
    }
    // Rutas comodín y rutas que no pueden ser un patrón (ñ, %, ;): llegan a las comprobaciones de plan.
    const wild = app({ "server.js": server('app.get("/api/archivo/*ruta", (req, res) => res.json({}));\napp.get("/api/año", (req, res) => res.json({}));\napp.get("/api/x%20y", (req, res) => res.json({}));\napp.get("/api/a;b", (req, res) => res.json({}));') });
    const wd = detect(wild); const wp = plan(wd);
    out.push(`wild:${decisions(wp, false)}`, `wild:apply:${apply(wild, wp, ["api-archivo"])}`);
    // Segunda barrera de apply con un plan manipulado (patrón inseguro y ruta comodín añadida).
    const datos = wp.proposed_plans.find((x) => x.route_pattern === "/api/datos/**")!;
    for (const edit of [(q: Plan) => { q.proposed_plans.find((x) => x.key === datos.key)!.route_pattern = "/api/datos?x/**"; },
      (q: Plan) => { q.proposed_plans.find((x) => x.key === datos.key)!.routes.push(wd.routes.find((r) => r.path === "/api/archivo/*ruta")!.id); }]) {
      const q = structuredClone(wp); edit(q); const r = selectPlans(q, wd, [datos.key]);
      out.push(`manipulated:${JSON.stringify(r.selected)}:${r.refusals.length}`);
    }
    return out;
  };
  for (const lang of LANGS) {
    test(lang, () => {
      const base = snapshot(lang);
      for (const mark of ["", "§", "comodín", "wildcard", "PARTIAL INTEGRATION", "aprobado"]) {
        const restore = scrambleCatalogs(mark);
        try { expect(snapshot(lang), `«${mark}»`).toEqual(base); } finally { restore(); }
      }
      expect(snapshot(lang)).toEqual(base);
    });
  }
});

// 0.2.8: la Skill decide si una integración es parcial con `summary.unresolved` de `plan --json` (un dato del contrato),
// nunca buscando una frase. La regla coincide con lo que apply deja sin cubrir, en los dos idiomas; y las rutas estáticas
// se excluyen por su categoría, con un motivo que cambia con el idioma sin cambiar la decisión.
describe("0.2.8: integración parcial decidida por datos y rutas excluidas, en los dos idiomas", () => {
  const partialApp = () => app({ "server.js": server('const base = "/api/" + process.env.X;\napp.get(base + "/x", (req, res) => res.json({}));\napp.use("/assets", express.static("public"));\napp.get("/health", (req, res) => res.send("ok"));') });
  for (const lang of LANGS) {
    test(`${lang}: summary.unresolved > 0 ⇔ apply deja rutas sin cubrir`, () => {
      setLang(lang);
      const seen = { partial: 0, complete: 0 };
      const dirs = [...readdirSync(FIXTURES).map((n) => { const d = join(work, `partial-${lang}-${n}`); cpSync(join(FIXTURES, n), d, { recursive: true }); return d; }), partialApp()];
      for (const dir of dirs) {
        let p: Plan; try { p = plan(detect(dir)); } catch { continue; }
        if (p.target !== "express" || !p.proposed_plans.length) continue;
        const r = prepareApply({ dir, planKeys: p.proposed_plans.map((x) => x.key), planSha: p.approval.plan_sha256, app: "mi-app", instance: "default", sdk: TGZ });
        if (!r.ok) continue; // un rechazo no escribe nada: no hay integración, ni completa ni parcial
        expect(p.summary.unresolved > 0, dir).toBe(r.uncovered > 0);
        seen[p.summary.unresolved > 0 ? "partial" : "complete"]++;
      }
      expect(seen.partial).toBeGreaterThan(0); expect(seen.complete).toBeGreaterThan(0);
    });
  }
  test("las rutas estáticas y de salud se excluyen igual en los dos idiomas; el motivo de las estáticas no dice que no se puedan vender", () => {
    const dir = partialApp();
    const [en, es] = LANGS.map((l) => { setLang(l); return plan(detect(dir)); }) as [Plan, Plan];
    expect(decisions(es)).toEqual(decisions(en));
    const staticRef = en.excluded.find((e) => e.reason === tc("plan.exclude.static"));
    expect(staticRef, JSON.stringify(en.excluded)).toBeDefined();
    expect(CATALOGS.en["plan.exclude.static"]).toMatch(/excludes them automatically[\s\S]*does not mean they can never be sold/);
    expect(CATALOGS.es["plan.exclude.static"]).toMatch(/los excluye automáticamente[\s\S]*no significa que nunca puedan comercializarse/);
    for (const l of LANGS) for (const k of ["plan.exclude.static", "init.challenge_hint", "consent.confirmed", "test.auth_own", "undo.env_warning"]) expect(CATALOGS[l][k]).not.toMatch(/no assistant can|el asistente pueden|not licensable content|no son contenido licenciable|^Confirm(ed|ado)\.\n$/);
  });
});
