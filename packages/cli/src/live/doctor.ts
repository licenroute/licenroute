/**
 * `licenroute doctor`, parte ACTIVA (S6): Central, Sandbox y la app local. Repositorio público (L6): no lanza ningún proceso;
 * SIN poder leer el proyecto: recibe de la parte estática solo un contexto pequeño, que se valida aquí. Distingue
 * `licensed_route_not_covered` de `service_unavailable` y mide la latencia sin cambiar ningún timeout.
 */
import type { DoctorContext, Finding } from "../doctor-static.ts";
import { centralDownHint, doctorSandboxMissingHint, missingPlanHint, planStateHint } from "../sandbox-hint.ts";
import { validDemoContext, demoDoctor } from "./doctor-demo.ts";
import { apiPort, appStatus, appUrl, errorOf, example, get, loopbackUrl, sandboxDetail } from "./sandbox.ts";
import { t } from "../../bin/i18n.mjs";

const TIMEOUT_MS = 200; const LICENSED_TIMEOUT_MS = 1000; // valores por defecto de los SDK
const PATTERN = /^\/[A-Za-z0-9/_.*-]{0,200}$/;

/** El contexto viene de otro proceso: se valida como cualquier entrada externa. */
export function validContext(raw: unknown): DoctorContext {
  const c = raw as Partial<DoctorContext> | null;
  if (!c || typeof c !== "object") throw new Error(t("doctor.invalid_context"));
  const lp = Array.isArray(c.licensedPaths) ? c.licensedPaths.filter((p): p is string => typeof p === "string" && PATTERN.test(p)).slice(0, 50) : [];
  return {
    framework: c.framework === "express" || c.framework === "rails" ? c.framework : null,
    licensedPaths: lp,
    exampleRoute: typeof c.exampleRoute === "string" && c.exampleRoute.length > 0 && c.exampleRoute.length <= 500 && !/[\u0000-\u001f\u007f]/.test(c.exampleRoute) ? c.exampleRoute : null,
    endpoint: typeof c.endpoint === "string" ? c.endpoint.slice(0, 200) : null,
    envInstance: typeof c.envInstance === "string" && /^[a-z0-9-]{1,30}$/.test(c.envInstance) ? c.envInstance : null,
    demo: validDemoContext(c.demo),
  };
}

export async function liveDoctor(ctx: DoctorContext, opts: { app: string | null; instance: string; baseUrl: string | null }): Promise<Finding[]> {
  const f: Finding[] = [];
  const add = (id: string, level: Finding["level"], message: string) => f.push({ id, level, message });
  if (!ctx.framework) return f;
  if (ctx.demo) return [...f, ...(await demoDoctor(ctx, ctx.demo, opts))];

  let endpoint = ctx.endpoint && (() => { try { return loopbackUrl(ctx.endpoint!).origin; } catch { return null; } })();
  if (!endpoint) { const port = apiPort(opts.instance); endpoint = port ? `http://127.0.0.1:${port}` : null; }
  if (!endpoint) add("central", "warn", t("doctor.no_api_url"));
  else {
    const samples: number[] = []; let down = false;
    for (let i = 0; i < 5; i++) { const h = await get(`${endpoint}/health/ready`); if (h.status !== 200) { down = true; break; } samples.push(h.ms); }
    if (down) add("central", "fail", centralDownHint(endpoint));
    else {
      const sorted = [...samples].sort((a, b) => a - b); const max = sorted[sorted.length - 1]!; const med = sorted[Math.floor(sorted.length / 2)]!;
      add("central", "ok", t("doctor.central_ok", { endpoint, med, max }));
      add("latencia", max > TIMEOUT_MS / 2 ? "warn" : "ok", t(max > TIMEOUT_MS / 2 ? "doctor.latency_high" : "doctor.latency", { max, timeout: TIMEOUT_MS, licensed: LICENSED_TIMEOUT_MS }));
    }
  }

  if (opts.app) {
    const st = appStatus(opts.instance, opts.app);
    if (!st) add("sandbox", "fail", [doctorSandboxMissingHint(opts.instance, opts.app), sandboxDetail()].filter(Boolean).join(" "));
    else {
      for (const p of st.plans) add(`plan ${p.pattern}`, p.state === "active" ? "ok" : "warn", planStateHint(p.state, p.quota, opts.app!));
      const recent = st.attestations.filter((a) => a.freshness === "recent");
      add("atestacion", recent.length ? "ok" : "warn", recent.length ? t("doctor.attesting", { count: recent.length, modes: recent.map((a) => t(a.mode === "deny" ? "doctor.mode_strict" : "doctor.mode_fallback")).join(", ") }) : t("doctor.no_attestation"));
      for (const p of ctx.licensedPaths) if (!st.plans.some((x) => x.pattern === p)) add(`plan ${p}`, "fail", missingPlanHint(p, opts.app!));
    }
  }

  if (opts.baseUrl && ctx.licensedPaths.length) {
    const base = loopbackUrl(opts.baseUrl);
    const ready = await get(appUrl(base, "/health/ready").toString());
    if (ready.status === 503) add("app-preparada", "warn", t("doctor.ready_503"));
    if (!ctx.exampleRoute) add("ruta-de-pago", "info", t("doctor.no_route_to_test"));
    else {
      let routeUrl: string;
      try { routeUrl = appUrl(base, example(ctx.exampleRoute)).toString(); }
      catch (e) { add(`ruta-de-pago ${ctx.exampleRoute}`, "fail", t("doctor.no_request_sent", { message: (e as Error).message })); return f; }
      const h = await get(routeUrl);
      const e = errorOf(h);
      const [level, msg] = h.status === null ? ["fail", t("doctor.app_down", { origin: base.origin })]
        : h.status === 402 ? ["ok", t("doctor.paid_402")]
        : h.status === 403 ? ["warn", t("doctor.paid_403")]
        : h.status === 503 && e === "licensed_route_not_covered" ? ["warn", t("doctor.paid_503_not_covered")]
        : h.status === 503 && e === "service_unavailable" ? ["warn", t("doctor.paid_503_unavailable", { ms: h.ms })]
        : h.status >= 200 && h.status < 300 ? ["fail", t("doctor.unprotected")]
        : ["warn", t("doctor.unexpected", { status: h.status })];
      add(`ruta-de-pago ${ctx.exampleRoute}`, level as Finding["level"], msg!);
    }
  }
  return f;
}
