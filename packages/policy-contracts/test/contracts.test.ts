import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  ATTESTATION_MAX_PATHS, canonicalJson, canonicalSha256, compileGlob, coversLicensed, InvalidLicensedPath, LicensedRoute, matchGlob, matchSegment,
  normalizeLicensedPaths, normalizePath, pathTemplate, requestCovered, uncoveredDeclared, SdkAttestationRequest, DecisionRequest, DecisionResponse, ReasonCodes, publishAttestationPaths, publishResourceReady, identityHash, identityKeyId, IDENTITY_SECRET_MIN_LENGTH, PolicyRule,
  declarationMatches, declarationsCover, InvalidLicensedDeclaration, parseLicensedDeclaration, uncoveredDeclarations,
} from "../src/index.ts";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;

describe("normalizePath (fixtures/path-normalization.json)", () => {
  const { cases } = fixture<{ cases: { input: string; expected: string; note?: string }[] }>("path-normalization.json");
  it.each(cases)("$input -> $expected", ({ input, expected }) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("es idempotente", () => {
    for (const { input } of cases) expect(normalizePath(normalizePath(input))).toBe(normalizePath(input));
  });

  it("acota la longitud", () => {
    expect(normalizePath("/" + "a".repeat(10_000)).length).toBeLessThanOrEqual(2048);
  });
});

describe("matchGlob (fixtures/glob.json)", () => {
  const { cases } = fixture<{ cases: { pattern: string; path: string; match: boolean }[] }>("glob.json");
  it.each(cases)("$pattern ~ $path = $match", ({ pattern, path, match }) => {
    expect(matchGlob(compileGlob(pattern), normalizePath(path))).toBe(match);
  });

  it("no tiene comportamiento catastrófico con entradas patológicas (sin ReDoS)", () => {
    const pattern = compileGlob("/" + Array(40).fill("**").join("/") + "/z");
    const path = "/" + Array(200).fill("a").join("/");
    const start = performance.now();
    expect(matchGlob(pattern, path)).toBe(false);
    expect(matchSegment("*a*a*a*a*a*a*a*a*b", "a".repeat(2000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("rechaza patrones que no empiezan por /", () => {
    expect(() => compileGlob("api/**")).toThrow();
  });
});

describe("JSON canónico (fixtures/canonical-json.json, compartido con Ruby)", () => {
  const { cases } = fixture<{ cases: { input: unknown; canonical: string; sha256: string }[] }>("canonical-json.json");
  it.each(cases.map((c, i) => ({ ...c, i })))("caso $i", ({ input, canonical, sha256 }) => {
    expect(canonicalJson(input)).toBe(canonical);
    expect(canonicalSha256(input)).toBe(sha256);
  });

  it("rechaza floats y undefined", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});

describe("compatibilidad con frameworks (fixtures/path-compat.json)", () => {
  type Case = { target: string; normalized: string; rule_matches: boolean; observed: Record<string, string> };
  const { cases } = fixture<{ cases: Case[] }>("path-compat.json");
  const admin = compileGlob("/admin/**");

  it.each(cases)("$target", ({ target, normalized, rule_matches }) => {
    expect(normalizePath(target)).toBe(normalized);
    expect(normalizePath(normalized)).toBe(normalized); // idempotente también con %3F / %23
    expect(matchGlob(admin, normalized)).toBe(rule_matches);
  });

  it("invariante: lo que algún framework enruta a /admin, la regla /admin/** lo bloquea", () => {
    const bypasses = cases.filter((c) => Object.values(c.observed).includes("admin") && !c.rule_matches);
    expect(bypasses.map((c) => c.target)).toEqual([]);
  });

  it("la salida nunca contiene ? ni # sin escapar", () => {
    for (const { normalized } of cases) expect(normalized).not.toMatch(/[?#]/);
  });
});

describe("sufijo de formato (Rails `(.:format)`)", () => {
  it.each([
    ["/admin/**", "/admin.json", true],
    ["/admin/**", "/admin.json/x", false],
    ["/admin/**", "/administrator", false],
    ["/admin/**", "/admin..", false],
    ["/login", "/login.json", true],
    ["/login", "/login.tar.gz", false],
    ["/api/*/items", "/api/v1/items.xml", true],
    ["/static/*.css", "/static/a.css.map", false],
    ["/a/**/z", "/a/b/z.json", true],
  ] as const)("%s ~ %s = %s", (pattern, path, expected) => {
    expect(matchGlob(compileGlob(pattern), normalizePath(path))).toBe(expected);
  });
});

describe("pathTemplate (fixtures/path-template.json)", () => {
  const { cases } = fixture<{ cases: { input: string; expected: string }[] }>("path-template.json");
  it.each(cases)("$input -> $expected", ({ input, expected }) => {
    expect(pathTemplate(normalizePath(input))).toBe(expected);
  });

  it("acota la longitud", () => {
    expect(pathTemplate(normalizePath("/" + "seg/".repeat(400))).length).toBeLessThanOrEqual(512);
  });
});

describe("BL-11: cobertura de rutas de pago y normalización de licensedPaths declarados", () => {
  const fx = JSON.parse(readFileSync(new URL("../fixtures/policy-fallback.json", import.meta.url), "utf8")) as { covers: { local: string[]; pattern: string; expect: boolean }[] };
  it.each(fx.covers)("cubre $local -> $pattern: $expect", (c) => {
    expect(coversLicensed(c.local.map(compileGlob), c.pattern)).toBe(c.expect);
  });

  it("normaliza (minúsculas, sin duplicados, ordenado) y rechaza globs inválidos", () => {
    expect(normalizeLicensedPaths(["/Datos/**", "/datos/**", "/api/v1/*"])).toEqual(["/api/v1/*", "/datos/**"]);
    for (const bad of ["datos/**", "/datos/a**", "/datos/(.*)", "/datos/<script>", "/da tos"]) {
      expect(() => normalizeLicensedPaths([bad]), bad).toThrow(InvalidLicensedPath);
    }
  });

  it("LicensedRoute admite status active|pending (opcional) y la atestación es un esquema cerrado", () => {
    const route = { plan_id: "p", plan_uuid: "u", route_pattern: "/d/**", methods: [], checkout_url: "x", currency: "EUR", unit_price_minor: 1, unit_size: 1 };
    expect(Value.Check(LicensedRoute, route)).toBe(true);
    expect(Value.Check(LicensedRoute, { ...route, status: "pending" })).toBe(true);
    expect(Value.Check(LicensedRoute, { ...route, status: "otro" })).toBe(false);
    const att = { instance_id: "web-1", boot_id: "0b0b0b0b-0000-4000-8000-000000000001", sdk: "express", sdk_version: "0.4.0", licensed_paths: ["/datos/**"], without_policy: "deny" };
    expect(Value.Check(SdkAttestationRequest, att)).toBe(true);
    expect(Value.Check(SdkAttestationRequest, { ...att, site_id: "site_x" })).toBe(false);
    expect(Value.Check(SdkAttestationRequest, { ...att, licensed_paths: Array.from({ length: ATTESTATION_MAX_PATHS + 1 }, (_, i) => `/r${i}`) })).toBe(false);
  });
});

describe("LicenRoute Trust (Fase 10): identidad seudónima y clases de cliente", () => {
  const vectors = fixture<{ cases: { clave_de_prueba: string; site_id: string; id: string; key_id: string; hash: string }[] }>("identity.json").cases;

  it.each(vectors)("HMAC de identidad y huella de clave coinciden con el vector independiente ($id)", (v) => {
    expect(identityKeyId(v.clave_de_prueba)).toBe(v.key_id);
    expect(identityHash(v.clave_de_prueba, v.site_id, v.id)).toBe(v.hash);
  });

  it("el mismo usuario tiene seudónimos distintos en sitios distintos", () => {
    const k = "k".repeat(IDENTITY_SECRET_MIN_LENGTH);
    expect(identityHash(k, "site_a", "42")).not.toBe(identityHash(k, "site_b", "42"));
  });

  it("DecisionRequest: identidad con hash y key_id hexadecimales; nada más", () => {
    const base = { request_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", site_id: "site_AbCdEf0123456789", timestamp: "2026-10-13T10:00:00Z", method: "GET", path: "/", client: { ip: "203.0.113.9" } };
    const identity = { hash: "a".repeat(64), key_id: "b".repeat(16) };
    expect(Value.Check(DecisionRequest, { ...base, identity })).toBe(true);
    expect(Value.Check(DecisionRequest, base)).toBe(true); // SDK anteriores
    expect(Value.Check(DecisionRequest, { ...base, identity: { ...identity, hash: "usuario-42" } })).toBe(false);
    expect(Value.Check(DecisionRequest, { ...base, identity: { ...identity, user_id: "42" } })).toBe(false);
  });

  it("Publish I2: IP opcional en la petición y licencia concedida en la respuesta (aditivo y compatible)", () => {
    const base = { request_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", site_id: "site_AbCdEf0123456789", timestamp: "2026-10-13T10:00:00Z", method: "GET", path: "/api/v1/productos/:id" };
    expect(Value.Check(DecisionRequest, { ...base, client: { ip: "203.0.113.9" } })).toBe(true); // SDK actuales
    expect(Value.Check(DecisionRequest, { ...base, client: {} })).toBe(true); // conector Publish (la API lo limita a ese tipo de sitio)
    expect(Value.Check(DecisionRequest, { ...base, client: { ip: "no-es-ip" } })).toBe(false);
    const decision = { request_id: base.request_id, action: "allow", risk_score: 0, reason_codes: [ReasonCodes.LICENSE_VALID], policy_version: 1, ttl_seconds: 0 };
    const license = { grant_id: "01a15443-049a-706a-ac7e-f842d27dc205", plan_id: "plan_1", data_scope: "distributor-a" };
    expect(Value.Check(DecisionResponse, decision)).toBe(true); // respuestas anteriores
    expect(Value.Check(DecisionResponse, { ...decision, license })).toBe(true);
    for (const bad of [{ ...license, data_scope: "" }, { ...license, data_scope: "a b" }, { ...license, data_scope: "*" }, { ...license, extra: 1 }, { grant_id: license.grant_id, plan_id: "p" }]) {
      expect(Value.Check(DecisionResponse, { ...decision, license: bad })).toBe(false);
    }
    expect(ReasonCodes.PUBLISH_ROUTE_NOT_LICENSED).toBe("PUBLISH_ROUTE_NOT_LICENSED");
  });

  it("BL-11 Publish: atestación publish_connector con recursos, planes y comprobaciones declaradas", () => {
    const base = { instance_id: "connector-1", boot_id: "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", sdk_version: "0.1.0", without_policy: "deny" };
    const resource = { slug: "productos", version: 1, plan_ids: ["plan_AbC123"], checks: { schema: "ok", index: "optimal", source_role: "read_only" } };
    const publish = { resources: [resource] };
    expect(Value.Check(SdkAttestationRequest, { ...base, sdk: "express", licensed_paths: ["/datos/**"] })).toBe(true); // SDK actuales
    expect(Value.Check(SdkAttestationRequest, { ...base, sdk: "publish_connector", licensed_paths: ["/api/v1/productos/**"], publish })).toBe(true);
    for (const bad of [
      { ...resource, slug: "Productos" }, { ...resource, version: 0 }, { ...resource, plan_ids: [] }, { ...resource, plan_ids: ["plan x"] },
      { ...resource, checks: { ...resource.checks, schema: "maybe" } }, { ...resource, checks: { ...resource.checks, extra: 1 } }, { ...resource, extra: 1 },
    ]) {
      expect(Value.Check(SdkAttestationRequest, { ...base, sdk: "publish_connector", licensed_paths: ["/api/v1/productos/**"], publish: { resources: [bad] } })).toBe(false);
    }
    expect(Value.Check(SdkAttestationRequest, { ...base, sdk: "publish_connector", licensed_paths: [], publish: { resources: [] } })).toBe(false);
    expect(publishAttestationPaths({ resources: [resource, { ...resource, slug: "pedidos" }] } as never)).toEqual(["/api/v1/productos/**", "/api/v1/pedidos/**"]);
    expect(publishResourceReady(resource as never)).toBe(true);
    expect(publishResourceReady({ ...resource, checks: { ...resource.checks, index: "small" } } as never)).toBe(true);
    for (const checks of [{ schema: "failed", index: "optimal", source_role: "read_only" }, { schema: "ok", index: "missing", source_role: "read_only" },
      { schema: "ok", index: "failed", source_role: "read_only" }, { schema: "ok", index: "optimal", source_role: "unsafe" }, { schema: "ok", index: "optimal", source_role: "failed" }]) {
      expect(publishResourceReady({ ...resource, checks } as never)).toBe(false);
    }
  });

  it("reglas: client_kind y dimensión client", () => {
    const rule = { id: "r1", priority: 1, path_pattern: "/**", methods: [], conditions: { client_kind: ["anonymous"] }, action: "rate_limit", mode: "enforce",
      rate_limit: { limit: 100, period_seconds: 60, burst: 10, dimension: "client" }, fallback: null };
    expect(Value.Check(PolicyRule, rule)).toBe(true);
    expect(Value.Check(PolicyRule, { ...rule, conditions: { client_kind: ["robot"] } })).toBe(false);
    expect(Value.Check(PolicyRule, { ...rule, conditions: { client_kind: [] } })).toBe(false);
  });
});

describe("F2: cobertura de rutas declaradas de pago (fixture compartido con Ruby)", () => {
  const fx = JSON.parse(readFileSync(new URL("../fixtures/licensed-coverage.json", import.meta.url), "utf8")) as {
    cases: { name: string; routes: { route_pattern: string; methods: string[] }[]; declared: string[]; uncovered: string[]; requests: { path: string; method: string; covered: boolean }[] }[];
  };
  for (const c of fx.cases) {
    it(c.name, () => {
      const routes = c.routes.map((r) => ({ glob: compileGlob(r.route_pattern), methods: new Set(r.methods) }));
      expect(uncoveredDeclared(routes, c.declared)).toEqual(c.uncovered);
      for (const r of c.requests) expect(requestCovered(routes, r.path, r.method, matchGlob), `${r.method} ${r.path}`).toBe(r.covered);
    });
  }
});


// D4.1 (F-D4-1): declaraciones locales con métodos. Solo TypeScript: el SDK de Rails sigue con cadenas (todos los
// métodos), que es exactamente la forma antigua y conserva la paridad de policy-fallback.json.

describe("parseLicensedDeclaration", () => {
  it("cadena = todos los métodos; objeto = métodos normalizados, ordenados y sin duplicados", () => {
    expect(parseLicensedDeclaration("/Datos/**")).toEqual({ pattern: "/datos/**", methods: [] });
    expect(parseLicensedDeclaration({ path: "/datos/**", methods: ["head", "GET", "get"] })).toEqual({ pattern: "/datos/**", methods: ["GET", "HEAD"] });
  });
  it.each([
    [{ path: "/a/**", methods: [] }], [{ path: "/a/**", methods: ["OPTIONS"] }], [{ path: "/a/**", methods: ["TRACE"] }],
    [{ path: "/a/**" }], [{ path: "a/**", methods: ["GET"] }], [{ path: "/a b/**", methods: ["GET"] }], [null], [["/a/**"]], [7],
  ])("%j: inválida", (entry) => { expect(() => parseLicensedDeclaration(entry)).toThrow(InvalidLicensedDeclaration); });
});

describe("declaraciones con métodos frente a peticiones y política", () => {
  const decl = (pattern: string, methods: string[] = []) => ({ glob: compileGlob(pattern), methods: new Set(methods) });
  const route = decl;
  it("declarationMatches: método exacto (GET no implica HEAD), cadena = todos", () => {
    const get = decl("/cupones/**", ["GET"]);
    expect(declarationMatches(get, "/cupones/x", "GET", matchGlob)).toBe(true);
    expect(declarationMatches(get, "/cupones/x", "HEAD", matchGlob)).toBe(false);
    expect(declarationMatches(get, "/cupones/canjear", "POST", matchGlob)).toBe(false);
    expect(declarationMatches(decl("/cupones/**"), "/cupones/canjear", "POST", matchGlob)).toBe(true);
    expect(declarationMatches(get, "/otra", "GET", matchGlob)).toBe(false);
  });
  it("declarationsCover (BL-11): una ruta de la política con todos los métodos solo la cubre una declaración con todos", () => {
    expect(declarationsCover([decl("/cupones/**", ["GET", "HEAD"])], { pattern: "/cupones/**", methods: new Set(["GET"]) })).toBe(true);
    expect(declarationsCover([decl("/cupones/**", ["GET"])], { pattern: "/cupones/**", methods: new Set(["GET", "POST"]) })).toBe(false);
    expect(declarationsCover([decl("/cupones/**", ["GET", "HEAD"])], { pattern: "/cupones/**", methods: new Set() })).toBe(false);
    expect(declarationsCover([decl("/cupones/**")], { pattern: "/cupones/x/**", methods: new Set() })).toBe(true);
    expect(declarationsCover([decl("/cupones/**", ["POST"])], { pattern: "/otra/**", methods: new Set(["POST"]) })).toBe(false);
  });
  it("uncoveredDeclarations (F2): cada método declarado necesita una ruta de la política que lo cubra", () => {
    const d = [{ pattern: "/cupones/**", methods: ["GET", "HEAD"] }];
    expect(uncoveredDeclarations([route("/cupones/**", ["GET", "HEAD"])], d)).toEqual([]);
    expect(uncoveredDeclarations([route("/cupones/**")], d)).toEqual([]);
    expect(uncoveredDeclarations([route("/cupones/**", ["GET"])], d)).toEqual(["/cupones/**"]);
    expect(uncoveredDeclarations([route("/cupones/**", ["GET"]), route("/cupones/**", ["HEAD"])], d)).toEqual([]);
    // Forma antigua: igual que uncoveredDeclared (una ruta restringida no cubre una declaración de todos los métodos).
    expect(uncoveredDeclarations([route("/cupones/**", ["GET", "HEAD"])], [{ pattern: "/cupones/**", methods: [] }])).toEqual(["/cupones/**"]);
    expect(uncoveredDeclarations([], d)).toEqual(["/cupones/**"]);
  });
});
