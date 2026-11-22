// Regressions found while seeding the first Market v2 API (Validaciones ES, 2026-11-21): BL-32, BL-33, BL-34.
import { describe, expect, it } from "vitest";
import { classify } from "../src/util.ts";
import { covers } from "../src/apply.ts";
import { refreshPlanRoutes } from "../src/route-refresh.ts";
import { exampleWith, probePath, validTestContext } from "../src/live/test.ts";

describe("BL-32: API documentation is never proposed for charging", () => {
  it("classifies specs and docs UIs as docs", () => {
    for (const p of ["/openapi.json", "/openapi.yaml", "/swagger.json", "/v1/openapi.json", "/docs", "/docs/intro", "/api-docs", "/swagger-ui", "/redoc"]) expect(classify(p, "GET"), p).toBe("docs");
  });
  it("does not swallow ordinary API routes (negative control)", () => {
    expect(classify("/api/documents", "GET")).toBe("api");
    expect(classify("/v1/validate/nif/:value", "GET")).toBe("api");
    expect(classify("/openapi-results", "GET")).not.toBe("docs");
    expect(classify("/health", "GET")).toBe("health");
  });
});

describe("BL-33: real example values for path parameters", () => {
  it("uses the given value and the generic placeholder for the rest", () => {
    expect(exampleWith("/v1/validate/nif/:value", { value: "12345678Z" })).toBe("/v1/validate/nif/12345678Z");
    expect(exampleWith("/v1/:type/:value", { value: "X" })).toBe("/v1/ejemplo/X");
    expect(exampleWith("/v1/items/:item_id")).toBe("/v1/items/1");
  });
  it("prefers a route without parameters as the probe", () => {
    expect(probePath([{ path: "/v1/validate/nif/:value" }, { path: "/v1/validate" }])).toBe("/v1/validate");
    expect(probePath([{ path: "/v1/a/:x" }, { path: "/v1/b/:y" }])).toBe("/v1/a/:x");
  });
  it("keeps only safe example values in the context passed to the live phase", () => {
    const base = { app: "demo", instance: "default", plans: [{ key: "v1", pattern: "/v1/**", methods: ["GET", "HEAD"], routes: [{ method: "GET", path: "/v1/x/:value" }] }], public_checks: [] };
    const ctx = validTestContext({ ...base, examples: { value: "12345678Z", bad: "../etc/passwd", "no space": "x", long: "a".repeat(65) } })!;
    expect(ctx.examples).toEqual({ value: "12345678Z" });
  });
});

describe("BL-34: tests use the routes the code has now", () => {
  const plan = { pattern: "/v1/validate/**", methods: ["GET", "HEAD"], routes: [{ method: "GET", path: "/v1/validate/:type/:value" }] };
  it("replaces stale routes and reports what changed", () => {
    const current = [{ method: "GET", path: "/v1/validate" }, { method: "GET", path: "/v1/validate/nif/:value" }, { method: "POST", path: "/v1/validate/batch" }, { method: "GET", path: "/health" }];
    const r = refreshPlanRoutes([plan], current, covers);
    expect(r.plans[0]!.routes).toEqual([{ method: "GET", path: "/v1/validate" }, { method: "GET", path: "/v1/validate/nif/:value" }]);
    expect(r.changes).toEqual([{ plan: "/v1/validate/**", added: ["/v1/validate", "/v1/validate/nif/:value"], removed: ["/v1/validate/:type/:value"] }]);
  });
  it("changes nothing when the code still has the recorded routes (negative control)", () => {
    const r = refreshPlanRoutes([plan], [{ method: "GET", path: "/v1/validate/:type/:value" }], covers);
    expect(r.changes).toEqual([]);
    expect(r.plans[0]).toBe(plan);
  });
  it("keeps the recorded routes when the code has none left under the pattern (the test then fails loudly)", () => {
    const r = refreshPlanRoutes([plan], [{ method: "GET", path: "/other" }], covers);
    expect(r.plans[0]!.routes).toEqual(plan.routes);
    expect(r.changes).toEqual([]);
  });
  it("validates route_changes in the context passed to the live phase", () => {
    const base = { app: "demo", instance: "default", plans: [{ key: "v1", pattern: "/v1/**", methods: [], routes: [{ method: "GET", path: "/v1/x" }] }], public_checks: [] };
    const ctx = validTestContext({ ...base, route_changes: [{ plan: "/v1/**", added: ["/v1/x"], removed: ["/v1/y"] }, { plan: "not a pattern", added: [], removed: [] }] })!;
    expect(ctx.route_changes).toEqual([{ plan: "/v1/**", added: ["/v1/x"], removed: ["/v1/y"] }]);
  });
});
