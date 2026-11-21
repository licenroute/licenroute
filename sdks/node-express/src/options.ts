import { hostname } from "node:os";
import { DEMO_MODE_ENV, IDENTITY_SECRET_MIN_LENGTH, identityKeyId, InvalidLicensedDeclaration, isDemoApiKey, isDemoSiteId, isLoopbackHost, parseLicensedDeclaration, productionSignals, type CompiledGlob, type Fallback, type LicensedDeclaration } from "@licenroute/policy-contracts";
import { declarationProblem, localizedGlob, m } from "./messages.ts";

export type FallbackOption = Fallback | "allow" | "deny";

/** Entrada de `licensedPaths`: patrón (todos los métodos) o patrón con sus métodos (D4.1). */
export type LicensedPathEntry = string | { path: string; methods: string[] };

export interface Logger {
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface LicenRouteOptions {
  /** API key del sitio (`bg_<env>_<prefix>_<secret>`). Solo en variables de entorno del servidor. */
  apiKey: string;
  /** `site_...` del sitio (dashboard). */
  siteId: string;
  /** URL base de la Decision API. HTTPS obligatorio salvo localhost o `allowInsecureEndpoint`. */
  endpoint: string;
  /** Tiempo máximo por decisión remota. Por defecto 200 ms. */
  timeoutMs?: number;
  /**
   * Tiempo máximo para peticiones CON token de comprador (rutas licenciadas). Por defecto 1000 ms.
   * Esas rutas son siempre fail_closed: abandonar a los 200 ms solo produce un 503 y, si la API
   * ya estaba cobrando, un cargo sin entrega (medido en la Fase 7).
   */
  licensedTimeoutMs?: number;
  /** Fallback global si la API no responde: `fail_open`/`allow` (defecto) o `fail_closed`/`deny`. */
  fallback?: FallbackOption;
  /** Fallback por ruta (glob -> fallback), p. ej. `{ "/login": "fail_closed" }`. */
  routeFallbacks?: Record<string, FallbackOption>;
  /**
   * OBLIGATORIO (BL-11). Rutas de pago (glob), tal como aparecen en los planes del panel, o `[]` si el
   * sitio no tiene ninguna. Si LicenRoute no responde, estas rutas se deniegan (503) SIEMPRE: también en
   * la primera instalación, sin política descargada y con la API caída.
   *
   * Cada entrada es un patrón (TODOS los métodos, como hasta 0.6.0) o `{ path, methods }` (D4.1): solo esos métodos
   * exigen licencia; el resto de métodos en esa ruta sigue su camino normal (p. ej. un POST con autenticación propia).
   * Métodos: GET, HEAD, POST, PUT, PATCH, DELETE, comparados exactamente como en la política: GET no implica HEAD
   * (Express atiende HEAD con el controlador de GET: decláralos juntos). OPTIONS no se puede licenciar.
   */
  licensedPaths: LicensedPathEntry[];
  /**
   * Sin política confiable (nunca descargada, corrupta o caducada): `"fallback"` (por defecto) aplica
   * el fallback configurado; `"deny"` deniega todas las rutas protegidas. Recomendado `"deny"` en
   * sitios con monetización.
   */
  withoutPolicy?: "fallback" | "deny";
  /** Fichero donde guardar la última política verificada (sobrevive a reinicios). Opcional. */
  policyCachePath?: string;
  /** Antigüedad máxima de una política sin reverificar. Por defecto 24 h. */
  policyMaxAgeMs?: number;
  /**
   * Identificador de esta instancia en las atestaciones (BL-11). Por defecto, el nombre del host.
   * Debe ser estable entre reinicios y distinto por instancia (p. ej. el nombre del pod o del contenedor).
   */
  instanceId?: string;
  /** Rutas evaluadas por LicenRoute (glob). Por defecto todas. */
  protectedPaths?: string[];
  /** Rutas que nunca se consultan (se suman a las del servidor). */
  excludedPaths?: string[];
  /** CIDR de proxies de confianza para X-Forwarded-For. Vacío = no se confía en ninguno. */
  trustedProxies?: string[];
  /** Nombres de cookie cuya PRESENCIA indica sesión (nunca se envía su valor). */
  sessionCookies?: string[];
  /** Devuelve si el usuario está autenticado en la app (señal opcional). */
  isAuthenticated?: (req: unknown) => boolean | undefined;
  /**
   * LicenRoute Trust (Fase 10): id INTERNO del usuario o de la sesión AUTENTICADA POR TU SERVIDOR (p. ej.
   * `req.user?.id` tras tu middleware de autenticación), o null si es anónimo. NUNCA un valor tomado de
   * una cabecera, cookie o parámetro sin verificar: un cliente podría suplantar a otro usuario y
   * gastar su cuota. El SDK envía solo un seudónimo (HMAC con `identitySecret`), nunca el id.
   */
  identify?: (req: unknown) => string | null | undefined;
  /**
   * Clave de identidad del SITIO (panel -> Sitio -> Clave de identidad; ≥ 32 caracteres). La misma en
   * todas las instancias. Obligatoria si se usa `identify`. Variable de entorno, nunca en el código.
   */
  identitySecret?: string;
  /** Caché de decisiones `allow` con ttl_seconds > 0. `false` la desactiva. */
  decisionCache?: { maxEntries?: number; maxTtlSeconds?: number } | false;
  /** Apertura inicial `openMs` (2 s), que se duplica mientras las pruebas fallan, hasta `maxOpenMs` (10 s). */
  circuitBreaker?: { failureThreshold?: number; windowMs?: number; openMs?: number; maxOpenMs?: number };
  /** Sincronización de la política publicada (fallbacks por regla, exclusiones). `false` la desactiva. */
  policySync?: { intervalMs?: number } | false;
  allowInsecureEndpoint?: boolean;
  logger?: Logger;
  /** Inyectable para pruebas. */
  fetch?: typeof fetch;
}

export const DEFAULT_EXCLUDED_PATHS = ["/health*/**", "/up", "/assets/**", "/favicon.ico", "/robots.txt"];
const API_KEY_FORMAT = /^bg_(live|test)_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
const SITE_ID_FORMAT = /^site_[A-Za-z0-9]{4,32}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface ResolvedOptions {
  /** "demo" solo con credenciales de demo, LICENROUTE_MODE=demo, endpoint de loopback y sin señales de producción. */
  mode: "live" | "demo";
  apiKey: string;
  siteId: string;
  endpoint: string;
  timeoutMs: number;
  licensedTimeoutMs: number;
  fallback: Fallback | null;
  routeFallbacks: { glob: CompiledGlob; fallback: Fallback }[];
  protectedPaths: CompiledGlob[];
  /** Declaraciones locales de pago con sus métodos (vacío = todos). */
  licensedPaths: LicensedDeclaration[];
  withoutPolicy: "fallback" | "deny";
  policyCachePath: string | null;
  policyMaxAgeMs: number;
  instanceId: string;
  /** Patrones normalizados, sin duplicados (para la atestación: el contrato C1 solo lleva rutas). */
  licensedPathPatterns: string[];
  /** Patrones con sus métodos (vacío = todos), para la cobertura F2. */
  licensedDeclarations: { pattern: string; methods: string[] }[];
  excludedPaths: CompiledGlob[];
  trustedProxies: string[];
  sessionCookies: string[];
  isAuthenticated?: (req: unknown) => boolean | undefined;
  identify?: (req: unknown) => string | null | undefined;
  identity: { secret: string; keyId: string } | null;
  cache: { maxEntries: number; maxTtlSeconds: number } | null;
  breaker: { failureThreshold: number; windowMs: number; openMs: number; maxOpenMs: number };
  policySyncMs: number | null;
  logger: Logger;
  fetch: typeof fetch;
}

/** Identificador de instancia válido para la API: [A-Za-z0-9._:-], 1–128 caracteres. */
export function sanitizeInstanceId(value: string): string {
  const id = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
  return id || "instancia";
}

export function normalizeFallback(value: FallbackOption): Fallback {
  if (value === "allow" || value === "fail_open") return "fail_open";
  if (value === "deny" || value === "fail_closed") return "fail_closed";
  throw new LicenRouteConfigError(m("options.fallback_invalid", { value: String(value) }));
}

export class LicenRouteConfigError extends Error {}

/**
 * Modo demo (S10.1): simulación local, nunca autorización real. Se activa SOLO si se cumple todo a la vez; si falla
 * cualquier condición, el SDK no arranca (no se degrada a otro modo):
 *  1. apiKey Y siteId con formato de demo (bg_dev_ / site_dev_), sin mezclar con credenciales reales;
 *  2. LICENROUTE_MODE=demo en el entorno del proceso (segundo factor, independiente del .env de credenciales);
 *  3. endpoint de loopback (127.0.0.1, ::1 o localhost);
 *  4. ninguna señal de producción (NODE_ENV=production o variables de plataformas de despliegue).
 * Al revés, LICENROUTE_MODE=demo con credenciales reales también es un error: no se mezclan modos.
 */
function resolveMode(options: LicenRouteOptions, url: URL, env: Record<string, string | undefined>): "live" | "demo" {
  const demoKey = isDemoApiKey(options.apiKey); const demoSite = isDemoSiteId(options.siteId);
  if (!demoKey && !demoSite) {
    if (env[DEMO_MODE_ENV] === "demo") throw new LicenRouteConfigError(m("options.demo_real_credentials", { env: DEMO_MODE_ENV }));
    return "live";
  }
  if (!demoKey || !demoSite) throw new LicenRouteConfigError(m("options.mixed_credentials"));
  if (env[DEMO_MODE_ENV] !== "demo") throw new LicenRouteConfigError(m("options.demo_without_env", { env: DEMO_MODE_ENV }));
  const signals = productionSignals(env);
  if (signals.length) throw new LicenRouteConfigError(m("options.demo_in_production", { signals: signals.join(", ") }));
  if (!isLoopbackHost(url.hostname)) throw new LicenRouteConfigError(m("options.demo_endpoint_not_local"));
  return "demo";
}

export function resolveOptions(options: LicenRouteOptions, env: Record<string, string | undefined> = process.env): ResolvedOptions {
  let url: URL;
  try {
    url = new URL(options.endpoint);
  } catch {
    throw new LicenRouteConfigError(m("options.endpoint_invalid"));
  }
  const mode = resolveMode(options, url, env);
  if (mode === "live" && !API_KEY_FORMAT.test(options.apiKey ?? "")) throw new LicenRouteConfigError(m("options.key_invalid"));
  if (mode === "live" && !SITE_ID_FORMAT.test(options.siteId ?? "")) throw new LicenRouteConfigError(m("options.site_invalid"));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (LOCAL_HOSTS.has(url.hostname) || options.allowInsecureEndpoint))) {
    throw new LicenRouteConfigError(m("options.endpoint_https"));
  }
  const timeoutMs = options.timeoutMs ?? 200;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new LicenRouteConfigError(m("options.timeout"));
  if (!Array.isArray(options.licensedPaths)) {
    throw new LicenRouteConfigError(m("options.licensed_paths_required"));
  }
  // D4.4.1: el contrato decide si la entrada es válida; el SDK solo elige el texto, por la entrada que falló.
  const declarations: { pattern: string; methods: string[] }[] = options.licensedPaths.map((entry) => {
    try { return parseLicensedDeclaration(entry); } catch (e) {
      if (e instanceof InvalidLicensedDeclaration || e instanceof Error) throw new LicenRouteConfigError(m("options.licensed_paths", { message: declarationProblem(entry) }));
      throw e;
    }
  });
  // F2: sin sincronizar la política no se puede verificar que las rutas de pago estén protegidas.
  if (options.policySync === false && options.licensedPaths.length > 0) {
    throw new LicenRouteConfigError(m("options.policy_sync_required"));
  }
  if (options.withoutPolicy !== undefined && !["fallback", "deny"].includes(options.withoutPolicy)) {
    throw new LicenRouteConfigError(m("options.without_policy"));
  }
  const policyMaxAgeMs = options.policyMaxAgeMs ?? 24 * 3_600_000;
  if (!Number.isInteger(policyMaxAgeMs) || policyMaxAgeMs < 60_000) throw new LicenRouteConfigError(m("options.policy_max_age"));
  const licensedTimeoutMs = options.licensedTimeoutMs ?? Math.max(1_000, timeoutMs);
  if (!Number.isInteger(licensedTimeoutMs) || licensedTimeoutMs < 1 || licensedTimeoutMs > 10_000) {
    throw new LicenRouteConfigError(m("options.licensed_timeout"));
  }

  if (options.identify !== undefined) {
    if (typeof options.identify !== "function") throw new LicenRouteConfigError(m("options.identify_function"));
    if (typeof options.identitySecret !== "string" || options.identitySecret.length < IDENTITY_SECRET_MIN_LENGTH) {
      throw new LicenRouteConfigError(m("options.identify_secret", { min: IDENTITY_SECRET_MIN_LENGTH }));
    }
  }

  return {
    mode,
    apiKey: options.apiKey,
    siteId: options.siteId,
    endpoint: url.toString().replace(/\/+$/, ""),
    timeoutMs,
    licensedTimeoutMs,
    fallback: options.fallback === undefined ? null : normalizeFallback(options.fallback),
    routeFallbacks: Object.entries(options.routeFallbacks ?? {}).map(([pattern, fb]) => ({ glob: localizedGlob(pattern), fallback: normalizeFallback(fb) })),
    protectedPaths: (options.protectedPaths ?? ["/**"]).map(localizedGlob),
    licensedPaths: declarations.map((d) => ({ glob: localizedGlob(d.pattern), methods: new Set(d.methods) })),
    withoutPolicy: options.withoutPolicy ?? "fallback",
    policyCachePath: options.policyCachePath ?? null,
    policyMaxAgeMs,
    instanceId: sanitizeInstanceId(options.instanceId ?? hostname()),
    licensedPathPatterns: [...new Set(declarations.map((d) => d.pattern))],
    licensedDeclarations: declarations,
    excludedPaths: (options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS).map(localizedGlob),
    trustedProxies: options.trustedProxies ?? [],
    sessionCookies: options.sessionCookies ?? [],
    isAuthenticated: options.isAuthenticated,
    identify: options.identify,
    identity: options.identify && options.identitySecret ? { secret: options.identitySecret, keyId: identityKeyId(options.identitySecret) } : null,
    cache: options.decisionCache === false ? null : { maxEntries: options.decisionCache?.maxEntries ?? 10_000, maxTtlSeconds: options.decisionCache?.maxTtlSeconds ?? 60 },
    breaker: { failureThreshold: 5, windowMs: 10_000, openMs: 2_000, maxOpenMs: 10_000, ...options.circuitBreaker },
    policySyncMs: options.policySync === false ? null : (options.policySync?.intervalMs ?? 60_000),
    logger: options.logger ?? consoleLogger,
    fetch: options.fetch ?? globalThis.fetch,
  };
}

/* eslint-disable no-console -- logger por defecto del SDK */
const consoleLogger: Logger = {
  warn: (details, message) => console.warn(`[licenroute] ${message}`, details),
  error: (details, message) => console.error(`[licenroute] ${message}`, details),
};
/* eslint-enable no-console */
