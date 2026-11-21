/**
 * `licenroute connect` (S10.2-B): SOLO la interfaz y los estados de conexión. No guarda credenciales, no llama a
 * ningún servicio y no inventa endpoints de administración. Lo que aún no existe lo dice y termina con código 3.
 */
export const CONNECT_SCHEMA = "licenroute.cli.connect/v1";
import { t } from "../bin/i18n.mjs";
export type Target = "demo" | "self-hosted" | "cloud";
export interface ConnectTarget { id: Target; state: "available" | "not_implemented" | "unavailable"; summary: string; next: string[] }

// En una función: el texto depende del idioma elegido al arrancar (D4.4), no del de la carga del módulo.
const targetsOf = (): Record<Target, ConnectTarget> => ({
  demo: { id: "demo", state: "available", summary: t("connect.demo_desc"), next: ["licenroute dev .", "licenroute test ."] },
  "self-hosted": {
    id: "self-hosted", state: "not_implemented",
    summary: t("connect.self_hosted_desc"),
    next: [
      t("connect.self_hosted_step1"),
      t("connect.self_hosted_step2"),
      t("connect.self_hosted_step3"),
      t("connect.self_hosted_step4"),
    ],
  },
  cloud: { id: "cloud", state: "unavailable", summary: t("connect.cloud_desc"), next: [t("connect.cloud_step")] },
});

export function runConnect(target: Target | null, selfHostedUrl: string | null): { report: { schema: typeof CONNECT_SCHEMA; target: Target | null; targets: ConnectTarget[]; url_check: string | null }; code: number } {
  let urlCheck: string | null = null;
  if (target === "self-hosted" && selfHostedUrl !== null) {
    let u: URL | null = null; try { u = new URL(selfHostedUrl); } catch { /* inválida */ }
    urlCheck = !u ? t("connect.url_not_url") : u.username || u.password ? t("connect.url_credentials") : u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) ? t("connect.url_ok") : t("connect.url_https");
  }
  const all = targetsOf(); const targets = target ? [all[target]] : Object.values(all);
  return { report: { schema: CONNECT_SCHEMA, target, targets, url_check: urlCheck }, code: target && all[target].state !== "available" ? 3 : 0 };
}

export function renderConnect(r: ReturnType<typeof runConnect>["report"]): string {
  const STATE = { available: t("connect.available"), not_implemented: t("connect.not_implemented"), unavailable: t("connect.not_available") } as const;
  return [
    t("connect.header"),
    ...r.targets.flatMap((t) => [`  ${t.id.padEnd(12)} ${STATE[t.state]}: ${t.summary}`, ...t.next.map((n) => `               · ${n}`)]),
    ...(r.url_check ? [t("connect.url_line", { url_check: r.url_check })] : []),
  ].join("\n");
}
