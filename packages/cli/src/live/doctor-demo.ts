/**
 * `licenroute doctor` con el proveedor demo (S10.2-B): simulador, puerto, credenciales, app e integración. El Sandbox
 * sigue igual (src/live/doctor.ts) cuando el proveedor es sandbox. Nada de lo que hay aquí certifica Central: los
 * resultados son de la SIMULACIÓN. El token de administración solo se envía a un simulador cuyo run_id coincide.
 */
import { loopbackOrigin, probeSimulator, RUN_ID_FORMAT, DEMO_ADMIN_TOKEN_FORMAT } from "../../bin/demo-common.mjs";
import type { DemoDoctorContext, DoctorContext, Finding } from "../doctor-static.ts";
import { appUrl, errorOf, example, get, loopbackUrl } from "./sandbox.ts";
import { demoTestAdmin } from "./test-admin.ts";
import { t } from "../../bin/i18n.mjs";

const short = (v: unknown, n = 300) => (typeof v === "string" ? [...v.slice(0, n)].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("") : "");

/** Viene de otro proceso: se valida como entrada externa. */
export function validDemoContext(raw: unknown): DemoDoctorContext | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>; const s = c.simulator as Record<string, unknown> | null | undefined;
  const simUrl = s ? loopbackOrigin(s.url) : null;
  return {
    simulator: s && simUrl && typeof s.admin_token === "string" && DEMO_ADMIN_TOKEN_FORMAT.test(s.admin_token) ? { url: simUrl, run_id: typeof s.run_id === "string" && RUN_ID_FORMAT.test(s.run_id) ? s.run_id : null, admin_token: s.admin_token } : null,
    appUrl: loopbackOrigin(c.appUrl), journalApp: typeof c.journalApp === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(c.journalApp) ? c.journalApp : null,
    envEndpoint: typeof c.envEndpoint === "string" ? short(c.envEndpoint, 200) : null,
    mode: (["demo", "real", "mixed", "none"] as const).find((m) => m === c.mode) ?? "none",
    reasons: Array.isArray(c.reasons) ? c.reasons.slice(0, 10).map((r) => short(r)) : [],
    productionSignals: Array.isArray(c.productionSignals) ? c.productionSignals.slice(0, 20).map((r) => short(r, 60)) : [],
    modeAssigned: c.modeAssigned === true,
  };
}

export async function demoDoctor(ctx: DoctorContext, d: DemoDoctorContext, opts: { app: string | null; baseUrl: string | null }): Promise<Finding[]> {
  const f: Finding[] = [];
  const add = (id: string, level: Finding["level"], message: string) => f.push({ id, level, message });
  add("proveedor", "info", t("doctor.demo.mode"));
  if (d.productionSignals.length) add("produccion", "fail", t("doctor.demo.production_signals", { p1: d.productionSignals.join(", ") }));
  if (d.modeAssigned) add("modo-en-fichero", "warn", t("doctor.demo.mode_in_env_file"));
  if (d.mode === "none") add("credenciales-demo", "fail", t("doctor.demo.no_credentials"));
  else if (d.mode === "real") add("credenciales-demo", "fail", t("doctor.demo.real_credentials"));
  else if (d.mode === "mixed") add("credenciales-demo", "fail", t("doctor.demo.mixed", { p1: d.reasons.join("; ") }));
  else add("credenciales-demo", "ok", t("doctor.demo.credentials_ok"));

  if (!d.simulator) { add("simulador", "fail", t("doctor.demo.simulator_not_running")); return f; }
  const probe = await probeSimulator(d.simulator.url, d.simulator.run_id);
  if (probe.state !== "running") {
    add("simulador", "fail", probe.state === "down" ? t("doctor.demo.simulator_down", { url: d.simulator.url }) : t("doctor.demo.impostor", { detail: probe.detail }));
    return f;
  }
  add("simulador", "ok", t("doctor.demo.simulator_at", { url: d.simulator.url, p2: d.simulator.run_id?.slice(0, 8) }));
  const envOrigin = d.envEndpoint ? loopbackOrigin(d.envEndpoint.replace(/\/+$/, "") + "/") : null;
  if (d.envEndpoint && envOrigin !== d.simulator.url) add("puerto", "fail", t("doctor.demo.wrong_port", { p1: short(d.envEndpoint, 80), url: d.simulator.url }));
  else if (d.envEndpoint) add("puerto", "ok", t("doctor.demo.points_to_simulator"));

  const app = opts.app ?? d.journalApp;
  if (app) {
    const admin = demoTestAdmin({ LICENROUTE_DEMO_ADMIN_URL: d.simulator.url, LICENROUTE_DEMO_ADMIN_TOKEN: d.simulator.admin_token });
    const st = "code" in admin ? null : await admin.siteStatus(app);
    if (!st || !st.ok) add("sitio-demo", "fail", t(probe.apps?.length ? "doctor.demo.app_missing_has" : "doctor.demo.app_missing", { app, apps: probe.apps?.join(", ") ?? "" }));
    else {
      for (const p of st.value.plans) add(`plan ${p.pattern}`, p.state === "active" ? "ok" : "info", p.state === "active" ? t("doctor.demo.plan_active", { quota: p.quota }) : t("doctor.demo.plan_pending"));
      const recent = st.value.attestations.filter((a) => a.freshness === "recent");
      add("atestacion", recent.length ? "ok" : "fail", recent.length ? t("doctor.demo.attested") : t("doctor.demo.not_attested"));
      for (const p of ctx.licensedPaths) if (!st.value.plans.some((x) => x.pattern === p)) add(`plan ${p}`, "fail", t("doctor.demo.plan_missing", { p }));
    }
  }

  const base = opts.baseUrl ?? d.appUrl;
  if (!base) { add("app", "warn", t("doctor.demo.app_unknown")); return f; }
  let baseUrl: URL;
  try { baseUrl = loopbackUrl(base); } catch (e) { add("app", "fail", (e as Error).message); return f; }
  if (!ctx.exampleRoute) { const h = await get(baseUrl.toString()); add("app", h.status === null ? "fail" : "ok", h.status === null ? t("doctor.demo.app_down", { origin: baseUrl.origin }) : t("doctor.demo.app_up", { origin: baseUrl.origin })); return f; }
  const h = await get(appUrl(baseUrl, example(ctx.exampleRoute)).toString());
  const e = errorOf(h);
  const [level, msg] = h.status === null ? ["fail", t("doctor.demo.app_down", { origin: baseUrl.origin })]
    : h.status === 402 ? ["ok", t("doctor.demo.paid_402")]
    : h.status === 503 && e === "licensed_route_not_covered" ? ["warn", t("doctor.demo.paid_503_not_covered")]
    : h.status === 503 ? ["fail", t("doctor.demo.paid_503")]
    : h.status >= 200 && h.status < 300 ? ["fail", t("doctor.demo.unprotected")]
    : ["warn", t("doctor.unexpected", { status: h.status })];
  add(`ruta-de-pago ${ctx.exampleRoute}`, level as Finding["level"], msg!);
  return f;
}
