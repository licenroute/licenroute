// Fase 9: el paquete publicado debe identificarse igual que el SDK ante la API (atestaciones, User-Agent).
// Regresión: package.json decía 0.3.0 mientras el código enviaba 0.4.0.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "../src/api-client.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; dependencies?: Record<string, string> };

describe("paquete npm", () => {
  it("la versión de package.json coincide con SDK_VERSION", () => {
    expect(manifest.version).toBe(SDK_VERSION);
  });

  it("no declara dependencias internas del monorepositorio (se incrustan al construir)", () => {
    expect(Object.keys(manifest.dependencies ?? {}).filter((d) => d.startsWith("@licenroute/"))).toEqual([]);
  });
});
