/**
 * Punto de entrada de `licenroute`. Normalmente se ejecuta desde bin/licenroute.mjs, que lo lanza con el modelo de permisos
 * de Node y un perfil por comando:
 *   detect, plan          lectura del proyecto; sin escritura, procesos ni red
 *   apply, undo           1.ª fase igual (vista previa y destinos); 2.ª fase con escritura SOLO en los ficheros aprobados,
 *                         tras el reto en el terminal que pide esa misma fase (src/consent.ts)
 *   test, doctor          lectura; en el repositorio, procesos del Sandbox local; peticiones GET a loopback; sin escritura
 *   init, env, connect    lectura (init --write lo convierte el lanzador en apply --approve, con su reto)
 *   assistant             como apply: vista previa; para escribir, destinos exactos y reto en el terminal
 *   dev                   esta parte solo lee el estado de demo; el simulador y la app los lanza bin/dev-command.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { insecureTestReady as repoInsecureReady } from "../bin/insecure-ack.mjs";
import { covers, prepareApply } from "./apply.ts";
import { DIST_BUILD } from "./build-flags.ts";
import { residuals } from "./residuals.ts";
import { detect } from "./detect.ts";
import { type Consent, prepareUndo, runUndo, undoTargets, writeChanges, writeTargets } from "./journal.ts";
import { applyNextSandbox } from "./sandbox-hint.ts";
import { confirmWrite } from "./consent.ts";
import { renderVersion } from "./version.ts";
import { localize, resolveLang, setLang, t } from "../bin/i18n.mjs";

/** El paquete compilado deja esto en falso aunque existan las dos variables y un árbol test/. */
function insecureTestReady(): boolean {
  if (DIST_BUILD) return false;
  return repoInsecureReady();
}

const consentText = (c: Consent) => t(c === "tty-challenge" ? "consent.tty" : "consent.insecure");
import { plan, PlanError } from "./plan.ts";
import { renderDetect, renderPlan } from "./render.ts";
import { refreshPlanRoutes } from "./route-refresh.ts";

const usage = () => t("cli.usage");

const VALUE_FLAGS = new Set(["--target", "--plans", "--plan-sha", "--app", "--instance", "--sdk", "--approve", "--resolve", "--base-url", "--env-file", "--phase", "--consent", "--self-hosted", "--quota", "--port", "--app-port", "--entry", "--lang", "--example"]);
const BOOL_FLAGS = new Set(["--write", "--demo", "--cloud", "--claude-code", "--cursor", "--start-app", "--status", "--stop"]);
const COMMANDS = ["detect", "plan", "apply", "undo", "test", "doctor", "init", "env", "dev", "connect", "assistant"];

export interface Args { command: string | undefined; dir: string; json: boolean; values: Map<string, string[]>; flags: Set<string>; unknown: string[] }
export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string[]>(); const positional: string[] = []; const unknown: string[] = []; const flags = new Set<string>(); let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (VALUE_FLAGS.has(a)) { values.set(a, [...(values.get(a) ?? []), argv[i + 1] ?? ""]); i++; }
    else if (BOOL_FLAGS.has(a)) flags.add(a);
    else if (a.startsWith("--")) unknown.push(a);
    else positional.push(a);
  }
  return { command: positional[0], dir: resolve(positional[1] ?? "."), json, values, flags, unknown };
}
const one = (a: Args, k: string) => a.values.get(k)?.at(-1);

// Texto para personas en el idioma elegido (los textos canónicos del plan y de detect se traducen al mostrarlos);
// el JSON va siempre en inglés canónico (D4.4).
function out(json: boolean, data: unknown, text: string) { process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${localize(text)}\n`); }

export async function run(argv: string[]): Promise<number> {
  // Idioma (D4.4, ver bin/i18n.mjs): --lang, LICENROUTE_LANG, locale del sistema, inglés. Con --json, siempre inglés: el
  // resultado estructurado es el mismo en los dos idiomas. Solo cambia texto: nunca permisos, rutas, planes ni hashes.
  const langAt = argv.indexOf("--lang");
  const lang = resolveLang(langAt >= 0 ? (argv[langAt + 1] ?? "") : undefined);
  if ("error" in lang && lang.error !== undefined) { process.stderr.write(`licenroute: ${lang.error}\n`); return 2; }
  setLang(argv.includes("--json") ? "en" : lang.lang!);
  // Versión y esquemas: la Skill de S7 comprueba la compatibilidad antes de usar la CLI.
  if (argv[0] === "--version" || argv[0] === "version") { process.stdout.write(renderVersion(argv.includes("--json"))); return 0; }
  const a = parseArgs(argv);
  if (process.env.LICENROUTE_CLI_REPORT_PERMISSIONS === "1" && process.permission) {
    // Solo para pruebas: qué puede hacer de verdad este proceso (lo comprueba test/apply.test.ts).
    process.stderr.write(`permisos fase=${one(a, "--phase") ?? "única"} procesos=${process.permission.has("child")} lectura-proyecto=${process.permission.has("fs.read", a.dir)} escritura-proyecto=${process.permission.has("fs.write", a.dir)}\n`);
  }
  if (!a.command || a.command === "help" || argv.includes("--help")) { process.stdout.write(`${usage()}\n`); return a.command ? 0 : 2; }
  if (a.unknown.length) { process.stderr.write(t("cli.unknown_option", { p1: a.unknown.join(" "), USAGE: usage() })); return 2; }
  if (!COMMANDS.includes(a.command)) { process.stderr.write(t("cli.unknown_command", { command: a.command, USAGE: usage() })); return 2; }
  // D4.3 (F-D4.3-1): el consentimiento ya no se recibe por argumentos; lo pide la propia fase de escritura.
  if (a.values.has("--consent")) { process.stderr.write(t("consent.no_consent_flag")); return 2; }
  const target = one(a, "--target");
  if (target !== undefined && target !== "express" && target !== "rails") { process.stderr.write(t("cli.target_invalid")); return 2; }
  const instance = one(a, "--instance") ?? process.env.BOTGATE_SANDBOX_INSTANCE ?? "default";
  const phase = one(a, "--phase");
  // Las fases activas de doctor y test no pueden leer el proyecto (a propósito): no se comprueba el directorio.
  if (phase !== "live" && (!existsSync(a.dir) || !statSync(a.dir).isDirectory())) { process.stderr.write(t("cli.no_dir", { dir: a.dir })); return 2; }

  if (a.command === "detect") { const d = detect(a.dir); out(a.json, d, renderDetect(d)); return 0; }

  if (a.command === "init") {
    const { INIT_SCHEMA, renderInit, runInit } = await import("./init.ts");
    const r = runInit({ dir: a.dir, ...(one(a, "--plans") !== undefined ? { plans: one(a, "--plans")! } : {}), ...(one(a, "--app") ? { app: one(a, "--app")! } : {}), sdk: one(a, "--sdk") ?? null, instance, ...(target ? { target: target as "express" | "rails" } : {}) });
    if (phase === "resolve") { // interno: el lanzador convierte init --write en apply --approve (con su reto)
      // --approve (opcional) fija el diff revisado en la vista previa: si el actual es otro, no se escribe.
      const pinned = one(a, "--approve");
      const stale = pinned !== undefined && pinned !== (r.preview?.approvalCode ?? null);
      const errors = stale ? [t("init.diff_changed", { p1: pinned.slice(0, 24), p2: r.preview?.approvalCode ?? t("init.no_diff") }), ...r.errors] : r.errors;
      process.stdout.write(`${JSON.stringify({ ok: !stale && r.ok && r.selection.length > 0 && r.preview?.ok === true, app: r.app, plans: r.selection, plan_sha: r.planSha, approval_code: r.preview?.approvalCode ?? null, errors })}\n`);
      return 0;
    }
    if (a.flags.has("--write")) { process.stderr.write(t("init.write_launcher_only")); return 5; }
    out(a.json, { schema: INIT_SCHEMA, ok: r.ok, errors: r.errors, framework: r.framework, app: r.app, sdk: r.sdk, plans: r.plans, untouched: r.untouched, needs_decision: r.needsDecision, unresolved: r.unresolved, selection: r.selection, plan_sha256: r.planSha, preview: r.preview ? { ok: r.preview.ok, refusals: r.preview.refusals, warnings: r.preview.warnings, approval_code: r.preview.approvalCode, changes: r.preview.changes.map((c) => ({ path: c.path, action: c.action, diff: c.diff })) } : null }, renderInit(r));
    return !r.ok ? (r.plans.length || r.selection.length ? 5 : 3) : 0;
  }

  if (a.command === "env") {
    const { renderEnv, runEnv } = await import("./live/env.ts");
    const r = await runEnv(a.dir, process.env);
    out(a.json, r, renderEnv(r));
    return r.mode === "mixed" ? 1 : 0;
  }

  if (a.command === "connect") {
    const { renderConnect, runConnect } = await import("./connect.ts");
    const chosen = [a.flags.has("--demo") && "demo", one(a, "--self-hosted") !== undefined && "self-hosted", a.flags.has("--cloud") && "cloud"].filter(Boolean) as ("demo" | "self-hosted" | "cloud")[];
    if (chosen.length > 1) { process.stderr.write(t("connect.one_mode")); return 2; }
    const { report, code } = runConnect(chosen[0] ?? null, one(a, "--self-hosted") ?? null);
    out(a.json, report, renderConnect(report));
    return code;
  }

  if (a.command === "dev") {
    // El simulador y la app los arranca el lanzador (bin/dev-command.mjs). Aquí solo se lee el estado, sin red.
    if (phase !== "static") { process.stderr.write(t("dev.launcher_only")); return 2; }
    const { demoState, readDemoAdmin, shellState } = await import("./demo-state.ts");
    const st = demoState(a.dir); const admin = readDemoAdmin(a.dir);
    process.stdout.write(`${JSON.stringify({ ...st, admin_token: admin?.admin_token ?? null, production_signals: shellState(process.env).productionSignals })}\n`);
    return 0;
  }

  if (a.command === "assistant") {
    const { assistantTargets, prepareAssistant, renderAssistant, templatesDir, ASSISTANT_SCHEMA } = await import("./assistant.ts");
    const { writeAssistant } = await import("./journal.ts");
    const hosts = [a.flags.has("--claude-code") && "claude-code", a.flags.has("--cursor") && "cursor"].filter(Boolean) as ("claude-code" | "cursor")[];
    if (hosts.length !== 1) { process.stderr.write(t("assistant.pick_host")); return 2; }
    const p = prepareAssistant(a.dir, hosts[0]!, templatesDir(process.argv[1] ?? "", DIST_BUILD), lang.lang);
    const approve = one(a, "--approve");
    if (phase === "targets") {
      const ok = p.ok && p.approvalCode !== null && approve === p.approvalCode;
      process.stdout.write(`${JSON.stringify({ ok, targets: ok ? assistantTargets(a.dir, p) : [], files: ok ? p.files.filter((f) => f.action === "create").map((f) => t("files.create", { path: f.path })) : [], approval_code: p.approvalCode, plans: [hosts[0]] })}\n`);
      return 0;
    }
    const summary = { schema: ASSISTANT_SCHEMA, ok: p.ok, host: p.host, errors: p.errors, approval_code: p.approvalCode, files: p.files.map((f) => ({ path: f.path, action: f.action, ...(f.proposal ? { proposal: f.proposal } : {}) })) };
    if (approve === undefined) { out(a.json, { ...summary, status: "preview" }, renderAssistant(p, ".")); return p.ok ? 0 : 5; }
    if (approve !== p.approvalCode) { out(a.json, { ...summary, status: "refused" }, t("assistant.code_mismatch")); return 5; }
    if (phase !== "write") { process.stderr.write(t("assistant.write_launcher_only")); return 5; }
    const asked = confirmWrite([...p.files.filter((f) => f.action === "create").map((f) => t("files.create", { path: f.path })), t("consent.plans_line", { plans: hosts[0] }), t("consent.code_line", { approvalCode: p.approvalCode })], insecureTestReady());
    if ("error" in asked) { if (asked.error) process.stderr.write(`${asked.error}\n`); return 5; }
    const consent: Consent = asked.consent;
    const w = writeAssistant(a.dir, p);
    out(a.json, { ...summary, status: w.error ? "failed" : "installed", written: w.written, error: w.error }, w.error ? t("assistant.failed", { error: w.error, p2: w.written.join(", ") || t("common.none_m") }) : [t("assistant.created", { p1: w.written.join(", ") }), t("consent.confirmation_line", { text: consentText(consent) }), ...p.files.filter((f) => f.action !== "create" && f.action !== "identical").map((f) => t("assistant.untouched", { path: f.path, p2: f.action === "conflict" ? t("assistant.conflict_label") : t("assistant.merge_label") }))].join("\n"));
    return w.error ? 1 : 0;
  }
  if (a.command === "plan") {
    const d = detect(a.dir);
    try { const p = plan(d, target as "express" | "rails" | undefined); out(a.json, p, renderPlan(p, d.routes)); return 0; }
    catch (e) { if (e instanceof PlanError) { process.stderr.write(t("plan.error", { message: e.message })); return 3; } throw e; }
  }

  if (a.command === "apply") {
    const prepared = prepareApply({
      dir: a.dir, planKeys: (one(a, "--plans") ?? "").split(",").map((s) => s.trim()).filter(Boolean), planSha: one(a, "--plan-sha") ?? "",
      app: one(a, "--app") ?? "", instance, sdk: one(a, "--sdk") ?? null, ...(target ? { target: target as "express" | "rails" } : {}),
    });
    const approve = one(a, "--approve");
    if (phase === "targets") { // interno: el lanzador pregunta a qué ficheros dar escritura
      const ok = prepared.ok && approve === prepared.approvalCode;
      process.stdout.write(`${JSON.stringify({ ok, targets: ok ? writeTargets(a.dir, prepared.changes) : [], files: ok ? prepared.changes.map((c) => `${c.action === "create" ? "create" : "modify"} ${c.path}`) : [], approval_code: prepared.approvalCode, plans: prepared.selected.map((x) => x.pattern), uncovered: prepared.uncovered })}\n`);
      return 0;
    }
    const summary = { schema: "licenroute.cli.apply/v1", status: "preview", ok: prepared.ok, refusals: prepared.refusals, warnings: prepared.warnings, plans: prepared.selected, approval_code: prepared.approvalCode, changes: prepared.changes.map((c) => ({ path: c.path, action: c.action, before_sha256: c.beforeSha, after_sha256: c.afterSha, diff: c.diff })) };
    const head = prepared.ok ? t("apply.header", { p1: prepared.selected.map((s) => s.pattern).join(", "), p2: one(a, "--app"), instance }) : t("apply.header_refused");
    const text = [head, ...prepared.refusals.map((r) => `  ✗ ${r}`), ...prepared.warnings.map((w) => `  aviso: ${w}`), "", ...prepared.changes.map((c) => c.diff), ""];
    if (!prepared.ok) { out(a.json, { ...summary, status: "refused" }, text.join("\n")); return 5; }
    if (approve === undefined) {
      text.push(t("apply.nothing_written_1", { approvalCode: prepared.approvalCode }));
      text.push(t("apply.nothing_written_2"));
      text.push(t("apply.nothing_written_3"));
      out(a.json, summary, text.join("\n")); return 0;
    }
    if (approve !== prepared.approvalCode) { out(a.json, { ...summary, status: "refused", refusals: [t("apply.code_mismatch_short")] }, t("apply.code_mismatch")); return 5; }
    if (phase !== "write") { process.stderr.write(t("apply.write_launcher_only")); return 5; }
    const asked = confirmWrite([...prepared.changes.map((c) => t(c.action === "create" ? "files.create" : "files.modify", { path: c.path })), t("consent.plans_line", { plans: prepared.selected.map((x) => x.pattern).join(", ") }),
      ...(prepared.uncovered ? [t("consent.partial_line", { uncovered: prepared.uncovered })] : []), t("consent.code_line", { approvalCode: prepared.approvalCode })], insecureTestReady());
    if ("error" in asked) { if (asked.error) process.stderr.write(`${asked.error}\n`); return 5; }
    const consent: Consent = asked.consent;
    const r = writeChanges(a.dir, prepared, { app: one(a, "--app")!, instance, consent });
    const sandboxStep = applyNextSandbox(one(a, "--app")!, prepared.selected.map((s) => `--plan ${s.key}=${s.pattern}:3${s.methods.length ? `@${s.methods.join(",")}` : ""}`).join(" "));
    const next = prepared.plan!.target === "express"
      ? [t("apply.next.npm_install"), t("apply.next.demo"), t("apply.next.central", { sandboxStep }), t("apply.next.start_app"), t("apply.next.test", { p1: one(a, "--app") })]
      : ["bundle install", sandboxStep, t("apply.next.start_app_short"), t("apply.next.test", { p1: one(a, "--app") })];
    out(a.json, { ...summary, status: r.ok ? "applied" : "rolled_back", consent, written: r.written, rolled_back: r.rolledBack, error: r.error, journal: r.journal.id },
      r.ok ? [t("apply.applied", { p1: r.written.join(", "), id: r.journal.id }), t("consent.confirmation_line", { text: consentText(consent) }),
        ...(prepared.uncovered ? [t("apply.partial", { uncovered: prepared.uncovered })] : []), t("apply.next_header"), ...next.map((n) => `  ${n}`), t("apply.not_proof")].join("\n")
        : t("apply.failed", { error: r.error, p2: r.rolledBack.length ? ` (restaurados: ${r.rolledBack.join(", ")})` : "" }));
    return r.ok ? 0 : 1;
  }

  if (a.command === "undo") {
    const resolveMap = new Map<string, "remove-block">();
    for (const v of a.values.get("--resolve") ?? []) { const [file, how] = v.split("="); if (file && how === "remove-block") resolveMap.set(file, "remove-block"); else { process.stderr.write(t("undo.resolve_usage")); return 2; } }
    const u = prepareUndo(a.dir, resolveMap);
    if (phase === "targets") { process.stdout.write(`${JSON.stringify({ ok: !u.error && u.conflicts.length === 0, targets: undoTargets(a.dir, u) })}\n`); return 0; }
    const lines = u.error ? [t("undo.error", { error: u.error })] : [t("undo.header", { id: u.journal!.id }), ...u.actions.map((x) => `  ${x.kind === "already" ? t("undo.action.already") : x.kind === "delete" ? t("undo.action.delete") : x.kind === "resolve" ? t("undo.action.resolve") : t("undo.action.restore")} ${x.path}`), ...u.conflicts.map((c) => t("undo.conflict_line", { conflict: localize(c) }))];
    if (u.error || u.conflicts.length) { out(a.json, { schema: "licenroute.cli.undo/v1", ok: false, error: u.error, conflicts: u.conflicts }, [...lines, t("undo.nothing_reverted")].join("\n")); return u.error ? 5 : 6; }
    if (phase !== "write") { process.stderr.write(t("undo.write_launcher_only")); return 5; }
    // --resolve toca ficheros que modificaste tú después de apply: hace falta tu confirmación (undo normal no la pide).
    if (resolveMap.size > 0) {
      const asked = confirmWrite([t("consent.undo_resolve")], insecureTestReady());
      if ("error" in asked) { if (asked.error) process.stderr.write(`${asked.error}\n`); return 5; }
    }
    const r = runUndo(a.dir, u);
    // Todo lo que undo NO revierte (no lo escribió apply): se informa, no se borra.
    const left = r.error ? [] : residuals(a.dir, u.journal!);
    const envLeft = left.some((x) => x.kind === "credenciales" && x.unignored === true);
    const warn = envLeft ? [t("undo.env_warning")] : [];
    out(a.json, { schema: "licenroute.cli.undo/v1", ok: !r.error, reverted: r.done, error: r.error, warnings: warn, residuals: left },
      [...lines, r.error ? t("undo.failed", { error: r.error }) : t("undo.reverted"), ...warn,
        ...(left.length ? ["", t("undo.left_header"), ...left.map((x) => `  ${x.kind}${x.path ? ` ${x.path}` : ""}: ${x.message}`)] : [])].join("\n"));
    return r.error ? 1 : 0;
  }

  if (a.command === "test") {
    // Dos procesos con privilegios mínimos (el lanzador los encadena): "static" lee el diario del proyecto SIN procesos;
    // "live" usa el Sandbox y la app CON procesos pero SIN poder leer el proyecto, y valida el contexto recibido.
    const { readJournals } = await import("./journal.ts");
    // Lo calcula esta fase, que es la que puede leer y analizar el proyecto:
    //  · S10.2-D3.1: rutas GET con autenticación propia, para comprobar que LicenRoute no las rechaza. D4.1: TODAS, también
    //    las que cubre un patrón (si un plan las cubriera, la licencia se adelantaría a su autenticación: fallo);
    //  · D4.1: rutas bajo un patrón con métodos que el plan no incluye (method_checks) o, con una declaración sin métodos
    //    de 0.2.2, que se cobran sin haberse aprobado (overreach); y lo que declara el código (declared).
    const fromJournal = () => {
      const j = readJournals(a.dir).filter((x) => x.status === "applied").pop();
      if (!j) return null;
      const d = detect(a.dir);
      const routes = d.routes.filter((r) => r.path !== null && r.resolution === "static");
      // BL-34: test the routes the code has NOW under each approved pattern and methods; say what changed since apply.
      const refreshed = refreshPlanRoutes(j.plans.map((p) => ({ ...p, methods: Array.isArray(p.methods) ? p.methods : [] })), routes.map((r) => ({ method: r.method, path: r.path! })), covers);
      const plans = refreshed.plans; const route_changes = refreshed.changes;
      // BL-32: public routes the code has now (health, docs, home) that no plan covers, plus those recorded at apply time.
      const publicNow = routes.filter((r) => r.method === "GET" && (r.category === "health" || r.category === "docs" || r.path === "/") && !plans.some((p) => covers(p.pattern, r.path!))).map((r) => r.path!);
      const public_checks = [...new Set([...(j.public_checks ?? []), ...publicNow])];
      // BL-33: --example name=value (repeatable): real values for path parameters.
      const examples: Record<string, string> = {};
      for (const raw of a.values.get("--example") ?? []) { const m = /^(\w{1,40})=([A-Za-z0-9._~-]{1,64})$/.exec(raw); if (m) examples[m[1]!] = m[2]!; }
      const method_checks: { method: string; path: string; plan: string; auth: string[] }[] = []; const overreach: typeof method_checks = [];
      for (const p of plans) {
        const own = new Set(p.routes.map((r) => `${r.method} ${r.path}`));
        const approved = new Set(p.methods.length ? p.methods : p.routes.flatMap((r) => (r.method === "GET" ? ["GET", "HEAD"] : [r.method])));
        for (const r of routes) {
          if (!covers(p.pattern, r.path!) || own.has(`${r.method} ${r.path}`) || approved.has(r.method)) continue;
          (p.methods.length ? method_checks : overreach).push({ method: r.method, path: r.path!, plan: p.pattern, auth: r.signals.auth_middleware });
        }
      }
      return {
        app: j.app, instance: j.instance, plans, public_checks, examples, route_changes,
        auth_checks: routes.filter((r) => r.method === "GET" && r.signals.auth_middleware.length > 0).map((r) => r.path!).slice(0, 20),
        method_checks: method_checks.slice(0, 20), overreach: overreach.slice(0, 20), declared: d.licenroute.licensed_routes ?? null,
      };
    };
    // Simulador del modo demo en marcha para este proyecto (licenroute-simulator escribe .licenroute/demo-admin.json).
    const demoFromProject = () => { try { const j = JSON.parse(readFileSync(join(a.dir, ".licenroute", "demo-admin.json"), "utf8")) as { url?: unknown; admin_token?: unknown; run_id?: unknown }; return typeof j.url === "string" && typeof j.admin_token === "string" ? { url: j.url.slice(0, 100), admin_token: j.admin_token.slice(0, 100), ...(typeof j.run_id === "string" ? { run_id: j.run_id.slice(0, 40) } : {}) } : null; } catch { return null; } };
    // S10.2-B: la app de demo que arrancó `licenroute dev --start-app` (solo su URL de loopback).
    const demoAppFromProject = async () => (await import("./demo-state.ts")).readDemoApp(a.dir)?.url ?? null;
    if (phase === "static") { process.stdout.write(`${JSON.stringify({ journal: fromJournal(), demo_admin: demoFromProject(), demo_app: await demoAppFromProject() })}\n`); return 0; }
    const { RESULT_LABEL, runTests, scenarioResult, validTestContext } = await import("./live/test.ts");
    const { selectTestAdmin } = await import("./live/test-admin.ts");
    let ctx: { journal: unknown; demo_admin?: { url?: unknown; admin_token?: unknown; run_id?: unknown } | null; demo_app?: unknown };
    try { ctx = phase === "live" ? JSON.parse(readFileSync(0, "utf8")) as typeof ctx : { journal: fromJournal(), demo_admin: demoFromProject(), demo_app: await demoAppFromProject() }; }
    catch (e) { process.stderr.write(t("test.error", { message: (e as Error).message })); return 2; }
    // Por defecto (S10.2-B): la app del diario y, en demo, la URL de la app que arrancó `licenroute dev --start-app`.
    const journalApp = (ctx.journal as { app?: unknown } | null)?.app;
    const app = one(a, "--app") ?? (typeof journalApp === "string" ? journalApp : undefined);
    const baseUrl = one(a, "--base-url") ?? (ctx.demo_admin && typeof ctx.demo_app === "string" ? ctx.demo_app : undefined);
    if (!app || !baseUrl) { process.stderr.write(t("test.need_app")); return 2; }
    const admin = selectTestAdmin(instance, process.env, ctx.demo_admin ?? null);
    if (!("contract" in admin)) { process.stderr.write(t("test.error", { message: admin.message })); return 2; }
    let checks;
    try {
      const raw = ctx.journal;
      checks = await runTests({ app, instance, baseUrl, journal: raw === null ? null : validTestContext(raw), admin });
    } catch (e) { process.stderr.write(t("test.error", { message: (e as Error).message })); return 2; }
    const failed = checks.filter((c) => c.ok === false).length;
    const simulated = admin.verification === "simulated";
    // Campos añadidos a licenroute.cli.test/v1 (compatibles): quien solo mire `ok` debe mirar también `result`.
    const result = failed ? "fail" : simulated ? "simulated_pass" : "verified_pass";
    const rows = checks.map((c) => ({ ...c, result: scenarioResult(c, admin.verification) }));
    const summary = failed ? t("test.failures", { failed }) : simulated ? t("test.simulated_pass") : t("test.verified_pass");
    out(a.json, { schema: "licenroute.cli.test/v1", ok: failed === 0, result, test_admin: { contract: admin.contract, provider: admin.provider, verification: admin.verification }, checks: rows }, [...(simulated ? [t("demo.banner_test"), ""] : []), ...rows.map((c) => `${RESULT_LABEL[c.result]} ${c.id}: ${c.detail}`), "", summary].join("\n"));
    return failed ? 1 : 0;
  }

  // doctor: dos procesos con privilegios mínimos (el lanzador los encadena). "static" lee y analiza el proyecto SIN
  // poder lanzar procesos; "live" consulta Sandbox, Central y la app CON procesos pero SIN poder leer el proyecto.
  const { staticDoctor } = await import("./doctor-static.ts");
  const opts = { app: one(a, "--app") ?? null, instance, baseUrl: one(a, "--base-url") ?? null };
  let findings; let ctx;
  if (phase === "static") {
    const r = staticDoctor({ dir: a.dir, app: opts.app, instance, envFile: one(a, "--env-file") ?? ".env.licenroute" });
    process.stdout.write(`${JSON.stringify(r)}\n`); return 0;
  }
  try {
    const { liveDoctor, validContext } = await import("./live/doctor.ts");
    if (phase === "live") {
      const input = JSON.parse(readFileSync(0, "utf8")) as { findings: unknown; ctx: unknown };
      findings = (Array.isArray(input.findings) ? input.findings : []) as Awaited<ReturnType<typeof liveDoctor>>; ctx = validContext(input.ctx);
    } else { // ejecución directa (sin lanzador): ambas partes en el mismo proceso
      const r = staticDoctor({ dir: a.dir, app: opts.app, instance, envFile: one(a, "--env-file") ?? ".env.licenroute" }); findings = r.findings; ctx = r.ctx;
    }
    findings = [...findings, ...(await liveDoctor(ctx, opts))];
  } catch (e) { process.stderr.write(t("doctor.error", { message: (e as Error).message })); return 2; }
  const icon = { ok: t("doctor.level.ok"), warn: t("doctor.level.warn"), fail: t("doctor.level.fail"), info: t("doctor.level.info") };
  const fails = findings.filter((x) => x.level === "fail").length;
  out(a.json, { schema: "licenroute.cli.doctor/v1", ok: fails === 0, findings }, [...findings.map((x) => `${icon[x.level].padEnd(5)} ${x.id}: ${x.message}`), "", fails ? t("doctor.problems", { fails }) : t("doctor.no_problems")].join("\n"));
  return fails ? 1 : 0;
}

// Ejecutado directamente (node src/main.ts …), no importado por las pruebas.
if (process.argv[1] && /[/\\]main\.(ts|js|cjs)$/.test(process.argv[1])) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
