// D4.4: las pruebas históricas comprueban los textos en español (como el lanzador, el idioma sale de LICENROUTE_LANG).
import { resolveLang, setLang } from "../../../cli/bin/i18n.mjs";

setLang(resolveLang(undefined).lang ?? "en");
