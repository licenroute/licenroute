/**
 * botgate.test-admin/v1 (S10.1): lo que `licenroute test` necesita de la administración de pruebas, sin saber qué
 * servicio hay detrás. Repositorio público (L6): un solo proveedor, el simulador en loopback (@licenroute/simulator), con
 * resultados SIMULATED que nunca certifican Central. No hay cliente del Sandbox privado ni de un Central remoto.
 * Ningún proveedor imprime tokens.
 */
import { probeSimulator, RUN_ID_FORMAT } from "../../bin/demo-common.mjs";
import { DEMO_ACCESS_TOKEN_FORMAT, isLoopbackHost } from "./demo-formats.ts";
import type { AppStatus } from "./sandbox-types.ts";
import { t } from "../../bin/i18n.mjs";

export const TEST_ADMIN_CONTRACT = "botgate.test-admin/v1";
export type Verification = "verified" | "simulated";
export type ActivationState = "activated" | "already_active" | "not_attested";
export type AdminError = { code: "unavailable" | "unsupported" | "license_missing" | "invalid" | "refused"; message: string };
export type AdminResult<T> = { ok: true; value: T } | { ok: false; error: AdminError };

export interface TestAdmin {
  readonly contract: typeof TEST_ADMIN_CONTRACT;
  readonly provider: "demo";
  /** Qué demuestra un escenario que pasa con este proveedor. */
  readonly verification: Verification;
  siteStatus(app: string): Promise<AdminResult<AppStatus>>;
  activate(app: string): Promise<AdminResult<{ pattern: string; state: ActivationState }[]>>;
  issueLicenses(app: string): Promise<AdminResult<null>>;
  license(app: string, name: string): Promise<AdminResult<string>>;
  revoke(app: string, name: string): Promise<AdminResult<null>>;
  /** Caída del servicio de decisiones y vuelta: con Central real, la Decision API; en demo, el simulador. */
  outage(state: "on" | "off"): Promise<AdminResult<null>>;
  /** Licencia con el formato de este servicio, que no existe (para comprobar el 403). */
  forgedToken(): string;
  /**
   * D4.1: decisión SIN licencia para un método y una ruta, preguntada al servicio de decisiones sin pasar por la app
   * (para métodos con efectos secundarios, que licenroute test nunca envía a la app). Sin ella: cobertura parcial.
   */
  decide?(app: string, method: string, path: string): Promise<AdminResult<string>>;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;
const ok = <T>(value: T): AdminResult<T> => ({ ok: true, value });
const err = (code: AdminError["code"], message: string): AdminResult<never> => ({ ok: false, error: { code, message: message.slice(0, 500) } });

/** Simulador local (modo demo): solo una URL de loopback y su token de administración por ejecución. */
export function demoTestAdmin(env: NodeJS.ProcessEnv = process.env): TestAdmin | AdminError {
  const rawUrl = env.LICENROUTE_DEMO_ADMIN_URL ?? ""; const token = env.LICENROUTE_DEMO_ADMIN_TOKEN ?? "";
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { code: "invalid", message: t("admin.url_invalid") }; }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.pathname !== "/" || url.username || url.password || url.search) return { code: "refused", message: t("admin.loopback_only") };
  if (!/^bgdevadmin_[A-Za-z0-9]{43}$/.test(token)) return { code: "invalid", message: t("admin.token_format") };
  const base = `${url.origin}/_botgate/test-admin/v1`;
  // Con el run_id del fichero del proyecto (licenroute dev), el token solo se envía si quien escucha es ESE simulador.
  const runId = env.LICENROUTE_DEMO_ADMIN_RUN_ID;
  if (runId !== undefined && !RUN_ID_FORMAT.test(runId)) return { code: "invalid", message: t("admin.run_id_invalid") };
  let identity: Promise<AdminResult<null>> | null = null;
  const identify = () => (identity ??= runId === undefined ? Promise.resolve(ok(null)) : probeSimulator(url.origin, runId).then((p) => (p.state === "running" ? ok(null) : err(p.state === "down" ? "unavailable" : "refused", t("admin.impostor", { detail: p.detail })))));
  const call = async (method: string, path: string, body?: unknown): Promise<AdminResult<Record<string, unknown>>> => {
    const who = await identify();
    if (!who.ok) return who;
    try {
      const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (r.headers.get("botgate-mode") !== "simulation") return err("refused", t("admin.not_simulator"));
      const json = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (r.status === 404 && json?.error === "license_missing") return err("license_missing", t("admin.licence_missing", { issued: (json.available as string[] | undefined)?.join(", ") || t("common.none") }));
      if (r.status !== 200 || !json) return err("unavailable", t("admin.status", { status: r.status }));
      return ok(json);
    } catch (e) { return err("unavailable", t("admin.no_response", { name: (e as Error).name })); }
  };
  const app = (a: string) => (NAME.test(a) ? a : null);
  return {
    contract: TEST_ADMIN_CONTRACT, provider: "demo", verification: "simulated",
    siteStatus: async (a) => { if (!app(a)) return err("invalid", t("admin.app_invalid")); const r = await call("GET", `/sites/${a}/status`); return r.ok ? ok({ plans: r.value.plans as AppStatus["plans"], attestations: r.value.attestations as AppStatus["attestations"] }) : r; },
    activate: async (a) => { if (!app(a)) return err("invalid", t("admin.app_invalid")); const r = await call("POST", `/sites/${a}/activate`); return r.ok ? ok(r.value.activation as { pattern: string; state: ActivationState }[]) : r; },
    issueLicenses: async (a) => { if (!app(a)) return err("invalid", t("admin.app_invalid")); const r = await call("POST", `/sites/${a}/grants`); return r.ok ? ok(null) : r; },
    license: async (a, n) => {
      if (!app(a) || !NAME.test(n)) return err("invalid", t("admin.app_or_licence_invalid"));
      const r = await call("GET", `/sites/${a}/licenses/${n}`);
      if (!r.ok) return r;
      return typeof r.value.token === "string" && DEMO_ACCESS_TOKEN_FORMAT.test(r.value.token) ? ok(r.value.token) : err("refused", t("admin.not_demo_licence"));
    },
    revoke: async (a, n) => { if (!app(a) || !NAME.test(n)) return err("invalid", t("admin.app_or_licence_invalid")); const r = await call("POST", `/sites/${a}/licenses/${n}/revoke`); return r.ok ? ok(null) : r; },
    outage: async (state) => { const r = await call("POST", "/outage", { state }); return r.ok ? ok(null) : r; },
    forgedToken: () => `bgdev_abcdefgh_${"x".repeat(43)}`,
    decide: async (a, method, path) => {
      if (!app(a) || !/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method) || !path.startsWith("/") || path.length > 500) return err("invalid", t("admin.decision_invalid"));
      const r = await call("POST", `/sites/${a}/decide`, { method, path });
      return r.ok ? (typeof r.value.action === "string" ? ok(r.value.action) : err("refused", t("admin.decision_no_action"))) : r;
    },
  };
}

/**
 * Prioridad: BOTGATE_TEST_PROVIDER explícito (solo `demo`); si no, el simulador que licenroute-simulator dejó anotado en
 * el proyecto (.licenroute/demo-admin.json, leído por la fase estática); si no, LICENROUTE_DEMO_ADMIN_URL. Sin simulador
 * no hay proveedor: no se recurre a ningún otro servicio. Un fichero del proyecto solo puede llevar a resultados SIMULATED
 * (loopback y marca de simulación obligatorios).
 */
export function selectTestAdmin(_instance: string, env: NodeJS.ProcessEnv = process.env, demoAdmin: { url?: unknown; admin_token?: unknown; run_id?: unknown } | null = null): TestAdmin | AdminError {
  const p = env.BOTGATE_TEST_PROVIDER;
  if (p !== undefined && p !== "demo") return { code: "invalid", message: t("admin.provider_invalid", { p }) };
  if (p === undefined && demoAdmin && typeof demoAdmin.url === "string" && typeof demoAdmin.admin_token === "string") {
    return demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: demoAdmin.url, LICENROUTE_DEMO_ADMIN_TOKEN: demoAdmin.admin_token, ...(typeof demoAdmin.run_id === "string" ? { LICENROUTE_DEMO_ADMIN_RUN_ID: demoAdmin.run_id } : {}) });
  }
  if (p === undefined && !env.LICENROUTE_DEMO_ADMIN_URL) return { code: "unavailable", message: t("admin.no_simulator") };
  return demoTestAdmin(env);
}
