/**
 * Ediciones por líneas (S6): lo que `apply` cambia y `undo` revierte. Solo se guardan las líneas añadidas y quitadas
 * (nunca copias completas de ficheros, que podrían contener secretos).
 */

import { t, tc } from "../bin/i18n.mjs";
export interface Edit {
  /** Índice (0) de la primera línea afectada en el fichero ORIGINAL. */
  start: number;
  removed: string[];
  added: string[];
}

export const splitLines = (text: string): string[] => text.split("\n");
export const joinLines = (lines: string[]): string => lines.join("\n");

/** Aplica ediciones (sobre el original, sin solaparse). */
export function applyEdits(text: string, edits: Edit[]): string {
  const lines = splitLines(text);
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    const current = lines.slice(e.start, e.start + e.removed.length);
    if (current.join("\n") !== e.removed.join("\n")) throw new Error(t("edits.mismatch", { p1: e.start + 1 }));
    lines.splice(e.start, e.removed.length, ...e.added);
  }
  return joinLines(lines);
}

/** Inversa: sobre el fichero YA editado, devuelve el original. */
export function revertEdits(text: string, edits: Edit[]): string {
  const lines = splitLines(text);
  // Posición de cada edición en el fichero editado: se desplaza por las anteriores.
  let shift = 0;
  const positioned = [...edits].sort((a, b) => a.start - b.start).map((e) => { const at = e.start + shift; shift += e.added.length - e.removed.length; return { ...e, at }; });
  for (const e of positioned.reverse()) {
    const current = lines.slice(e.at, e.at + e.added.length);
    if (current.join("\n") !== e.added.join("\n")) throw new Error(t("edits.block_not_intact", { p1: e.at + 1 }));
    lines.splice(e.at, e.added.length, ...e.removed);
  }
  return joinLines(lines);
}

/** Busca un bloque añadido, literal y una sola vez, en un fichero que el usuario ha modificado después (undo --resolve). */
export function removeBlockIfUnique(text: string, e: Edit): string | null {
  const lines = splitLines(text);
  const hits: number[] = [];
  for (let i = 0; i + e.added.length <= lines.length; i++) if (lines.slice(i, i + e.added.length).join("\n") === e.added.join("\n")) hits.push(i);
  if (hits.length !== 1) return null;
  lines.splice(hits[0]!, e.added.length, ...e.removed);
  return joinLines(lines);
}

// Valores con aspecto de secreto (no nombres de variables): no se muestran en el diff.
const SECRET_VALUE = /(?:\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|\bbg_(?:live|test)_\w{6,}|\bbgat_\w{6,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:password|passwd|secret|token|api[_-]?key)\w*["']?\s*[:=]\s*["'][^"'\s]{8,}["']|["'][A-Za-z0-9+/=_-]{32,}["'])/i;
export const looksSecret = (line: string): boolean => SECRET_VALUE.test(line);
const shown = (line: string) => (looksSecret(line) ? tc("diff.line_omitted") : line);

/** Diff unificado con 3 líneas de contexto (ediciones cercanas en un mismo bloque). Las líneas del proyecto con
 * aspecto de secreto se omiten; las añadidas por LicenRoute no contienen secretos (solo nombres de variables). */
export function unifiedDiff(file: string, original: string | null, edits: Edit[]): string {
  const before = original === null ? [] : splitLines(original);
  const out = [`--- ${original === null ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`];
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const groups: Edit[][] = [];
  for (const e of sorted) { const g = groups.at(-1); const last = g?.at(-1); if (g && last && e.start - (last.start + last.removed.length) <= 6) g.push(e); else groups.push([e]); }
  let shift = 0;
  for (const g of groups) {
    const first = g[0]!; const last = g.at(-1)!;
    const from = Math.max(0, first.start - 3); const to = Math.min(before.length, last.start + last.removed.length + 3);
    const body: string[] = []; let cursor = from; let oldCount = 0; let newCount = 0;
    for (const e of g) {
      for (; cursor < e.start; cursor++) { body.push(` ${shown(before[cursor]!)}`); oldCount++; newCount++; }
      for (const l of e.removed) { body.push(`-${shown(l)}`); oldCount++; }
      for (const l of e.added) { body.push(`+${l}`); newCount++; }
      cursor = e.start + e.removed.length;
    }
    for (; cursor < to; cursor++) { body.push(` ${shown(before[cursor]!)}`); oldCount++; newCount++; }
    out.push(`@@ -${original === null ? 0 : from + 1},${oldCount} +${from + 1 + shift},${newCount} @@`, ...body);
    shift += g.reduce((n, e) => n + e.added.length - e.removed.length, 0);
  }
  return out.join("\n");
}
