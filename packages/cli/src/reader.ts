/**
 * Único acceso a disco del analizador. El proyecto analizado es contenido NO confiable:
 *  - nunca se sale de la raíz ni se sigue un enlace simbólico (ni ficheros ni directorios);
 *  - nunca se abre un fichero sensible (.env*, claves, credenciales): solo se informa de su nombre;
 *  - límites de tamaño por fichero y de número de ficheros; los binarios se ignoran;
 *  - solo lectura: no hay ninguna función de escritura en este módulo.
 * El proceso, además, corre con el modelo de permisos de Node (ver bin/licenroute.mjs): sin escritura ni procesos hijo.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const MAX_FILE_BYTES = 1_000_000;
export const MAX_FILES = 5_000;
export const MAX_TOTAL_BYTES = 30_000_000;

/** Directorios que nunca se recorren (dependencias, artefactos, VCS). */
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage", "tmp", "log", "vendor", ".bundle",
  ".next", ".nuxt", ".cache", ".turbo", ".yarn", "public", "storage", ".botgate-sandbox",
]);

/** Nombres de fichero sensibles: nunca se abren (ni para calcular su hash). */
const SENSITIVE: RegExp[] = [
  /^\.env(\..*)?$/i, /\.env$/i, /^\.envrc$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.jks$/i, /\.keystore$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /^master\.key$/i, /credentials(\.yml)?\.enc$/i, /^credentials\.(json|ya?ml)$/i,
  /^secrets?\.(json|ya?ml|toml)$/i, /^\.npmrc$/i, /^\.pgpass$/i, /^\.netrc$/i, /^service-account.*\.json$/i,
];
export const isSensitive = (name: string): boolean => SENSITIVE.some((re) => re.test(name));
// eslint-disable-next-line no-control-regex -- detecta justamente caracteres de control en nombres de fichero
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_NAME_G = new RegExp(UNSAFE_NAME.source, "g");

export interface Skipped {
  sensitive_files: string[];
  too_large: string[];
  symlinks: string[];
  binary: string[];
  unsafe_names: string[];
  limit_reached: boolean;
}

export interface ReaderOptions {
  /** Hook de pruebas: registra cada fichero que se abre. */
  onOpen?: (relativePath: string) => void;
  /** Contenido en memoria que sustituye al del disco (apply: analizar el resultado ANTES de escribirlo). */
  overrides?: ReadonlyMap<string, string>;
}

export class ProjectReader {
  readonly root: string;
  readonly skipped: Skipped = { sensitive_files: [], too_large: [], symlinks: [], binary: [], unsafe_names: [], limit_reached: false };
  private readonly opened = new Map<string, string>(); // ruta relativa -> sha256 de lo leído
  private totalBytes = 0;
  private readonly onOpen: ((p: string) => void) | undefined;
  private readonly overrides: ReadonlyMap<string, string>;

  constructor(root: string, options: ReaderOptions = {}) {
    this.root = realpathSync(root);
    this.onOpen = options.onOpen;
    this.overrides = options.overrides ?? new Map();
  }

  /** Lista los ficheros (relativos, con /) cuyo nombre cumple `accept`, sin seguir enlaces ni entrar en ignorados. */
  list(accept: (relativePath: string) => boolean): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 25 || this.skipped.limit_reached) return;
      let entries: string[];
      try { entries = readdirSync(dir).sort(); } catch { return; }
      for (const name of entries) {
        const abs = join(dir, name);
        const rel = this.rel(abs);
        // Nombres con caracteres de control o de dirección: no se abren ni se muestran tal cual.
        if (UNSAFE_NAME.test(rel)) { this.note(this.skipped.unsafe_names, rel.replace(UNSAFE_NAME_G, "?")); continue; }
        let st;
        try { st = lstatSync(abs); } catch { continue; }
        if (st.isSymbolicLink()) { this.note(this.skipped.symlinks, rel); continue; }
        if (st.isDirectory()) { if (!IGNORED_DIRS.has(name)) walk(abs, depth + 1); continue; }
        if (!st.isFile()) continue;
        if (isSensitive(name)) { this.note(this.skipped.sensitive_files, rel); continue; }
        if (!accept(rel)) continue;
        if (found.length >= MAX_FILES) { this.skipped.limit_reached = true; return; }
        found.push(rel);
      }
    };
    walk(this.root, 0);
    for (const p of this.overrides.keys()) if (!found.includes(p) && accept(p)) found.push(p); // ficheros que solo existen en memoria
    return found.sort();
  }

  /** Lee un fichero relativo a la raíz, o null si no existe, es sensible, enlace, demasiado grande o binario. */
  read(relativePath: string): string | null {
    const override = this.overrides.get(relativePath);
    if (override !== undefined) { this.opened.set(relativePath, createHash("sha256").update(override).digest("hex")); return override; }
    const parts = relativePath.split("/");
    if (parts.some((p) => p === ".." || p === "")) return null;
    const name = parts[parts.length - 1]!;
    if (isSensitive(name)) { this.note(this.skipped.sensitive_files, relativePath); return null; }
    // Ningún componente del camino puede ser un enlace simbólico.
    let cur = this.root;
    for (const p of parts) {
      cur = join(cur, p);
      let st;
      try { st = lstatSync(cur); } catch { return null; }
      if (st.isSymbolicLink()) { this.note(this.skipped.symlinks, relativePath); return null; }
    }
    const st = lstatSync(cur);
    if (!st.isFile()) return null;
    if (st.size > MAX_FILE_BYTES) { this.note(this.skipped.too_large, relativePath); return null; }
    if (this.totalBytes + st.size > MAX_TOTAL_BYTES) { this.skipped.limit_reached = true; return null; }
    this.totalBytes += st.size;
    this.onOpen?.(relativePath);
    const buf = readFileSync(cur);
    if (buf.includes(0)) { this.note(this.skipped.binary, relativePath); return null; }
    this.opened.set(relativePath, createHash("sha256").update(buf).digest("hex"));
    return buf.toString("utf8");
  }

  exists(relativePath: string): boolean {
    if (this.overrides.has(relativePath)) return true;
    try { return lstatSync(join(this.root, ...relativePath.split("/"))).isFile(); } catch { return false; }
  }

  /** Hash de un fichero leído (para el plan y S6). */
  hashOf(relativePath: string): string | null {
    if (!this.opened.has(relativePath)) this.read(relativePath);
    return this.opened.get(relativePath) ?? null;
  }

  /** Ficheros efectivamente leídos, ordenados, con su sha256. */
  files(): { path: string; sha256: string }[] {
    return [...this.opened.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, sha256]) => ({ path, sha256 }));
  }

  private rel(abs: string): string {
    return relative(this.root, abs).split(sep).join("/");
  }

  private note(list: string[], rel: string) {
    if (!list.includes(rel)) list.push(rel);
  }
}
