#!/usr/bin/env node
// Lanzador del paquete compilado. Misma barrera de permisos que el del repositorio, sin modo de prueba.
// Repositorio público (L6): sin cliente del Sandbox privado; ninguna orden concede procesos hijos.
// Perfiles:
//   detect, plan     lectura del proyecto y de este paquete; sin escritura ni procesos
//   apply, undo      vista previa de solo lectura; si hay que escribir, permiso SOLO sobre esos ficheros
//   test, doctor     la fase estática lee el proyecto; la activa, sin el proyecto. Ninguna lanza procesos.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLang, setLang, t } from "../bin/i18n.mjs";

// Idioma (D4.4): el mismo que resolverá la CLI (bin/i18n.mjs). Con --json, siempre inglés.
{
  const argv = process.argv.slice(2); const at = argv.indexOf("--lang");
  const r = resolveLang(at >= 0 ? (argv[at + 1] ?? "") : undefined);
  if (r.error) { process.stderr.write(`licenroute: ${r.error}\n`); process.exit(2); }
  setLang(argv.includes("--json") ? "en" : r.lang);
}
const pkgRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const entry = join(pkgRoot, "dist", "main.cjs");
if (!existsSync(entry)) { process.stderr.write(t("launcher.no_dist")); process.exit(1); }

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--target", "--plans", "--plan-sha", "--app", "--instance", "--sdk", "--approve", "--resolve", "--base-url", "--env-file", "--phase", "--consent", "--self-hosted", "--quota", "--port", "--app-port", "--entry", "--lang"]);
const DIR_COMMANDS = ["detect", "plan", "apply", "undo", "test", "doctor", "init", "env", "dev", "assistant"];
const positional = []; const valueOf = {};
for (let i = 0; i < args.length; i++) { if (VALUE_FLAGS.has(args[i])) { valueOf[args[i]] = args[i + 1]; i++; } else if (!args[i].startsWith("--")) positional.push(args[i]); }
if (valueOf["--phase"] || valueOf["--consent"]) { process.stderr.write(t("launcher.internal_flags")); process.exit(2); }
let command = positional[0];
const dir = resolve(positional[1] ?? ".");
const real = existsSync(dir) ? realpathSync(dir) : null;
if (DIR_COMMANDS.includes(command) && !real) { process.stderr.write(t("cli.no_dir", { dir })); process.exit(2); }

const forwarded = [...args];
if (real && DIR_COMMANDS.includes(command)) {
  const at = positional[1] === undefined ? -1 : args.indexOf(positional[1]);
  if (at >= 0) forwarded[at] = real; else forwarded.splice(args.indexOf(command) + 1, 0, real);
}
const readable = [pkgRoot];
if (real) readable.push(real);
if ((command === "apply" || command === "init") && valueOf["--sdk"] && existsSync(resolve(valueOf["--sdk"]))) {
  const sdk = realpathSync(resolve(valueOf["--sdk"]));
  readable.push(sdk);
  forwarded[forwarded.indexOf("--sdk") + 1] = sdk;
}

const timeoutS = Number(process.env.LICENROUTE_CLI_TIMEOUT_S ?? (command === "test" ? 900 : 60));
const childEnv = (base) => {
  const env = { ...base };
  for (const key of ["NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  return env;
};
// Node 24 deniega operar sobre un directorio concedido si antes se concedió un subdirectorio suyo (p. ej. la CLI instalada
// en node_modules del proyecto). Se quitan las rutas que ya están dentro de otra concedida: el padre cubre su subárbol,
// así que el acceso efectivo es el mismo.
function grantRoots(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  const roots = unique.filter((p) => !unique.some((q) => q !== p && p.startsWith(q.endsWith(sep) ? q : q + sep)));
  // Node 24 también deniega stat de un directorio concedido si otra concesión empieza por el mismo TEXTO sin ser un
  // subdirectorio (…/app y …/app-tools/…). No se amplía ningún permiso: se explica y se para (S10.2-D2).
  const clash = roots.find((p) => roots.some((q) => q !== p && q.startsWith(p) && q[p.length] !== sep));
  if (clash) {
    const other = roots.find((q) => q !== clash && q.startsWith(clash) && q[clash.length] !== sep);
    process.stderr.write(t("launcher.prefix_clash", { clash, other, p3: clash.split(sep).pop() }));
    process.exit(2);
  }
  return roots;
}
const node = (extra, argv, stdio, read = readable, input = undefined, env = process.env) => spawnSync(process.execPath, [
  "--max-old-space-size=512", "--stack-size=4000", "--permission",
  ...grantRoots(read).map((d) => `--allow-fs-read=${d}`), ...extra,
  "--disable-warning=ExperimentalWarning", "--disable-warning=SecurityWarning", entry, ...argv,
], { stdio, input, env: childEnv(env), encoding: "utf8", timeout: timeoutS * 1000, killSignal: "SIGKILL" });
const finish = (r) => {
  if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") { process.stderr.write(t("launcher.timeout", { timeoutS })); process.exit(4); }
  if (r.error) { process.stderr.write(`licenroute: ${r.error.message}\n`); process.exit(1); }
  if (r.status === 134 || r.signal === "SIGABRT") { process.stderr.write(t("launcher.memory")); process.exit(4); }
  process.exit(r.status ?? 1);
};

// El paquete distribuido no tiene modo de prueba: el reto lo pide la fase de escritura (src/consent.ts) y insecure-test
// está desactivado (src/insecure-disabled.ts); las dos variables no bastan, ni un árbol test/ copiado al lado.

// init --write (S10.2-B; --approve opcional desde D3.1): no es una vía de escritura nueva. Una ejecución de solo lectura resuelve los planes elegidos y
// su código de aprobación, y la orden sigue como `apply … --approve <código>`: mismos destinos exactos y mismo reto.
if (command === "init" && args.includes("--write")) {
  // --approve <código de la vista previa> fija el diff revisado (la fase de resolución lo compara); el reto sigue siendo
  // obligatorio. Sin --approve también se puede escribir: el reto lista los ficheros.
  const r = node([], [...forwarded.filter((x) => x !== "--write"), "--phase", "resolve"], ["ignore", "pipe", "inherit"]);
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { finish(r); }
  if (!res.ok || !res.approval_code) { process.stderr.write(t("launcher.init_cannot_write", { errors: res.errors?.length ? `:\n  ${res.errors.join("\n  ")}` : "" })); process.exit(5); }
  command = "apply";
  forwarded.splice(0, forwarded.length, "apply", real, "--plans", res.plans.join(","), "--plan-sha", res.plan_sha, "--app", res.app, "--approve", res.approval_code,
    ...(valueOf["--sdk"] ? ["--sdk", forwarded[forwarded.indexOf("--sdk") + 1]] : []), ...(valueOf["--instance"] ? ["--instance", valueOf["--instance"]] : []), ...(valueOf["--target"] ? ["--target", valueOf["--target"]] : []));
  valueOf["--approve"] = res.approval_code;
}
if (command === "dev") {
  // La CLI lee el estado del proyecto (sin red ni procesos); el simulador y la app los arranca dev-command.mjs.
  const st = node([], [...forwarded, "--phase", "static"], ["ignore", "pipe", "inherit"]);
  let info;
  try { info = JSON.parse(st.stdout); } catch { finish(st); }
  const { runDev } = await import("./dev-command.mjs");
  const flags = new Set(args.filter((x) => x.startsWith("--") && !VALUE_FLAGS.has(x)));
  process.exit(await runDev({ real, flags, values: valueOf, info, simulator: { entry: join(pkgRoot, "dist", "simulator.cjs"), read: [pkgRoot], nodeArgs: [] } }));
}
if ((command === "apply" && valueOf["--approve"]) || command === "undo" || (command === "assistant" && valueOf["--approve"])) {
  const probe = node([], [...forwarded, "--phase", "targets"], ["ignore", "pipe", "inherit"]);
  let targets = [];
  try { const probeOut = JSON.parse(probe.stdout); targets = probeOut.ok ? probeOut.targets : []; } catch { finish(probe); }
  const safe = targets.every((t) => {
    if (!t.startsWith(real + sep)) return false;
    for (let p = dirname(t.replace(/\/\*$/, "/x")); p.startsWith(real) && p !== real; p = dirname(p)) { try { if (lstatSync(p).isSymbolicLink()) return false; } catch { /* aún no existe */ } }
    try { return !lstatSync(t).isSymbolicLink(); } catch { return true; }
  });
  if (!safe) { process.stderr.write(t("launcher.unsafe_target")); process.exit(5); }
  // 2.ª fase: escritura SOLO en esos destinos. El reto en el terminal lo pide ESA fase justo antes de escribir (D4.3,
  // F-D4.3-1: antes lo pedía el lanzador y la fase confiaba en un --consent que cualquiera podía pasarle). Por eso puede
  // leer y escribir /dev/tty; nada más fuera de los destinos.
  finish(node([...targets.map((t) => `--allow-fs-write=${t}`), "--allow-fs-write=/dev/tty"], [...forwarded, "--phase", "write"], "inherit", [...readable, "/dev/tty"]));
}
if (command === "doctor" || command === "test") {
  const st = node([], [...forwarded, "--phase", "static"], ["ignore", "pipe", "inherit"]);
  let staticOut;
  try { staticOut = JSON.parse(st.stdout); } catch { finish(st); }
  finish(node([], [...forwarded, "--phase", "live"], ["pipe", "inherit", "inherit"], readable.filter((d) => d !== real), JSON.stringify(staticOut)));
}
finish(node([], forwarded, "inherit"));
