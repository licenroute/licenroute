/**
 * LicenRoute Trust (Fase 10): identidad seudónima desde identify() (servidor de la app), nunca desde la
 * petición; vector compartido (calculado con Python) para la paridad con Rails; huella de la clave en la
 * atestación; caché sin mezclar usuarios.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { licenroute } from "../src/index.ts";
import { LicenRouteConfigError } from "../src/options.ts";
import { SDK_VERSION } from "../src/api-client.ts";
import { allow, API_KEY, FakeApi, fixture, raw, silentLogger, startApp } from "./helpers.ts";

const vectors = fixture<{ cases: { clave_de_prueba: string; site_id: string; id: string; key_id: string; hash: string }[] }>("identity.json").cases;
const V = vectors[0]!;

let api: FakeApi;
beforeAll(async () => { api = await new FakeApi().start(); });
afterAll(() => api.close());

/** Simula el middleware de autenticación de la app: la sesión de SERVIDOR "s1" pertenece al usuario V.id. */
const sessions = new Map([["s1", V.id], ["s2", "otro-usuario"]]);
function withServerAuth(protection: ReturnType<typeof licenroute>) {
  return (req: IncomingMessage & { user?: string }, res: ServerResponse, next: (e?: unknown) => void) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    req.user = sid ? sessions.get(sid) : undefined; // validado en el servidor (aquí, un mapa de sesiones)
    protection(req, res, next);
  };
}
const make = (extra: Record<string, unknown> = {}) => licenroute({
  apiKey: API_KEY, siteId: V.site_id, endpoint: api.endpoint, licensedPaths: [], logger: silentLogger, policySync: false,
  identify: (req) => (req as { user?: string }).user ?? null, identitySecret: V.clave_de_prueba, ...extra,
});
const decisions = () => api.received.filter((r) => r.url === "/v1/decisions").map((r) => JSON.parse(r.body));

describe("identidad seudónima (Fase 10)", () => {
  it("envía el seudónimo del vector compartido (HMAC con la clave del sitio) y su huella; nunca el id", async () => {
    api.received.length = 0;
    api.reply = { status: 200, body: allow() };
    const app = await startApp(5, withServerAuth(make({ decisionCache: false })));
    try {
      await raw(app.port, "GET", "/cuenta", { cookie: "sid=s1" });
      const body = decisions().at(-1);
      expect(body.identity).toEqual({ hash: V.hash, key_id: V.key_id });
      expect(JSON.stringify(body)).not.toContain(JSON.stringify(V.id)); // como valor JSON: sin comillas podía aparecer por azar en la marca de tiempo
    } finally { await app.close(); }
  });

  it("anónimo: sin identidad, aunque el cliente envíe cabeceras de identidad o una cookie de sesión inválida", async () => {
    api.received.length = 0;
    const app = await startApp(5, withServerAuth(make({ decisionCache: false })));
    try {
      await raw(app.port, "GET", "/x", { "x-botgate-identity": V.hash, "x-user-id": V.id, cookie: "sid=inventada" });
      expect(decisions().at(-1).identity).toBeUndefined();
    } finally { await app.close(); }
  });

  it("identify sin identitySecret, o con una clave corta, falla al arrancar", () => {
    expect(() => make({ identitySecret: undefined })).toThrow(LicenRouteConfigError);
    expect(() => make({ identitySecret: "corta" })).toThrow(LicenRouteConfigError);
  });

  it("la caché de decisiones no mezcla usuarios: cada identidad consulta la API", async () => {
    api.received.length = 0;
    api.reply = { status: 200, body: allow({ ttl_seconds: 30 }) };
    const app = await startApp(5, withServerAuth(make()));
    try {
      await raw(app.port, "GET", "/catalogo", { cookie: "sid=s1" });
      await raw(app.port, "GET", "/catalogo", { cookie: "sid=s1" }); // en caché
      await raw(app.port, "GET", "/catalogo", { cookie: "sid=s2" }); // otro usuario: nueva consulta
      expect(decisions().map((d) => d.identity?.hash)).toHaveLength(2);
      expect(new Set(decisions().map((d) => d.identity?.hash)).size).toBe(2);
    } finally { await app.close(); api.reply = { status: 200, body: allow() }; }
  });

  it("la atestación declara la huella de la clave de identidad de la instancia", async () => {
    api.received.length = 0;
    api.reply = (url) => (url.startsWith("/v1/policies") ? { status: 404, body: {} } : { status: 204, body: {} });
    const protection = make({ policySync: { intervalMs: 60_000 } });
    try {
      await expect.poll(() => api.received.some((r) => r.url === "/v1/sdk/attestations"), { timeout: 5_000 }).toBe(true);
      const att = JSON.parse(api.received.find((r) => r.url === "/v1/sdk/attestations")!.body);
      expect(att.identity_key_id).toBe(V.key_id);
      expect(att.sdk_version).toBe(SDK_VERSION);
    } finally { protection.close(); api.reply = { status: 200, body: allow() }; }
  });
});
