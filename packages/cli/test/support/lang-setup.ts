// D4.4: las pruebas que importan los módulos de la CLI usan el idioma de LICENROUTE_LANG (como el lanzador).
import { resolveLang, setLang } from "../../bin/i18n.mjs";

setLang(resolveLang(undefined).lang ?? "en");
