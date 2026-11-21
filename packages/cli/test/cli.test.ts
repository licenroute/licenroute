// Pruebas de S5: `licenroute detect` y `licenroute plan` sobre proyectos de prueba copiados a un directorio temporal con su
// propio repositorio git. Se ejecuta el lanzador real (con el modelo de permisos de Node) y se comprueba, en cada
// caso, que el árbol queda idéntico: mismos ficheros, mismo contenido, mismas fechas y `git status` sin cambios.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Value } from "typebox/value";
import { afterAll, describe, expect, test } from "vitest";
import { detect } from "../src/detect.ts";
import { DetectResult, Plan } from "../src/schema.ts";
// D4.4: los textos que forman parte de los datos (motivos, notas, avisos del plan) son siempre inglés canónico.

const CLI = new URL("../bin/licenroute.mjs", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "licenroute-cli-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function project(name: string, setup?: (dir: string) => void): string {
  const dir = join(work, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  setup?.(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q"); git("add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fixture", "--no-gpg-sign");
  return dir;
}

/** Huella completa del árbol de trabajo (sin .git): ruta, tipo, contenido o destino, permisos y fecha. */
function manifest(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ".git") continue;
      const abs = join(d, name); const st = lstatSync(abs); const rel = relative(dir, abs);
      if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(abs)} ${st.mtimeMs}`);
      else if (st.isDirectory()) { out.push(`${rel}/ ${st.mode}`); walk(abs); }
      else out.push(`${rel} ${createHash("sha256").update(readFileSync(abs)).digest("hex")} ${st.mode} ${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out.join("\n");
}
const gitStatus = (dir: string) => execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], { cwd: dir, encoding: "utf8" });

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** detect + plan (JSON y texto) sin tocar nada; valida ambos contra el esquema v1. */
function analyze(dir: string, target?: string) {
  const before = manifest(dir); const statusBefore = gitStatus(dir);
  const d = cli(["detect", dir, "--json"]);
  const dText = cli(["detect", dir]);
  const p = cli(["plan", dir, "--json", ...(target ? ["--target", target] : [])]);
  const pText = cli(["plan", dir, ...(target ? ["--target", target] : [])]);
  expect(d.status, d.stderr).toBe(0);
  expect(manifest(dir)).toBe(before);
  expect(gitStatus(dir)).toBe(statusBefore);
  const detected = JSON.parse(d.stdout) as DetectResult;
  expect([...Value.Errors(DetectResult, detected)]).toEqual([]);
  let plan: Plan | null = null;
  if (p.status === 0) { plan = JSON.parse(p.stdout) as Plan; expect([...Value.Errors(Plan, plan)]).toEqual([]); }
  return { detected, plan, planStatus: p.status, text: `${dText.stdout}\n${pText.stdout}`, stderr: `${d.stderr}${p.stderr}` };
}

const paths = (d: DetectResult) => d.routes.map((r) => `${r.method} ${r.path}`);
const patterns = (p: Plan) => p.proposed_plans.map((x) => x.route_pattern);
const decided = (list: Plan["excluded"]) => list.map((x) => `${x.method} ${x.path}`);

describe("Express 4 (JavaScript, CommonJS)", () => {
  const { detected: d, plan: p } = analyze(project("express4-js"));
  test("versión y app", () => {
    expect(d.frameworks).toEqual([expect.objectContaining({ name: "express", version: "4.21.2", major: 4, supported: true, language: "javascript", entry_files: ["app.js"] })]);
  });
  test("routers montados, anidados, registrador y concatenación de constantes", () => {
    expect(paths(d)).toEqual(expect.arrayContaining(["GET /api/reports", "GET /api/reports/:id", "GET /api/v2/stats", "GET /admin/users", "GET /api/catalogo/:sku", "GET /api/items", "POST /api/items", "ALL /assets/**"]));
  });
  test("rutas dinámicas y en bucle: no resueltas, con línea", () => {
    expect(d.unresolved.map((u) => `${u.file}:${u.line}:${u.kind}`)).toEqual(expect.arrayContaining(["routes/api.js:13:dynamic-path", "routes/api.js:14:dynamic-path"]));
    expect(d.routes.find((r) => r.source.line === 14)?.signals.conditional).toBe(true);
    expect(d.completeness.complete).toBe(false);
  });
  test("señal de autenticación por middleware", () => {
    expect(d.routes.find((r) => r.path === "/api/me")?.signals.auth_middleware).toEqual(["requireAuth"]);
  });
  test("plan: candidatas, exclusiones y decisiones", () => {
    expect(patterns(p!)).toEqual(expect.arrayContaining(["/api/reports/**", "/api/catalogo/**", "/api/items/**", "/api/v2/stats/**"]));
    expect(decided(p!.excluded)).toEqual(expect.arrayContaining(["GET /health", "POST /login", "POST /webhooks/stripe", "ALL /assets/**"]));
    expect(decided(p!.needs_decision)).toEqual(expect.arrayContaining(["GET /api/me", "POST /api/items", "GET /admin/users", "GET /"]));
    expect(p!.integration.dependencies.map((x) => x.name)).toEqual(["@licenroute/connect-express"]);
    expect(p!.integration.file_changes.map((c) => c.file)).toEqual(["package.json", "app.js", ".gitignore"]);
    expect(p!.writes_files).toBe(false);
  });
});

describe("Express 5 (TypeScript, ESM)", () => {
  const { detected: d, plan: p } = analyze(project("express5-ts"));
  test("TypeScript, versión 5 y routers importados", () => {
    expect(d.frameworks[0]).toEqual(expect.objectContaining({ major: 5, language: "typescript", entry_files: ["src/app.ts"] }));
    expect(paths(d)).toEqual(expect.arrayContaining(["GET /v1/users", "GET /v1/users/:id", "DELETE /v1/users/:id", "GET /v1/catalog", "GET /v1/catalog/:sku", "GET /v1/precios/:sku", "GET /up"]));
  });
  test("middleware de autenticación montado con prefijo: solo afecta a ese prefijo", () => {
    expect(d.routes.filter((r) => r.path?.startsWith("/v1/users")).every((r) => r.signals.auth_middleware.includes("authenticate"))).toBe(true);
    expect(d.routes.find((r) => r.path === "/v1/catalog")?.signals.auth_middleware).toEqual([]);
  });
  test("plan: autenticadas y comodín a decisión humana; salud excluida", () => {
    expect(patterns(p!)).toEqual(expect.arrayContaining(["/v1/catalog/**", "/v1/precios/**"]));
    expect(patterns(p!).some((x) => x.startsWith("/v1/users"))).toBe(false);
    expect(decided(p!.needs_decision)).toEqual(expect.arrayContaining(["GET /v1/users", "GET /*splat", "DELETE /v1/users/:id"]));
    expect(decided(p!.excluded)).toContain("GET /up");
  });
});

describe("Rails 7 API", () => {
  const { detected: d, plan: p } = analyze(project("rails7-api"));
  test("versión, modo API y recursos anidados", () => {
    expect(d.frameworks[0]).toEqual(expect.objectContaining({ name: "rails", version: "7.2.2", major: 7, supported: true, api_only: true }));
    expect(paths(d)).toEqual(expect.arrayContaining(["GET /api/v1/reports", "GET /api/v1/reports/:id", "GET /api/v1/reports/:id/preview", "GET /api/v1/reports/search", "GET /api/v1/reports/:report_id/comments", "GET /api/v1/account", "ALL /users/**", "GET /up", "ALL /sidekiq/**"]));
    expect(paths(d)).not.toContain("GET /api/v1/reports/new"); // api_only: sin new/edit
  });
  test("plan: reports NO se propone (cubriría comments, autenticadas); Devise, salud y webhooks excluidos; autenticadas a decisión", () => {
    // D4.1 (F-D4-1): hasta 0.2.2 se proponía /api/v1/reports/**, que en Rails (licensed_paths sin métodos) exigía
    // licencia también en GET y POST /api/v1/reports/:report_id/comments, con before_action :authenticate_user!.
    expect(p!.proposed_plans).toEqual([]);
    expect(p!.needs_decision.find((n) => n.method === "GET" && n.path === "/api/v1/reports")?.reason).toMatch(/would also require a licence on GET \/api\/v1\/reports\/:report_id\/comments, POST \/api\/v1\/reports\/:report_id\/comments/);
    expect(decided(p!.excluded)).toEqual(expect.arrayContaining(["ALL /users/**", "GET /up", "POST /webhooks/stripe"]));
    expect(decided(p!.needs_decision)).toEqual(expect.arrayContaining(["GET /api/v1/account", "GET /api/v1/reports/:report_id/comments", "ALL /sidekiq/**"]));
    expect(p!.integration.file_changes.map((c) => `${c.action} ${c.file}`)).toEqual(["modify Gemfile", "create config/initializers/botgate.rb", "create .gitignore"]);
  });
});

describe("Rails 8", () => {
  const { detected: d, plan: p } = analyze(project("rails8"));
  test("draw(:admin), autenticación heredada y excepciones", () => {
    expect(d.frameworks[0]).toEqual(expect.objectContaining({ major: 8, entry_files: ["config/routes.rb", "config/routes/admin.rb"] }));
    expect(paths(d)).toEqual(expect.arrayContaining(["GET /admin/users", "GET /articles/:article_id/revisions", "GET /informes/:year", "GET /session"]));
    expect(d.routes.find((r) => r.path === "/articles" && r.method === "GET")?.signals.auth_middleware).toEqual([]);
    expect(d.routes.find((r) => r.path === "/articles/new")?.signals.auth_middleware.length).toBeGreaterThan(0);
  });
  test("condicional, bucle con interpolación y concern: no resueltos", () => {
    expect(d.unresolved.map((u) => u.kind)).toEqual(expect.arrayContaining(["conditional", "dynamic-path", "concern"]));
    expect(d.routes.find((r) => r.path === "/debug/tools")?.signals.conditional).toBe(true);
  });
  test("plan", () => {
    // D4.1: /articles/** ya no se propone: en Rails cubriría POST, PATCH y PUT /articles y las páginas new/edit
    // (autenticadas), que quedan fuera del plan.
    expect(patterns(p!)).toEqual(["/informes/**"]);
    expect(p!.needs_decision.find((n) => n.method === "GET" && n.path === "/articles")?.reason).toMatch(/would also require a licence on POST \/articles/);
    expect(p!.excluded.some((x) => x.path === "/session")).toBe(true);
    expect(p!.proposed_plans.flatMap((x) => x.routes).some((id) => d.routes.find((r) => r.id === id)?.path?.startsWith("/admin"))).toBe(false);
  });
});

describe("Ficheros malformados y apps parcialmente soportadas", () => {
  test("Express con un fichero roto: se señala y se analiza el resto", () => {
    const { detected: d } = analyze(project("malformed-express"));
    expect(d.skipped.unparseable.map((u) => u.file)).toContain("broken.js");
    expect(paths(d)).toContain("GET /ok");
  });
  test("Rails con bloques sin cerrar: se señala sin abortar", () => {
    const { detected: d } = analyze(project("malformed-rails"));
    expect(d.skipped.unparseable.some((u) => u.file === "config/routes.rb" && /"end" missing/.test(u.error))).toBe(true);
    // Dentro de resources sin member/collection, Rails anida la ruta bajo :product_id.
    expect(paths(d)).toEqual(expect.arrayContaining(["GET /products", "GET /products/:product_id/featured", "GET /products/:product_id/sin-cerrar"]));
  });
  test("montajes dinámicos y router huérfano: parciales y avisados", () => {
    const { detected: d, plan: p } = analyze(project("partial-express"));
    expect(d.unresolved.map((u) => u.kind)).toContain("dynamic-mount");
    // S10.2-D2: sin prefijo conocido, la ruta no tiene valor (antes «/secreto/:id», como si colgara de /).
    expect(d.routes.some((r) => r.path === "/secreto/:id")).toBe(false);
    const orphan = d.routes.find((r) => r.notes.some((n) => n.includes("/secreto/:id")));
    expect(orphan).toMatchObject({ path: null, resolution: "dynamic" });
    expect(orphan?.notes.join(" ")).toMatch(/router not mounted/);
    expect(p!.proposed_plans.some((x) => x.route_pattern.startsWith("/secreto"))).toBe(false);
    expect(p!.warnings.join(" ")).toMatch(/need human review/);
  });
  test("sin framework: detect lo dice y apunta a subproyectos; plan sale con 3", () => {
    const { detected: d, planStatus } = analyze(project("no-framework"));
    expect(d.frameworks).toEqual([]);
    expect(d.notes.join(" ")).toContain("servicios/api/package.json");
    expect(planStatus).toBe(3);
  });
});

describe("Integración LicenRoute existente", () => {
  test("Express: licensedPaths leídos, orden de registro y plan que solo amplía", () => {
    const { detected: d, plan: p } = analyze(project("integrated-express"));
    expect(d.licenroute).toEqual(expect.objectContaining({ present: true, sdk: "express", licensed_paths: ["/api/informes/**"] }));
    expect(d.routes.find((r) => r.path === "/temprana")?.signals.behind_licenroute).toBe(false);
    expect(d.routes.find((r) => r.path === "/api/informes/:id")?.signals.behind_licenroute).toBe(true);
    expect(p!.integration.already_integrated).toBe(true);
    expect(p!.integration.dependencies).toEqual([]);
    expect(p!.proposed_plans.find((x) => x.route_pattern === "/api/informes/**")?.already_licensed).toBe(true);
    expect(p!.proposed_plans.find((x) => x.route_pattern === "/api/estadisticas/**")?.already_licensed).toBe(false);
    expect(p!.integration.order_warning).toMatch(/before the LicenRoute middleware/);
  });
  test("Rails: middleware global y licensed_paths", () => {
    const { detected: d, plan: p } = analyze(project("integrated-rails"));
    expect(d.licenroute).toEqual(expect.objectContaining({ present: true, licensed_paths: ["/api/datos/**"] }));
    expect(d.routes.every((r) => r.signals.behind_licenroute)).toBe(true);
    expect(p!.proposed_plans.find((x) => x.route_pattern === "/api/datos/**")?.already_licensed).toBe(true);
  });
});

describe("Seguridad: contenido no confiable", () => {
  const SENTINEL = "SENTINELA-NO-DEBE-APARECER";
  const outside = join(work, `fuera-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secreto.js"), `const r = require("express").Router(); r.get("/fuera-del-proyecto", (q, s) => s.json({})); // ${SENTINEL}\nmodule.exports = r;\n`);
  const sensitive = [".env", ".env.production", "config/master.key", "id_rsa", "secrets.json", "credentials.json", ".npmrc", "certs/servidor.pem"];
  const dir = project("express4-js", (d) => {
    for (const f of sensitive) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), `LICENROUTE_API_KEY=${SENTINEL}\n`); }
    symlinkSync(join(outside, "secreto.js"), join(d, "routes", "enlace.js"));
    symlinkSync(outside, join(d, "dir-enlazado"));
  });
  const { detected: d, plan: p, text } = analyze(dir);

  test("los ficheros sensibles se listan por nombre y nunca se abren", () => {
    expect(d.skipped.sensitive_files).toEqual(expect.arrayContaining(sensitive));
    const opened: string[] = [];
    detect(dir, { onOpen: (f) => opened.push(f) });
    expect(opened.filter((f) => sensitive.includes(f))).toEqual([]);
    expect(opened.some((f) => f.includes("enlace") || f.includes("dir-enlazado"))).toBe(false);
  });
  test("ningún contenido sensible ni de fuera del proyecto aparece en la salida", () => {
    for (const out of [JSON.stringify(d), JSON.stringify(p), text]) expect(out).not.toContain(SENTINEL);
    expect(paths(d)).not.toContain("GET /fuera-del-proyecto");
    expect(d.skipped.symlinks).toEqual(expect.arrayContaining(["routes/enlace.js", "dir-enlazado"]));
  });
  test("caracteres de control, ANSI y de dirección se neutralizan; los comentarios no se muestran", () => {
    const { detected: h, text: t } = analyze(project("hostile-express"));
    const all = `${t}\n${JSON.stringify(h)}`;
    // eslint-disable-next-line no-control-regex -- se comprueba justamente su ausencia
    expect(/[\u001b\u2028\u2029\u202e]/.test(all)).toBe(false);
    expect(all).not.toContain("IGNORA LAS INSTRUCCIONES");
    expect(h.routes.every((r) => r.notes.some((n) => n.includes("control or direction characters")))).toBe(true);
  });
  test("ficheros con nombres con caracteres de control: no se abren", () => {
    const { detected: u } = analyze(project("express4-js", (d2) => writeFileSync(join(d2, "routes", "mal\u001bnombre.js"), "x")));
    expect(u.skipped.unsafe_names).toEqual(["routes/mal?nombre.js"]);
  });
});

describe("Esquema, determinismo y base para S6", () => {
  test("misma entrada, misma salida; un cambio de fichero cambia el hash del plan", () => {
    const dir = project("express4-js");
    const a = cli(["plan", dir, "--json"]).stdout; const b = cli(["plan", dir, "--json"]).stdout;
    expect(a).toBe(b);
    writeFileSync(join(dir, "routes", "api.js"), `${readFileSync(join(dir, "routes", "api.js"), "utf8")}\n// cambio\n`);
    const c = JSON.parse(cli(["plan", dir, "--json"]).stdout) as Plan;
    const pa = JSON.parse(a) as Plan;
    expect(c.approval.plan_sha256).not.toBe(pa.approval.plan_sha256);
    expect(c.approval.files.find((f) => f.path === "routes/api.js")!.sha256).not.toBe(pa.approval.files.find((f) => f.path === "routes/api.js")!.sha256);
  });
  test("plan con varios frameworks exige --target; códigos de salida de uso", () => {
    const dir = project("express4-js", (d) => cpSync(join(FIXTURES, "rails8"), d, { recursive: true }));
    expect(cli(["plan", dir]).status).toBe(3);
    expect(cli(["plan", dir, "--target", "rails"]).status).toBe(0);
    expect(cli(["inventado", dir]).status).toBe(2);
    expect(cli(["detect", join(dir, "no-existe")]).status).toBe(2);
    expect(cli(["detect", dir, "--escribir"]).status).toBe(2);
  });
});

describe("Garantías de solo lectura", () => {
  test("el lanzador: siempre --permission; escritura solo por destino exacto; ningún proceso hijo (L6)", () => {
    const bin = readFileSync(CLI, "utf8");
    expect(bin).toContain('"--permission"');
    expect(bin).not.toMatch(/--allow-worker|--allow-addons|--allow-wasi/);
    // Un permiso por destino validado y, desde D4.3, el terminal de control: el reto lo pide la fase de escritura.
    expect(bin.match(/--allow-fs-write=[^`"]*/g)).toEqual(["--allow-fs-write=${t}", "--allow-fs-write=/dev/tty"]);
    expect(bin.match(/"--allow-child-process"/g)).toBeNull(); // L6: ni siquiera doctor/test (no hay Sandbox)
    expect(bin).toMatch(/if \(command === "doctor" \|\| command === "test"\)/);
  });
  test("control negativo: con esos permisos, escribir o lanzar un proceso falla", () => {
    const dir = project("express4-js");
    const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${dir}`, "-e",
      `const fs=require("fs"); const out=[]; try{fs.writeFileSync(${JSON.stringify(join(dir, "x"))},"1")}catch(e){out.push(e.code)} try{require("child_process").execSync("true")}catch(e){out.push(e.code)} console.log(out.join(","))`], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("ERR_ACCESS_DENIED,ERR_ACCESS_DENIED");
  });
  test("solo journal.ts escribe y solo src/live/ usa red y procesos; el análisis y apply, ninguna de las dos cosas", () => {
    const src = new URL("../src/", import.meta.url).pathname;
    const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    expect(files).toEqual(expect.arrayContaining(["journal.ts", "live/test.ts", "live/doctor.ts", "live/sandbox.ts", "apply.ts", "express.ts", "rails.ts", "reader.ts"]));
    const WRITE = /\b(?:writeFile|appendFile|mkdir|rmSync|rmdir|unlink|rename|copyFile|createWriteStream|symlink|chmod|chown|truncate|writeSync|openSync)\w*\s*\(/;
    const NET = /node:(?:child_process|http|https|net|dgram|tls)\b|(?<![.\w])fetch\s*\(/; // ENV.fetch (Ruby generado) no cuenta
    for (const f of files) {
      const text = readFileSync(join(src, f), "utf8");
      expect(text, f).not.toMatch(/node:(?:worker_threads|cluster|vm)\b|\beval\s*\(|new Function\b|require\s*\(\s*[^"'\s]/);
      // consent.ts (D4.3) solo abre el terminal de control para el reto: nada más en él puede escribir.
      if (f === "consent.ts") expect(text.replace('openSync("/dev/tty", "r+")', "").replace(/\b(?:writeSync|readSync|closeSync)\(fd,/g, ""), f).not.toMatch(WRITE);
      else if (f !== "journal.ts") expect(text, f).not.toMatch(WRITE);
      if (!f.startsWith("live/")) expect(text, f).not.toMatch(NET);
    }
  });
});

describe("Esquema publicado", () => {
  test("schema/*.v1.json coincide con src/schema.ts (regenerar con npm run schema)", () => {
    for (const [name, schema] of [["detect", DetectResult], ["plan", Plan]] as const) {
      const published = JSON.parse(readFileSync(new URL(`../schema/${name}.v1.json`, import.meta.url), "utf8")) as Record<string, unknown>;
      delete published.$schema; delete published.$id;
      expect(published).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });
});
