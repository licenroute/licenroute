// Punto de entrada empaquetado de licenroute-simulator (dist/simulator.cjs).
import { resolveLang, setLang } from "../../cli/bin/i18n.mjs";
import { main } from "./cli.ts";

// Idioma (D4.4): LICENROUTE_LANG (licenroute dev lo pasa) o el locale del sistema; inglés por defecto.
setLang(resolveLang(undefined).lang ?? "en");

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`licenroute-simulator: ${(e as Error).message}\n`); process.exitCode = 1; });
