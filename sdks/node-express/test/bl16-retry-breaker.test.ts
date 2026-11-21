import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalSha256, type PolicyDocumentBody } from "@licenroute/policy-contracts";
import { licenroute } from "../src/index.ts";
import { API_KEY, FakeApi, raw, SITE_ID, silentLogger, startApp, allow } from "./helpers.ts";

const token = "bgat_abcdefgh_" + "A".repeat(43);
const requestId = "11111111-2222-4333-8444-555555555555";
const policy: PolicyDocumentBody = {
  site_id: SITE_ID,
  version: 1,
  published_at: "2026-10-18T00:00:00.000Z",
  defaults: { fallback: "fail_closed", score_thresholds: { observe: 30, rate_limit: 60, block: 80 }, excluded_paths: [] },
  rules: [],
  licensed_routes: [{
    plan_id: "plan_1", plan_uuid: "00000000-0000-7000-8000-000000000001",
    route_pattern: "/datos/**", methods: [], checkout_url: "https://licenroute.example/p",
    currency: "EUR", unit_price_minor: 100, unit_size: 1,
  }],
};

describe("BL-16: uncertain licensed retry bypasses open breaker", () => {
  const api = new FakeApi();
  beforeAll(() => api.start());
  afterAll(() => api.close());

  it("retries same licensed ID through breaker, while unrelated requests stay fail closed", async () => {
    let attempts = 0;
    api.reply = (url) => {
      if (url.startsWith("/v1/policies/current")) return {
        status: 200, body: { ...policy, checksum: canonicalSha256(policy) },
      };
      if (url.startsWith("/v1/sdk/attestations")) return { status: 204, raw: "" };
      attempts++;
      return attempts === 1 ? { status: 503, body: {} } : {
        status: 200, body: allow({ reason_codes: ["LICENSE_VALID"] }), delay_ms: 350,
      };
    };
    const mw = licenroute({
      apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: ["/datos/**"],
      timeoutMs: 1000, licensedTimeoutMs: 100, logger: silentLogger,
      policySync: { intervalMs: 60_000 },
      circuitBreaker: { failureThreshold: 1, windowMs: 10_000, openMs: 60_000 },
    });
    const app = await startApp(5, mw);
    try {
      expect(await mw.policy!.refresh()).toBe(true);
      const headers = { "botgate-access-token": token, "x-request-id": requestId };
      expect((await raw(app.port, "GET", "/datos/1", headers)).status).toBe(503);
      // A new request must NOT bypass the open breaker.
      expect((await raw(app.port, "GET", "/datos/1", {
        ...headers, "x-request-id": "22222222-2222-4333-8444-555555555555",
      })).status).toBe(503);
      expect(attempts).toBe(1);
      // Same ID retries with a 1000ms recovery deadline, enough for a 350ms API response.
      expect((await raw(app.port, "GET", "/datos/1", headers)).status).toBe(200);
      expect(attempts).toBe(2);
      // The receipt was consumed after the successful decision.
      expect((await raw(app.port, "GET", "/datos/1", headers)).status).toBe(503);
      expect(attempts).toBe(2);
    } finally {
      mw.close();
      await app.close();
    }
  });
});
