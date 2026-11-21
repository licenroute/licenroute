/**
 * Coincidencia de patrones de ruta sin expresiones regulares (threat model T11: sin ReDoS).
 *
 *  - `*`  dentro de un segmento: cualquier secuencia de caracteres sin `/` (`/static/*.css`).
 *  - `**` como segmento completo: cero o más segmentos (`/api/**` coincide con `/api` y `/api/a/b`).
 *  - Resto: literal, sin distinguir mayúsculas (el patrón se pasa a minúsculas).
 *  - Sufijo de formato: si el último segmento literal del patrón (seguido solo de `**` o de
 *    nada) se compara con el ÚLTIMO segmento de la ruta, también coincide `<literal>.<ext>`
 *    (ext sin `.` ni `/`). Rails enruta `get "/admin"` como `/admin(.:format)`, así que
 *    `/admin.json` llega al mismo controlador: sin esto, `/admin/**` se eludiría en Rails.
 *    En otros frameworks esto puede sobre-proteger `/admin.json`; es la dirección segura.
 *
 * Complejidad: O(segmentos_patrón × segmentos_ruta) con memoización; cada segmento con `*`
 * se compara en O(n·m) en el peor caso, acotado por MAX_PATH_LENGTH.
 */
import { pathSegments } from "./path.ts";

export interface CompiledGlob {
  readonly pattern: string;
  readonly segments: readonly string[];
}

export function compileGlob(pattern: string): CompiledGlob {
  const lower = pattern.trim().toLowerCase();
  if (!lower.startsWith("/")) throw new Error(`patrón inválido (debe empezar por /): ${pattern}`);
  const segments = lower.split("/").slice(1).filter((s) => s !== "");
  return { pattern: lower, segments };
}

/** `normalizedPath` debe venir de normalizePath(). */
export function matchGlob(glob: CompiledGlob, normalizedPath: string): boolean {
  const path = pathSegments(normalizedPath);
  const pat = glob.segments;
  const memo = new Map<number, boolean>();

  const match = (pi: number, si: number): boolean => {
    const key = pi * (path.length + 1) + si;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (pi === pat.length) {
      result = si === path.length;
    } else if (pat[pi] === "**") {
      // `**` consume 0 segmentos, o 1 y sigue siendo `**`.
      result = match(pi + 1, si) || (si < path.length && match(pi, si + 1));
    } else {
      result =
        si < path.length &&
        (matchSegment(pat[pi]!, path[si]!) || (si === path.length - 1 && isFormatVariant(pat, pi, path[si]!))) &&
        match(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/** `admin.json` frente al literal final `admin` (ver cabecera: sufijo de formato de Rails). */
function isFormatVariant(pat: readonly string[], pi: number, segment: string): boolean {
  const literal = pat[pi]!;
  if (literal.includes("*") || !pat.slice(pi + 1).every((s) => s === "**")) return false;
  if (!segment.startsWith(literal + ".")) return false;
  const ext = segment.slice(literal.length + 1);
  return ext.length > 0 && !ext.includes(".");
}

/** Comodín `*` dentro de un segmento. Algoritmo iterativo con un único punto de retroceso. */
export function matchSegment(pattern: string, text: string): boolean {
  if (!pattern.includes("*")) return pattern === text;
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}
