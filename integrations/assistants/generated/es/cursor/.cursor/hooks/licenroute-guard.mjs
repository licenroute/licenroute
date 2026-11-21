#!/usr/bin/env node
// Puerta de aprobación de LicenRoute para asistentes (S7, capa B). Lo ejecuta el ENTORNO del asistente antes de cada
// comando de shell (Claude Code: hook PreToolUse; Cursor: hook beforeShellExecution) y decide:
//   - escrituras de LicenRoute (apply --approve, undo --resolve, init --write, assistant --approve) y arrancar la app
//     (dev --start-app): Claude Code → "ask" (la persona aprueba en la
//     interfaz); Cursor → "deny" (su "ask" no es fiable en todas las versiones: la persona ejecuta la orden en su
//     terminal, donde LicenRoute le pide el reto). Ninguna de las dos sustituye ese reto;
//   - LICENROUTE_APPROVAL=host-gated, insecure-test, LICENROUTE_INSECURE_TEST (y sus formas antiguas BOTGATE_) o leer
//     credenciales (.env*): "deny" siempre;
//   - LicenRoute 0.3.0: npx, npm exec / npm x, pnpm dlx / pnpx, yarn dlx y bunx con licenroute o botgate: "deny" siempre.
//     Descargarían y ejecutarían un paquete del registro (el de un tercero, si el nombre no es el nuestro); la forma
//     aprobada es el binario local ./node_modules/.bin/licenroute;
//   - lo demás: sin decisión (Claude Code) o "allow" solo para lo que no escribe (detect, plan, init sin --write, env,
//     connect; Cursor). El resto, "ask". El nombre antiguo botgate (legado propio o un paquete ajeno: el nombre no los
//     distingue) nunca se permite sin preguntar; sus escrituras se tratan como las de licenroute.
// Reduce el riesgo; NO prueba que una persona aprobó (un comando ofuscado puede escapar a los patrones).
// Uso: node licenroute-guard.mjs claude|cursor [en|es]  (JSON del entorno por stdin)
// D4.4: UNA sola lógica para los dos idiomas. El idioma solo elige el texto que ve la persona (la plantilla instalada lo
// fija en la orden del hook; sin él o con otro valor, inglés); classify() y las decisiones no dependen de él.
import { readFileSync } from "node:fs";

export const MESSAGES = {
  en: {
    host_gated: "LICENROUTE_APPROVAL=host-gated no longer authorises writes: the developer runs apply in their terminal",
    insecure: "LicenRoute's internal test mode is not used from an assistant",
    env_read: "LicenRoute: this command would read a credentials file (.env*), so it is blocked. The hook blocks the accesses it detects; it does not detect every possible way to read a file.",
    proc_env: "LicenRoute: the environment of processes is not shown (it may contain credentials)",
    write: "LicenRoute is going to modify files of your project (apply/init/undo/assistant). Review the diff the assistant showed you before approving.",
    start_app: "LicenRoute is going to start your app with a command you must review yourself in your terminal.",
    bad_input: "LicenRoute: invalid hook input",
    bad_input_agent: "invalid hook input",
    cursor_write_user: "LicenRoute: this command modifies your code. Run it yourself in your terminal (it will ask you to confirm with a challenge).",
    cursor_write_agent: "Do not run LicenRoute writes: ask the developer to run the command in their terminal.",
    usage: "usage: licenroute-guard.mjs claude|cursor [en|es]",
    pkg_runner: "LicenRoute: npx/npm exec would download and run a package from the npm registry, which may not be LicenRoute. Run the approved local binary instead: ./node_modules/.bin/licenroute <command>",
  },
  es: {
    host_gated: "LICENROUTE_APPROVAL=host-gated ya no autoriza escrituras: el desarrollador ejecuta apply en su terminal",
    insecure: "el modo de prueba interno de LicenRoute no se usa desde un asistente",
    env_read: "LicenRoute: esta orden leería un fichero de credenciales (.env*), así que se bloquea. El hook bloquea los accesos que detecta; no detecta todas las formas posibles de leer un fichero.",
    proc_env: "LicenRoute: no se muestra el entorno de los procesos (puede contener credenciales)",
    write: "LicenRoute va a modificar ficheros de tu proyecto (apply/init/undo/assistant). Revisa el diff que te mostró el asistente antes de aprobar.",
    start_app: "LicenRoute va a arrancar tu app con un comando que debes revisar tú en tu terminal.",
    bad_input: "LicenRoute: entrada del hook inválida",
    bad_input_agent: "entrada del hook inválida",
    cursor_write_user: "LicenRoute: esta orden modifica tu código. Ejecútala tú en tu terminal (te pedirá confirmar con un reto).",
    cursor_write_agent: "No ejecutes escrituras de LicenRoute: pide al desarrollador que ejecute la orden en su terminal.",
    usage: "uso: licenroute-guard.mjs claude|cursor [en|es]",
    pkg_runner: "LicenRoute: npx/npm exec descargaría y ejecutaría un paquete del registro de npm, que puede no ser LicenRoute. Usa el binario local aprobado: ./node_modules/.bin/licenroute <orden>",
  },
};
const text = (lang) => MESSAGES[lang] ?? MESSAGES.en;

/** Clase de la orden (deny/write/read/other/none) y el motivo como clave de MESSAGES; no depende del idioma. */
export function classify(cmd) {
  const c = cmd.replace(/\s+/g, " ");
  if (/(?:LICENROUTE|BOTGATE)_APPROVAL\s*=\s*["']?host-gated/.test(c)) return { kind: "deny", why: "host_gated" };
  if (/(?:LICENROUTE|BOTGATE)_APPROVAL\s*=\s*["']?insecure-test/.test(c) || /(?:LICENROUTE|BOTGATE)_INSECURE_TEST\s*=/.test(c)) return { kind: "deny", why: "insecure" };
  if (/(?:^|[\s;|&(])(?:cat|less|more|head|tail|bat|grep|rg|sed|awk|strings|xxd|od|cp|scp|base64|source|\.)\s[^;|&]*\.env(?:\.[\w.-]+)?\b/.test(c) || /printenv|env\s*\|/.test(c) && /LICENROUTE|BOTGATE/.test(c)) return { kind: "deny", why: "env_read" };
  // S10.2-D3.1: el entorno de otros procesos (la app lleva sus credenciales en él) se ve con ps eww / ps -E / /proc/*/environ.
  if (/\bps\s+[a-zA-Z]*e[a-zA-Z]*(?=\s|$)|\bps\b[^|;&]*\s-[a-zA-Z]*E/.test(c) || /\/proc\/[^\s]*\/environ/.test(c)) return { kind: "deny", why: "proc_env" };
  // LicenRoute 0.3.0: ejecutores de paquetes del registro con cualquiera de los dos nombres (antes de clasificar escrituras:
  // también una escritura por npx se deniega; la persona la ejecuta con el binario local y contesta el reto).
  if (/(?:^|[\s;|&(])(?:npx|pnpx|bunx|(?:npm|pnpm)\s+(?:exec|x)|(?:pnpm|yarn)\s+dlx)\b[^;|&]*(?:licenroute|botgate)/.test(c)) return { kind: "deny", why: "pkg_runner" };
  const isLicenRoute = /licenroute(?:\.mjs)?\b/.test(c);
  const isLegacy = /botgate(?:\.mjs)?\b/.test(c); // nombre antiguo: legado propio o paquete ajeno
  const ours = isLicenRoute || isLegacy;
  if (/(?:LICENROUTE|BOTGATE)_APPROVAL\s*=/.test(c) || (ours && /\b(?:apply|assistant)\b/.test(c) && /--approve\b/.test(c)) || (ours && /\bundo\b/.test(c) && /--resolve\b/.test(c)) || (ours && /\binit\b/.test(c) && /--write\b/.test(c))) {
    return { kind: "write", why: "write" };
  }
  if (ours && /\bdev\b/.test(c) && /--start-app\b/.test(c)) return { kind: "write", why: "start_app" };
  if (isLicenRoute && !isLegacy && /\b(?:detect|plan|init|env|connect)\b/.test(c) && !/\b(?:apply|undo|test|doctor|dev|assistant)\b/.test(c) && !/--(?:write|approve)\b/.test(c)) return { kind: "read" };
  if (ours) return { kind: "other" };
  return { kind: "none" };
}

export function decide(host, rawInput, lang = "en") {
  const msg = text(lang);
  let input = null;
  try { input = JSON.parse(rawInput); } catch { /* entrada inválida: fallo cerrado abajo */ }
  if (!input) return host === "cursor" ? { code: 0, out: { continue: true, permission: "deny", user_message: msg.bad_input, agent_message: msg.bad_input_agent } } : { code: 2, err: msg.bad_input };
  const d = classify(String((host === "claude" ? input?.tool_input?.command : input?.command) ?? ""));
  if (host === "claude") {
    // Sin salida = sin decisión: Claude Code sigue su flujo normal de permisos.
    const decision = d.kind === "deny" ? "deny" : d.kind === "write" ? "ask" : null;
    return { code: 0, out: decision ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: msg[d.why] } } : null };
  }
  if (host === "cursor") {
    const out = d.kind === "deny" ? { permission: "deny", user_message: msg[d.why], agent_message: msg[d.why] }
      : d.kind === "write" ? { permission: "deny", user_message: msg.cursor_write_user, agent_message: msg.cursor_write_agent }
        : d.kind === "read" ? { permission: "allow" } : { permission: "ask" };
    return { code: 0, out: { continue: true, ...out } };
  }
  return { code: 2, err: msg.usage }; // fallo cerrado
}

if (process.argv[1] && /licenroute-guard\.mjs$/.test(process.argv[1])) {
  const r = decide(process.argv[2], readFileSync(0, "utf8"), process.argv[3]);
  if (r.out) process.stdout.write(JSON.stringify(r.out));
  if (r.err) process.stderr.write(`${r.err}\n`);
  process.exit(r.code);
}
