#!/usr/bin/env node
// Lanzador del simulador del modo demo (licenroute-simulator, S10.2-A) en el paquete compilado.
// Permisos mínimos: leer el paquete y el proyecto (para no pisar credenciales reales); escribir SOLO <proyecto>/.env.licenroute
// y <proyecto>/.licenroute/; sin procesos hijos. El simulador solo escucha en 127.0.0.1.
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "../bin/i18n.mjs";

const pkgRoot = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const entry = join(pkgRoot, "dist", "simulator.cjs");
const args = process.argv.slice(2);
const at = args.indexOf("--dir");
const dir = resolve(at >= 0 ? args[at + 1] ?? "" : ".");
if (!existsSync(dir)) { process.stderr.write(t("simulator.no_dir", { dir })); process.exit(2); }
const real = realpathSync(dir);
const forwarded = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
// Node 24: una concesión hija antes que su padre deniega operar sobre el padre; se quitan las ya cubiertas.
const roots = (paths) => { const u = [...new Set(paths)]; return u.filter((p) => !u.some((q) => q !== p && p.startsWith(q.endsWith(sep) ? q : q + sep))); };
// Y otra concesión con el mismo prefijo de texto (…/app y …/app-tools): Node 24 tampoco lo distingue. Se para con un mensaje.
const clash = (() => { const r = roots([pkgRoot, real]); return r.find((p) => r.some((q) => q !== p && q.startsWith(p) && q[p.length] !== sep)); })();
if (clash) { process.stderr.write(t("simulator.prefix_clash", { clash })); process.exit(2); }
const child = spawn(process.execPath, [
  "--max-old-space-size=256", "--permission",
  ...roots([pkgRoot, real]).map((d) => `--allow-fs-read=${d}`),
  `--allow-fs-write=${join(real, ".env.licenroute")}`, `--allow-fs-write=${join(real, ".licenroute")}`, `--allow-fs-write=${join(real, ".licenroute", "*")}`,
  "--disable-warning=ExperimentalWarning", "--disable-warning=SecurityWarning", entry, ...forwarded, "--dir", real,
], { stdio: "inherit", env: (() => { const e = { ...process.env }; for (const k of ["NODE_OPTIONS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete e[k]; return e; })() });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
