// Modo demo (S10.2-B): lo que comparten los lanzadores (JS sin compilar) y la CLI (TS, que lo importa y esbuild lo
// incluye). Copia mínima de packages/policy-contracts/src/demo.ts: con el modelo de permisos, la CLI solo lee su propio
// paquete. test/dev.test.ts falla si deja de coincidir con el original. Nada de aquí lee ni devuelve secretos.
import { connect } from "node:net";
import { t } from "./i18n.mjs";

export const DEMO_API_KEY_FORMAT = /^bg_dev_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
export const DEMO_SITE_ID_FORMAT = /^site_dev_[A-Za-z0-9]{8,24}$/;
export const DEMO_ACCESS_TOKEN_FORMAT = /^bgdev_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
export const REAL_API_KEY_FORMAT = /^bg_(live|test)_[a-z2-7]{8}_[A-Za-z0-9]{43}$/;
export const DEMO_ADMIN_TOKEN_FORMAT = /^bgdevadmin_[A-Za-z0-9]{43}$/;
export const RUN_ID_FORMAT = /^run_[A-Za-z0-9]{16}$/;
export const HELLO_PATH = "/_botgate/hello";
export const SIMULATOR_SCHEMA = "botgate.simulator/v1";
export const PRODUCTION_SIGNALS = ["KUBERNETES_SERVICE_HOST", "ECS_CONTAINER_METADATA_URI", "ECS_CONTAINER_METADATA_URI_V4", "AWS_EXECUTION_ENV", "AWS_LAMBDA_FUNCTION_NAME", "K_SERVICE", "FUNCTION_TARGET", "WEBSITE_INSTANCE_ID", "DYNO", "FLY_APP_NAME", "RENDER", "RAILWAY_ENVIRONMENT", "VERCEL", "NETLIFY", "HEROKU_APP_ID"];

export function productionSignals(env) {
  const found = PRODUCTION_SIGNALS.filter((k) => env[k] !== undefined && env[k] !== "");
  if (env.NODE_ENV === "production") found.unshift("NODE_ENV=production");
  return found;
}

export function isLoopbackHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/** Qué tipo de credencial es, sin devolverla nunca. */
export function keyKind(v) {
  if (v === undefined || v === null || v === "") return "missing";
  if (DEMO_API_KEY_FORMAT.test(v)) return "demo";
  if (REAL_API_KEY_FORMAT.test(v)) return "real";
  return "unknown";
}
export function siteKind(v) {
  if (v === undefined || v === null || v === "") return "missing";
  if (DEMO_SITE_ID_FORMAT.test(v)) return "demo";
  return /^site_[A-Za-z0-9]{8,40}$/.test(v) ? "real" : "unknown";
}

/** http://127.0.0.1:<puerto> (o ::1, localhost) sin ruta, usuario ni consulta; si no, null. */
export function loopbackOrigin(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== "http:" || !isLoopbackHost(u.hostname) || !u.port || (u.pathname !== "/" && u.pathname !== "") || u.username || u.password || u.search || u.hash) return null;
  return u.origin;
}

/**
 * ¿Quién escucha en esa URL? Sin enviar ninguna credencial (GET /_botgate/hello):
 *   running    el simulador de ESTA ejecución (mismo run_id que el fichero del proyecto)
 *   other-run  un simulador de LicenRoute, pero de otra ejecución (no se le envía el token)
 *   impostor   responde algo que no es el simulador
 *   down       nadie responde
 */
export async function probeSimulator(url, runId, timeoutMs = 1500) {
  const origin = loopbackOrigin(url);
  if (!origin) return { state: "impostor", detail: t("probe.not_loopback") };
  let r;
  try { r = await fetch(`${origin}${HELLO_PATH}`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
  catch { return { state: "down", detail: t("probe.nobody", { origin }) }; }
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || r.headers.get("botgate-mode") !== "simulation" || body?.schema !== SIMULATOR_SCHEMA || typeof body.run_id !== "string") return { state: "impostor", detail: t("probe.not_simulator", { origin }) };
  if (body.run_id !== runId) return { state: "other-run", detail: t("probe.other_run", { origin }) };
  return { state: "running", detail: t("probe.simulator_at", { origin }), apps: Array.isArray(body.apps) ? body.apps.filter((a) => typeof a === "string").slice(0, 10) : [] };
}

/** ¿Algo acepta conexiones en 127.0.0.1:<puerto>? */
export function portBusy(port, timeoutMs = 800) {
  return new Promise((done) => {
    const s = connect({ host: "127.0.0.1", port });
    const end = (busy) => { s.destroy(); done(busy); };
    s.setTimeout(timeoutMs, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

export function validPort(v) { return /^\d{4,5}$/.test(String(v)) && Number(v) >= 1024 && Number(v) <= 65535; }
