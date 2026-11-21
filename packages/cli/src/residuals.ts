/**
 * Lo que queda después de `undo` (S6, solo lectura): undo solo revierte lo que escribió apply; aquí se informa de todo
 * lo demás relacionado con LicenRoute (credenciales, dependencias instaladas, datos en el Sandbox, diarios antiguos,
 * temporales), sin borrar nada. Nunca lee ni muestra el contenido de las credenciales.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Journal } from "./journal.ts";
import { residualSandbox } from "./sandbox-hint.ts";
import { t } from "../bin/i18n.mjs";

// kind es un código del JSON (no se traduce); message, el texto para personas. unignored (D4.4): .env.licenroute ya no
// está en .gitignore; antes se deducía buscando «YA NO» en el mensaje, que ahora depende del idioma.
export interface Residual { kind: "credenciales" | "dependencia" | "sandbox" | "diario" | "temporal" | "proceso"; path: string | null; message: string; unignored?: true }

const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };

export function residuals(root: string, j: Journal): Residual[] {
  const out: Residual[] = [];
  const gitignore = (read(join(root, ".gitignore")) ?? "").split("\n").map((l) => l.trim());
  const ignored = (name: string) => gitignore.includes(name) || gitignore.includes(".env*") || gitignore.includes(".env.*");
  for (const f of ls(root).filter((n) => /^\.env\.licenroute/.test(n))) {
    out.push({ kind: "credenciales", path: f, message: t(ignored(f) ? "residual.credentials" : "residual.credentials_unignored", { instance: j.instance, app: j.app }), ...(ignored(f) ? {} : { unignored: true as const }) });
  }
  // S10.2-D3.1: el aviso depende de lo que package.json declara DE VERDAD y de quién lo añadió. En el flujo documentado,
  // el SDK se instala con npm antes de init: apply no toca package.json y undo no lo revierte (antes se decía lo
  // contrario, «ya no lo declara», y era falso).
  const declared = (() => { try { const p = JSON.parse(read(join(root, "package.json")) ?? "{}") as Record<string, Record<string, unknown> | undefined>; return ["dependencies", "devDependencies"].some((k) => typeof p[k]?.["@licenroute/connect-express"] === "string"); } catch { return false; } })();
  const applyAdded = j.files.some((f) => f.path === "package.json");
  const installed = existsSync(join(root, "node_modules", "@licenroute", "connect-express"));
  if (declared && !applyAdded) out.push({ kind: "dependencia", path: "package.json", message: t("residual.dep_declared") });
  else if (installed && !declared) out.push({ kind: "dependencia", path: "node_modules/@licenroute/connect-express", message: t("residual.dep_installed") });
  if ((read(join(root, "package-lock.json")) ?? "").includes("@licenroute/connect-express")) out.push({ kind: "dependencia", path: "package-lock.json", message: t("residual.lock_npm") });
  if ((read(join(root, "Gemfile.lock")) ?? "").includes("botgate-connect")) out.push({ kind: "dependencia", path: "Gemfile.lock", message: t("residual.lock_gem") });
  // Con credenciales del simulador de demo no hay ningún Sandbox implicado: el simulador no guarda nada al pararse.
  const demo = (read(join(root, ".env.licenroute")) ?? "").startsWith("# Generado por el simulador de LicenRoute");
  if (!demo) out.push({ kind: "sandbox", path: null, message: residualSandbox(j.instance, j.app) });
  for (const f of ls(join(root, ".licenroute", "journal")).filter((n) => n !== `${j.id}.json`)) out.push({ kind: "diario", path: `.licenroute/journal/${f}`, message: t("residual.other_journal") });
  for (const dir of [...new Set(j.files.map((f) => dirname(f.path)))]) {
    for (const f of ls(join(root, dir)).filter((n) => n.endsWith(".licenroute-tmp"))) out.push({ kind: "temporal", path: dir === "." ? f : `${dir}/${f}`, message: t("residual.temp") });
  }
  out.push({ kind: "proceso", path: null, message: t("residual.process") });
  return out;
}
