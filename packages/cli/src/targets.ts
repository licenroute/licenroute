// Repositorio público (D4.3): LicenRoute solo escribe integraciones Express 4 y 5. detect y plan analizan Rails en solo lectura.
import { t } from "../bin/i18n.mjs";

export type WriteTarget = "express" | "rails";
export const WRITE_TARGETS: readonly WriteTarget[] = ["express"];

export function unsupportedTarget(target: string): string {
  return t("targets.unsupported", { target });
}
