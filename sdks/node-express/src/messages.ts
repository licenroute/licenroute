/**
 * Idioma de los mensajes del SDK (registros y errores de configuración), D4.4. Inglés por defecto; español completo.
 * Solo cambia TEXTO para personas: nunca decisiones, códigos de error HTTP, campos ni el comportamiento del middleware.
 *
 * Prioridad, la misma que la CLI (packages/cli/bin/i18n.mjs; test/i18n.test.ts de la CLI comprueba que coinciden):
 * LICENROUTE_LANG=en|es (un valor no soportado se ignora) > LC_ALL > LC_MESSAGES > LANG (la primera no vacía) > inglés.
 * Se resuelve en cada mensaje, con el entorno del proceso de la app.
 */
import { canonicalSha256, compileGlob, LICENSABLE_METHODS, type CompiledGlob } from "@licenroute/policy-contracts";

export type Lang = "en" | "es";

const en = {
  "api.http_status": "the API answered HTTP {status}",
  "api.invalid_decision": "decision with an invalid format",
  "api.invalid_json": "invalid JSON",
  "api.network_error": "network error",
  "api.not_json": "non-JSON response",
  "api.read_timeout": "timeout reading the response",
  "api.simulated_live": "simulated decision with real credentials",
  "api.simulator_live": "{what}: response from a simulator with real credentials",
  "api.unmarked_decision": "decision without the simulation code in demo mode",
  "api.unmarked_response": "{what}: response without the simulation marker in demo mode",
  "api.what.attestation": "attestation",
  "api.what.decision": "decision",
  "api.what.policy": "policy",
  "contracts.canonical_invalid": "the policy cannot be represented as canonical JSON (only safe integers, strings, booleans, lists and objects)",
  "contracts.entry_type": "each licensedPaths entry is a route (string) or { path, methods }",
  "contracts.method_not_licensable": "{path}: method {bad} cannot be licensed (only {allowed}; never OPTIONS)",
  "contracts.methods_list": "{path}: methods must be a non-empty list of methods ({allowed})",
  "contracts.path_type": "{ path, methods }: path must be a string",
  "contracts.pattern_invalid": "invalid pattern: {pattern}",
  "contracts.pattern_must_start": "invalid pattern (it must start with /): {pattern}",
  "ip.invalid_proxy": "invalid trusted proxy: {cidr}",
  "middleware.api_key_rejected": "API key rejected by LicenRoute (revoked or missing scope?)",
  "middleware.demo_mode": "LicenRoute in DEMO MODE (local simulation): it protects and charges nothing real; do not use it in production",
  "middleware.fallback": "decision unavailable: the fallback applies",
  "middleware.get_without_head": "licensedPaths declares GET without HEAD: HEAD will not require a licence on those routes (Express serves it with the GET handler)",
  "middleware.internal_error": "internal SDK error; the request continues",
  "middleware.uncovered_route": "declared paid route not covered by the published policy: denied (503) until a policy that protects it is published (F2)",
  "middleware.unsafe_config": "unsafe configuration: paid routes not declared in licensedPaths; without a trusted policy every protected route will be denied (BL-11)",
  "options.demo_endpoint_not_local": "demo credentials with an endpoint that is not local: only the simulator on 127.0.0.1, ::1 or localhost is accepted",
  "options.demo_in_production": "demo credentials in a production environment ({signals}): the SDK does not start",
  "options.demo_real_credentials": "{env}=demo with real credentials: demo mode only accepts demo credentials (bg_dev_, site_dev_)",
  "options.demo_without_env": "demo credentials without {env}=demo in the environment: the SDK does not start",
  "options.endpoint_https": "endpoint must use HTTPS; for development use localhost or allowInsecureEndpoint",
  "options.endpoint_invalid": "endpoint is not a valid URL",
  "options.fallback_invalid": "invalid fallback: {value} (use fail_open/allow or fail_closed/deny)",
  "options.identify_function": "identify must be a function (req) => id | null",
  "options.identify_secret": "identify requires identitySecret (the site identity key, ≥ {min} characters)",
  "options.key_invalid": "apiKey missing or with an invalid format",
  "options.licensed_paths": "licensedPaths: {message}",
  "options.licensed_paths_required": "licensedPaths is required: declare the paid routes from the dashboard (e.g. [\"/data/**\"] or [{ path: \"/data/**\", methods: [\"GET\", \"HEAD\"] }]) or [] if the site has none (BL-11)",
  "options.licensed_timeout": "licensedTimeoutMs must be between 1 and 10000",
  "options.mixed_credentials": "mixed credentials: apiKey and siteId must both be demo or both be real",
  "options.policy_max_age": "policyMaxAgeMs must be an integer >= 60000",
  "options.policy_sync_required": "policySync cannot be disabled with licensedPaths: the SDK needs the published policy to verify that the paid routes are protected (F2)",
  "options.site_invalid": "siteId missing or with an invalid format",
  "options.timeout": "timeoutMs must be between 1 and 10000",
  "options.without_policy": "withoutPolicy must be \"fallback\" or \"deny\"",
  "policy.attestation_not_sent": "attestation not sent",
  "policy.attestation_rejected": "attestation rejected by LicenRoute",
  "policy.bad_checksum": "invalid policy checksum",
  "policy.bad_verified_at": "invalid verified_at",
  "policy.not_saved": "the policy could not be saved to disk",
  "policy.other_site": "the policy belongs to another site",
  "policy.rejected": "policy rejected or unavailable; the previous one is kept",
  "policy.stale": "saved policy expired: only its paid routes are used (to close them)",
  "policy.sync_failed": "the policy could not be synchronised; the previous one is kept",
  "policy.unusable": "saved policy corrupt or from another site: ignored",
} as const;

export type MessageKey = keyof typeof en;

const es: Record<MessageKey, string> = {
  "api.http_status": "la API respondió HTTP {status}",
  "api.invalid_decision": "decisión con formato inválido",
  "api.invalid_json": "JSON inválido",
  "api.network_error": "error de red",
  "api.not_json": "respuesta no JSON",
  "api.read_timeout": "timeout leyendo la respuesta",
  "api.simulated_live": "decisión simulada con credenciales reales",
  "api.simulator_live": "{what}: respuesta de un simulador con credenciales reales",
  "api.unmarked_decision": "decisión sin el código de simulación en modo demo",
  "api.unmarked_response": "{what}: respuesta sin la marca de simulación en modo demo",
  "api.what.attestation": "atestación",
  "api.what.decision": "decisión",
  "api.what.policy": "política",
  "contracts.canonical_invalid": "la política no se puede representar como JSON canónico (solo enteros seguros, cadenas, booleanos, listas y objetos)",
  "contracts.entry_type": "cada entrada de licensedPaths es una ruta (cadena) o { path, methods }",
  "contracts.method_not_licensable": "{path}: método no licenciable {bad} (solo {allowed}; OPTIONS nunca)",
  "contracts.methods_list": "{path}: methods debe ser una lista no vacía de métodos ({allowed})",
  "contracts.path_type": "{ path, methods }: path debe ser una cadena",
  "contracts.pattern_invalid": "patrón inválido: {pattern}",
  "contracts.pattern_must_start": "patrón inválido (debe empezar por /): {pattern}",
  "ip.invalid_proxy": "proxy de confianza inválido: {cidr}",
  "middleware.api_key_rejected": "API key rechazada por LicenRoute (¿revocada o sin scope?)",
  "middleware.demo_mode": "LicenRoute en MODO DEMO (simulación local): no protege ni cobra nada real; no lo uses en producción",
  "middleware.fallback": "decisión no disponible: se aplica el fallback",
  "middleware.get_without_head": "licensedPaths declara GET sin HEAD: HEAD no exigirá licencia en esas rutas (Express lo atiende con el controlador de GET)",
  "middleware.internal_error": "error interno del SDK; la petición continúa",
  "middleware.uncovered_route": "ruta declarada de pago sin cobertura en la política publicada: se deniega (503) hasta publicar una política que la proteja (F2)",
  "middleware.unsafe_config": "configuración insegura: rutas de pago sin declarar en licensedPaths; sin política confiable se denegarán todas las rutas protegidas (BL-11)",
  "options.demo_endpoint_not_local": "credenciales de demo con un endpoint que no es local: solo se admite el simulador en 127.0.0.1, ::1 o localhost",
  "options.demo_in_production": "credenciales de demo en un entorno de producción ({signals}): el SDK no arranca",
  "options.demo_real_credentials": "{env}=demo con credenciales reales: el modo demo solo admite credenciales de demo (bg_dev_, site_dev_)",
  "options.demo_without_env": "credenciales de demo sin {env}=demo en el entorno: el SDK no arranca",
  "options.endpoint_https": "endpoint debe usar HTTPS; para desarrollo usa localhost o allowInsecureEndpoint",
  "options.endpoint_invalid": "endpoint no es una URL válida",
  "options.fallback_invalid": "fallback inválido: {value} (usa fail_open/allow o fail_closed/deny)",
  "options.identify_function": "identify debe ser una función (req) => id | null",
  "options.identify_secret": "identify requiere identitySecret (la clave de identidad del sitio, ≥ {min} caracteres)",
  "options.key_invalid": "apiKey ausente o con formato inválido",
  "options.licensed_paths": "licensedPaths: {message}",
  "options.licensed_paths_required": "licensedPaths es obligatorio: declara las rutas de pago del panel (p. ej. [\"/datos/**\"] o [{ path: \"/datos/**\", methods: [\"GET\", \"HEAD\"] }]) o [] si el sitio no tiene (BL-11)",
  "options.licensed_timeout": "licensedTimeoutMs debe estar entre 1 y 10000",
  "options.mixed_credentials": "credenciales mezcladas: apiKey y siteId deben ser las dos de demo o las dos reales",
  "options.policy_max_age": "policyMaxAgeMs debe ser un entero >= 60000",
  "options.policy_sync_required": "policySync no se puede desactivar con licensedPaths: el SDK necesita la política publicada para verificar que las rutas de pago están protegidas (F2)",
  "options.site_invalid": "siteId ausente o con formato inválido",
  "options.timeout": "timeoutMs debe estar entre 1 y 10000",
  "options.without_policy": "withoutPolicy debe ser \"fallback\" o \"deny\"",
  "policy.attestation_not_sent": "atestación no enviada",
  "policy.attestation_rejected": "atestación rechazada por LicenRoute",
  "policy.bad_checksum": "checksum de política inválido",
  "policy.bad_verified_at": "verified_at inválido",
  "policy.not_saved": "no se pudo guardar la política en disco",
  "policy.other_site": "la política pertenece a otro sitio",
  "policy.rejected": "política rechazada o no disponible; se mantiene la anterior",
  "policy.stale": "política guardada caducada: solo se usan sus rutas de pago (para cerrar)",
  "policy.sync_failed": "no se pudo sincronizar la política; se mantiene la anterior",
  "policy.unusable": "política guardada corrupta o de otro sitio: se ignora",
};

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, es };

function langOfLocale(value: string): Lang | null {
  const l = /^([a-z]{2})(?:[_.@-]|$)/i.exec(value)?.[1]?.toLowerCase();
  return l === "en" || l === "es" ? l : null;
}

/** Idioma de los mensajes con este entorno (misma prioridad que la CLI, sin --lang). */
export function messageLang(env: NodeJS.ProcessEnv = process.env): Lang {
  if (env.LICENROUTE_LANG === "en" || env.LICENROUTE_LANG === "es") return env.LICENROUTE_LANG;
  for (const k of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const v = env[k];
    if (v) return langOfLocale(v) ?? "en";
  }
  return "en";
}

/** Mensaje en el idioma del proceso; {nombre} se sustituye por params.nombre. */
export function m(key: MessageKey, params: Record<string, string | number> = {}): string {
  return MESSAGES[messageLang()][key].replace(/\{(\w+)\}/g, (s, name: string) => (name in params ? String(params[name]) : s));
}

// D4.4.1: los mensajes de @licenroute/policy-contracts (compartido con Central) están en español y el contrato no cambia.
// El SDK los presenta en el idioma del proceso eligiendo el texto por LA LLAMADA QUE FALLÓ Y SU ENTRADA, nunca por el
// texto del error. La decisión (rechazar) la sigue tomando el contrato; si algo no encaja, se conserva su mensaje.

/** compileGlob del contrato con el mensaje localizado. */
export function localizedGlob(pattern: string): CompiledGlob {
  try { return compileGlob(pattern); } catch (e) {
    if (typeof pattern === "string" && !pattern.trim().startsWith("/")) throw new Error(m("contracts.pattern_must_start", { pattern }), { cause: e });
    throw e;
  }
}

/** canonicalSha256 del contrato con el mensaje localizado (documentos de política recibidos). */
export function localizedChecksum(value: unknown): string {
  try { return canonicalSha256(value); } catch (e) { throw new Error(m("contracts.canonical_invalid"), { cause: e }); }
}

/** Por qué parseLicensedDeclaration rechazó esta entrada, con las mismas comprobaciones y en el idioma del proceso. */
export function declarationProblem(entry: unknown): string {
  const allowed = LICENSABLE_METHODS.join(", ");
  if (typeof entry === "string") return m("contracts.pattern_invalid", { pattern: entry.slice(0, 80) });
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return m("contracts.entry_type");
  const { path, methods } = entry as { path?: unknown; methods?: unknown };
  if (typeof path !== "string") return m("contracts.path_type");
  if (!Array.isArray(methods) || methods.length === 0 || methods.some((x) => typeof x !== "string")) return m("contracts.methods_list", { path: path.slice(0, 80), allowed });
  const bad = [...new Set((methods as string[]).map((x) => x.trim().toUpperCase()))].filter((x) => !(LICENSABLE_METHODS as readonly string[]).includes(x));
  if (bad.length) return m("contracts.method_not_licensable", { path: path.slice(0, 80), bad: bad.join(", ").slice(0, 40), allowed });
  return m("contracts.pattern_invalid", { pattern: path.slice(0, 80) }); // lo único que queda: normalizeLicensedPaths
}
