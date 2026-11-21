// L6 (0.3.1): el repositorio público no lleva cliente del Sandbox privado. Ningún fichero lo localiza, verifica ni lanza,
// ninguna orden concede procesos hijos y --version no anuncia sus contratos. Cada búsqueda tiene su control positivo.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { apiPort, appStatus, sandboxDetail } from "../src/live/sandbox.ts";
import { versionInfo } from "../src/version.ts";

const root = new URL("../", import.meta.url).pathname;
const CLI = join(root, "bin/licenroute.mjs");
const MARKERS = /sandbox-trust|sandbox-locator|sandbox-controller|SANDBOX_API_PORT|SANDBOX_ACTIVATION|BOTGATE_SANDBOX_(?:LOCATOR|CONTROLLER|STATE|REFUSAL)|authorizePinned/;
const files = (dir: string): string[] => readdirSync(join(root, dir), { recursive: true }).map(String).filter((f) => /\.(?:[cm]?[jt]s|json)$/.test(f)).map((f) => join(dir, f));

describe("sin cliente del Sandbox privado (L6)", () => {
  test("los módulos del cliente, su localizador y sus esquemas no están en el árbol", () => {
    for (const f of ["src/live/sandbox-external.ts", "src/live/sandbox-locator.ts", "bin/sandbox-trust-check.mjs", "bin/sandbox-trust-check.d.mts",
      "sandbox-locator.json", "sandbox-trust.json", "schema/sandbox-locator.v1.json", "schema/sandbox-trust.v1.json"]) expect(existsSync(join(root, f)), f).toBe(false);
    expect(existsSync(join(root, "src/live/sandbox-backend.ts"))).toBe(true); // control positivo: la ruta es la correcta
  });
  test("ningún fichero de la CLI nombra el localizador, la identidad ni la orden del controlador", () => {
    expect(MARKERS.test('import { authorizePinned } from "./sandbox-trust-check.mjs"')).toBe(true); // control positivo
    // scripts/pack.mjs es el que comprueba el paquete: nombra esas marcas para rechazarlas.
    const all = [...files("src"), ...files("bin"), ...files("scripts"), ...files("schema")].filter((f) => f !== "scripts/pack.mjs");
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((f) => MARKERS.test(readFileSync(join(root, f), "utf8")))).toEqual([]);
  });
  test("ningún lanzador concede procesos hijos", () => {
    for (const f of ["bin/licenroute.mjs", "scripts/dist-launcher.mjs"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).toContain('"--permission"'); // control positivo: es el lanzador
      expect(text, f).not.toContain('"--allow-child-process"'); // como opción; un comentario puede nombrarla
    }
  });
  test("el acceso al Sandbox es inerte: no hay puerto, ni estado del sitio, y remite al modo demo", () => {
    expect(apiPort("default")).toBeNull();
    expect(appStatus("default", "demo-express")).toBeNull();
    expect(sandboxDetail()).toContain("licenroute dev");
  });
  test("licenroute --version --json no anuncia contratos del Sandbox y coincide con versionInfo", () => {
    const info = versionInfo();
    expect(Object.keys(info).sort()).toEqual(["contracts", "distribution", "schema", "tool"]);
    const r = spawnSync(process.execPath, [CLI, "--version", "--json"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(info);
    expect(r.stdout).not.toMatch(/sandbox/i);
    const detected = JSON.parse(spawnSync(process.execPath, [CLI, "detect", join(root, "test/fixtures/demo-express"), "--json"], { encoding: "utf8" }).stdout) as { schema: string };
    expect(detected.schema).toBe("licenroute.cli.detect/v1");
  });
});
