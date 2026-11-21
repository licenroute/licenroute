import { compileGlob, type CompiledGlob } from "./glob.ts";

/**
 * ¿Cubre la declaración local (`licensedPaths`) la ruta licenciada `pattern`? (BL-11)
 * Conservadora: puede dar falsos "no cubierta", nunca falsos "cubierta". Cubre si el patrón es
 * idéntico (normalizado) o si un local acaba en `/**` y es prefijo literal (sin comodines) del patrón.
 * La usan los SDK (aviso de configuración insegura), la API y el worker (protección de planes) y el
 * panel (versión Ruby). Fixture: policy-fallback.json (`covers`).
 */
export function coversLicensed(local: readonly CompiledGlob[], pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  return local.some((l) => {
    if (l.pattern === p) return true;
    if (!l.pattern.endsWith("/**")) return false;
    const prefix = l.pattern.slice(0, -2); // "/datos/"
    return !prefix.includes("*") && (p.startsWith(prefix) || p === prefix.slice(0, -1));
  });
}

/** Segmento válido de un glob: mismas reglas que SecurityRule::PATH_SEGMENT / AccessPlan (Rails). */
const SEGMENT = /^(\*\*|[a-z0-9\-._~:@*]+)$/;

export class InvalidLicensedPath extends Error {}

/**
 * Normaliza y valida los patrones declarados por un SDK con las reglas de los globs del panel:
 * minúsculas, empiezan por "/", segmentos válidos y `**` solo como segmento completo.
 * Devuelve la lista ordenada y sin duplicados; lanza InvalidLicensedPath si alguno no es válido.
 */
export function normalizeLicensedPaths(patterns: readonly string[]): string[] {
  const out = patterns.map((raw) => {
    const p = raw.trim().toLowerCase();
    const segments = p.split("/").slice(1);
    if (!p.startsWith("/") || segments.some((s) => s !== "" && !SEGMENT.test(s)) || segments.some((s) => s.includes("**") && s !== "**")) {
      throw new InvalidLicensedPath(`patrón inválido: ${raw.slice(0, 80)}`);
    }
    return compileGlob(p).pattern;
  });
  return [...new Set(out)].sort();
}

/**
 * F2 (EVAL-01/02): cobertura de las rutas DECLARADAS de pago (`licensedPaths`) por la política verificada.
 * Una ruta declarada solo se sirve si la política vigente y verificada la protege EFECTIVAMENTE; si no, el SDK
 * la cierra (503) y `ready()` es false. Gemelo de Botgate::DeclaredCoverage (Ruby); fixture licensed-coverage.json.
 */
export interface PolicyLicensedRoute {
  glob: CompiledGlob;
  /** Vacío = todos los métodos. */
  methods: ReadonlySet<string>;
}

/** ¿Protege la política esta petición concreta (ruta y método)? */
export function requestCovered(routes: readonly PolicyLicensedRoute[], path: string, method: string, match: (g: CompiledGlob, p: string) => boolean): boolean {
  return routes.some((r) => (r.methods.size === 0 || r.methods.has(method)) && match(r.glob, path));
}

/**
 * Patrones declarados que la política NO cubre por completo (todas las rutas y todos los métodos).
 * Conservadora (reutiliza coversLicensed): ante la duda, «sin cobertura» -> ready() false, nunca al revés.
 * Una ruta de la política restringida a ciertos métodos no cubre por completo un patrón declarado.
 */
export function uncoveredDeclared(routes: readonly PolicyLicensedRoute[], declared: readonly string[]): string[] {
  const full = routes.filter((r) => r.methods.size === 0).map((r) => r.glob);
  return declared.filter((d) => !coversLicensed(full, d));
}

/**
 * D4.1 (F-D4-1): declaración local de una ruta de pago con sus MÉTODOS. `methods` vacío = todos (la forma antigua,
 * una cadena en `licensedPaths`). Los métodos se comparan EXACTAMENTE, como el motor de decisiones con
 * `licensed_routes[].methods`: GET no implica HEAD. Quien genera la declaración (licenroute apply) escribe GET y HEAD
 * juntos porque Express atiende HEAD con el controlador de GET.
 */
export interface LicensedDeclaration {
  glob: CompiledGlob;
  /** Vacío = todos los métodos. */
  methods: ReadonlySet<string>;
}

/** Métodos que una declaración puede licenciar. OPTIONS no: una petición previa de CORS no lleva licencia. */
export const LICENSABLE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

export class InvalidLicensedDeclaration extends Error {}

/**
 * Valida una entrada de `licensedPaths`: una cadena (todos los métodos) o `{ path, methods }` con métodos de
 * LICENSABLE_METHODS (en mayúsculas o no; sin duplicados). Lanza InvalidLicensedDeclaration si no es válida.
 */
export function parseLicensedDeclaration(entry: unknown): { pattern: string; methods: string[] } {
  if (typeof entry === "string") return { pattern: normalizeLicensedPaths([entry])[0]!, methods: [] };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new InvalidLicensedDeclaration("cada entrada de licensedPaths es una ruta (cadena) o { path, methods }");
  const { path, methods } = entry as { path?: unknown; methods?: unknown };
  if (typeof path !== "string") throw new InvalidLicensedDeclaration("{ path, methods }: path debe ser una cadena");
  if (!Array.isArray(methods) || methods.length === 0 || methods.some((m) => typeof m !== "string")) throw new InvalidLicensedDeclaration(`${path.slice(0, 80)}: methods debe ser una lista no vacía de métodos (${LICENSABLE_METHODS.join(", ")})`);
  const upper = [...new Set((methods as string[]).map((m) => m.trim().toUpperCase()))];
  const bad = upper.filter((m) => !(LICENSABLE_METHODS as readonly string[]).includes(m));
  if (bad.length) throw new InvalidLicensedDeclaration(`${path.slice(0, 80)}: método no licenciable ${bad.join(", ").slice(0, 40)} (solo ${LICENSABLE_METHODS.join(", ")}; OPTIONS nunca)`);
  let pattern: string;
  try { pattern = normalizeLicensedPaths([path])[0]!; } catch (e) { throw new InvalidLicensedDeclaration((e as Error).message); }
  return { pattern, methods: upper.sort() };
}

/** ¿Exige licencia esta declaración para la petición (ruta normalizada y método)? */
export function declarationMatches(d: LicensedDeclaration, path: string, method: string, match: (g: CompiledGlob, p: string) => boolean): boolean {
  return (d.methods.size === 0 || d.methods.has(method)) && match(d.glob, path);
}

/**
 * ¿Cubre la declaración local esta ruta licenciada de la política (patrón y métodos)? Conservadora, como
 * coversLicensed: una declaración con métodos solo cubre una ruta de la política restringida a métodos que la
 * declaración también incluye; una ruta de la política con todos los métodos solo la cubre una declaración con todos.
 */
export function declarationsCover(local: readonly LicensedDeclaration[], route: { pattern: string; methods: ReadonlySet<string> }): boolean {
  return local.some((d) => coversLicensed([d.glob], route.pattern) && (d.methods.size === 0 || (route.methods.size > 0 && [...route.methods].every((m) => d.methods.has(m)))));
}

/**
 * F2 con métodos: declaraciones locales que la política verificada NO cubre por completo. Una declaración con todos
 * los métodos exige una ruta de la política con todos (uncoveredDeclared); una con métodos exige, para CADA método,
 * una ruta de la política que lo incluya (o con todos) y cuyo patrón cubra el declarado. Devuelve los patrones.
 */
export function uncoveredDeclarations(routes: readonly PolicyLicensedRoute[], declared: readonly { pattern: string; methods: readonly string[] }[]): string[] {
  return declared.filter((d) => {
    if (d.methods.length === 0) return uncoveredDeclared(routes, [d.pattern]).length > 0;
    return d.methods.some((m) => !coversLicensed(routes.filter((r) => r.methods.size === 0 || r.methods.has(m)).map((r) => r.glob), d.pattern));
  }).map((d) => d.pattern);
}
