/**
 * Escritura de `apply` y reversión de `undo` (S6). Solo esta parte del código escribe, y solo en los ficheros
 * aprobados: el proceso corre con el modelo de permisos de Node limitado a esos ficheros, sus temporales y el diario
 * (.licenroute/journal/). El diario guarda hashes y las líneas añadidas/quitadas, nunca copias completas.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { FileChange, Prepared } from "./apply.ts";
import type { AssistantPlan } from "./assistant.ts";
import { type Edit, removeBlockIfUnique, revertEdits } from "./edits.ts";
import { t } from "../bin/i18n.mjs";

export const JOURNAL_DIR = ".licenroute/journal";
export type Consent = "tty-challenge" | "insecure-test";
export const CONSENTS: readonly Consent[] = ["tty-challenge", "insecure-test"];
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Journal {
  schema: "licenroute.cli.journal/v1";
  id: string;
  created_at: string;
  status: "applying" | "applied" | "rolled_back" | "undone";
  plan_sha256: string;
  approval_code: string;
  /** Cómo se confirmó la escritura: reto en el terminal, o modo interno de las pruebas de este repositorio. */
  consent: Consent;
  app: string;
  instance: string;
  target: "express" | "rails";
  sdk: string | null;
  plans: Prepared["selected"];
  public_checks: string[];
  files: { path: string; action: "modify" | "create"; before_sha256: string | null; after_sha256: string; edits: Edit[] }[];
}

/** Escritura atómica: temporal junto al destino + rename (los dos permitidos explícitamente por el lanzador). El
 *  modelo de permisos de Node desactiva fsync: el rename sigue garantizando que el destino queda entero o intacto. */
function atomicWrite(abs: string, content: string, mode?: number) {
  const tmp = `${abs}.licenroute-tmp`;
  try {
    const fd = openSync(tmp, "w", mode ?? 0o644);
    try { writeSync(fd, content); } finally { closeSync(fd); }
    renameSync(tmp, abs);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* sin permiso: lo informa quien llama */ }
    throw e;
  }
}
const readOrNull = (abs: string) => { try { return readFileSync(abs, "utf8"); } catch { return null; } };

/** Rutas que la fase de escritura necesita (el lanzador concede escritura SOLO a estas). */
export function writeTargets(root: string, changes: { path: string }[]): string[] {
  return [...changes.flatMap((c) => [join(root, c.path), `${join(root, c.path)}.licenroute-tmp`]), join(root, ".licenroute"), join(root, ".licenroute", "*")];
}

export function writeJournal(root: string, j: Journal) {
  for (const d of [join(root, ".licenroute"), join(root, JOURNAL_DIR)]) if (!existsSync(d)) mkdirSync(d, { mode: 0o700 });
  atomicWrite(join(root, JOURNAL_DIR, `${j.id}.json`), `${JSON.stringify(j, null, 2)}\n`, 0o600);
}

export function readJournals(root: string): Journal[] {
  const dir = join(root, JOURNAL_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[0-9TZ-]+-[0-9a-f]{8}\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Journal);
}

export interface WriteResult { ok: boolean; written: string[]; rolledBack: string[]; error: string | null; journal: Journal }

/** Escribe los cambios preparados. Si algo falla a mitad, deshace lo escrito (solo si nadie lo ha tocado). */
export function writeChanges(root: string, prepared: Prepared, meta: { app: string; instance: string; consent: Consent }): WriteResult {
  const now = new Date();
  const journal: Journal = {
    schema: "licenroute.cli.journal/v1",
    id: `${now.toISOString().replace(/[:.]/g, "-")}-${prepared.approvalCode!.slice(4, 12)}`,
    created_at: now.toISOString(), status: "applying",
    plan_sha256: prepared.plan!.approval.plan_sha256, approval_code: prepared.approvalCode!, consent: meta.consent, app: meta.app, instance: meta.instance,
    target: prepared.plan!.target, sdk: prepared.sdkSpec, plans: prepared.selected, public_checks: prepared.publicChecks,
    files: prepared.changes.map((c) => ({ path: c.path, action: c.action, before_sha256: c.beforeSha, after_sha256: c.afterSha, edits: c.edits })),
  };
  // Comprobación final justo antes de escribir: cada destino sigue como se aprobó.
  for (const c of prepared.changes) {
    const now = readOrNull(join(root, c.path));
    if (c.action === "create" ? now !== null : now === null || hashOf(now) !== c.beforeSha) return { ok: false, written: [], rolledBack: [], error: t("journal.changed_since_preview", { path: c.path }), journal };
  }
  writeJournal(root, journal);
  const written: FileChange[] = [];
  try {
    for (const c of prepared.changes) { atomicWrite(join(root, c.path), c.after); written.push(c); }
  } catch (e) {
    const rolledBack: string[] = [];
    for (const c of written.reverse()) {
      const abs = join(root, c.path); const cur = readOrNull(abs);
      if (cur === null || hashOf(cur) !== c.afterSha) continue; // alguien lo ha tocado: no se pisa
      try { if (c.action === "create") unlinkSync(abs); else atomicWrite(abs, c.before!); rolledBack.push(c.path); } catch { /* se informa abajo */ }
    }
    const tmpLeft = prepared.changes.map((c) => `${join(root, c.path)}.licenroute-tmp`).filter((t) => existsSync(t));
    for (const t of tmpLeft) { try { unlinkSync(t); } catch { /* sin permiso: se informa */ } }
    journal.status = "rolled_back"; writeJournal(root, journal);
    return { ok: false, written: written.map((c) => c.path), rolledBack, error: t("journal.write_failed", { message: (e as NodeJS.ErrnoException).code ?? (e as Error).message, length: rolledBack.length, length_: written.length }), journal };
  }
  journal.status = "applied"; writeJournal(root, journal);
  return { ok: true, written: written.map((c) => c.path), rolledBack: [], error: null, journal };
}

export interface UndoAction {
  path: string;
  kind: "restore" | "delete" | "already" | "resolve";
  content: string | null;
  /** Hash que el fichero debe conservar hasta el instante de la operación. null si no se escribe. */
  expectSha: string | null;
}
export interface UndoPlan { journal: Journal | null; actions: UndoAction[]; conflicts: string[]; error: string | null }

/** Prepara undo SIN escribir: solo revierte lo que sigue exactamente como lo dejó apply. */
export function prepareUndo(root: string, resolve: Map<string, "remove-block">): UndoPlan {
  const journal = readJournals(root).filter((j) => j.status === "applied").pop() ?? null;
  if (!journal) return { journal, actions: [], conflicts: [], error: t("journal.no_integration") };
  const actions: UndoPlan["actions"] = []; const conflicts: string[] = [];
  for (const f of [...journal.files].reverse()) {
    const cur = readOrNull(join(root, f.path));
    if (f.action === "create") {
      if (cur === null) actions.push({ path: f.path, kind: "already", content: null, expectSha: null });
      else if (hashOf(cur) === f.after_sha256) actions.push({ path: f.path, kind: "delete", content: null, expectSha: hashOf(cur) });
      else conflicts.push(t("journal.created_then_modified", { path: f.path }));
      continue;
    }
    if (cur === null) { conflicts.push(t("journal.gone", { path: f.path })); continue; }
    if (f.before_sha256 && hashOf(cur) === f.before_sha256) { actions.push({ path: f.path, kind: "already", content: null, expectSha: null }); continue; }
    if (hashOf(cur) === f.after_sha256) {
      const original = revertEdits(cur, f.edits);
      if (hashOf(original) !== f.before_sha256) { conflicts.push(t("journal.not_exact", { path: f.path })); continue; }
      actions.push({ path: f.path, kind: "restore", content: original, expectSha: hashOf(cur) });
      continue;
    }
    // Modificado después de apply: nunca se reemplaza. Solo con --resolve <fichero>=remove-block se quita NUESTRO
    // bloque, si aparece intacto exactamente una vez, conservando los cambios del usuario.
    if (resolve.get(f.path) === "remove-block") {
      let text: string | null = cur;
      for (const e of [...f.edits].sort((a, b) => b.start - a.start)) { text = text === null ? null : removeBlockIfUnique(text, e); }
      if (text === null) conflicts.push(t("journal.block_not_intact", { path: f.path }));
      else actions.push({ path: f.path, kind: "resolve", content: text, expectSha: hashOf(cur) });
    } else conflicts.push(t("journal.modified_after", { path: f.path, path_: f.path }));
  }
  return { journal, actions, conflicts, error: null };
}

export function undoTargets(root: string, u: UndoPlan): string[] {
  return [...u.actions.flatMap((a) => [join(root, a.path), `${join(root, a.path)}.licenroute-tmp`]), join(root, ".licenroute"), join(root, ".licenroute", "*")];
}

const matchesPrepared = (root: string, a: UndoAction) => {
  if (a.kind === "already") return true;
  const cur = readOrNull(join(root, a.path));
  return cur !== null && a.expectSha !== null && hashOf(cur) === a.expectSha && (a.kind === "delete" || a.content !== null);
};

/**
 * Ejecuta undo. Todo o nada: con conflictos, o si algún fichero cambió desde la preparación, no se toca nada y el
 * diario se conserva. Justo antes de cada operación se vuelve a comprobar el hash. Si una escritura falla, se
 * devuelve lo ya revertido a su contenido anterior (sin pisar un fichero que haya cambiado otra vez).
 *
 * Límite residual: entre esa última lectura y el `rename` o `unlink` no hay un comparar-y-escribir atómico. Otro
 * proceso puede sustituir el fichero en esa ventana. El modelo de permisos de Node tampoco ofrece un bloqueo ni fsync.
 */
export function runUndo(root: string, u: UndoPlan): { done: string[]; error: string | null } {
  if (u.error) return { done: [], error: u.error };
  if (u.conflicts.length) return { done: [], error: t("journal.unresolved_conflicts") };
  const stale = u.actions.find((a) => !matchesPrepared(root, a));
  if (stale) return { done: [], error: t("journal.changed_since_prepare", { path: stale.path }) };

  const applied: { path: string; kind: UndoAction["kind"]; previous: string; writtenSha: string | null }[] = [];
  try {
    for (const a of u.actions) {
      if (a.kind === "already") continue;
      const abs = join(root, a.path);
      const cur = readOrNull(abs);
      if (cur === null || a.expectSha === null || hashOf(cur) !== a.expectSha) throw new Error(t("journal.changed_just_before", { path: a.path }));
      if (a.kind === "delete") { unlinkSync(abs); applied.push({ path: a.path, kind: "delete", previous: cur, writtenSha: null }); }
      else { atomicWrite(abs, a.content!); applied.push({ path: a.path, kind: a.kind, previous: cur, writtenSha: hashOf(a.content!) }); }
    }
  } catch (e) {
    const recovered: string[] = []; const stuck: string[] = [];
    for (const op of applied.reverse()) {
      const abs = join(root, op.path);
      try {
        if (op.kind === "delete") {
          if (readOrNull(abs) !== null) { stuck.push(op.path); continue; }
          atomicWrite(abs, op.previous);
        } else {
          const now = readOrNull(abs);
          if (now === null || hashOf(now) !== op.writtenSha) { stuck.push(op.path); continue; }
          atomicWrite(abs, op.previous);
        }
        recovered.push(op.path);
      } catch { stuck.push(op.path); }
    }
    const tail = stuck.length ? t("journal.stuck", { p1: stuck.join(", ") }) : t("journal.recovered", { length: recovered.length });
    return { done: [], error: t("journal.undo_interrupted", { message: (e as Error).message, tail }) };
  }
  const done = u.actions.filter((a) => a.kind !== "already").map((a) => a.path);
  const j = u.journal!;
  unlinkSync(join(root, JOURNAL_DIR, `${j.id}.json`));
  for (const d of [join(root, JOURNAL_DIR), join(root, ".licenroute")]) { try { if (readdirSync(d).length === 0) rmdirSync(d); } catch { /* no vacío */ } }
  return { done, error: null };
}

/** licenroute assistant: crea directorios y ficheros que NO existen (flag wx: falla si alguien lo creó entretanto). */
export function writeAssistant(dir: string, p: AssistantPlan): { written: string[]; error: string | null } {
  const written: string[] = [];
  try {
    for (const d of p.dirs) if (!existsSync(join(dir, d))) mkdirSync(join(dir, d), { mode: 0o755 });
    for (const f of p.files.filter((x) => x.action === "create")) { writeFileSync(join(dir, f.path), f.content, { flag: "wx", mode: 0o644 }); written.push(f.path); }
    return { written, error: null };
  } catch (e) { return { written, error: (e as Error).message.slice(0, 300) }; }
}
