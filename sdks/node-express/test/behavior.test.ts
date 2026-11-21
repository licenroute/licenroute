/**
 * Fixtures compartidos con el SDK de Rails: sdk-behavior.json (respuesta de la API -> respuesta
 * del SDK) y client-ip.json. Se ejecutan con Express 4 y 5 REALES y una API HTTP real.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { licenroute, FALLBACK_RETRY_SECONDS } from "../src/index.ts";
import { buildTrustList, resolveClientIp } from "../src/client-ip.ts";
import { API_KEY, FakeApi, fixture, freePort, raw, SITE_ID, silentLogger, startApp, type ApiReply } from "./helpers.ts";

type Case = { name: string; api: ApiReply & { down?: boolean }; fallback: "fail_open" | "fail_closed"; expect: { outcome: "next" | number; retry_after?: number; cacheable?: boolean; fallback_used?: boolean } };
const { cases } = fixture<{ cases: Case[] }>("sdk-behavior.json");

describe.each([4, 5] as const)("Express %i: sdk-behavior.json", (version) => {
  const api = new FakeApi();
  let deadEndpoint: string;
  beforeAll(async () => {
    await api.start();
    deadEndpoint = `http://127.0.0.1:${await freePort()}`;
  });
  afterAll(() => api.close());

  it.each(cases)("$name", async (c) => {
    api.reply = c.api;
    const mw = licenroute({
      apiKey: API_KEY, siteId: SITE_ID, endpoint: c.api.down ? deadEndpoint : api.endpoint, licensedPaths: [],
      // 400 ms: holgado para respuestas inmediatas en runners lentos; muy por debajo de los
      // 1000 ms de retraso de los casos de timeout del fixture.
      timeoutMs: 400, fallback: c.fallback, policySync: false, logger: silentLogger,
    });
    const app = await startApp(version, mw);
    try {
      const first = await raw(app.port, "GET", "/pagina");
      if (c.expect.outcome === "next") {
        expect(first.status).toBe(200);
        const info = JSON.parse(first.body).licenroute;
        expect(info.fallback).toBe(Boolean(c.expect.fallback_used));
      } else {
        expect(first.status).toBe(c.expect.outcome);
        expect(JSON.parse(first.body).request_id).toBe(first.headers["x-request-id"]);
      }
      if (c.expect.retry_after !== undefined) expect(first.headers["retry-after"]).toBe(String(c.expect.retry_after));
      if (c.expect.fallback_used && c.expect.outcome !== "next") expect(c.expect.retry_after).toBe(FALLBACK_RETRY_SECONDS);

      if (c.expect.cacheable !== undefined && !c.api.down) {
        const before = api.decisionRequests().length;
        const second = await raw(app.port, "GET", "/pagina");
        expect(second.status).toBe(first.status);
        expect(api.decisionRequests().length - before).toBe(c.expect.cacheable ? 0 : 1);
      }
    } finally {
      mw.close();
      await app.close();
    }
  });
});

describe("client-ip.json (threat model T3)", () => {
  const { cases } = fixture<{ cases: { remote: string; xff: string | null; trusted: string[]; expected: string; note?: string }[] }>("client-ip.json");
  it.each(cases)("$remote / $xff -> $expected", ({ remote, xff, trusted, expected }) => {
    expect(resolveClientIp(remote, xff ?? undefined, buildTrustList(trusted))).toBe(expected);
  });
});

describe("access-token.json (Fase 5): solo se reenvían tokens bgat_ y se retiran de la petición", () => {
  type Case = { name: string; headers: Record<string, string>; forwarded: string | null; app_sees: Record<string, string | null> };
  const { cases } = fixture<{ cases: Case[] }>("access-token.json");
  const api = new FakeApi();
  beforeAll(() => api.start());
  afterAll(() => api.close());

  it.each(cases)("$name", async (c) => {
    api.received.length = 0;
    const mw = licenroute({ apiKey: API_KEY, siteId: SITE_ID, endpoint: api.endpoint, licensedPaths: [], timeoutMs: 1000, policySync: false, logger: silentLogger });
    let seen: Record<string, string | undefined> = {};
    const server = createServer((req, res) =>
      mw(req, res, () => {
        seen = { authorization: req.headers.authorization, "botgate-access-token": req.headers["botgate-access-token"] as string | undefined };
        res.end("ok");
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    await raw(port, "GET", "/x", c.headers);
    server.close();
    const sent = JSON.parse(api.decisionRequests()[0]!.body);
    expect(sent.access_token ?? null).toBe(c.forwarded);
    for (const [header, value] of Object.entries(c.app_sees)) expect(seen[header] ?? null).toBe(value);
  });
});
