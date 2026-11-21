import { createHash } from "node:crypto";
import type { Category } from "./schema.ts";
import { tc } from "../bin/i18n.mjs";

/** Texto del proyecto -> imprimible: sin caracteres de control (ni secuencias ANSI), recortado. */
export function sanitize(text: string, max = 160): string {
  // eslint-disable-next-line no-control-regex -- se eliminan justamente los caracteres de control
  const clean = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// eslint-disable-next-line no-control-regex -- se detectan justamente los caracteres de control
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Ruta del proyecto -> VALOR funcional (S10.2-D2). El valor nunca se sanea: una ruta con caracteres de control o de
 * dirección, o demasiado larga, no se puede representar sin ambigüedad y queda en null (sin resolver), con el motivo.
 * Para mostrarla, displayPath(). Antes se sustituían esos caracteres por «?» y el texto saneado acababa en un patrón
 * de licencia distinto de la ruta real.
 */
export function safePath(path: string | null): { path: string | null; rejected: string | null } {
  if (path === null) return { path, rejected: null };
  if (CONTROL_OR_BIDI.test(path)) return { path: null, rejected: tc("util.path_control_chars") };
  if (path.length > 500) return { path: null, rejected: tc("util.path_too_long") };
  return { path, rejected: null };
}

/** Solo para PANTALLA: caracteres de control o de dirección visibles como «?». Nunca para comparar ni para patrones. */
/**
 * D4.1 (F-D4-3): cómo se MUESTRA una dependencia declarada del SDK. Una ruta `file:` relativa puede ser larguísima,
 * dejar ver el directorio de la persona y cortarse antes del nombre del paquete: se muestra solo `file:…/<fichero>`.
 * Es solo presentación (el JSON conserva el valor completo; ni el diff ni el código de aprobación dependen de esto).
 */
export function sdkSpecLabel(spec: string): string {
  const m = /^file:(.*\/)?([^/]+)$/.exec(spec);
  return displayPath(m ? `file:${m[1] ? "…/" : ""}${m[2]}` : spec);
}

export function displayPath(path: string): string {
  const shown = path.replace(new RegExp(CONTROL_OR_BIDI.source, "g"), "?");
  return shown.length > 120 ? `${shown.slice(0, 119)}…` : shown;
}

/**
 * ¿Puede esta ruta convertirse en un patrón de licencia que el SDK compare igual que Express o Rails? null si sí; si no,
 * el motivo. Solo ASCII imprimible sin espacios ni `% ? # \ ;`: el SDK decodifica `%`, corta en `?` y `#`, trata `\`
 * como `/`, descarta lo que sigue a `;` y no normaliza Unicode (un literal NFD no coincidiría con una petición NFC).
 */
// D4.4.2: el motivo es solo texto para mostrar; quien llama decide por `!== null`, nunca por el texto (puede estar vacío).
export function unplannablePath(path: string): string | null {
  if (CONTROL_OR_BIDI.test(path)) return tc("util.pattern_control_chars");
  if (/[^\x21-\x7e]/.test(path)) return tc("util.pattern_non_ascii");
  if (/[%?#\\;]/.test(path)) return tc("util.pattern_special");
  if (!path.startsWith("/")) return tc("util.pattern_no_slash");
  return null;
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function routeId(framework: string, method: string, path: string | null, file: string, line: number): string {
  return `r_${sha256(`${framework}\n${method}\n${path ?? ""}\n${file}\n${line}`).slice(0, 12)}`;
}

/** Une segmentos de ruta como lo hace un montaje: "/api" + "/items/:id" -> "/api/items/:id". */
/**
 * Ruta comodín de Express (`*`, `/*splat`, `(.*)`): puede atender cualquier ruta bajo su prefijo, así que nunca entra
 * sola en un plan. D4.4.1: la decisión se toma con la ruta (marco y path), nunca leyendo una nota o un texto.
 */
export const EXPRESS_WILDCARD = /(?:^|\/)\*|\(\.\*\)/;
export function isWildcardRoute(r: { framework: string; category: string; path: string | null }): boolean {
  // express.static(...) se declara como «<prefijo>/**»: son estáticos (excluidos aparte), no una ruta comodín.
  return r.framework === "express" && r.category !== "static" && r.path !== null && EXPRESS_WILDCARD.test(r.path);
}

export function joinPaths(...parts: string[]): string {
  const joined = parts.filter((p) => p !== "" && p !== "/").map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return `/${joined}`;
}

/** JSON canónico (claves ordenadas): base de los hashes del plan. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const HEALTH = /^\/(?:health(?:z|check)?|healthcheck|up|ready|readiness|live|liveness|ping|status|metrics|_health)(?:\/|$)/i;
const AUTH = /(?:^|\/)(?:login|logout|log-in|log-out|signin|sign-in|signout|sign-out|sign_in|sign_out|signup|sign-up|sign_up|register|registration|registrations|session|sessions|oauth2?|auth|authenticate|password|passwords|reset-password|forgot-password|token|tokens|verify-email|confirmation|confirmations|unlock|2fa|mfa|otp|saml|sso|openid|\.well-known)(?:\/|$)/i;
const WEBHOOK = /(?:^|\/)(?:webhooks?|hooks?|callbacks?|stripe|github-events|ipn|notify|notifications\/incoming)(?:\/|$)/i;
const STATIC = /(?:^|\/)(?:assets|static|public|packs|images|img|css|js|fonts|uploads)(?:\/|$)|\.(?:css|js|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|txt|xml|webmanifest)$|^\/(?:favicon\.ico|robots\.txt|sitemap\.xml|manifest\.json)$/i;
const ADMIN = /(?:^|\/)(?:admin|administrator|backoffice|dashboard|internal|sidekiq|jobs|cable|rails\/|_debug|debug)(?:[/.]|$)/i;
const API = /(?:^|\/)(?:api|v\d+|graphql|rpc)(?:\/|$)/i;

/** Clasificación heurística: el orden importa (salud y autenticación nunca son candidatas). */
export function classify(path: string | null, method: string): Category {
  if (path === null) return "other";
  if (HEALTH.test(path)) return "health";
  if (WEBHOOK.test(path)) return "webhook";
  if (AUTH.test(path)) return "auth";
  if (STATIC.test(path)) return "static";
  if (ADMIN.test(path)) return "admin";
  if (API.test(path)) return "api";
  if (method === "GET" || method === "HEAD" || method === "ALL") return "page";
  return "other";
}

export const AUTH_MIDDLEWARE = /(?:auth|authenticate|authorize|authorise|requireuser|requirelogin|ensureloggedin|isloggedin|loggedin|isauthenticated|jwt|passport|session|verifytoken|checktoken|protect|guard|currentuser)/i;
