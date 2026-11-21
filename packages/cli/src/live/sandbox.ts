/**
 * Peticiones GET de `test` y `doctor` a la app LOCAL del desarrollador. Repositorio público (L6): `sandbox-backend.ts`
 * es un módulo inerte, sin Sandbox, el mismo en el código fuente y en el paquete compilado.
 */
export type { AppStatus } from "./sandbox-types.ts";
import { t } from "../../bin/i18n.mjs";
export { apiPort, appStatus, sandboxDetail } from "./sandbox-backend.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Solo apps locales: nunca servicios externos ni producción. */
export function loopbackUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(t("sandbox.base_url_invalid", { raw })); }
  if (!["http:", "https:"].includes(u.protocol) || !LOOPBACK.has(u.hostname) || u.username || u.password) throw new Error(t("sandbox.base_url_not_local", { origin: u.origin }));
  return u;
}

/**
 * Ruta de un proyecto o del diario, tratada como entrada no confiable. Rechaza `//`, barras invertidas (Node las
 * interpreta como `/` y una ruta `/\host` sale del loopback) y cualquier resolución cuyo origen no sea exactamente
 * el de `base`. No llama a la red.
 */
export function appUrl(base: URL, path: string): URL {
  if (typeof path !== "string" || path.length === 0 || path.length > 500) throw new Error(t("sandbox.path_rejected"));
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(t("sandbox.path_not_origin"));
  if (path.includes("\\") || /%5c/i.test(path)) throw new Error(t("sandbox.path_backslash"));
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error(t("sandbox.path_rejected"));
  const u = new URL(path, base);
  if (u.origin !== base.origin || u.username || u.password || !LOOPBACK.has(u.hostname)) throw new Error(t("sandbox.path_other_origin", { origin: u.origin, origin_: base.origin }));
  return u;
}

/** Destino a punto de pedirse. Con credencial, el origen tiene que ser exactamente el autorizado. */
export function assertLoopbackDestination(raw: string, token?: string, authorizedOrigin?: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(t("sandbox.url_invalid")); }
  if (!["http:", "https:"].includes(u.protocol) || !LOOPBACK.has(u.hostname) || u.username || u.password) throw new Error(t("sandbox.outside_loopback", { origin: u.origin }));
  if (token && u.origin !== authorizedOrigin) throw new Error(t("sandbox.credential_not_sent"));
  return u;
}

export interface Hit { status: number | null; error: string | null; body: string; ms: number }
/** GET con límite de tiempo. `redirect: "manual"`: un 3xx no se sigue, ni siquiera si Location sigue en loopback. */
/** D4.1: solo métodos SIN efectos secundarios. Las escrituras nunca se envían a la app de la persona. */
export type SafeMethod = "GET" | "HEAD" | "OPTIONS";
export async function get(url: string, token?: string, authorizedOrigin?: string, method: SafeMethod = "GET"): Promise<Hit> {
  const refused = refuse(url, token, authorizedOrigin);
  if (refused) return refused;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) return { status: null, error: t("sandbox.method_rejected"), body: "", ms: 0 };
  const h = await getOnce(url, token, authorizedOrigin, method);
  // El cliente de Node puede reutilizar una conexión keep-alive que el servidor acaba de cerrar (UND_ERR_SOCKET):
  // se reintenta UNA vez, solo sin licencia (con licencia, un reintento podría contar dos usos de la cuota).
  if (!token && h.status === null && /UND_ERR_SOCKET|ECONNRESET/.test(h.error ?? "")) return getOnce(url, token, authorizedOrigin, method);
  return h;
}
function refuse(url: string, token?: string, authorizedOrigin?: string): Hit | null {
  try { assertLoopbackDestination(url, token, authorizedOrigin); return null; }
  catch (e) { return { status: null, error: (e as Error).message, body: "", ms: 0 }; }
}
async function getOnce(url: string, token?: string, authorizedOrigin?: string, method: SafeMethod = "GET"): Promise<Hit> {
  const refused = refuse(url, token, authorizedOrigin);
  if (refused) return refused;
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, redirect: "manual", headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000) });
    const body = (await res.text()).slice(0, 2000);
    return { status: res.status, error: null, body, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: null, error: (e as Error).cause ? String(((e as Error).cause as { code?: string }).code ?? (e as Error).message) : (e as Error).name, body: "", ms: Math.round(performance.now() - t0) };
  }
}
export const errorOf = (h: Hit): string | null => { try { return (JSON.parse(h.body) as { error?: string }).error ?? null; } catch { return null; } };
export const example = (path: string) => path.replace(/\{[^}]*\}/g, "").replace(/\([^)]*\)/g, "").replace(/:(\w+)/g, (_m, n: string) => (/id$/.test(n) ? "1" : "ejemplo")).replace(/\*\w*/g, "x");
export const planKey = (pattern: string) => pattern.replace(/\/\*\*$/, "").replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "raiz";
