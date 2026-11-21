import type { IncomingMessage, ServerResponse } from "node:http";
import { DEMO_ACCESS_TOKEN_FORMAT, IDENTITY_MAX_ID_LENGTH, identityHash, matchGlob, normalizePath, type DecisionRequest } from "@licenroute/policy-contracts";
import { DecisionUnavailableError, requestDecision, type Decision } from "./api-client.ts";
import { CircuitBreaker } from "./circuit-breaker.ts";
import { buildTrustList, resolveClientIp } from "./client-ip.ts";
import { DecisionCache } from "./decision-cache.ts";
import { resolveFallback } from "./fallback.ts";
import { declarationMatches, declarationsCover, requestCovered, uncoveredDeclarations } from "@licenroute/policy-contracts";
import { resolveOptions, type LicenRouteOptions } from "./options.ts";
import { PolicySync } from "./policy-sync.ts";
import { requestIdFor } from "./request-id.ts";
import { UncertainLicensedRequests } from "./uncertain-licensed-requests.ts";
import { m } from "./messages.ts";

const SUPPORTED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ACCESS_TOKEN = /^bgat_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
// En demo solo se reenvían licencias de demo; una bgat_ real nunca llega al simulador (y al revés).
/** Retry-After cuando el SDK cierra por fallback: el servicio, no el cliente, falla. */
export const FALLBACK_RETRY_SECONDS = 5;

export interface LicenRouteRequestInfo {
  requestId: string;
  decision: Decision | null;
  /** true si se aplicó el fallback porque la API no dio una decisión utilizable. */
  fallback: boolean;
  cached: boolean;
}

type Req = IncomingMessage & { originalUrl?: string; licenroute?: LicenRouteRequestInfo };
type Next = (err?: unknown) => void;
export type LicenRouteMiddleware = ((req: IncomingMessage, res: ServerResponse, next: Next) => void) & {
  close(): void;
  policy: PolicySync | null;
  /** true cuando hay una política verificada y vigente. Úsalo en el health check de la app. */
  ready(): boolean;
};

/** Middleware Connect/Express (4 y 5) de LicenRoute Connect. */
export function licenroute(options: LicenRouteOptions): LicenRouteMiddleware {
  const opts = resolveOptions(options);
  const trustList = buildTrustList(opts.trustedProxies);
  const breaker = new CircuitBreaker(opts.breaker);
  const uncertainLicensed = new UncertainLicensedRequests();
  const cache = opts.cache ? new DecisionCache(opts.cache.maxEntries, opts.cache.maxTtlSeconds) : null;
  const policy = opts.policySyncMs === null
    ? null
    : new PolicySync({
      fetch: opts.fetch, endpoint: opts.endpoint, apiKey: opts.apiKey, siteId: opts.siteId, timeoutMs: opts.timeoutMs, logger: opts.logger,
      maxAgeMs: opts.policyMaxAgeMs, cachePath: opts.policyCachePath, mode: opts.mode,
      attestation: { instanceId: opts.instanceId, licensedPaths: opts.licensedPathPatterns, withoutPolicy: opts.withoutPolicy, identityKeyId: opts.identity?.keyId ?? null },
    });
  policy?.start(opts.policySyncMs!);
  // D4.1: los métodos se comparan exactamente. Express atiende HEAD con el controlador de GET: sin HEAD declarado,
  // un HEAD llega a la ruta de pago sin licencia (sin cuerpo, pero ejecutando el controlador).
  const getWithoutHead = opts.licensedDeclarations.filter((d) => d.methods.includes("GET") && !d.methods.includes("HEAD")).map((d) => d.pattern);
  if (getWithoutHead.length) opts.logger.warn({ patterns: getWithoutHead }, m("middleware.get_without_head"));
  if (opts.mode === "demo") opts.logger.warn({ endpoint: opts.endpoint }, m("middleware.demo_mode"));

  // BL-11: rutas de pago de la política (con sus métodos) que licensedPaths no declara -> configuración insegura.
  let checkedRoutes: unknown = null;
  let missingLicensed: string[] = [];
  const unsafeConfig = (): boolean => {
    if (!policy || opts.withoutPolicy === "deny") return false;
    const known = policy.fallbackState().knownLicensed;
    if (checkedRoutes !== known) {
      checkedRoutes = known;
      missingLicensed = known.filter((r) => !declarationsCover(opts.licensedPaths, { pattern: r.glob.pattern, methods: r.methods })).map((r) => r.glob.pattern);
      if (missingLicensed.length > 0) {
        opts.logger.error({ missing: missingLicensed }, m("middleware.unsafe_config"));
      }
    }
    return missingLicensed.length > 0;
  };

  const effectiveFallback = (path: string, method: string, hasToken: boolean) =>
    resolveFallback(
      { localLicensed: opts.licensedPaths, ...(policy?.fallbackState() ?? { knownLicensed: [], trusted: null }), withoutPolicy: opts.withoutPolicy, unsafeConfig: unsafeConfig(), routeFallbacks: opts.routeFallbacks, fallback: opts.fallback },
      { path, method, hasToken },
    );

  // F2 (EVAL-01/02): una ruta DECLARADA de pago solo se sirve si la política verificada la protege efectivamente.
  // D4.1: «declarada» es ruta Y método; un POST bajo un patrón declarado solo para GET no es de pago.
  const isDeclaredLicensed = (path: string, method: string) => opts.licensedPaths.some((d) => declarationMatches(d, path, method, matchGlob));
  const coveredByPolicy = (path: string, method: string): boolean => {
    const t = policy?.trusted();
    return t ? requestCovered(t.licensed, path, method, matchGlob) : false;
  };
  let lastUncoveredLog = 0;
  const logUncovered = (path: string) => {
    if (Date.now() - lastUncoveredLog < 60_000) return;
    lastUncoveredLog = Date.now();
    opts.logger.error({ path, version: policy?.version ?? null }, m("middleware.uncovered_route"));
  };

  /** Una ruta de pago nunca queda fuera de LicenRoute, aunque una exclusión o protectedPaths la dejen fuera. Las rutas
   *  de pago de la política se miran sin método (solo hacen que se consulte a LicenRoute, nunca abren nada). */
  const isLicensedPath = (path: string, method: string) =>
    isDeclaredLicensed(path, method) || (policy?.fallbackState().knownLicensed.some((l) => matchGlob(l.glob, path)) ?? false);

  const handler = async (req: Req, res: ServerResponse, next: Next): Promise<void> => {
    // Ruta CRUDA (sin query); la API vuelve a normalizarla. Localmente se normaliza para exclusiones.
    const rawPath = (req.originalUrl ?? req.url ?? "/").split("?")[0] || "/";
    const path = normalizePath(rawPath);
    const method = (req.method ?? "GET").toUpperCase();
    if ((opts.excludedPaths.some((g) => matchGlob(g, path)) || policy?.isExcluded(path) || !opts.protectedPaths.some((g) => matchGlob(g, path))) && !isLicensedPath(path, method)) {
      return next();
    }

    const requestId = requestIdFor(req.headers["x-request-id"]);
    res.setHeader("X-Request-Id", requestId);
    if (opts.mode === "demo") res.setHeader("BotGate-Mode", "demo-simulation");
    const info: LicenRouteRequestInfo = { requestId, decision: null, fallback: false, cached: false };
    req.licenroute = info;

    // Token de comprador para rutas licenciadas (Fase 5). Solo se reenvía un token bgat_ válido;
    // nunca otra credencial de la app. Se retira de la petición: la app no lo necesita y no debe registrarlo.
    const accessToken = takeAccessToken(req, opts.mode === "demo" ? DEMO_ACCESS_TOKEN_FORMAT : ACCESS_TOKEN);

    const applyFallback = (reason: string, details: Record<string, unknown> = {}) => {
      info.fallback = true;
      const { fallback, reason: fallbackReason } = effectiveFallback(path, method, accessToken !== null);
      opts.logger.warn({ ...details, reason, fallback, fallback_reason: fallbackReason, request_id: requestId }, m("middleware.fallback"));
      if (fallback === "fail_open") return next();
      return send(res, 503, { error: "service_unavailable", request_id: requestId }, { "Retry-After": String(FALLBACK_RETRY_SECONDS) });
    };

    // F2, capa 1: ruta declarada de pago que la política verificada (vigente) no cubre -> cerrada, sin preguntar.
    const declaredLicensed = isDeclaredLicensed(path, method);
    const notCovered = () => {
      logUncovered(path);
      info.fallback = true;
      return send(res, 503, { error: "licensed_route_not_covered", request_id: requestId }, { "Retry-After": String(UNCOVERED_RETRY_SECONDS) });
    };
    if (declaredLicensed && !coveredByPolicy(path, method)) return notCovered();

    const ip = resolveClientIp(req.socket?.remoteAddress, req.headers["x-forwarded-for"], trustList);
    if (!ip || !SUPPORTED_METHODS.has(method)) return applyFallback(!ip ? "ip_no_resoluble" : "metodo_no_soportado");

    const userAgent = (req.headers["user-agent"] ?? "").slice(0, 512) || null;
    const signals: DecisionRequest["signals"] = {};
    if (opts.sessionCookies.length > 0) signals.session_present = hasAnyCookie(req.headers.cookie, opts.sessionCookies);
    const authenticated = opts.isAuthenticated?.(req);
    if (typeof authenticated === "boolean") signals.authenticated_user = authenticated;

    // Fase 10: identidad SOLO desde identify() (el servidor de la app); jamás desde la petición.
    let identity: DecisionRequest["identity"];
    if (opts.identify && opts.identity) {
      const id = opts.identify(req);
      if (typeof id === "string" && id.length > 0 && id.length <= IDENTITY_MAX_ID_LENGTH) {
        identity = { hash: identityHash(opts.identity.secret, opts.siteId, id), key_id: opts.identity.keyId };
      }
    }

    const cacheKey = cache && !accessToken && !declaredLicensed ? JSON.stringify([method, path, ip, userAgent, signals.session_present ?? null, signals.authenticated_user ?? null, identity?.hash ?? null]) : "";
    // Con token o en una ruta declarada de pago, nunca caché: cada petición se decide con la política vigente.
    const cached = accessToken || declaredLicensed ? undefined : cache?.get(cacheKey);
    if (cached) {
      info.decision = cached;
      info.cached = true;
      return next();
    }

    // BL-16: a previously uncertain licensed request gets a bounded recovery attempt.
    // Extend ONLY that attempt's deadline; brand-new requests keep the configured timeout.
    const recoveryAttempt = declaredLicensed && accessToken !== null &&
      uncertainLicensed.consume(requestId, method, path, accessToken);
    const breakerAllowed = breaker.allowRequest();
    if (!breakerAllowed && !recoveryAttempt) return applyFallback("circuit_breaker_abierto");

    // Solo metadatos: nunca cookies, Authorization, cuerpo ni query string (F3-07).
    const body: DecisionRequest = {
      request_id: requestId,
      site_id: opts.siteId,
      timestamp: new Date().toISOString(),
      method: method as DecisionRequest["method"],
      path: rawPath,
      client: { ip, user_agent: userAgent },
      ...(Object.keys(signals).length > 0 ? { signals } : {}),
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(identity ? { identity } : {}),
    };

    let decision: Decision;
    try {
      decision = await requestDecision(opts.fetch, opts.endpoint, opts.apiKey, accessToken ? (recoveryAttempt ? Math.max(1_000, opts.licensedTimeoutMs) : opts.licensedTimeoutMs) : opts.timeoutMs, body,
        unsafeConfig() ? { "botgate-sdk-warning": "licensed-paths-missing" } : {}, opts.mode);
      if (breakerAllowed) breaker.success();
      uncertainLicensed.forget(requestId);
    } catch (error) {
      if (!(error instanceof DecisionUnavailableError)) throw error;
      if (breakerAllowed) breaker.failure();
      if (declaredLicensed && accessToken !== null && (error.status === null || error.status === 200 || error.status >= 500)) {
        uncertainLicensed.mark(requestId, method, path, accessToken);
      }
      if (error.status === 401 || error.status === 403) opts.logger.error({ status: error.status }, m("middleware.api_key_rejected"));
      return applyFallback(error.message, { status: error.status });
    }

    info.decision = decision;
    // F2, capa 2: LicenRoute permitió una ruta declarada de pago SIN licencia válida (p. ej. el propietario retiró el
    // plan y la copia local de la política aún no lo sabe): se cierra igualmente.
    if (declaredLicensed && decision.action === "allow" && !decision.reason_codes.includes("LICENSE_VALID")) return notCovered();
    if (cache && !accessToken && !declaredLicensed) cache.set(cacheKey, decision);
    switch (decision.action) {
      case "allow":
        return next();
      case "rate_limit":
        return send(res, 429, { error: "rate_limited", retry_after_seconds: decision.retry_after_seconds ?? 1, request_id: requestId }, {
          "Retry-After": String(decision.retry_after_seconds ?? 1),
        });
      case "payment_required":
        return send(res, 402, { error: "payment_required", request_id: requestId, payment: decision.payment ?? null });
      default:
        // block, y challenge mientras no haya proveedor de desafío (plan §4).
        return send(res, 403, { error: "forbidden", request_id: requestId });
    }
  };

  const middleware = ((req: IncomingMessage, res: ServerResponse, next: Next) => {
    // next() se invoca como mucho una vez, aunque el SDK falle después de llamarlo.
    let passed = false;
    const once: Next = (err) => {
      if (passed) return;
      passed = true;
      next(err);
    };
    handler(req as Req, res, once).catch((error: unknown) => {
      // Fallo interno del SDK: nunca debe tumbar la app. Se registra y la petición continúa.
      opts.logger.error({ err: (error as Error).message }, m("middleware.internal_error"));
      if (!res.headersSent) once();
    });
  }) as LicenRouteMiddleware;
  middleware.close = () => { policy?.stop(); uncertainLicensed.clear(); };
  middleware.policy = policy;
  // Para el health check de la app: no recibir tráfico hasta tener una política confiable (BL-11) que además
  // cubra TODAS las rutas declaradas de pago (F2).
  middleware.ready = () => {
    const t = policy?.trusted();
    return t != null && uncoveredDeclarations(t.licensed, opts.licensedDeclarations).length === 0;
  };
  return middleware;
}

const UNCOVERED_RETRY_SECONDS = 30;

function send(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

/** Extrae y retira el token de comprador (BotGate-Access-Token o Authorization: Bearer bgat_…). */
function takeAccessToken(req: IncomingMessage, format: RegExp): string | null {
  const explicit = req.headers["botgate-access-token"];
  if (typeof explicit === "string") {
    delete req.headers["botgate-access-token"];
    if (format.test(explicit.trim())) return explicit.trim();
  }
  const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (bearer && format.test(bearer)) {
    delete req.headers.authorization;
    return bearer;
  }
  return null;
}

/** Presencia de alguna de las cookies indicadas. Su valor nunca se lee ni se envía. */
function hasAnyCookie(header: string | undefined, names: string[]): boolean {
  if (!header) return false;
  const present = new Set(header.split(";").map((c) => c.split("=", 1)[0]!.trim()));
  return names.some((n) => present.has(n));
}
