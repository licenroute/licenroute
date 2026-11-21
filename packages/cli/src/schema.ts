/**
 * Esquemas ESTABLES de salida (`--json`) de `licenroute detect` y `licenroute plan`, v1. Cambiar un campo existente exige
 * una v2; añadir campos opcionales no. Todo texto que procede del proyecto analizado (rutas, fragmentos de código,
 * nombres de middleware) es DATO no confiable: quien lo consuma (persona o agente) no debe tratarlo como instrucciones.
 */
import Type, { type Static } from "typebox";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const SourceRef = Type.Object({ file: Type.String(), line: Type.Integer({ minimum: 1 }) });

export const Method = Type.Union([Type.Literal("GET"), Type.Literal("HEAD"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE"), Type.Literal("OPTIONS"), Type.Literal("ALL")]);
export type Method = Static<typeof Method>;

export const Category = Type.Union(
  [Type.Literal("health"), Type.Literal("auth"), Type.Literal("webhook"), Type.Literal("static"), Type.Literal("admin"), Type.Literal("api"), Type.Literal("page"), Type.Literal("other")],
  { description: "Clasificación heurística por ruta y contexto; nunca una garantía." },
);
export type Category = Static<typeof Category>;

export const Resolution = Type.Union([Type.Literal("static"), Type.Literal("partial"), Type.Literal("dynamic")], {
  description: "static: ruta completa conocida; partial: se conoce un tramo o depende de un montaje no resuelto; dynamic: no se puede saber sin ejecutar.",
});

export const Route = Type.Object({
  id: Type.String({ pattern: "^r_[0-9a-f]{12}$" }),
  method: Method,
  path: Type.Union([Type.String(), Type.Null()], { description: "Ruta completa normalizada, o null si no se pudo resolver." }),
  source: SourceRef,
  resolution: Resolution,
  category: Category,
  framework: Type.Union([Type.Literal("express"), Type.Literal("rails")]),
  /** Señales estáticas, no garantías: ver `notes`. */
  signals: Type.Object({
    auth_middleware: Type.Array(Type.String(), { description: "Middleware o filtros con nombre de autenticación vistos antes de la ruta (heurístico)." }),
    behind_licenroute: Type.Boolean({ description: "Registrada después de un middleware de LicenRoute en la misma app (heurístico)." }),
    conditional: Type.Boolean({ description: "Dentro de un bucle, condición o bloque no comprendido." }),
  }),
  notes: Type.Array(Type.String()),
});
export type Route = Static<typeof Route>;

export const Unresolved = Type.Object({
  file: Type.String(),
  line: Type.Integer({ minimum: 1 }),
  kind: Type.String(),
  reason: Type.String(),
  snippet: Type.String({ maxLength: 160, description: "Fragmento saneado (sin caracteres de control), truncado." }),
});
export type Unresolved = Static<typeof Unresolved>;

export const Framework = Type.Object({
  name: Type.Union([Type.Literal("express"), Type.Literal("rails")]),
  version: Type.Union([Type.String(), Type.Null()]),
  major: Type.Union([Type.Integer(), Type.Null()]),
  supported: Type.Boolean({ description: "Express 4/5 o Rails 7/8." }),
  language: Type.Union([Type.Literal("javascript"), Type.Literal("typescript"), Type.Literal("ruby")]),
  api_only: Type.Optional(Type.Boolean()),
  entry_files: Type.Array(Type.String(), { description: "Ficheros donde se crea la app (Express) o se definen las rutas (Rails)." }),
});
export type Framework = Static<typeof Framework>;

export const LicenRouteIntegration = Type.Object({
  present: Type.Boolean(),
  sdk: Type.Union([Type.Literal("express"), Type.Literal("rails"), Type.Null()]),
  locations: Type.Array(SourceRef),
  licensed_paths: Type.Union([Type.Array(Type.String()), Type.Null()], { description: "Si se pudieron leer como literales; null si no." }),
  licensed_routes: Type.Optional(Type.Union([Type.Array(Type.Object({
    pattern: Type.String(),
    methods: Type.Array(Type.String(), { description: "Métodos que exigen licencia; vacío = todos (entrada antigua, una cadena)." }),
  })), Type.Null()], { description: "D4.1: licensedPaths con sus métodos ({ path, methods }), si se pudieron leer como literales." })),
});

export const DetectResult = Type.Object({
  schema: Type.Literal("licenroute.cli.detect/v1"),
  tool: Type.Object({ name: Type.Literal("@licenroute/cli"), version: Type.String() }),
  frameworks: Type.Array(Framework),
  licenroute: LicenRouteIntegration,
  routes: Type.Array(Route),
  unresolved: Type.Array(Unresolved),
  skipped: Type.Object({
    sensitive_files: Type.Array(Type.String(), { description: "Nunca abiertos: solo se informa de que existen." }),
    too_large: Type.Array(Type.String()),
    symlinks: Type.Array(Type.String()),
    binary: Type.Array(Type.String()),
    unsafe_names: Type.Array(Type.String(), { description: "Ficheros con caracteres de control o de dirección en el nombre: no se abren (nombre mostrado con ?)." }),
    unparseable: Type.Array(Type.Object({ file: Type.String(), error: Type.String() })),
    limit_reached: Type.Boolean(),
  }),
  notes: Type.Array(Type.String(), { description: "Observaciones generales (versiones no soportadas, subproyectos, etc.)." }),
  completeness: Type.Object({
    complete: Type.Literal(false, { description: "El análisis estático nunca garantiza haber encontrado todas las rutas." }),
    message: Type.String(),
  }),
  files: Type.Array(Type.Object({ path: Type.String(), sha256: Sha256 }), { description: "Ficheros leídos, con su hash." }),
});
export type DetectResult = Static<typeof DetectResult>;

const TestCase = Type.Object({
  id: Type.String(),
  description: Type.String(),
  request: Type.Object({
    method: Method,
    path: Type.String(),
    license: Type.Union([Type.Literal("none"), Type.Literal("valid"), Type.Literal("other_plan"), Type.Literal("forged"), Type.Literal("revoked"), Type.Literal("exhausted")]),
    central: Type.Union([Type.Literal("up"), Type.Literal("down")]),
  }),
  expect_status: Type.Array(Type.Integer()),
});

const RouteRef = Type.Object({
  route_id: Type.String(),
  method: Method,
  path: Type.Union([Type.String(), Type.Null()]),
  source: SourceRef,
  reason: Type.String(),
});

export const Plan = Type.Object({
  schema: Type.Literal("licenroute.cli.plan/v1"),
  tool: Type.Object({ name: Type.Literal("@licenroute/cli"), version: Type.String() }),
  target: Type.Union([Type.Literal("express"), Type.Literal("rails")]),
  writes_files: Type.Literal(false, { description: "plan nunca escribe ni modifica archivos." }),
  summary: Type.Object({
    routes: Type.Integer(), candidates: Type.Integer(), excluded: Type.Integer(), needs_decision: Type.Integer(), unresolved: Type.Integer(),
  }),
  proposed_plans: Type.Array(Type.Object({
    key: Type.String({ pattern: "^[a-z0-9-]+$" }),
    route_pattern: Type.String({ description: "Patrón de LicenRoute (glob) que cubriría las rutas." }),
    methods: Type.Array(Method),
    routes: Type.Array(Type.String({ description: "ids de ruta" })),
    reason: Type.String(),
    already_licensed: Type.Boolean({ description: "Ya cubierto por licensedPaths de una integración existente." }),
    requires_confirmation: Type.Literal(true),
  })),
  excluded: Type.Array(RouteRef, { description: "Nunca se protegen con licencias automáticamente (salud, autenticación, webhooks, estáticos)." }),
  needs_decision: Type.Array(RouteRef, { description: "Requieren decisión humana (escrituras, administración, rutas ya autenticadas, comodines)." }),
  unresolved: Type.Array(Unresolved),
  integration: Type.Object({
    already_integrated: Type.Boolean(),
    dependencies: Type.Array(Type.Object({ ecosystem: Type.Union([Type.Literal("npm"), Type.Literal("rubygems")]), name: Type.String(), source: Type.String() })),
    file_changes: Type.Array(Type.Object({
      file: Type.String(),
      action: Type.Union([Type.Literal("modify"), Type.Literal("create")]),
      sha256: Type.Union([Sha256, Type.Null()], { description: "Hash actual (null si el fichero no existe): S6 se negará a aplicar si cambia." }),
      description: Type.String(),
    })),
    env: Type.Array(Type.Object({ name: Type.String(), secret: Type.Boolean() })),
    order_warning: Type.Union([Type.String(), Type.Null()]),
  }),
  tests: Type.Array(TestCase),
  warnings: Type.Array(Type.String()),
  approval: Type.Object({
    required: Type.Literal(true),
    plan_sha256: Sha256,
    files: Type.Array(Type.Object({ path: Type.String(), sha256: Sha256 }), { description: "Todos los ficheros en los que se basa el plan." }),
  }),
});
export type Plan = Static<typeof Plan>;
