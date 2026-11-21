/**
 * Simulador local de decisiones de LicenRoute (S10.1, modo demo). NO es Central y NO es productivo.
 *
 * Implementa el contrato C1 que usa el SDK (política, atestación, decisiones, eventos y salud) y, aparte, la
 * administración de pruebas botgate.test-admin/v1 (estado, activar, emitir licencias, obtener una, revocar y
 * simular una caída). Todo en memoria, sin código de Central: solo los contratos públicos de policy-contracts.
 *
 * Aislamiento:
 *  - escucha solo en 127.0.0.1; rechaza conexiones que no vengan de loopback y cabeceras Host ajenas;
 *  - solo emite y acepta credenciales de demo (bg_dev_, site_dev_, bgdev_); las reales se rechazan explícitamente;
 *  - toda respuesta lleva `botgate-mode: simulation`, y cada decisión, el código DEMO_SIMULATOR;
 *  - la administración exige un token aleatorio por ejecución, distinto de la clave del sitio.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  canonicalSha256, compileGlob, DEMO_ACCESS_TOKEN_FORMAT, DEMO_API_KEY_FORMAT, DEMO_MODE_HEADER, DEMO_MODE_VALUE,
  DEMO_REASON_CODE, isLoopbackHost, LICENSABLE_METHODS, matchGlob, normalizePath, REAL_ACCESS_TOKEN_FORMAT, REAL_API_KEY_FORMAT,
  type CompiledGlob, type PolicyDocumentBody,
} from "@licenroute/policy-contracts";

export const TEST_ADMIN_PREFIX = "/_botgate/test-admin/v1";
export const SIMULATOR_SCHEMA = "botgate.simulator/v1";

/** methods: los que exige la licencia (vacío = todos, como en Central). D4.1: licenroute dev pasa los del plan. */
export interface PlanConfig { key: string; pattern: string; quota: number; methods?: string[] }
export interface SiteConfig { app: string; plans: PlanConfig[] }
export interface SiteCredentials { app: string; site_id: string; api_key: string; endpoint: string }

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const pick = (alphabet: string, n: number) => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const APP = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATTERN = /^\/[A-Za-z0-9/_.*-]{0,200}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

interface Grant { name: string; planKey: string; token: string; remaining: number; revoked: boolean }
interface Plan extends PlanConfig { methods: string[]; uuid: string; glob: CompiledGlob; active: boolean }
interface Site { app: string; siteId: string; apiKey: string; plans: Plan[]; grants: Map<string, Grant>; attestations: Map<string, { paths: string[]; mode: string; at: number }>; version: number }

export interface Simulator {
  url: string;
  adminToken: string;
  sites: SiteCredentials[];
  setOutage(on: boolean): void;
  /** Identificador PÚBLICO de esta ejecución (no es un secreto): `licenroute dev` lo compara con el de su fichero para
   *  distinguir su simulador de otro servicio que escuche en el mismo puerto. */
  runId: string;
  close(): Promise<void>;
}

function siteOf(cfg: SiteConfig): Site {
  if (!APP.test(cfg.app) || !Array.isArray(cfg.plans) || cfg.plans.length === 0 || cfg.plans.length > 20) throw new Error(`invalid demo site: ${cfg.app}`);
  const plans = cfg.plans.map((p) => {
    const methods = [...new Set((p.methods ?? []).map((m) => String(m).toUpperCase()))].sort();
    if (!KEY.test(p.key) || !PATTERN.test(p.pattern) || !Number.isInteger(p.quota) || p.quota < 1 || p.quota > 1_000_000 || methods.some((m) => !(LICENSABLE_METHODS as readonly string[]).includes(m))) throw new Error(`invalid demo plan: ${p.key}`);
    return { ...p, methods, uuid: randomUUID(), glob: compileGlob(p.pattern), active: false };
  });
  return { app: cfg.app, siteId: `site_dev_${pick(ALNUM, 16)}`, apiKey: `bg_dev_${pick(B32, 8)}_${pick(ALNUM, 43)}`, plans, grants: new Map(), attestations: new Map(), version: 1 };
}

function policyOf(site: Site, base: string): PolicyDocumentBody {
  return {
    site_id: site.siteId,
    version: site.version,
    published_at: new Date(0).toISOString(),
    defaults: { fallback: "fail_closed", score_thresholds: { observe: 100, rate_limit: 100, block: 100 }, excluded_paths: [] },
    rules: [],
    licensed_routes: site.plans.map((p) => ({ plan_id: p.key, plan_uuid: p.uuid, route_pattern: p.pattern, methods: p.methods, checkout_url: `${base}/_botgate/demo/checkout/${p.key}`, currency: "EUR", unit_price_minor: 0, unit_size: 1, status: p.active ? "active" as const : "pending" as const })),
  } as PolicyDocumentBody;
}

/** Decisión simulada: misma forma que DecisionResponse; la acción sigue la semántica observable de Central. */
function decide(site: Site, body: Record<string, unknown>, base: string): Record<string, unknown> {
  const path = normalizePath(typeof body.path === "string" ? body.path : "/");
  const method = typeof body.method === "string" ? body.method.toUpperCase() : "GET";
  // Como el motor real (engine.ts): la ruta licenciada coincide si su lista de métodos está vacía o contiene el método.
  const plan = site.plans.find((p) => (p.methods.length === 0 || p.methods.includes(method)) && matchGlob(p.glob, path));
  const reasons = (...codes: string[]) => [DEMO_REASON_CODE, ...codes];
  const out = (action: string, codes: string[], extra: Record<string, unknown> = {}) => ({ request_id: typeof body.request_id === "string" ? body.request_id : randomUUID(), action, risk_score: 0, reason_codes: codes, policy_version: site.version, ttl_seconds: 0, ...extra });
  // Igual que el motor real (ALLOW_TTL_SECONDS = 10): un allow de una ruta no licenciada es cacheable; nada más.
  if (!plan) return out("allow", reasons(), { ttl_seconds: 10 });
  if (!plan.active) return out("block", reasons("LICENSE_NOT_ACTIVE"));
  const payment = { plan_id: plan.key, checkout_url: `${base}/_botgate/demo/checkout/${plan.key}`, currency: "EUR", unit_price_minor: 0, unit_size: 1 };
  const token = typeof body.access_token === "string" ? body.access_token : null;
  if (!token) return out("payment_required", reasons("LICENSE_REQUIRED"), { payment });
  if (!DEMO_ACCESS_TOKEN_FORMAT.test(token)) return out("block", reasons("LICENSE_INVALID"));
  const grant = [...site.grants.values()].find((g) => g.token === token);
  if (!grant) return out("block", reasons("LICENSE_INVALID"));
  if (grant.revoked) return out("block", reasons("LICENSE_REVOKED"));
  if (grant.planKey !== plan.key) return out("payment_required", reasons("LICENSE_REQUIRED"), { payment });
  if (grant.remaining <= 0) return out("payment_required", reasons("QUOTA_EXHAUSTED"), { payment });
  grant.remaining -= 1;
  return out("allow", reasons("LICENSE_VALID"));
}

function grantsFor(site: Site): void {
  site.grants.clear();
  for (const p of site.plans) {
    for (const [suffix, remaining] of [["", 1_000_000], ["-revocable", 1_000_000], ["-cuota", p.quota]] as const) {
      const name = `${p.key}${suffix}`;
      site.grants.set(name, { name, planKey: p.key, token: `bgdev_${pick(B32, 8)}_${pick(ALNUM, 43)}`, remaining, revoked: false });
    }
  }
}

export const HELLO_PATH = "/_botgate/hello";

export async function startSimulator(opts: { sites: SiteConfig[]; port?: number; onShutdown?: () => void }): Promise<Simulator> {
  const sites = opts.sites.map(siteOf);
  if (new Set(sites.map((s) => s.app)).size !== sites.length) throw new Error("repeated demo apps");
  const adminToken = `bgdevadmin_${pick(ALNUM, 43)}`;
  const runId = `run_${pick(ALNUM, 16)}`;
  let outage = false;
  let base = "";

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.statusCode = status;
    res.setHeader(DEMO_MODE_HEADER, DEMO_MODE_VALUE);
    res.setHeader("cache-control", "no-store");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (body === null) { res.end(); return; }
    const text = JSON.stringify(body);
    res.setHeader("content-type", "application/json");
    res.end(text);
  };
  const problem = (res: ServerResponse, status: number, detail: string) => send(res, status, { type: "about:blank", title: "simulation", status, detail, mode: DEMO_MODE_VALUE });
  const readBody = (req: IncomingMessage) => new Promise<Record<string, unknown> | null>((ok) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { text += c; if (text.length > 256 * 1024) { req.destroy(); ok(null); } });
    req.on("end", () => { try { ok(text ? JSON.parse(text) as Record<string, unknown> : {}); } catch { ok(null); } });
    req.on("error", () => ok(null));
  });
  const bearer = (req: IncomingMessage) => /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Solo loopback, y Host de loopback (contra DNS rebinding).
    const remote = req.socket.remoteAddress ?? "";
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") || !isLoopbackHost(host)) return problem(res, 403, "the simulator only serves local requests");
    const url = new URL(req.url ?? "/", base);

    // Identificación sin credenciales (también durante una caída simulada): nunca devuelve secretos.
    if (req.method === "GET" && url.pathname === HELLO_PATH) return send(res, 200, { schema: SIMULATOR_SCHEMA, mode: DEMO_MODE_VALUE, run_id: runId, apps: sites.map((s) => s.app) });

    // Administración de pruebas (botgate.test-admin/v1).
    if (url.pathname.startsWith(`${TEST_ADMIN_PREFIX}/`)) {
      if (bearer(req) !== adminToken) return problem(res, 401, "invalid simulator administration token");
      const parts = url.pathname.slice(TEST_ADMIN_PREFIX.length + 1).split("/");
      if (req.method === "POST" && parts.length === 1 && parts[0] === "outage") {
        const b = await readBody(req);
        if (!b || (b.state !== "on" && b.state !== "off")) return problem(res, 400, "state must be on or off");
        outage = b.state === "on";
        return send(res, 200, { schema: SIMULATOR_SCHEMA, outage });
      }
      // Parada controlada (licenroute dev stop): responde y después avisa a quien lo arrancó, que borra sus ficheros.
      if (req.method === "POST" && parts.length === 1 && parts[0] === "shutdown") {
        if (!opts.onShutdown) return problem(res, 404, "this simulator does not accept a remote stop");
        send(res, 200, { schema: SIMULATOR_SCHEMA, stopping: true });
        setImmediate(opts.onShutdown);
        return;
      }
      const site = sites.find((s) => s.app === parts[1]);
      if (parts[0] !== "sites" || !site) return problem(res, 404, "unknown app in the simulator");
      const op = parts.slice(2).join("/");
      if (req.method === "GET" && op === "status") {
        return send(res, 200, {
          schema: SIMULATOR_SCHEMA,
          plans: site.plans.map((p) => ({ pattern: p.pattern, methods: p.methods, state: p.active ? "active" : "pending", quota: p.quota })),
          attestations: [...site.attestations.values()].map((a) => ({ sdk: "express", freshness: Date.now() - a.at < 180_000 ? "recent" : "stale", mode: a.mode, paths: a.paths })),
        });
      }
      if (req.method === "POST" && op === "activate") {
        const attested = [...site.attestations.values()].filter((a) => Date.now() - a.at < 180_000).flatMap((a) => a.paths);
        const result = site.plans.map((p) => {
          if (p.active) return { pattern: p.pattern, state: "already_active" };
          if (!attested.includes(p.pattern)) return { pattern: p.pattern, state: "not_attested" };
          p.active = true; site.version += 1;
          return { pattern: p.pattern, state: "activated" };
        });
        return send(res, 200, { schema: SIMULATOR_SCHEMA, activation: result });
      }
      // D4.1: decisión SIN token para un método y una ruta, sin pasar por la app (para comprobar métodos con efectos
      // secundarios sin enviarle escrituras). No consume cuota: sin token no hay licencia que gastar.
      if (req.method === "POST" && op === "decide") {
        const b = await readBody(req);
        const m = typeof b?.method === "string" ? b.method.toUpperCase() : "";
        if (!b || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(m) || typeof b.path !== "string" || !b.path.startsWith("/") || b.path.length > 500) return problem(res, 400, "valid method and path");
        const d = decide(site, { method: m, path: b.path }, base);
        return send(res, 200, { schema: SIMULATOR_SCHEMA, method: m, action: d.action, reason_codes: d.reason_codes });
      }
      if (req.method === "POST" && op === "grants") { grantsFor(site); return send(res, 200, { schema: SIMULATOR_SCHEMA, issued: [...site.grants.keys()] }); }
      const lic = /^licenses\/([a-z0-9-]{1,60})(\/revoke)?$/.exec(op);
      if (lic && NAME.test(lic[1]!)) {
        const grant = site.grants.get(lic[1]!);
        if (!grant) return send(res, 404, { schema: SIMULATOR_SCHEMA, error: "license_missing", available: [...site.grants.keys()].sort() });
        if (req.method === "GET" && !lic[2]) return send(res, 200, { schema: SIMULATOR_SCHEMA, token: grant.token });
        if (req.method === "POST" && lic[2]) { grant.revoked = true; return send(res, 200, { schema: SIMULATOR_SCHEMA, revoked: grant.name }); }
      }
      return problem(res, 404, "unknown administration operation");
    }

    // C1: lo que usa el SDK. Con la caída simulada, todo responde 503 (también la salud).
    if (outage) return problem(res, 503, "simulated outage of the decision service");
    if (req.method === "GET" && (url.pathname === "/health/live" || url.pathname === "/health/ready")) return send(res, 200, { status: "ok", mode: DEMO_MODE_VALUE });
    const key = bearer(req);
    if (key && REAL_API_KEY_FORMAT.test(key)) return problem(res, 401, "real LicenRoute credential: the simulator only accepts demo credentials (bg_dev_)");
    const site = key && DEMO_API_KEY_FORMAT.test(key) ? sites.find((s) => s.apiKey === key) : undefined;
    if (!site) return problem(res, 401, "unknown demo key");

    if (req.method === "GET" && url.pathname === "/v1/policies/current") {
      const document = policyOf(site, base);
      const checksum = canonicalSha256(document);
      const etag = `"sim-${site.version}"`;
      if (req.headers["if-none-match"] === etag) return send(res, 304, null, { etag });
      return send(res, 200, { ...document, checksum }, { etag });
    }
    if (req.method === "POST" && url.pathname === "/v1/sdk/attestations") {
      const b = await readBody(req);
      if (!b || typeof b.instance_id !== "string" || !Array.isArray(b.licensed_paths)) return problem(res, 400, "invalid attestation");
      site.attestations.set(String(b.instance_id).slice(0, 128), { paths: (b.licensed_paths as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 100), mode: b.without_policy === "deny" ? "deny" : "fallback", at: Date.now() });
      return send(res, 204, null);
    }
    if (req.method === "POST" && url.pathname === "/v1/decisions") {
      const b = await readBody(req);
      if (!b || b.site_id !== site.siteId) return problem(res, 403, "site_id does not match the demo key");
      if (typeof b.access_token === "string" && REAL_ACCESS_TOKEN_FORMAT.test(b.access_token)) return send(res, 200, { ...decide(site, { ...b, access_token: "x" }, base) });
      return send(res, 200, decide(site, b, base));
    }
    if (req.method === "POST" && url.pathname === "/v1/events/batch") { await readBody(req); return send(res, 202, { accepted: true, mode: DEMO_MODE_VALUE }); }
    return problem(res, 404, "unknown route in the simulator");
  };

  const server: Server = createServer((req, res) => { handle(req, res).catch(() => { try { problem(res, 500, "simulator internal error"); } catch { /* respuesta ya enviada */ } }); });
  await new Promise<void>((ok, ko) => { server.once("error", ko); server.listen(opts.port ?? 0, "127.0.0.1", () => ok()); });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    adminToken,
    runId,
    sites: sites.map((s) => ({ app: s.app, site_id: s.siteId, api_key: s.apiKey, endpoint: base })),
    setOutage: (on: boolean) => { outage = on; },
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
