// Repositorio público (L6): la developer preview no incluye cliente del Sandbox privado. Este módulo no ejecuta ni lee
// nada: la parte de doctor que no es demo contesta «no disponible». El modo demo no pasa por aquí.
import { t } from "../../bin/i18n.mjs";
import type { AppStatus } from "./sandbox-types.ts";

export function sandboxDetail(): string { return t("sandbox.no_controller"); }
export function apiPort(_instance: string): number | null { return null; }
export function appStatus(_instance: string, _app: string): AppStatus | null { return null; }
