// D4.4: idiomas de la CLI. Paridad de catálogos (mismas claves y mismos {parámetros}), claves usadas en el código que
// existen, prioridad --lang > LICENROUTE_LANG > locale del sistema > inglés, y resultado estructurado idéntico en en y es.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CATALOGS, DEFAULT_LANG, LANGS, langOfLocale, localize, placeholders, resolveLang, t, tc } from "../bin/i18n.mjs";
import { messageLang } from "../../../sdks/node-express/src/messages.ts";
import { prepareAssistant } from "../src/assistant.ts";
import { detect } from "../src/detect.ts";
import { plan } from "../src/plan.ts";
import { getLang, setLang } from "../bin/i18n.mjs";

const PKG = new URL("..", import.meta.url).pathname;
const CLI = join(PKG, "bin/licenroute.mjs");
const FIXTURE = join(PKG, "test/fixtures/express4-js");
const SOURCES = ["src", "bin", "scripts", "../simulator/src"].map((d) => join(PKG, d));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "i18n" || n === "node_modules" ? [] : files(p);
    return /\.(ts|mjs)$/.test(n) && !n.endsWith(".d.mts") ? [p] : [];
  });
}

/** Claves pasadas a t()/tc() en el código (literales, también en ternarios dentro de la llamada). */
function usedKeys(): Map<string, string> {
  const namespaces = new Set(Object.keys(CATALOGS.en).map((k) => k.split(".")[0]));
  const used = new Map<string, string>();
  for (const f of SOURCES.flatMap(files)) {
    const src = readFileSync(f, "utf8");
    for (const call of src.matchAll(/(?<![\w.])tc?\(/g)) {
      const head = src.slice(call.index, call.index + 240).split(/\{|\)\s*[;,:\]})]/)[0] ?? "";
      for (const m of head.matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"/g)) if (namespaces.has(m[1]!.split(".")[0]!)) used.set(m[1]!, f);
    }
  }
  return used;
}

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const base = { ...process.env };
  for (const k of ["LICENROUTE_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) delete base[k];
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...base, ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("catálogos", () => {
  test("en y es tienen exactamente las mismas claves", () => {
    expect(Object.keys(CATALOGS.es).sort()).toEqual(Object.keys(CATALOGS.en).sort());
    expect(LANGS).toEqual(["en", "es"]);
    expect(DEFAULT_LANG).toBe("en");
  });

  test("cada mensaje tiene los mismos {parámetros} en los dos idiomas y ninguno está vacío", () => {
    const bad = Object.keys(CATALOGS.en).filter((k) => placeholders(CATALOGS.en[k]!).join() !== placeholders(CATALOGS.es[k] ?? "").join());
    expect(bad).toEqual([]);
    for (const lang of LANGS) expect(Object.entries(CATALOGS[lang]).filter(([, v]) => typeof v !== "string" || v.length === 0)).toEqual([]);
  });

  test("toda clave usada en el código existe y no sobra ninguna", () => {
    const used = usedKeys();
    expect([...used].filter(([k]) => !(k in CATALOGS.en)).map(([k, f]) => `${k} (${f})`)).toEqual([]);
    expect(Object.keys(CATALOGS.en).filter((k) => !used.has(k))).toEqual([]);
  });

  test("una clave inexistente es un error, nunca un texto vacío", () => {
    expect(() => t("no.such_key")).toThrow(/missing key no\.such_key/);
  });

  test("tc() genera siempre inglés canónico y localize() lo traduce solo al mostrarlo", () => {
    const s = tc("common.none_m");
    expect(s).toBe(CATALOGS.en["common.none_m"]);
    expect(localize(`x ${s} y`, "es")).toBe(`x ${CATALOGS.es["common.none_m"]} y`);
    expect(localize(`x ${s} y`, "en")).toBe(`x ${s} y`);
  });
});

describe("prioridad del idioma", () => {
  test("--lang gana a todo; un valor no soportado es un error", () => {
    expect(resolveLang("es", { LICENROUTE_LANG: "en", LANG: "en_US.UTF-8" })).toEqual({ lang: "es", source: "--lang" });
    expect(resolveLang("en", { LICENROUTE_LANG: "es", LC_ALL: "es_ES.UTF-8" })).toEqual({ lang: "en", source: "--lang" });
    expect(resolveLang("fr", {})).toHaveProperty("error");
    expect(resolveLang("", {})).toHaveProperty("error");
  });

  test("LICENROUTE_LANG gana al locale; un valor no soportado se ignora", () => {
    expect(resolveLang(undefined, { LICENROUTE_LANG: "es", LANG: "en_US.UTF-8" })).toEqual({ lang: "es", source: "LICENROUTE_LANG" });
    expect(resolveLang(undefined, { LICENROUTE_LANG: "fr", LANG: "es_ES.UTF-8" })).toEqual({ lang: "es", source: "LANG" });
  });

  test("locale POSIX: LC_ALL, después LC_MESSAGES, después LANG; la primera no vacía decide", () => {
    expect(resolveLang(undefined, { LC_ALL: "es_MX.UTF-8", LC_MESSAGES: "en_US", LANG: "en_US" }).lang).toBe("es");
    expect(resolveLang(undefined, { LC_ALL: "", LC_MESSAGES: "es_ES", LANG: "en_US" })).toEqual({ lang: "es", source: "LC_MESSAGES" });
    expect(resolveLang(undefined, { LC_ALL: "fr_FR.UTF-8", LANG: "es_ES.UTF-8" })).toEqual({ lang: "en", source: "LC_ALL" });
    expect(resolveLang(undefined, { LANG: "C.UTF-8" }).lang).toBe("en");
    expect(resolveLang(undefined, {})).toEqual({ lang: "en", source: "default" });
  });

  test("el SDK resuelve el idioma igual que la CLI (sin --lang)", () => {
    const envs = [{}, { LICENROUTE_LANG: "es" }, { LICENROUTE_LANG: "en", LANG: "es_ES" }, { LICENROUTE_LANG: "fr", LC_ALL: "es_AR.UTF-8" },
      { LC_ALL: "", LC_MESSAGES: "es", LANG: "en_US" }, { LANG: "C" }, { LANG: "pt_BR.UTF-8" }, { LC_MESSAGES: "en_GB", LANG: "es_ES" }];
    for (const env of envs) expect(messageLang(env), JSON.stringify(env)).toBe(resolveLang(undefined, env).lang);
  });

  test("langOfLocale reconoce solo en y es", () => {
    expect(["es", "es_ES", "es-AR", "ES_es.utf8", "es@euro"].map(langOfLocale)).toEqual(["es", "es", "es", "es", "es"]);
    expect(["en_GB.UTF-8", "en"].map(langOfLocale)).toEqual(["en", "en"]);
    expect(["C", "POSIX", "pt_BR", "esperanto", "", undefined].map(langOfLocale)).toEqual([null, null, null, null, null, null]);
  });
});

describe("la CLI en los dos idiomas", () => {
  test("la ayuda sale en el idioma elegido", () => {
    const en = cli(["--help"], { LANG: "es_ES.UTF-8", LICENROUTE_LANG: "en" });
    const es = cli(["--help", "--lang", "es"]);
    expect(es.status).toBe(en.status);
    expect(en.stdout).toMatch(/^Usage: licenroute/);
    expect(es.stdout).toMatch(/^Uso: licenroute/);
  });

  test("--lang con un valor no soportado sale con 2 y no hace nada", () => {
    const r = cli(["detect", FIXTURE, "--lang", "fr"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--lang/);
    expect(r.stdout).toBe("");
  });

  test("detect y plan --json son idénticos byte a byte en en y es (incluido plan_sha256)", () => {
    for (const cmd of ["detect", "plan"]) {
      const en = cli([cmd, FIXTURE, "--json"], { LICENROUTE_LANG: "en" });
      const es = cli([cmd, FIXTURE, "--json", "--lang", "es"], { LANG: "es_ES.UTF-8" });
      expect(en.status).toBe(0);
      expect(es.stdout).toBe(en.stdout);
    }
  });

  test("el texto humano cambia de idioma pero no los datos (claves y patrones de los planes)", () => {
    const json = JSON.parse(cli(["plan", FIXTURE, "--json"]).stdout);
    const en = cli(["plan", FIXTURE], { LICENROUTE_LANG: "en" });
    const es = cli(["plan", FIXTURE], { LICENROUTE_LANG: "es" });
    expect(en.status).toBe(0); expect(es.status).toBe(0);
    expect(en.stdout).not.toBe(es.stdout);
    for (const out of [en.stdout, es.stdout]) {
      expect(json.proposed_plans.length).toBeGreaterThan(0);
      for (const c of json.proposed_plans) expect(out).toContain(`${c.key}  →  ${c.route_pattern}`);
    }
  });
});

describe("licenroute assistant en los dos idiomas", () => {
  test("instala la Skill del idioma elegido; cambiar de idioma cambia el código asst_… (la aprobación no se reutiliza)", () => {
    const root = mkdtempSync(join(tmpdir(), "bg-i18n-asst-"));
    try {
      const tpl = join(root, "templates"); const project = join(root, "app"); mkdirSync(project);
      for (const lang of ["en", "es"]) {
        mkdirSync(join(tpl, lang, "cursor/.cursor/rules"), { recursive: true });
        writeFileSync(join(tpl, lang, "cursor/.cursor/rules/licenroute.mdc"), `rules ${lang}\n`);
      }
      const en = prepareAssistant(project, "cursor", tpl, "en"); const es = prepareAssistant(project, "cursor", tpl, "es");
      expect(en.ok && es.ok).toBe(true);
      expect(en.files.map((f) => f.content)).toEqual(["rules en\n"]);
      expect(es.files.map((f) => f.content)).toEqual(["rules es\n"]);
      expect(en.files.map((f) => f.path)).toEqual(es.files.map((f) => f.path));
      expect(en.approvalCode).toMatch(/^asst_/);
      expect(es.approvalCode).not.toBe(en.approvalCode);
      expect(prepareAssistant(project, "cursor", tpl, "fr").files[0]?.content).toBe("rules en\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("el idioma no cambia ninguna decisión del análisis", () => {
  // D4.4 (regresión encontrada en la revisión): las notas del análisis son inglés canónico; una comprobación que buscaba
  // la nota en español («comodín») dejaba de mandar las rutas comodín a revisión humana. Se prueba con los dos idiomas.
  test("una ruta comodín bajo un prefijo va a «requieren tu decisión» y no se propone, en en y en es", () => {
    const dir = mkdtempSync(join(tmpdir(), "bg-i18n-wild-"));
    const saved = getLang();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "w", type: "module", dependencies: { express: "^5.1.0" } }));
      writeFileSync(join(dir, "server.js"), 'import express from "express";\nconst app = express();\napp.get("/api/archivo/*ruta", (req, res) => res.json({}));\napp.get("/api/datos", (req, res) => res.json([]));\napp.listen(3000);\n');
      const results = ["en", "es"].map((lang) => { setLang(lang); return plan(detect(dir)); });
      expect(JSON.stringify(results[0])).toBe(JSON.stringify(results[1]));
      const p = results[0]!;
      expect(p.needs_decision.find((n) => n.path === "/api/archivo/*ruta")?.reason).toBe(CATALOGS.en["plan.review.wildcard"]);
      expect(p.proposed_plans.some((x) => x.route_pattern.startsWith("/api/archivo"))).toBe(false);
      expect(p.proposed_plans.map((x) => x.route_pattern)).toContain("/api/datos/**");
    } finally { setLang(saved); rmSync(dir, { recursive: true, force: true }); }
  });
});
