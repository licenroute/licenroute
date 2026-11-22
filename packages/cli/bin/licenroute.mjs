#!/usr/bin/env node
// Lanzador de `licenroute`: ejecuta la CLI con el modelo de permisos de Node, como segunda barrera además del diseño.
// Perfiles (nunca hay complementos nativos ni workers):
//   detect, plan     lectura del proyecto y de la CLI; sin escritura ni procesos
//   apply, undo      vista previa igual que plan; si hay --approve, una 1.ª ejecución de solo lectura decide los
//                    destinos y la 2.ª escribe con permiso SOLO sobre esos ficheros exactos y .licenroute/
//   test, doctor     lectura; sin escritura ni procesos (L6: no hay Sandbox). Peticiones solo a 127.0.0.1 (en el código)
// Límites para proyectos desconocidos: 512 MB de memoria y LICENROUTE_CLI_TIMEOUT_S (60 s por defecto; 900 s en test).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLang, setLang, t } from "./i18n.mjs";

const cliRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const repoRoot = dirname(dirname(cliRoot));
const require = createRequire(import.meta.url);
// Directorio de un paquete: se sube desde su punto de entrada hasta el package.json (algunos no exportan package.json).
const pkgDir = (name) => {
  let d = dirname(realpathSync(require.resolve(name)));
  while (!existsSync(join(d, "package.json")) && dirname(d) !== d) d = dirname(d);
  return d;
};

// Idioma (D4.4): el mismo que resolverá la CLI (bin/i18n.mjs). Con --json, siempre inglés.
{
  const argv = process.argv.slice(2); const at = argv.indexOf("--lang");
  const r = resolveLang(at >= 0 ? (argv[at + 1] ?? "") : undefined);
  if (r.error) { process.stderr.write(`licenroute: ${r.error}\n`); process.exit(2); }
  setLang(argv.includes("--json") ? "en" : r.lang);
}
const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--target", "--plans", "--plan-sha", "--app", "--instance", "--sdk", "--approve", "--resolve", "--base-url", "--env-file", "--phase", "--consent", "--self-hosted", "--quota", "--port", "--app-port", "--entry", "--lang", "--example"]);
const DIR_COMMANDS = ["detect", "plan", "apply", "undo", "test", "doctor", "init", "env", "dev", "assistant"];
const positional = []; const valueOf = {};
for (let i = 0; i < args.length; i++) { if (VALUE_FLAGS.has(args[i])) { valueOf[args[i]] = args[i + 1]; i++; } else if (!args[i].startsWith("--")) positional.push(args[i]); }
if (valueOf["--phase"] || valueOf["--consent"]) { process.stderr.write(t("launcher.internal_flags")); process.exit(2); }
let command = positional[0];
const dir = resolve(positional[1] ?? ".");
const real = existsSync(dir) ? realpathSync(dir) : null;
if (DIR_COMMANDS.includes(command) && !real) { process.stderr.write(t("cli.no_dir", { dir })); process.exit(2); }

// El modelo de permisos compara rutas literales: se permite y se pasa la ruta REAL (en macOS, /var -> /private/var).
const forwarded = [...args];
if (real && DIR_COMMANDS.includes(command)) {
  const at = positional[1] === undefined ? -1 : args.indexOf(positional[1]);
  if (at >= 0) forwarded[at] = real; else forwarded.splice(args.indexOf(command) + 1, 0, real);
}
const readable = [cliRoot, pkgDir("typescript")];
if (real) readable.push(real);
if ((command === "apply" || command === "init") && valueOf["--sdk"] && existsSync(resolve(valueOf["--sdk"]))) {
  const sdk = realpathSync(resolve(valueOf["--sdk"]));
  readable.push(sdk);
  forwarded[forwarded.indexOf("--sdk") + 1] = sdk; // también la ruta real
}
if (command === "assistant") readable.push(join(repoRoot, "integrations", "assistants", "generated"));

const timeoutS = Number(process.env.LICENROUTE_CLI_TIMEOUT_S ?? (command === "test" ? 900 : 60));
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
const node = (extra, argv, stdio, read = readable, input = undefined) => spawnSync(process.execPath, [
  "--max-old-space-size=512", "--stack-size=4000", "--permission",
  // Una opción por ruta (Node 24 no admite varias separadas por comas); un directorio incluye su contenido.
  ...grantRoots(read).map((d) => `--allow-fs-read=${d}`), ...extra,
  // SecurityWarning: Node avisa de que --allow-child-process debilita el modelo; en el repositorio público ninguna orden lo concede (L6).
  "--disable-warning=ExperimentalWarning", "--disable-warning=SecurityWarning", join(cliRoot, "src", "main.ts"), ...argv,
], { stdio, input, encoding: "utf8", timeout: timeoutS * 1000, killSignal: "SIGKILL" });
const finish = (r) => {
  if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") { process.stderr.write(t("launcher.timeout", { timeoutS })); process.exit(4); }
  if (r.error) { process.stderr.write(`licenroute: ${r.error.message}\n`); process.exit(1); }
  if (r.status === 134 || r.signal === "SIGABRT") { process.stderr.write(t("launcher.memory")); process.exit(4); }
  process.exit(r.status ?? 1);
};

// Confirmación de la escritura (capa A, S7): el código apr_… solo prueba que el diff es el revisado; quien lo ve (también
// un agente) puede copiarlo. Por eso la fase de escritura pide además un reto aleatorio de un solo uso en el terminal de
// control (src/consent.ts, desde D4.3 dentro de esa misma fase). insecure-test es un modo interno de las pruebas de este
// repositorio (ver insecure-ack.mjs); el paquete compilado y el código fuente público no lo tienen.

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
  process.exit(await runDev({ real, flags, values: valueOf, info, simulator: { entry: join(repoRoot, "packages", "simulator", "src", "main.ts"), read: [join(repoRoot, "packages"), join(repoRoot, "node_modules")], nodeArgs: ["--conditions=source"] } }));
}
if ((command === "apply" && valueOf["--approve"]) || command === "undo" || (command === "assistant" && valueOf["--approve"])) {
  // 1.ª fase (solo lectura): ¿qué ficheros exactos hay que escribir? La CLI solo los da si la aprobación es válida.
  const probe = node([], [...forwarded, "--phase", "targets"], ["ignore", "pipe", "inherit"]);
  let targets = [];
  try { const probeOut = JSON.parse(probe.stdout); targets = probeOut.ok ? probeOut.targets : []; } catch { finish(probe); }
  // Cada destino debe estar dentro del proyecto y no ser (ni atravesar) un enlace simbólico.
  const safe = targets.every((t) => {
    if (!t.startsWith(real + sep)) return false;
    for (let p = dirname(t.replace(/\/\*$/, "/x")); p.startsWith(real) && p !== real; p = dirname(p)) { try { if (lstatSync(p).isSymbolicLink()) return false; } catch { /* aún no existe */ } }
    try { return !lstatSync(t).isSymbolicLink(); } catch { return true; }
  });
  if (!safe) { process.stderr.write(t("launcher.unsafe_target")); process.exit(5); }
  // Confirmación (apply; undo solo con --resolve, que toca ficheros modificados por el usuario). Sin destinos válidos
  // no se pide nada: la 2.ª fase, sin permiso de escritura, explica el rechazo.
  // 2.ª fase: escritura SOLO en esos destinos. El reto en el terminal lo pide ESA fase justo antes de escribir (D4.3,
  // F-D4.3-1: antes lo pedía el lanzador y la fase confiaba en un --consent que cualquiera podía pasarle). Por eso puede
  // leer y escribir /dev/tty; nada más fuera de los destinos.
  finish(node([...targets.map((t) => `--allow-fs-write=${t}`), "--allow-fs-write=/dev/tty"], [...forwarded, "--phase", "write"], "inherit", [...readable, "/dev/tty"]));
}
if (command === "doctor" || command === "test") {
  // Privilegio mínimo: la lectura del proyecto (parser en doctor, diario en test) y la parte activa corren SIN procesos
  // (L6); la activa, además, SIN poder leer el proyecto, y recibe un contexto que valida como entrada externa.
  const st = node([], [...forwarded, "--phase", "static"], ["ignore", "pipe", "inherit"]);
  let staticOut;
  try { staticOut = JSON.parse(st.stdout); } catch { finish(st); }
  finish(node([], [...forwarded, "--phase", "live"], ["pipe", "inherit", "inherit"], readable.filter((d) => d !== real), JSON.stringify(staticOut)));
}
finish(node([], forwarded, "inherit"));
