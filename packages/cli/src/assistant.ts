/**
 * `licenroute assistant <dir> --claude-code|--cursor` (S10.2-B): instala la Skill de LicenRoute (Claude Code) o sus reglas
 * (Cursor) en el proyecto. Mismo flujo que apply: vista previa sin escribir, código asst_… y, para escribir, el reto
 * en el terminal (lo pide el lanzador).
 *  - Solo CREA ficheros que no existen. Uno idéntico se omite; uno distinto se muestra y NUNCA se sobrescribe.
 *  - .claude/settings.json y .cursor/hooks.json: si no existen, se crean; si existen, se propone la fusión (sin
 *    duplicar reglas) y no se escriben. Las reglas solo AÑADEN restricciones (ask/deny y el hook de LicenRoute).
 * La escritura está en journal.ts (el único módulo que escribe). Las plantillas son las del propio paquete (assistants/) o, en el repositorio, integrations/assistants/generated/.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { sha256 } from "./util.ts";
import { t } from "../bin/i18n.mjs";

export type Host = "claude-code" | "cursor";
export const ASSISTANT_SCHEMA = "licenroute.cli.assistant/v1";
export interface AssistantFile { path: string; action: "create" | "identical" | "conflict" | "merge-proposal"; content: string; proposal?: string }
export interface AssistantPlan { ok: boolean; host: Host; errors: string[]; files: AssistantFile[]; dirs: string[]; approvalCode: string | null }

/** Dónde están las plantillas, a partir del punto de entrada que lanzó el lanzador (no de una opción del usuario). */
export function templatesDir(entry: string, dist: boolean): string {
  const root = dirname(dirname(entry));
  return dist ? join(root, "assistants") : join(root, "..", "..", "integrations", "assistants", "generated");
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) walk(p, base, out); else if (lstatSync(p).isFile()) out.push(relative(base, p));
  }
  return out;
}

type Json = Record<string, unknown>;
const uniq = (xs: unknown[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
/** Fusiona SOLO lo de LicenRoute en un settings.json/hooks.json existente, sin duplicar. null si ya lo tiene todo. */
export function mergeSettings(host: Host, existing: Json, ours: Json): Json | null {
  const out = structuredClone(existing);
  if (host === "claude-code") {
    const perms = (out.permissions ??= {}) as Json; const ourPerms = ours.permissions as Json;
    for (const k of ["ask", "deny"]) perms[k] = uniq([...((perms[k] as unknown[]) ?? []), ...((ourPerms[k] as unknown[]) ?? [])]);
    const hooks = (out.hooks ??= {}) as Json; const pre = ((hooks.PreToolUse as unknown[]) ?? []).slice();
    for (const h of ((ours.hooks as Json).PreToolUse as Json[])) if (!JSON.stringify(pre).includes("licenroute-guard.mjs")) pre.push(h);
    hooks.PreToolUse = pre;
  } else {
    const hooks = (out.hooks ??= {}) as Json; const before = ((hooks.beforeShellExecution as unknown[]) ?? []).slice();
    for (const h of ((ours.hooks as Json).beforeShellExecution as Json[])) if (!JSON.stringify(before).includes("licenroute-guard.mjs")) before.push(h);
    hooks.beforeShellExecution = before;
    out.version ??= ours.version;
  }
  return JSON.stringify(out) === JSON.stringify(existing) ? null : out;
}

/**
 * lang: idioma de la Skill o las reglas (D4.4), el que eligió el desarrollador (--lang, LICENROUTE_LANG o su locale), no el
 * de la salida (--json va siempre en inglés). Plantillas bilingües: <plantillas>/<en|es>/<host>; las de un solo idioma
 * (repositorio y kits anteriores): <plantillas>/<host>. El código asst_… cubre el contenido: cambiar de idioma entre la
 * vista previa y --approve da otro código y no se escribe.
 */
export function prepareAssistant(dir: string, host: Host, templates: string, lang = "en"): AssistantPlan {
  const errors: string[] = []; const files: AssistantFile[] = []; const dirs = new Set<string>();
  const bilingual = existsSync(join(templates, "en")) && existsSync(join(templates, "es"));
  const src = bilingual ? join(templates, lang === "es" ? "es" : "en", host) : join(templates, host);
  if (!existsSync(src)) return { ok: false, host, errors: [t("assistant.no_templates", { host })], files, dirs: [], approvalCode: null };
  const entries: { path: string; content: string }[] = [];
  for (const rel of walk(src)) {
    const content = readFileSync(join(src, rel), "utf8");
    if (host === "claude-code" && rel === "settings.licenroute.json") {
      const settings = JSON.parse(content) as Json; delete settings.$comment;
      entries.push({ path: join(".claude", "settings.json"), content: `${JSON.stringify(settings, null, 2)}\n` });
    } else entries.push({ path: rel, content });
  }
  for (const e of entries) {
    const abs = join(dir, e.path);
    for (let p = dirname(e.path); p !== "." && p !== ""; p = dirname(p)) {
      const a = join(dir, p);
      if (existsSync(a) && (lstatSync(a).isSymbolicLink() || !statSync(a).isDirectory())) { errors.push(t("assistant.not_dir", { p })); break; }
      if (!existsSync(a)) dirs.add(p);
    }
    if (!existsSync(abs)) { files.push({ path: e.path, action: "create", content: e.content }); continue; }
    if (lstatSync(abs).isSymbolicLink()) { errors.push(t("assistant.symlink", { path: e.path })); continue; }
    const current = readFileSync(abs, "utf8");
    if (current === e.content) { files.push({ path: e.path, action: "identical", content: e.content }); continue; }
    const isSettings = e.path === join(".claude", "settings.json") || e.path === join(".cursor", "hooks.json");
    if (isSettings) {
      let parsed: Json | null = null; try { parsed = JSON.parse(current) as Json; } catch { /* no es JSON */ }
      const merged = parsed && typeof parsed === "object" ? mergeSettings(host, parsed, JSON.parse(e.content) as Json) : null;
      if (parsed && !merged) files.push({ path: e.path, action: "identical", content: current });
      else files.push({ path: e.path, action: "merge-proposal", content: e.content, ...(merged ? { proposal: `${JSON.stringify(merged, null, 2)}\n` } : {}) });
    } else files.push({ path: e.path, action: "conflict", content: e.content });
  }
  const creates = files.filter((f) => f.action === "create");
  const approvalCode = errors.length || !creates.length ? null : `asst_${sha256(JSON.stringify({ host, files: creates.map((f) => [f.path, sha256(f.content)]), dirs: [...dirs].sort() })).slice(0, 20)}`;
  return { ok: errors.length === 0, host, errors, files, dirs: [...dirs].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b)), approvalCode };
}

/** Destinos exactos de escritura para el lanzador: cada directorio nuevo y cada fichero nuevo. */
export function assistantTargets(dir: string, p: AssistantPlan): string[] {
  return [...p.dirs.map((d) => join(dir, d)), ...p.files.filter((f) => f.action === "create").map((f) => join(dir, f.path))];
}

export function renderAssistant(p: AssistantPlan, dirArg: string): string {
  const name = p.host === "claude-code" ? t("assistant.name_claude") : t("assistant.name_cursor");
  const out = [`LicenRoute assistant — ${name}`, ...p.errors.map((e) => `  ✗ ${e}`)];
  const label = { create: t("assistant.label.create"), identical: t("assistant.label.identical"), conflict: t("assistant.label.conflict"), "merge-proposal": t("assistant.label.merge") };
  for (const f of p.files) out.push(`  ${label[f.action].padEnd(11)} ${f.path}`);
  for (const f of p.files.filter((x) => x.action === "conflict")) out.push("", t("assistant.conflict", { path: f.path }), ...f.content.split("\n").slice(0, 40).map((l) => `  | ${l}`), ...(f.content.split("\n").length > 40 ? ["  | …"] : []));
  for (const f of p.files.filter((x) => x.action === "merge-proposal")) {
    out.push("", f.proposal ? t("assistant.merge", { path: f.path }) : t("assistant.merge_invalid", { path: f.path }));
    out.push(...(f.proposal ?? f.content).split("\n").map((l) => `  | ${l}`));
  }
  if (!p.approvalCode) { out.push("", p.errors.length ? t("assistant.nothing_installed") : t("assistant.nothing_to_create")); return out.join("\n"); }
  out.push("", t("assistant.nothing_written"), `  licenroute assistant ${dirArg} --${p.host} --approve ${p.approvalCode}`, t("assistant.challenge_hint"));
  return out.join("\n");
}
