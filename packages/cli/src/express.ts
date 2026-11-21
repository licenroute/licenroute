/**
 * Análisis ESTÁTICO de apps Express 4/5 (JS o TS): se parsea con el compilador de TypeScript y nunca se ejecuta nada.
 * Reconoce apps (`express()`), routers (`express.Router()` / `Router()`), rutas (`x.get(path, …)`, `x.route(path).get()`),
 * montajes (`x.use(path?, router)`), `express.static`, middleware de autenticación por nombre y el middleware de LicenRoute.
 * Resuelve literales, plantillas sin sustituciones, concatenaciones y constantes del mismo fichero; lo demás es dinámico.
 */
import ts from "typescript";
import type { ProjectReader } from "./reader.ts";
import type { Method, Route, Unresolved } from "./schema.ts";
import { AUTH_MIDDLEWARE, classify, displayPath, EXPRESS_WILDCARD, joinPaths, routeId, safePath, sanitize } from "./util.ts";
import { tc } from "../bin/i18n.mjs";

const HTTP = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const SOURCE_EXT = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const LICENROUTE_MODULE = "@licenroute/connect-express";

type PathVal = { kind: "static"; values: string[] } | { kind: "dynamic"; text: string };

interface NodeDef { key: string; kind: "app" | "router" | "param"; file: string; line: number }
type Ref = { local: string; file: string } | { node: string };
interface Entry {
  pos: number;
  file: string;
  line: number;
  conditional: boolean;
  kind: "route" | "mount" | "auth" | "licenroute" | "static";
  method?: string;
  path?: PathVal;
  target?: Ref;
  middleware?: string[];
  name?: string;
  responds?: "json" | "html" | null;
  /** use(X, router) con X importado de un módulo propio: si X no resulta ser un router o un middleware, es un prefijo. */
  prefixRef?: { ref: Ref; text: string };
  /** Este montaje es el propio X de prefixRef: si no se resuelve, no es un router perdido sino un posible prefijo. */
  prefixCandidate?: boolean;
}

interface FileInfo {
  file: string;
  imports: Map<string, { module: string; name: string }>; // local -> (módulo, export: "default" | nombre | "*")
  expressDefault: Set<string>;   // nombres locales de express()
  routerFactory: Set<string>;    // nombres locales de Router
  licenRouteFactory: Set<string>;   // nombres locales de licenroute()
  nodes: Map<string, string>;    // variable local -> clave de nodo
  licenRouteVars: Set<string>;      // const protection = licenroute(...)
  strings: Map<string, PathVal>; // const BASE = "/api"
  exports: Map<string, string>;  // nombre exportado ("default"…) -> variable local o "fn:<clave>"
  registrars: Map<string, string>; // función local -> clave del nodo parámetro
}

export interface ExpressResult {
  routes: Route[];
  unresolved: Unresolved[];
  unparseable: { file: string; error: string }[];
  entryFiles: string[];
  usesTypeScript: boolean;
  licenroute: { locations: { file: string; line: number }[]; licensedPaths: string[] | null; licensedRoutes: { pattern: string; methods: string[] }[] | null };
}

export function analyzeExpress(reader: ProjectReader): ExpressResult {
  const files = reader.list((p) => SOURCE_EXT.test(p) && !/\.d\.[cm]?ts$/.test(p) && !/(?:^|\/)(?:test|tests|__tests__|spec|e2e|fixtures?)\//.test(p) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p));
  const nodes = new Map<string, NodeDef>();
  const entries = new Map<string, Entry[]>(); // clave de nodo -> entradas en orden
  const infos = new Map<string, FileInfo>();
  const unresolved: Unresolved[] = [];
  const unparseable: { file: string; error: string }[] = [];
  const licenRouteLocations: { file: string; line: number }[] = [];
  let licensedPaths: string[] | null = null;
  let licensedRoutes: { pattern: string; methods: string[] }[] | null = null;
  let usesTypeScript = false;
  const pendingCalls: { callee: string; viaRequire?: string; argNode: string; pos: number; line: number; conditional: boolean; file: string }[] = [];

  const addEntry = (node: string, e: Entry) => { const list = entries.get(node) ?? []; list.push(e); entries.set(node, list); };

  for (const file of files) {
    const text = reader.read(file);
    if (text === null) continue;
    const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    let sf: ts.SourceFile;
    try { sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind); }
    catch (e) { unparseable.push({ file, error: sanitize(tc(e instanceof RangeError ? "express.parser_nesting" : "express.parser_internal")) }); continue; }
    const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
      const first = diagnostics[0]!;
      unparseable.push({ file, error: sanitize(`línea ${sf.getLineAndCharacterOfPosition(first.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`) });
      // Se sigue analizando lo que el parser haya podido recuperar, pero el fichero queda señalado.
    }
    if (!text.includes("express") && !text.includes("Router") && !text.includes(LICENROUTE_MODULE) && !/\.(?:get|post|put|patch|delete|use|route)\s*\(/.test(text)) continue;
    const info: FileInfo = { file, imports: new Map(), expressDefault: new Set(), routerFactory: new Set(), licenRouteFactory: new Set(), nodes: new Map(), licenRouteVars: new Set(), strings: new Map(), exports: new Map(), registrars: new Map() };
    infos.set(file, info);
    if (/\.[cm]?tsx?$/.test(file)) usesTypeScript = true;
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    // Forma de la llamada, SIN valores: nombres de identificadores; literales y expresiones sustituidos (pueden ser secretos).
    const argShape = (a: ts.Expression): string => {
      if (ts.isIdentifier(a)) return sanitize(a.text, 40);
      if (ts.isPropertyAccessExpression(a) && /^[\w$.]+$/.test(a.getText(sf))) return sanitize(a.getText(sf), 60);
      if (ts.isStringLiteralLike(a)) return '"<text>"';
      if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return "<function>";
      if (ts.isCallExpression(a)) return `${ts.isIdentifier(a.expression) || ts.isPropertyAccessExpression(a.expression) ? argShape(a.expression) : "<expression>"}(…)`;
      return "<expression>";
    };
    const snippet = (n: ts.Node) => {
      if (!ts.isCallExpression(n)) return "<expression>";
      const callee = ts.isPropertyAccessExpression(n.expression) || ts.isIdentifier(n.expression) ? argShape(n.expression) : ts.isElementAccessExpression(n.expression) ? `${argShape(n.expression.expression)}[<expresión>]` : "<expression>";
      return sanitize(`${callee}(${n.arguments.map(argShape).join(", ")})`);
    };
    const isConditional = (n: ts.Node): boolean => {
      for (let p = n.parent; p; p = p.parent) {
        if (ts.isIfStatement(p) || ts.isConditionalExpression(p) || ts.isSwitchStatement(p) || ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return true;
        if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression) && ["forEach", "map", "flatMap", "reduce", "filter"].includes(p.parent.expression.name.text)) return true;
      }
      return false;
    };

    // --- 1.ª pasada: importaciones, fábricas y constantes de texto -----------------------------------------------
    const visitDecls = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const mod = n.moduleSpecifier.text; const clause = n.importClause;
        if (clause?.name) bindImport(info, clause.name.text, mod, "default");
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) bindImport(info, clause.namedBindings.name.text, mod, "*");
          else for (const el of clause.namedBindings.elements) bindImport(info, el.name.text, mod, (el.propertyName ?? el.name).text);
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = n.initializer;
        const req = requireOf(init);
        if (req !== null) {
          if (ts.isIdentifier(n.name)) bindImport(info, n.name.text, req, "default");
          else if (ts.isObjectBindingPattern(n.name)) for (const el of n.name.elements) if (ts.isIdentifier(el.name)) bindImport(info, el.name.text, req, el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text);
        }
        if (ts.isIdentifier(n.name) && (ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0)) {
          const v = stringValue(init, info);
          if (v.kind === "static") info.strings.set(n.name.text, v);
        }
      }
      ts.forEachChild(n, visitDecls);
    };
    visitDecls(sf);

    const isExpressCall = (e: ts.Expression): "app" | "router" | null => {
      if (!ts.isCallExpression(e) && !ts.isNewExpression(e)) return null;
      const c = e.expression;
      if (ts.isIdentifier(c) && info.expressDefault.has(c.text)) return "app";
      if (ts.isIdentifier(c) && info.routerFactory.has(c.text)) return "router";
      if (ts.isPropertyAccessExpression(c) && c.name.text === "Router" && ts.isIdentifier(c.expression) && info.expressDefault.has(c.expression.text)) return "router";
      if (ts.isCallExpression(c)) { const r = requireOf(c); if (r === "express") return "app"; } // require("express")()
      if (ts.isPropertyAccessExpression(c) && c.name.text === "Router" && requireOf(c.expression) === "express") return "router";
      return null;
    };
    const isLicenRouteCall = (e: ts.Expression): ts.CallExpression | null => {
      if (!ts.isCallExpression(e)) return null;
      const c = e.expression;
      if (ts.isIdentifier(c) && info.licenRouteFactory.has(c.text)) return e;
      if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && info.imports.get(c.expression.text)?.module === LICENROUTE_MODULE) return e;
      return null;
    };
    const noteLicenRoute = (call: ts.CallExpression) => {
      licenRouteLocations.push({ file, line: lineOf(call) });
      const opts = call.arguments[0];
      if (opts && ts.isObjectLiteralExpression(opts)) {
        for (const p of opts.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "licensedPaths") {
            // Cada entrada: "/patrón/**" (todos los métodos) o { path: "/patrón/**", methods: ["GET", "HEAD"] } (D4.1),
            // siempre literales; cualquier otra forma deja licensedPaths sin leer (null).
            const entries = ts.isArrayLiteralExpression(p.initializer) ? p.initializer.elements.map(literalDeclaration) : [null];
            if (entries.every((e) => e !== null)) {
              licensedPaths = [...(licensedPaths ?? []), ...entries.map((e) => e!.pattern)];
              licensedRoutes = [...(licensedRoutes ?? []), ...(entries as { pattern: string; methods: string[] }[])];
            }
          }
        }
      }
    };

    // --- 2.ª pasada: apps y routers declarados, registradores y exportaciones --------------------------------------
    const fnParams = new Map<ts.Node, { param: string; key: string }>();
    const newNode = (kind: NodeDef["kind"], at: ts.Node, label: string): string => {
      const key = `${file}#${label}@${lineOf(at)}`;
      nodes.set(key, { key, kind, file, line: lineOf(at) });
      return key;
    };
    const visitNodes = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const kind = isExpressCall(n.initializer);
        if (kind) info.nodes.set(n.name.text, newNode(kind, n, n.name.text));
        const bg = isLicenRouteCall(n.initializer);
        if (bg) { info.licenRouteVars.add(n.name.text); noteLicenRoute(bg); }
        // const register = (app) => { … }  /  function register(router) { … }
        if ((ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && n.initializer.parameters[0] && ts.isIdentifier(n.initializer.parameters[0].name)) {
          info.registrars.set(n.name.text, registrar(n.initializer, n.name.text));
        }
      }
      if (ts.isFunctionDeclaration(n) && n.name && n.parameters[0] && ts.isIdentifier(n.parameters[0].name)) {
        info.registrars.set(n.name.text, registrar(n, n.name.text));
        if (n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) info.exports.set(n.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? "default" : n.name.text, `fn:${n.name.text}`);
      }
      if (ts.isExportAssignment(n)) exportExpr(n.expression, "default");
      if (ts.isVariableStatement(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) info.exports.set(d.name.text, d.name.text);
      if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause) && !n.moduleSpecifier) for (const el of n.exportClause.elements) info.exports.set(el.name.text, (el.propertyName ?? el.name).text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = n.left.getText(sf);
        if (left === "module.exports") exportExpr(n.right, "default");
        const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
        if (m) exportExpr(n.right, m[1]!);
      }
      ts.forEachChild(n, visitNodes);
    };
    const registrar = (fn: ts.SignatureDeclaration, label: string): string => {
      const param = fn.parameters[0]!.name as ts.Identifier;
      const key = newNode("param", fn, `${label}(${param.text})`);
      fnParams.set(fn, { param: param.text, key }); // solo dentro de esa función, el parámetro es "la app o el router que se pase"
      return key;
    };
    const exportExpr = (e: ts.Expression, name: string) => {
      if (ts.isIdentifier(e)) { info.exports.set(name, info.registrars.has(e.text) ? `fn:${e.text}` : e.text); return; }
      if ((ts.isArrowFunction(e) || ts.isFunctionExpression(e)) && e.parameters[0] && ts.isIdentifier(e.parameters[0].name)) {
        const local = `__export_${name}`; info.registrars.set(local, registrar(e, local)); info.exports.set(name, `fn:${local}`); return;
      }
      const kind = isExpressCall(e);
      if (kind) { const local = `__export_${name}`; info.nodes.set(local, newNode(kind, e, local)); info.exports.set(name, local); }
    };
    visitNodes(sf);

    // --- 3.ª pasada: llamadas sobre apps y routers ------------------------------------------------------------------
    const nodeOf = (e: ts.Expression): string | null => {
      if (!ts.isIdentifier(e)) return null;
      for (let p: ts.Node | undefined = e.parent; p; p = p.parent) { const f = fnParams.get(p); if (f && f.param === e.text) return f.key; }
      return info.nodes.get(e.text) ?? null;
    };
    const middlewareName = (a: ts.Expression): string => {
      if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) return sanitize(a.getText(sf), 60);
      if (ts.isCallExpression(a)) return sanitize(`${a.expression.getText(sf)}(…)`, 60);
      if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return "<function>";
      return sanitize(a.getText(sf), 60);
    };
    /** ¿Seguro que el primer argumento de use() NO es un prefijo? Si hay duda, se trata como prefijo desconocido. */
    const surelyNotPrefix = (a: ts.Expression): boolean => {
      if (ts.isCallExpression(a) || ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return true; // cors(), express.json(), (req,res,next) => …
      if (!ts.isIdentifier(a)) return false; // config.prefijo, process.env.X, a ?? b …
      if (info.nodes.has(a.text) || info.licenRouteVars.has(a.text) || info.registrars.has(a.text) || AUTH_MIDDLEWARE.test(a.text)) return true;
      const imp = info.imports.get(a.text);
      return Boolean(imp && !imp.module.startsWith(".")); // de un paquete (helmet, morgan…): middleware
    };
    const routeEntry = (node: string, method: string, pathArg: ts.Expression | undefined, args: readonly ts.Expression[], call: ts.CallExpression) => {
      const path = pathArg ? stringValue(pathArg, info) : { kind: "dynamic" as const, text: tc("express.no_route") };
      const mw = args.slice(0, -1).map(middlewareName);
      // Pista (no garantía) del tipo de respuesta, solo si el manejador está escrito en la propia llamada.
      const last = args[args.length - 1];
      const body = last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last)) ? last.getText(sf) : "";
      const responds = /\.render\s*\(/.test(body) ? "html" : /\.(?:json|jsonp)\s*\(/.test(body) ? "json" : null;
      addEntry(node, { pos: call.getStart(sf), file, line: lineOf(call), conditional: isConditional(call), kind: "route", method: method.toUpperCase(), path, middleware: mw, responds });
      if (path.kind === "dynamic") unresolved.push({ file, line: lineOf(call), kind: "dynamic-path", reason: tc("express.not_literal"), snippet: snippet(call) });
    };
    const visitCalls = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        // x.get(path, …handlers)  (con un solo argumento, app.get(nombre) es un ajuste de Express, no una ruta)
        if (ts.isPropertyAccessExpression(callee) && HTTP.has(callee.name.text)) {
          const recv = callee.expression;
          const node = nodeOf(recv);
          if (node && n.arguments.length >= 2) routeEntry(node, callee.name.text, n.arguments[0], n.arguments.slice(1), n);
          else if (!node && ts.isCallExpression(recv)) {
            // x.route(path).get(h).post(h): se baja por la cadena hasta .route(path)
            let base: ts.Expression = recv;
            while (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && HTTP.has(base.expression.name.text)) base = base.expression.expression;
            if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text === "route") {
              const rn = nodeOf(base.expression.expression);
              if (rn) routeEntry(rn, callee.name.text, base.arguments[0], [...n.arguments], n);
            }
          } else if (!node && ts.isIdentifier(recv) && n.arguments.length >= 2 && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text.startsWith("/")) {
            unresolved.push({ file, line: lineOf(n), kind: "unknown-receiver", reason: tc("express.possible_route", { p1: sanitize(recv.text, 40) }), snippet: snippet(n) });
          }
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "route" && nodeOf(callee.expression)) {
          // x.route(path) suelto, sin métodos encadenados: nada que registrar.
        } else if (ts.isElementAccessExpression(callee) && nodeOf(callee.expression)) {
          unresolved.push({ file, line: lineOf(n), kind: "dynamic-method", reason: tc("express.computed_method"), snippet: snippet(n) });
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "use" && nodeOf(callee.expression)) {
          useEntry(nodeOf(callee.expression)!, n);
        } else if (ts.isIdentifier(callee) && info.registrars.has(callee.text) && n.arguments[0] && nodeOf(n.arguments[0])) {
          // register(app) en el mismo fichero
          addEntry(nodeOf(n.arguments[0])!, { pos: n.getStart(sf), file, line: lineOf(n), conditional: isConditional(n), kind: "mount", path: { kind: "static", values: [""] }, target: { node: info.registrars.get(callee.text)! }, middleware: [] });
        } else if (n.arguments[0] && nodeOf(n.arguments[0])) {
          // register(app) importado, o require("./rutas")(app)
          const req = ts.isCallExpression(callee) ? requireOf(callee) : null;
          const argNode = nodeOf(n.arguments[0])!;
          if (ts.isIdentifier(callee) && info.imports.has(callee.text)) pendingCalls.push({ callee: callee.text, argNode, pos: n.getStart(sf), line: lineOf(n), conditional: isConditional(n), file });
          else if (req !== null) pendingCalls.push({ callee: "", viaRequire: req, argNode, pos: n.getStart(sf), line: lineOf(n), conditional: isConditional(n), file });
        }
      }
      ts.forEachChild(n, visitCalls);
    };
    const useEntry = (node: string, call: ts.CallExpression) => {
      const args = [...call.arguments];
      let path: PathVal = { kind: "static", values: [""] };
      let prefixRef: Entry["prefixRef"];
      if (args[0] && (ts.isStringLiteralLike(args[0]) || ts.isTemplateExpression(args[0]) || ts.isBinaryExpression(args[0]) || ts.isArrayLiteralExpression(args[0]) || ts.isRegularExpressionLiteral(args[0]) || (ts.isIdentifier(args[0]) && info.strings.has(args[0].text)))) {
        path = stringValue(args.shift()!, info);
        if (path.kind === "dynamic") unresolved.push({ file, line: lineOf(call), kind: "dynamic-mount", reason: tc("express.mount_unresolvable"), snippet: snippet(call) });
      } else if (args.length >= 2 && args[0] && !surelyNotPrefix(args[0])) {
        // S10.2-D2: use(PREFIJO, router) con un primer argumento que no se puede evaluar. Antes se tomaba por un
        // middleware y el router quedaba montado en la RAÍZ (/indicadores en vez de /api/v2/indicadores).
        const a = args[0]; const text = sanitize(a.getText(sf), 60);
        const local = ts.isIdentifier(a) ? a.text : null;
        const imp = local ? info.imports.get(local) : undefined;
        if (local && imp && imp.module.startsWith(".")) prefixRef = { ref: { local, file }, text }; // se decide al resolver
        else {
          args.shift();
          path = { kind: "dynamic", text };
          unresolved.push({ file, line: lineOf(call), kind: "dynamic-mount", reason: tc("express.computed_prefix", { text }), snippet: snippet(call) });
        }
      }
      const base = { pos: call.getStart(sf), file, line: lineOf(call), conditional: isConditional(call) };
      const before: string[] = [];
      for (const a of args) {
        const bg = isLicenRouteCall(a);
        if (bg || (ts.isIdentifier(a) && info.licenRouteVars.has(a.text))) { if (bg) noteLicenRoute(bg); else licenRouteLocations.push({ file, line: lineOf(call) }); addEntry(node, { ...base, kind: "licenroute", path }); continue; }
        if (ts.isCallExpression(a) && /(?:^|\.)static$/.test(a.expression.getText(sf))) { addEntry(node, { ...base, kind: "static", path, name: middlewareName(a) }); continue; }
        // Un middleware con nombre de autenticación (local o importado) no es un router, aunque venga de otro fichero.
        if (ts.isIdentifier(a) && !info.nodes.has(a.text) && AUTH_MIDDLEWARE.test(a.text)) {
          if (a === args[args.length - 1]) addEntry(node, { ...base, kind: "auth", path, name: a.text }); else before.push(a.text);
          continue;
        }
        const target = ts.isIdentifier(a) ? (info.nodes.has(a.text) ? { node: info.nodes.get(a.text)! } : info.imports.has(a.text) ? { local: a.text, file } : null) : ts.isCallExpression(a) && requireOf(a) !== null ? { local: `require:${requireOf(a)}`, file } : null;
        if (target) { addEntry(node, { ...base, kind: "mount", path, target, middleware: [...before], ...(prefixRef ? (a === call.arguments[0] ? { prefixCandidate: true } : { prefixRef }) : {}) }); continue; }
        const name = middlewareName(a);
        if (AUTH_MIDDLEWARE.test(name)) { if (args.length === 1 || a === args[args.length - 1]) addEntry(node, { ...base, kind: "auth", path, name }); else before.push(name); continue; }
        before.push(name);
      }
    };
    visitCalls(sf);
  }

  // --- resolución entre ficheros ------------------------------------------------------------------------------------
  const resolveModule = (fromFile: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    const parts = [...(dir ? dir.split("/") : []), ...spec.split("/")];
    const out: string[] = [];
    for (const p of parts) { if (p === "." || p === "") continue; if (p === "..") { if (!out.pop()) return null; continue; } out.push(p); }
    const baseRaw = out.join("/");
    const base = baseRaw.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [baseRaw, ...["ts", "tsx", "mts", "cts", "js", "mjs", "cjs", "jsx"].map((e) => `${base}.${e}`), ...["ts", "js", "mts", "mjs", "tsx", "jsx"].map((e) => `${baseRaw}/index.${e}`)];
    return candidates.find((c) => infos.has(c)) ?? candidates.find((c) => reader.exists(c)) ?? null;
  };
  const resolveRef = (ref: Ref, depth = 0): string | null => {
    if ("node" in ref) return ref.node;
    if (depth > 8) return null;
    const from = infos.get(ref.file)!;
    let mod: string; let name: string;
    if (ref.local.startsWith("require:")) { mod = ref.local.slice(8); name = "default"; }
    else { const imp = from.imports.get(ref.local); if (!imp) return null; mod = imp.module; name = imp.name; }
    const target = resolveModule(ref.file, mod);
    const tinfo = target ? infos.get(target) : undefined;
    if (!tinfo) return null;
    const local = tinfo.exports.get(name) ?? (name === "default" ? tinfo.exports.get("router") : undefined);
    if (!local) return null;
    if (local.startsWith("fn:")) return tinfo.registrars.get(local.slice(3)) ?? null;
    if (tinfo.nodes.has(local)) return tinfo.nodes.get(local)!;
    if (tinfo.imports.has(local)) return resolveRef({ local, file: target! }, depth + 1);
    return null;
  };
  for (const c of pendingCalls) {
    const ref: Ref = c.viaRequire !== undefined ? { local: `require:${c.viaRequire}`, file: c.file } : { local: c.callee, file: c.file };
    const target = resolveRef(ref);
    const appNode = c.argNode;
    if (target && nodes.get(target)?.kind === "param") addEntry(appNode, { pos: c.pos, file: c.file, line: c.line, conditional: c.conditional, kind: "mount", path: { kind: "static", values: [""] }, target: { node: target }, middleware: [] });
  }

  // --- recorrido desde cada app ---------------------------------------------------------------------------------
  const routes: Route[] = [];
  const reached = new Set<string>();
  // Un middleware montado con ruta (app.use("/admin", auth)) solo afecta a las rutas bajo ese prefijo.
  type Scoped = { name: string; scope: string };
  const inScope = (path: string | null, s: Scoped) => path === null || s.scope === "/" || path === s.scope || path.startsWith(`${s.scope}/`);
  // ctx.unknown: el prefijo no se ha podido resolver. Bajo él, `prefixes` son RELATIVOS y ninguna ruta tiene valor (path
  // null, sin resolver): nunca se usa la raíz ni el prefijo del padre como sustituto (S10.2-D2). D4.4.2: se decide por
  // la PRESENCIA de ctx.unknown; `label` (texto del código o etiqueta traducible) solo se muestra.
  const emit = (node: string, prefixes: string[], ctx: { auth: Scoped[]; licenroute: Scoped[]; conditional: boolean; partial: boolean; notes: string[]; unknown?: { label: string } }, stack: string[]) => {
    if (stack.includes(node) || stack.length > 12) return;
    reached.add(node);
    const auth = [...ctx.auth]; const licenroute = [...ctx.licenroute];
    const list = [...(entries.get(node) ?? [])].sort((a, b) => (a.file === b.file ? a.pos - b.pos : 0));
    for (const e of list) {
      const paths = e.path?.kind === "static" ? e.path.values : [null];
      if (e.kind === "auth" || e.kind === "licenroute") {
        for (const prefix of prefixes) for (const p of paths) (e.kind === "auth" ? auth : licenroute).push({ name: e.name ?? "licenroute", scope: p === null ? prefix : joinPaths(prefix, p) });
        continue;
      }
      const sig = (path: string | null, extra: string[]) => ({ auth: [...auth.filter((a) => inScope(path, a)).map((a) => a.name), ...extra.filter((m) => AUTH_MIDDLEWARE.test(m))], licenroute: licenroute.some((b) => inScope(path, b)), conditional: ctx.conditional || e.conditional });
      for (const prefix of prefixes) {
        for (const p of paths) {
          const full = p === null ? null : joinPaths(prefix, p);
          const where = (rel: string | null) => (ctx.unknown !== undefined ? null : rel); // bajo un prefijo desconocido no hay ruta
          const under = (rel: string | null, method: string) => {
            if (ctx.unknown === undefined) return [];
            unresolved.push({ file: e.file, line: e.line, kind: "dynamic-mount", reason: tc("express.under_unknown_prefix", { method, route: rel === null ? tc("express.dynamic_route") : displayPath(rel), prefix: ctx.unknown.label }), snippet: sanitize(`${method.toLowerCase()}(${rel === null ? "?" : displayPath(rel)}, …)`) });
            return [tc("express.unresolvable_prefix", { prefix: ctx.unknown.label, route: rel === null ? tc("express.dynamic") : displayPath(rel) })];
          };
          if (e.kind === "static") {
            const rel = full === null ? null : joinPaths(full, "**");
            routes.push(mkRoute("ALL", where(rel), e, "static", sig(full, []), [...ctx.notes, `express.static (${e.name})`, ...under(rel, "ALL")], ctx.partial || p === null));
          } else if (e.kind === "route") {
            const notes = [...ctx.notes];
            if (p !== null && EXPRESS_WILDCARD.test(p)) notes.push(tc("express.wildcard")); // la nota solo informa; decide isWildcardRoute
            routes.push(mkRoute(e.method!, where(full), e, null, sig(full, e.middleware!), [...notes, ...under(full, e.method!)], ctx.partial || p === null));
          } else if (e.kind === "mount") {
            const target = resolveRef(e.target!);
            if (target && nodes.get(target)?.kind === "param" && !(entries.get(target) ?? []).some((x) => x.kind === "route" || x.kind === "mount")) continue; // función middleware, no un router
            if (!target) {
              if (e.prefixCandidate) continue; // era el prefijo de use(PREFIJO, router), no un router
              unresolved.push({ file: e.file, line: e.line, kind: "unresolved-mount", reason: tc("express.router_not_found"), snippet: sanitize(`use(${p ?? "?"}, …)`) });
              continue;
            }
            // use(X, router) con X importado: si X es un router o un middleware ya se ha montado aparte; si no, es un prefijo.
            const unknownPrefix = e.prefixRef && resolveRef(e.prefixRef.ref) === null ? e.prefixRef.text : p === null ? (e.path as { text: string }).text : null;
            if (e.prefixRef && unknownPrefix !== null) unresolved.push({ file: e.file, line: e.line, kind: "dynamic-mount", reason: tc("express.imported_prefix", { unknownPrefix }), snippet: sanitize(`use(${unknownPrefix}, …)`) });
            const unknown = ctx.unknown ?? (unknownPrefix !== null ? { label: unknownPrefix } : undefined);
            const scope = unknown !== undefined && ctx.unknown === undefined ? "/" : full ?? prefix;
            emit(target, [scope], { auth: [...auth, ...e.middleware!.filter((m) => AUTH_MIDDLEWARE.test(m)).map((name) => ({ name, scope }))], licenroute, conditional: ctx.conditional || e.conditional, partial: ctx.partial || p === null, notes: ctx.notes, ...(unknown !== undefined ? { unknown } : {}) }, [...stack, node]);
          }
        }
      }
    }
  };
  const mkRoute = (method: string, path: string | null, e: Entry, category: Route["category"] | null, s: { auth: string[]; licenroute: boolean; conditional: boolean }, notes: string[], partial: boolean): Route => {
    const original = path;
    const safe = safePath(path); path = safe.path;
    if (safe.rejected !== null && original !== null) {
      notes = [...notes, tc("express.rejected_unresolved", { rejected: safe.rejected })];
      unresolved.push({ file: e.file, line: e.line, kind: "dynamic-path", reason: tc("express.rejected_by_hand", { rejected: safe.rejected }), snippet: sanitize(`${method.toLowerCase()}(${displayPath(original)}, …)`) });
    }
    const resolution = path === null ? "dynamic" : partial ? "partial" : "static";
    if (s.conditional) notes = [...notes, tc("express.in_loop")];
    let cat = category ?? classify(path, method);
    if (cat === "page" && e.responds === "json") { cat = "api"; notes = [...notes, tc("express.responds_json")]; }
    if (e.responds === "html") notes = [...notes, tc("express.renders_view")];
    return { id: routeId("express", method, path, e.file, e.line), method: method as Method, path, source: { file: e.file, line: e.line }, resolution, category: cat, framework: "express", signals: { auth_middleware: [...new Set(s.auth)], behind_licenroute: s.licenroute, conditional: s.conditional }, notes };
  };
  const apps = [...nodes.values()].filter((n) => n.kind === "app");
  for (const app of apps) emit(app.key, ["/"], { auth: [], licenroute: [], conditional: false, partial: false, notes: [] }, []);
  // Routers con rutas a los que no llega ninguna app: se informan con su ruta relativa.
  for (const n of nodes.values()) {
    if (reached.has(n.key) || !(entries.get(n.key) ?? []).some((e) => e.kind === "route")) continue;
    // Su prefijo real es desconocido: se listan como sin resolver, con la ruta relativa (S10.2-D2: antes, como si colgaran de /).
    emit(n.key, ["/"], { auth: [], licenroute: [], conditional: false, partial: true, notes: [n.kind === "param" ? tc("express.in_function") : tc("express.router_unmounted")], unknown: { label: n.kind === "param" ? tc("express.kind_function") : tc("express.kind_unmounted") } }, []);
  }
  const seen = new Set<string>();
  const unique = routes.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return { routes: unique, unresolved, unparseable, entryFiles: [...new Set(apps.map((a) => a.file))].sort(), usesTypeScript, licenroute: { locations: licenRouteLocations, licensedPaths, licensedRoutes } };
}

function bindImport(info: FileInfo, local: string, module: string, name: string) {
  info.imports.set(local, { module, name });
  if (module === "express" && (name === "default" || name === "*")) info.expressDefault.add(local);
  if (module === "express" && name === "Router") info.routerFactory.add(local);
  if (module === LICENROUTE_MODULE && (name === "licenroute" || name === "default")) info.licenRouteFactory.add(local);
}

function requireOf(e: ts.Expression): string | null {
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "require" && e.arguments[0] && ts.isStringLiteralLike(e.arguments[0])) return e.arguments[0].text;
  return null;
}

/** Valor de una expresión de ruta sin ejecutar nada. */
function stringValue(e: ts.Expression, info: FileInfo): PathVal {
  if (ts.isStringLiteralLike(e)) return { kind: "static", values: [e.text] };
  if (ts.isParenthesizedExpression(e)) return stringValue(e.expression, info);
  if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return stringValue(e.expression, info);
  if (ts.isIdentifier(e) && info.strings.has(e.text)) return info.strings.get(e.text)!;
  if (ts.isTemplateExpression(e)) {
    let acc = [e.head.text];
    for (const span of e.templateSpans) {
      const v = stringValue(span.expression, info);
      if (v.kind === "dynamic" || v.values.length !== 1) return { kind: "dynamic", text: sanitize(e.getText()) };
      acc = acc.map((a) => a + v.values[0] + span.literal.text);
    }
    return { kind: "static", values: acc };
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = stringValue(e.left, info); const r = stringValue(e.right, info);
    if (l.kind === "static" && r.kind === "static" && l.values.length === 1 && r.values.length === 1) return { kind: "static", values: [l.values[0]! + r.values[0]!] };
  }
  if (ts.isArrayLiteralExpression(e)) {
    const vs = e.elements.map((el) => stringValue(el as ts.Expression, info));
    if (vs.every((v) => v.kind === "static")) return { kind: "static", values: vs.flatMap((v) => (v as { values: string[] }).values) };
  }
  return { kind: "dynamic", text: sanitize(e.getText()) };
}

/** Entrada literal de licensedPaths: cadena (todos los métodos) u objeto { path, methods } con literales; si no, null. */
export function literalDeclaration(el: ts.Expression): { pattern: string; methods: string[] } | null {
  if (ts.isStringLiteralLike(el)) return { pattern: el.text, methods: [] };
  if (!ts.isObjectLiteralExpression(el) || el.properties.length !== 2) return null;
  let pattern: string | null = null; let methods: string[] | null = null;
  for (const prop of el.properties) {
    if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) return null;
    if (prop.name.text === "path" && ts.isStringLiteralLike(prop.initializer)) pattern = prop.initializer.text;
    else if (prop.name.text === "methods" && ts.isArrayLiteralExpression(prop.initializer) && prop.initializer.elements.length > 0 && prop.initializer.elements.every((m) => ts.isStringLiteralLike(m))) methods = [...new Set(prop.initializer.elements.map((m) => (m as ts.StringLiteralLike).text.toUpperCase()))].sort();
    else return null;
  }
  return pattern !== null && methods !== null ? { pattern, methods } : null;
}
