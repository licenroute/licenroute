// Idiomas de LicenRoute (D4.4). Inglés por defecto; español completo. Solo cambia TEXTO para personas: nunca permisos,
// rutas, licencias, planes, códigos de aprobación, campos JSON ni el código que se escribe en el proyecto.
//
// Prioridad (la primera que exista y sea válida):
//   1. --lang en|es               (un valor no soportado es un error de uso)
//   2. LICENROUTE_LANG=en|es         (un valor no soportado se ignora)
//   3. configuración del usuario  (no existe en esta preview)
//   4. locale del sistema: LC_ALL, después LC_MESSAGES, después LANG (orden POSIX); «es…» → es, «en…» → en
//   5. inglés (también para C, POSIX y cualquier otro locale)
// --json produce siempre el resultado en inglés: el resultado estructurado es idéntico en los dos idiomas.
import { en } from "./i18n/en.mjs";
import { es } from "./i18n/es.mjs";

export const LANGS = ["en", "es"];
export const DEFAULT_LANG = "en";
export const CATALOGS = { en, es };

/** Idioma de un valor de locale POSIX («es_ES.UTF-8» → es); null si no es uno soportado. */
export function langOfLocale(value) {
  const m = /^([a-z]{2})(?:[_.@-]|$)/i.exec(value ?? "");
  const l = m?.[1].toLowerCase();
  return l && LANGS.includes(l) ? l : null;
}

/** Resuelve el idioma. flag: valor de --lang (o undefined). Devuelve { lang, source } o { error }. */
export function resolveLang(flag, env = process.env) {
  if (flag !== undefined) return LANGS.includes(flag) ? { lang: flag, source: "--lang" } : { error: `--lang: use one of ${LANGS.join(", ")} / usa uno de ${LANGS.join(", ")}` };
  if (LANGS.includes(env.LICENROUTE_LANG)) return { lang: env.LICENROUTE_LANG, source: "LICENROUTE_LANG" };
  for (const k of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const v = env[k];
    if (!v) continue; // POSIX: la primera variable NO vacía decide
    return { lang: langOfLocale(v) ?? DEFAULT_LANG, source: k };
  }
  return { lang: DEFAULT_LANG, source: "default" };
}

let current = DEFAULT_LANG;
export function setLang(lang) { current = LANGS.includes(lang) ? lang : DEFAULT_LANG; }
export function getLang() { return current; }

/** Texto de la clave en el idioma actual (o en `lang`). Los parámetros sustituyen {nombre}. Clave inexistente: error. */
export function t(key, params = {}, lang = current) {
  const msg = CATALOGS[lang]?.[key] ?? CATALOGS[DEFAULT_LANG][key];
  if (msg === undefined) throw new Error(`i18n: missing key ${key}`);
  return msg.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

// Textos que forman parte de DATOS (el plan, cuyo sha256 aprueba el desarrollador; el JSON de detect y plan): se generan
// SIEMPRE en inglés canónico con tc(), para que el hash, la aprobación y el resultado estructurado no dependan del
// idioma. Al mostrarlos a una persona, localize() los traduce al idioma elegido.
const canonical = new Map();
export function tc(key, params = {}) {
  const s = t(key, params, DEFAULT_LANG);
  canonical.set(s, [key, params]);
  return s;
}
/** Traduce en `text` los textos canónicos generados con tc() (los más largos primero). */
export function localize(text, lang = current) {
  if (lang === DEFAULT_LANG || !canonical.size || typeof text !== "string") return text;
  let out = text;
  for (const [s, [key, params]] of [...canonical].sort((a, b) => b[0].length - a[0].length)) if (out.includes(s)) out = out.split(s).join(t(key, params, lang));
  return out;
}

/** Los {parámetros} de un mensaje (para las pruebas de paridad). */
export const placeholders = (msg) => [...new Set([...msg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
