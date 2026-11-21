/**
 * Metadatos de compatibilidad. No forman parte de los esquemas detect/plan/apply/undo/test/doctor v1:
 * esos no cambian. `licenroute --version --json` usa `licenroute.cli.version/v1`.
 * Repositorio público (L6): sin los campos del Sandbox privado (localizador, contrato e identidad del controlador).
 */
import { DIST_BUILD } from "./build-flags.ts";
import { TOOL_VERSION } from "./detect.ts";
import { t } from "../bin/i18n.mjs";

export const CLI_CONTRACTS = {
  detect: "licenroute.cli.detect/v1",
  plan: "licenroute.cli.plan/v1",
  apply: "licenroute.cli.apply/v1",
  undo: "licenroute.cli.undo/v1",
  test: "licenroute.cli.test/v1",
  doctor: "licenroute.cli.doctor/v1",
} as const;

export function versionInfo() {
  return {
    schema: "licenroute.cli.version/v1" as const,
    tool: { name: "@licenroute/cli" as const, version: TOOL_VERSION },
    distribution: DIST_BUILD ? "compiled" as const : "source" as const,
    contracts: CLI_CONTRACTS,
  };
}

export function renderVersion(json: boolean): string {
  const info = versionInfo();
  if (json) return `${JSON.stringify(info, null, 2)}\n`;
  return [
    `licenroute ${info.tool.version} (${info.distribution})`,
    t("version.schemas"),
    "",
  ].join("\n");
}
