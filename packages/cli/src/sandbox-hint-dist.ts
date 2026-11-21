/**
 * Los mismos textos, para el paquete compilado. No nombran el repositorio ni lanzan el Sandbox.
 * Repositorio público (L6): sin localizador; `{where}` remite al modo demo.
 */
import { t } from "../bin/i18n.mjs";

const where = () => t("hint.locator");

export function credentialHint(envFile: string, app: string): string {
  return t("hint.no_env_file", { envFile, app, where: where() });
}

export function centralDownHint(endpoint: string): string {
  return t("hint.central_down", { endpoint, where: where() });
}

export function planStateHint(state: string, quota: number, app: string): string {
  if (state === "active") return t("hint.charge_active", { quota });
  return t("hint.charge_inactive", { state, app, where: where() });
}

export function missingPlanHint(path: string, app: string): string {
  return t("hint.missing_plan", { path, app, where: where() });
}

export function sandboxMissingHint(instance: string, app: string): string {
  return t("hint.no_sandbox_instance", { instance, app, where: where() });
}

export function doctorSandboxMissingHint(instance: string, app: string): string {
  return sandboxMissingHint(instance, app);
}

export function quotaHint(_key: string, _pattern: string, quota: number): string {
  return t("hint.quota_high", { quota, where: where() });
}

export function applyNextSandbox(app: string, planArgs: string): string {
  return t("hint.no_sandbox_apply", { app, p2: planArgs ? `; ${planArgs}` : "", where: where() });
}

export function residualSandbox(instance: string, app: string): string {
  return t("hint.sandbox_keeps", { instance, app, where: where() });
}
