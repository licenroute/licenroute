/**
 * Análisis ESTÁTICO de las rutas de Rails 7/8 (config/routes.rb y config/routes/*.rb vía `draw`). No ejecuta Ruby:
 * un parser conservador del DSL de rutas con una pila de bloques. Lo que no entiende (bucles, condiciones, concerns,
 * interpolación, métodos propios) se marca como no resuelto con su línea, en lugar de adivinar.
 */
import type { ProjectReader } from "./reader.ts";
import type { Method, Route, Unresolved } from "./schema.ts";
import { classify, displayPath, joinPaths, routeId, safePath, sanitize } from "./util.ts";
import { tc } from "../bin/i18n.mjs";

type Tok = { t: "sym" | "str" | "dyn" | "key" | "arrow" | "comma" | "lbr" | "rbr" | "word" | "other"; v: string };
type Val = string | string[] | null; // símbolo/cadena, lista, o desconocido

interface Frame {
  kind: "root" | "namespace" | "scope" | "resources" | "resource" | "member" | "collection" | "constraints" | "unknown" | "concern";
  path: string;        // prefijo de ruta acumulado
  module: string;      // módulo de controladores acumulado (api/v1)
  resource?: { name: string; param: string; plural: boolean; controller: string; memberPath: string; collectionPath: string };
  conditional: boolean;
}

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "match"]);
const REST = (api: boolean) => [
  ["GET", "", "index", false], ["POST", "", "create", false], ["GET", "/new", "new", false], ["GET", "/:id/edit", "edit", true],
  ["GET", "/:id", "show", true], ["PATCH", "/:id", "update", true], ["PUT", "/:id", "update", true], ["DELETE", "/:id", "destroy", true],
].filter(([, , action]) => !(api && (action === "new" || action === "edit"))) as [string, string, string, boolean][];
const SINGULAR = (api: boolean) => [
  ["GET", "", "show"], ["POST", "", "create"], ["PATCH", "", "update"], ["PUT", "", "update"], ["DELETE", "", "destroy"], ["GET", "/new", "new"], ["GET", "/edit", "edit"],
].filter(([, , action]) => !(api && (action === "new" || action === "edit"))) as [string, string, string][];

export interface RailsResult {
  routes: Route[];
  unresolved: Unresolved[];
  unparseable: { file: string; error: string }[];
  version: string | null;
  apiOnly: boolean;
  routeFiles: string[];
  licenroute: { locations: { file: string; line: number }[]; licensedPaths: string[] | null; global: boolean };
}

export function railsVersion(reader: ProjectReader): string | null {
  const lock = reader.read("Gemfile.lock");
  const m = lock && (/^ {4}rails \(([\d.]+[^)]*)\)/m.exec(lock) ?? /^ {4}railties \(([\d.]+[^)]*)\)/m.exec(lock));
  if (m) return m[1]!;
  const gemfile = reader.read("Gemfile");
  const g = gemfile && /^\s*gem\s+["']rails["']\s*,\s*["']([^"']+)["']/m.exec(gemfile);
  return g ? g[1]!.replace(/^[~>=<\s]+/, "") : null;
}

export function analyzeRails(reader: ProjectReader): RailsResult {
  const unresolved: Unresolved[] = [];
  const unparseable: { file: string; error: string }[] = [];
  const routes: Route[] = [];
  const routeFiles: string[] = [];
  const app = reader.read("config/application.rb") ?? "";
  // API: config.api_only, o controladores sobre ActionController::API (también en apps de un solo fichero).
  const apiOnly = /^\s*config\.api_only\s*=\s*true/m.test(app) || /<\s*ActionController::API\b/.test(reader.read("app/controllers/application_controller.rb") ?? "") || /<\s*ActionController::API\b/.test(reader.read("config.ru") ?? "");
  const licenroute = findLicenRoute(reader);
  const authOf = controllerAuth(reader);

  const add = (method: string, path: string | null, file: string, line: number, f: Frame, controller: string | null, action: string | null, notes: string[] = [], categoryOverride?: Route["category"]) => {
    const n = [...notes];
    // S10.2-D2: el valor nunca se sanea; una ruta ambigua queda sin resolver (path null) y se muestra con displayPath.
    const original = path;
    const safe = safePath(path); path = safe.path;
    if (safe.rejected !== null && original !== null) {
      n.push(tc("rails.rejected_unresolved", { rejected: safe.rejected }));
      unresolved.push({ file, line, kind: "dynamic-path", reason: tc("rails.rejected_by_hand", { rejected: safe.rejected }), snippet: sanitize(`${method.toLowerCase()} ${displayPath(original)}`) });
    }
    if (f.conditional) n.push(tc("rails.conditional_block"));
    const auth = controller ? authOf(controller, action) : { names: [], notes: [] };
    routes.push({
      id: routeId("rails", method, path, file, line), method: method as Method, path, source: { file, line },
      resolution: path === null ? "dynamic" : "static", category: categoryOverride ?? (apiOnly && classify(path, method) === "page" ? "api" : classify(path, method)), framework: "rails",
      signals: { auth_middleware: auth.names, behind_licenroute: licenroute.global, conditional: f.conditional }, notes: [...n, ...auth.notes, ...(controller ? [tc("rails.controller", { controller, p2: action ? `#${action}` : "" })] : [])],
    });
  };

  const parseFile = (file: string, base: Frame, depth: number, fromLine = 0) => {
    const text = reader.read(file);
    if (text === null) { if (depth > 0) unresolved.push({ file, line: 1, kind: "missing-draw", reason: tc("rails.draw_missing"), snippet: file }); return; }
    routeFiles.push(file);
    const stack: Frame[] = [base];
    // fromLine: en una app de un solo fichero (config.ru), solo se analiza el bloque `X.routes.draw do … end`.
    const lines = joinContinuations(text.split("\n")).filter((l) => l.line > fromLine);
    const drawDepth = fromLine > 0 ? 0 : -1;
    for (const { line: lineNo, text: raw } of lines) {
      const code = stripComment(raw).trim();
      if (!code) continue;
      const f = stack[stack.length - 1]!;
      if (/^end\b/.test(code) || code === "}") {
        if (stack.length > 1) stack.pop(); else unparseable.push({ file, error: tc("rails.end_without_block", { lineNo }) });
        if (drawDepth >= 0 && stack.length === 1) break; // fin del bloque draw de config.ru
        continue;
      }
      const opensBlock = /\bdo(\s*\|[^|]*\|)?\s*$/.test(code) || /\{\s*(\|[^|]*\|)?\s*$/.test(code);
      const body = code.replace(/\s*(?:\bdo(\s*\|[^|]*\|)?|\{\s*(\|[^|]*\|)?)\s*$/, "");
      const toks = tokenize(body);
      const head = toks[0];
      const push = (fr: Partial<Frame> & { kind: Frame["kind"] }) => { if (opensBlock) stack.push({ ...f, resource: undefined, ...fr }); };
      // Forma de la sentencia, SIN valores: palabras y símbolos; cadenas e interpolaciones sustituidas (pueden ser secretos).
      const snippet = sanitize(tokenize(code).map((t) => (t.t === "str" ? '"<text>"' : t.t === "dyn" ? "<interpolation>" : t.t === "sym" ? `:${t.v}` : t.t === "key" ? `${t.v}:` : t.t === "word" ? t.v : t.t === "comma" ? "," : t.t === "arrow" ? "=>" : t.t === "lbr" ? "[" : t.t === "rbr" ? "]" : "")).join(" ").replace(/ ,/g, ","));
      if (f.kind === "concern") { if (opensBlock) push({ kind: "concern" }); continue; }
      if (/^Rails\.application\.routes\.draw\b/.test(code) || /^\w+(::\w+)*\.routes\.draw\b/.test(code)) { push({ kind: "root" }); continue; }
      if (/^(if|unless|case|while|until|for|begin)\b/.test(code)) { if (!/\bend\s*$/.test(code)) stack.push({ ...f, kind: "unknown", conditional: true }); unresolved.push({ file, line: lineNo, kind: "conditional", reason: tc("rails.block_varies"), snippet }); continue; }
      if (/^(def|class|module)\b/.test(code)) { stack.push({ ...f, kind: "unknown", conditional: true }); unresolved.push({ file, line: lineNo, kind: "ruby-definition", reason: tc("rails.ruby_definition"), snippet }); continue; }
      if (/\s(if|unless)\s/.test(code) && !opensBlock) { unresolved.push({ file, line: lineNo, kind: "conditional", reason: tc("rails.conditional_modifier"), snippet }); }
      if (!head || head.t !== "word") { if (opensBlock) stack.push({ ...f, kind: "unknown", conditional: true }); unresolved.push({ file, line: lineNo, kind: "unknown-statement", reason: tc("rails.unknown_statement"), snippet }); continue; }
      const word = head.v;
      const { args, opts, dynamic } = parseArgs(toks.slice(1));
      const s = (v: Val | undefined): string | null => (typeof v === "string" ? v : null);
      if (dynamic) unresolved.push({ file, line: lineNo, kind: "dynamic-path", reason: tc("rails.interpolation"), snippet });

      if (word === "namespace") {
        const name = s(args[0]); if (!name) { unresolved.push({ file, line: lineNo, kind: "dynamic-namespace", reason: tc("rails.namespace_not_literal"), snippet }); push({ kind: "unknown", conditional: true }); continue; }
        push({ kind: "namespace", path: joinPaths(f.path, s(opts.path) ?? name), module: joinMod(f.module, s(opts.module) ?? name) });
      } else if (word === "scope") {
        const path = s(args[0]) ?? s(opts.path);
        push({ kind: "scope", path: path ? joinPaths(f.path, path) : f.path, module: s(opts.module) ? joinMod(f.module, s(opts.module)!) : f.module, conditional: f.conditional || "constraints" in opts });
      } else if (word === "constraints") {
        push({ kind: "constraints", conditional: true });
        unresolved.push({ file, line: lineNo, kind: "constraints", reason: tc("rails.constraints"), snippet });
      } else if (word === "resources" || word === "resource") {
        const plural = word === "resources";
        const names = args.flatMap((a) => (typeof a === "string" ? [a] : Array.isArray(a) ? a : []));
        if (names.length === 0 || dynamic) { unresolved.push({ file, line: lineNo, kind: "dynamic-resource", reason: tc("rails.resource_not_literal"), snippet }); push({ kind: "unknown", conditional: true }); continue; }
        if ("concerns" in opts) unresolved.push({ file, line: lineNo, kind: "concerns", reason: tc("rails.concerns_not_listed"), snippet });
        const only = listOpt(opts.only); const except = listOpt(opts.except);
        for (const name of names) {
          const segment = s(opts.path) ?? name;
          const param = s(opts.param) ?? "id";
          const controller = joinMod(f.module, s(opts.controller) ?? (plural ? name : pluralize(name)));
          const parentPath = f.resource ? (f.kind === "member" ? f.path : f.resource.memberPath.replace(/\/:id$/, `/:${singular(f.resource.name)}_id`)) : f.path;
          const basePath = joinPaths(parentPath, segment);
          const allowed = (action: string) => (only ? only.includes(action) : true) && !(except ?? []).includes(action);
          if (plural) for (const [m, suffix, action, member] of REST(apiOnly)) { if (allowed(action)) add(m, basePath + (member ? suffix.replace(":id", `:${param}`) : suffix), file, lineNo, f, controller, action); }
          else for (const [m, suffix, action] of SINGULAR(apiOnly)) { if (allowed(action)) add(m, basePath + suffix, file, lineNo, f, controller, action); }
          if (names.length === 1) push({ kind: plural ? "resources" : "resource", path: basePath, resource: { name, param, plural, controller, memberPath: plural ? `${basePath}/:${param}` : basePath, collectionPath: basePath } });
        }
        if (names.length > 1 && opensBlock) stack.push({ ...f, kind: "unknown", conditional: true });
      } else if (word === "member" || word === "collection") {
        if (!f.resource) { unresolved.push({ file, line: lineNo, kind: "orphan-block", reason: tc("rails.outside_resources", { word }), snippet }); push({ kind: "unknown", conditional: true }); continue; }
        push({ kind: word, path: word === "member" ? f.resource.memberPath : f.resource.collectionPath, resource: f.resource });
      } else if (VERBS.has(word)) {
        let methods = [word.toUpperCase()];
        if (word === "match") {
          const via = opts.via; const list = typeof via === "string" ? [via] : Array.isArray(via) ? via : [];
          methods = list.includes("all") ? ["ALL"] : list.map((v) => v.toUpperCase());
          const bad = methods.filter((m) => !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(m));
          if (bad.length) { unresolved.push({ file, line: lineNo, kind: "unknown-verb", reason: tc("rails.unknown_verb", { p1: sanitize(bad.join(", "), 40) }), snippet }); methods = methods.filter((m) => !bad.includes(m)); }
          if (methods.length === 0) { unresolved.push({ file, line: lineNo, kind: "match-without-via", reason: tc("rails.match_no_via"), snippet }); methods = ["ALL"]; }
        }
        const first = args[0];
        let path: string | null; let target = s(opts.to) ?? s(opts["=>"]) ?? null;
        if (typeof first === "string") {
          const isSymbol = toks[1]?.t === "sym";
          // Dentro de resources sin member/collection, una ruta va ANIDADA (/fotos/:foto_id/x), salvo on: :member|:collection.
          const on = s(opts.on);
          const base = f.resource && (f.kind === "resources" || f.kind === "resource")
            ? on === "member" ? f.resource.memberPath : on === "collection" || !f.resource.plural ? f.resource.collectionPath : f.resource.memberPath.replace(/\/:[^/]+$/, `/:${singular(f.resource.name)}_id`)
            : f.path;
          path = joinPaths(base, first);
          if (!target && isSymbol && f.resource) target = `${f.resource.controller.split("/").pop()}#${first}`;
        } else if (dynamic || first === null) path = null;
        else { path = null; unresolved.push({ file, line: lineNo, kind: "dynamic-path", reason: tc("rails.route_not_literal"), snippet }); }
        const [controller, action] = target && target.includes("#") ? [joinMod(f.module, target.split("#")[0]!), target.split("#")[1]!] : [f.resource?.controller ?? null, null];
        const health = target === "rails/health#show" ? "health" : undefined;
        for (const m of methods) add(m, path, file, lineNo, f, health ? null : controller, action, health ? [tc("rails.health_controller")] : [], health);
      } else if (word === "root") {
        const target = s(args[0]) ?? s(opts.to);
        const [controller, action] = target?.includes("#") ? [joinMod(f.module, target.split("#")[0]!), target.split("#")[1]!] : [null, null];
        add("GET", f.path, file, lineNo, f, controller, action);
      } else if (word === "mount") {
        const at = s(opts.at) ?? s(opts["=>"]);
        add("ALL", at ? joinPaths(f.path, at, "**") : null, file, lineNo, f, null, null, [tc("rails.mounted_app")]);
        if (!at) unresolved.push({ file, line: lineNo, kind: "dynamic-mount", reason: tc("rails.mount_not_literal"), snippet });
      } else if (word === "devise_for") {
        const name = s(args[0]) ?? "users";
        add("ALL", joinPaths(f.path, s(opts.path) ?? name, "**"), file, lineNo, f, null, null, [tc("rails.devise")], "auth");
      } else if (word === "draw") {
        const name = s(args[0]);
        if (!name || depth > 3) { unresolved.push({ file, line: lineNo, kind: "dynamic-draw", reason: tc("rails.draw_not_literal"), snippet }); continue; }
        parseFile(`config/routes/${name}.rb`, f, depth + 1);
      } else if (word === "concern") {
        stack.push({ ...f, kind: "concern" }); unresolved.push({ file, line: lineNo, kind: "concern", reason: tc("rails.concern_definition"), snippet });
      } else if (word === "concerns") {
        unresolved.push({ file, line: lineNo, kind: "concerns", reason: tc("rails.concerns_use"), snippet });
      } else if (["direct", "resolve", "use_doorkeeper", "draw_routes"].includes(word)) {
        if (opensBlock) stack.push({ ...f, kind: "unknown", conditional: true });
        unresolved.push({ file, line: lineNo, kind: "unsupported", reason: tc("rails.unsupported_word", { word }), snippet });
      } else {
        if (opensBlock) stack.push({ ...f, kind: "unknown", conditional: true });
        unresolved.push({ file, line: lineNo, kind: "unknown-statement", reason: tc("rails.unknown_call", { p1: sanitize(word, 40) }), snippet });
      }
    }
    if (stack.length > 1 && depth === 0) unparseable.push({ file, error: tc("rails.missing_end", { p1: stack.length - 1 }) });
  };
  const rootFrame: Frame = { kind: "root", path: "/", module: "", conditional: false };
  const ru = reader.exists("config/routes.rb") ? null : reader.read("config.ru");
  const drawAt = ru ? ru.split("\n").findIndex((l) => /^\s*[\w:]+\.routes\.draw\s+do\b/.test(stripComment(l))) : -1;
  if (ru && drawAt >= 0) parseFile("config.ru", rootFrame, 0, drawAt);
  else parseFile("config/routes.rb", rootFrame, 0);
  const seen = new Set<string>();
  return { routes: routes.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))), unresolved, unparseable, version: railsVersion(reader), apiOnly, routeFiles, licenroute };
}

// --- utilidades del DSL -------------------------------------------------------------------------------------------
function joinMod(a: string, b: string) { return [a, b].filter(Boolean).join("/"); }
function singular(name: string) { return name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("ses") ? name.slice(0, -2) : name.replace(/s$/, ""); }
function pluralize(name: string) { return name.endsWith("y") ? `${name.slice(0, -1)}ies` : name.endsWith("s") ? name : `${name}s`; }
function listOpt(v: Val | undefined): string[] | null { return v === undefined || v === null ? null : typeof v === "string" ? [v] : v; }

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === "\\") i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Une líneas que continúan (terminan en coma, paréntesis o corchete abiertos o \). */
function joinContinuations(lines: string[]): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let buf = ""; let start = 0;
  lines.forEach((raw, i) => {
    const code = stripComment(raw);
    if (!buf) start = i + 1;
    buf = buf ? `${buf} ${code.trim()}` : code;
    const open = (buf.match(/[[(]/g) ?? []).length - (buf.match(/[\])]/g) ?? []).length;
    if (/[,\\]\s*$/.test(code) || open > 0) return;
    out.push({ line: start, text: buf.replace(/\\\s*$/, "") });
    buf = "";
  });
  if (buf) out.push({ line: start, text: buf });
  return out;
}

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s|\(|\)/.test(c)) { i++; continue; }
    if (c === ",") { toks.push({ t: "comma", v: "," }); i++; continue; }
    if (c === "[") { toks.push({ t: "lbr", v: "[" }); i++; continue; }
    if (c === "]") { toks.push({ t: "rbr", v: "]" }); i++; continue; }
    if (s.startsWith("=>", i)) { toks.push({ t: "arrow", v: "=>" }); i += 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let v = ""; let dyn = false;
      while (j < s.length && s[j] !== c) { if (s[j] === "\\") { v += s[j + 1] ?? ""; j += 2; continue; } if (c === '"' && s.startsWith("#{", j)) dyn = true; v += s[j]; j++; }
      toks.push({ t: dyn ? "dyn" : "str", v }); i = j + 1; continue;
    }
    const pct = /^%[iwIW]\[([^\]]*)\]/.exec(s.slice(i));
    if (pct) { toks.push({ t: "lbr", v: "[" }); for (const w of pct[1]!.trim().split(/\s+/).filter(Boolean)) { toks.push({ t: "sym", v: w }); toks.push({ t: "comma", v: "," }); } toks.push({ t: "rbr", v: "]" }); i += pct[0].length; continue; }
    const sym = /^:(["']?)([A-Za-z_][\w!?]*)\1/.exec(s.slice(i));
    if (sym && s[i + 1] !== ":") { toks.push({ t: "sym", v: sym[2]! }); i += sym[0].length; continue; }
    const key = /^([A-Za-z_]\w*):(?!:)/.exec(s.slice(i));
    if (key) { toks.push({ t: "key", v: key[1]! }); i += key[0].length; continue; }
    const word = /^[A-Za-z_][\w:.!?]*/.exec(s.slice(i));
    if (word) { toks.push({ t: "word", v: word[0] }); i += word[0].length; continue; }
    toks.push({ t: "other", v: c }); i++;
  }
  return toks;
}

/** Argumentos posicionales y opciones (`clave: valor`, `"ruta" => "c#a"`). */
function parseArgs(toks: Tok[]): { args: Val[]; opts: Record<string, Val>; dynamic: boolean } {
  const args: Val[] = []; const opts: Record<string, Val> = {}; let dynamic = false;
  let i = 0;
  const value = (): Val => {
    const t = toks[i];
    if (!t) return null;
    if (t.t === "str" || t.t === "sym") { i++; return t.v; }
    if (t.t === "dyn") { i++; dynamic = true; return null; }
    if (t.t === "lbr") {
      i++; const list: string[] = []; let ok = true;
      while (i < toks.length && toks[i]!.t !== "rbr") { const v = value(); if (typeof v === "string") list.push(v); else ok = false; if (toks[i]?.t === "comma") i++; }
      i++; return ok ? list : null;
    }
    i++; // palabra, constante u otra expresión: desconocido
    while (i < toks.length && toks[i]!.t !== "comma") i++;
    return null;
  };
  while (i < toks.length) {
    const t = toks[i]!;
    if (t.t === "comma") { i++; continue; }
    if (t.t === "key") { i++; opts[t.v] = value(); continue; }
    if (t.t === "word" && (toks[i + 1]?.t === "arrow")) { i += 2; const target = value(); opts["=>"] = target; opts.mounted = t.v; continue; } // mount App => "/x"
    const v = value();
    if (toks[i]?.t === "arrow") { i++; opts.to = value(); args.push(v); continue; } // get "x" => "c#a"
    args.push(v);
  }
  return { args, opts, dynamic };
}

// --- integración existente y autenticación en controladores -------------------------------------------------------
function findLicenRoute(reader: ProjectReader) {
  const locations: { file: string; line: number }[] = [];
  let licensedPaths: string[] | null = null; let global = false;
  for (const file of reader.list((p) => /^config\/.*\.rb$/.test(p) || p === "config.ru")) {
    const text = reader.read(file); if (!text || !text.includes("Botgate::Middleware")) continue;
    const idx = text.indexOf("Botgate::Middleware");
    locations.push({ file, line: text.slice(0, idx).split("\n").length });
    if (/(?:config\.middleware\.(?:use|insert_\w+)|^\s*use)\s*\(?\s*(?:[^,\n]*,\s*)?Botgate::Middleware/m.test(text)) global = true;
    const m = /licensed_paths:\s*(\[[^\]]*\])/.exec(text.slice(idx, idx + 3000));
    if (m) { const items = [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!); const bare = m[1]!.replace(/["'][^"']*["']|[\s,[\]]/g, ""); licensedPaths = bare === "" ? [...(licensedPaths ?? []), ...items] : null; }
  }
  return { locations, licensedPaths, global };
}

/** Señal heurística de autenticación por controlador (y su ApplicationController). Nunca una garantía. */
function controllerAuth(reader: ProjectReader) {
  const cache = new Map<string, string | null>();
  const read = (c: string) => { if (!cache.has(c)) cache.set(c, reader.read(`app/controllers/${c}_controller.rb`)); return cache.get(c)!; };
  const AUTH_FILTER = /^\s*before_action\s+:(authenticate\w*!?|require_(?:login|user|authentication)\w*|authorize\w*|ensure_\w*logged_in\w*|logged_in\w*)([^\n]*)$/m;
  return (controller: string, action: string | null): { names: string[]; notes: string[] } => {
    const names: string[] = []; const notes: string[] = [];
    const own = read(controller); const appc = read("application");
    const parentAuth = appc && (/^\s*include\s+Authentication\b/m.test(appc) || AUTH_FILTER.test(appc));
    const ownFilter = own && AUTH_FILTER.exec(own);
    if (ownFilter) names.push(`before_action :${ownFilter[1]}`);
    if (own && /^\s*include\s+Authentication\b/m.test(own)) names.push("include Authentication");
    if (parentAuth) names.push(tc("rails.inherited_auth"));
    const allow = own && /^\s*(allow_unauthenticated_access|skip_before_action\s+:authenticate\w*!?)([^\n]*)$/m.exec(own);
    if (allow) {
      const only = /only:\s*(?:%i\[([^\]]*)\]|\[([^\]]*)\]|:(\w+))/.exec(allow[2] ?? "");
      const actions = only ? (only[1] ?? only[2] ?? only[3] ?? "").replace(/[:,]/g, " ").split(/\s+/).filter(Boolean) : null;
      if (!actions || (action && actions.includes(action))) { names.length = 0; notes.push(tc("rails.allow_unauthenticated", { p1: sanitize(allow[1]!, 40) })); }
    }
    if (own === null) notes.push(tc("rails.controller_not_found"));
    return { names, notes };
  };
}
