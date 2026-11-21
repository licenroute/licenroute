// D4.4: mensajes del SDK en inglés (por defecto) y español. Mismas claves y {parámetros}; el idioma no cambia decisiones.
import { describe, expect, test } from "vitest";
import { MESSAGES, m, messageLang } from "../src/messages.ts";
import { LicenRouteConfigError, licenroute } from "../src/index.ts";

const ph = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]))].sort().join();

describe("mensajes del SDK", () => {
  test("en y es: mismas claves, mismos parámetros, ninguno vacío", () => {
    expect(Object.keys(MESSAGES.es).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    for (const k of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      expect(ph(MESSAGES.es[k]), k).toBe(ph(MESSAGES.en[k]));
      expect(MESSAGES.en[k].length * MESSAGES.es[k].length, k).toBeGreaterThan(0);
    }
  });

  test("prioridad: LICENROUTE_LANG > LC_ALL > LC_MESSAGES > LANG > inglés", () => {
    expect(messageLang({ LICENROUTE_LANG: "es", LANG: "en_US.UTF-8" })).toBe("es");
    expect(messageLang({ LICENROUTE_LANG: "fr", LANG: "es_ES.UTF-8" })).toBe("es");
    expect(messageLang({ LC_ALL: "en_US", LANG: "es_ES" })).toBe("en");
    expect(messageLang({ LC_ALL: "", LC_MESSAGES: "es_MX", LANG: "en_US" })).toBe("es");
    expect(messageLang({ LANG: "C.UTF-8" })).toBe("en");
    expect(messageLang({ LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(messageLang({})).toBe("en");
  });

  test("el mensaje sale en el idioma del proceso y el error de configuración es el mismo tipo en los dos", () => {
    const saved = process.env.LICENROUTE_LANG;
    try {
      const errors: Record<string, unknown> = {};
      for (const lang of ["en", "es"]) {
        process.env.LICENROUTE_LANG = lang;
        expect(m("options.timeout")).toBe(MESSAGES[lang as "en" | "es"]["options.timeout"]);
        try { licenroute({ apiKey: "x", siteId: "y", endpoint: "https://api.example", licensedPaths: [] }); } catch (e) { errors[lang] = e; }
      }
      expect(errors.en).toBeInstanceOf(LicenRouteConfigError);
      expect(errors.es).toBeInstanceOf(LicenRouteConfigError);
      expect((errors.en as Error).message).toBe(MESSAGES.en["options.key_invalid"]);
      expect((errors.es as Error).message).toBe(MESSAGES.es["options.key_invalid"]);
    } finally { process.env.LICENROUTE_LANG = saved; }
  });
});

// D4.4.1: los mensajes de @licenroute/policy-contracts (sin cambios, compartido con Central) se presentan en el idioma del
// proceso. Oráculo: en español, el texto elegido por la entrada que falló es EXACTAMENTE el mensaje del contrato.
import { canonicalSha256, compileGlob, parseLicensedDeclaration } from "@licenroute/policy-contracts";
import { declarationProblem, localizedChecksum, localizedGlob } from "../src/messages.ts";

describe("errores del contrato en los dos idiomas", () => {
  const ENTRIES: unknown[] = [42, null, ["/x"], { methods: ["GET"] }, { path: "/x" }, { path: "/x", methods: [] }, { path: "/x", methods: [1] },
    { path: "/x/**", methods: ["OPTIONS"] }, { path: "/x/**", methods: ["GET", "FETCH", "TRACE"] }, { path: "x/**", methods: ["GET"] }, { path: "", methods: ["GET"] },
    { path: "/a/**b", methods: ["GET"] }, "sin-barra", "/a/**b", "/ok/**"];
  const withLang = <T>(lang: string, fn: () => T): T => { const s = process.env.LICENROUTE_LANG; process.env.LICENROUTE_LANG = lang; try { return fn(); } finally { process.env.LICENROUTE_LANG = s; } };

  test("licensedPaths: mismo rechazo que el contrato; en español su mismo texto, en inglés el equivalente", () => {
    let rejected = 0;
    for (const entry of ENTRIES) {
      let contract: string | null = null;
      try { parseLicensedDeclaration(entry); } catch (e) { contract = (e as Error).message; }
      if (contract === null) continue;
      rejected++;
      expect(withLang("es", () => declarationProblem(entry)), JSON.stringify(entry)).toBe(contract);
      const en = withLang("en", () => declarationProblem(entry));
      expect(en).not.toBe(contract);
      expect(en).not.toMatch(/[áéíóúñ]|debe|cadena|patrón|método no/);
      for (const lang of ["en", "es"]) {
        process.env.LICENROUTE_LANG = lang;
        expect(() => licenroute({ apiKey: `bg_test_abcdefgh_${"k".repeat(43)}`, siteId: "site_ABCDEFGH", endpoint: "https://api.example", licensedPaths: [entry as string] })).toThrow(LicenRouteConfigError);
        let msg = ""; try { licenroute({ apiKey: `bg_test_abcdefgh_${"k".repeat(43)}`, siteId: "site_ABCDEFGH", endpoint: "https://api.example", licensedPaths: [entry as string] }); } catch (e) { msg = (e as Error).message; }
        expect(msg).toBe(`licensedPaths: ${declarationProblem(entry)}`);
      }
    }
    expect(rejected).toBeGreaterThanOrEqual(12);
  });

  test("patrones y JSON canónico: mismo fallo que el contrato, texto en el idioma del proceso", () => {
    for (const p of ["sin-barra", "  x/y", ""]) {
      let contract = ""; try { compileGlob(p); } catch (e) { contract = (e as Error).message; }
      expect(contract).not.toBe("");
      expect(() => withLang("es", () => localizedGlob(p))).toThrow(contract);
      expect(() => withLang("en", () => localizedGlob(p))).toThrow(/must start with \//);
    }
    expect(localizedGlob("/ok/**")).toEqual(compileGlob("/ok/**"));
    expect(localizedChecksum({ a: 1 })).toBe(canonicalSha256({ a: 1 }));
    expect(() => canonicalSha256({ a: 1.5 })).toThrow();
    expect(() => withLang("en", () => localizedChecksum({ a: 1.5 }))).toThrow(/canonical JSON/);
    expect(() => withLang("es", () => localizedChecksum({ a: 1.5 }))).toThrow(/JSON canónico/);
    expect(() => withLang("en", () => licenroute({ apiKey: `bg_test_abcdefgh_${"k".repeat(43)}`, siteId: "site_ABCDEFGH", endpoint: "https://api.example", licensedPaths: [], excludedPaths: ["sin-barra"] }))).toThrow(/must start with \//);
  });
});
