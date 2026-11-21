/**
 * Confirmación humana de una escritura (capa A, S7; D4.3). La pide el MISMO proceso que escribe, justo antes de
 * escribir, en el terminal de control (/dev/tty, nunca stdin). Hasta 0.2.3 la pedía el lanzador y pasaba el resultado
 * a la fase de escritura con --consent: invocar dist/main.cjs (o src/main.ts) con --phase write --consent tty-challenge
 * escribía sin reto y el diario registraba un consentimiento que nadie dio (F-D4.3-1). Ahora --consent no existe y
 * ningún argumento ni variable de entorno sustituye el reto.
 *
 * insecure-test solo existe para las pruebas de este repositorio (ver bin/insecure-ack.mjs): el paquete compilado y el
 * código fuente público lo tienen desactivado. Limitación conocida: quien controle un pseudoterminal puede responder al
 * reto; es una fricción y una señal, no una prueba criptográfica de quién aprueba.
 */
import { randomInt } from "node:crypto";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import type { Consent } from "./journal.ts";
import { t } from "../bin/i18n.mjs";

export type ConsentResult = { consent: Consent } | { error: string };

export function confirmWrite(what: string[], insecureReady: boolean): ConsentResult {
  const mode = process.env.LICENROUTE_APPROVAL;
  if (mode === "host-gated") return { error: t("consent.host_gated") };
  if (mode === "insecure-test") {
    if (!insecureReady) return { error: t("consent.insecure_refused") };
    process.stderr.write(t("consent.insecure_active"));
    return { consent: "insecure-test" };
  }
  if (mode !== undefined) return { error: t("consent.env_refused", { mode }) };
  let fd: number;
  try { fd = openSync("/dev/tty", "r+"); } catch {
    return { error: t("consent.no_terminal") };
  }
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const challenge = Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + letters[randomInt(letters.length)]).join("");
  writeSync(fd, t("consent.prompt", { p1: what.map((l) => `  ${l}`).join("\n"), challenge }));
  const buf = Buffer.alloc(64); let line = "";
  for (;;) { const n = readSync(fd, buf, 0, buf.length, null); if (n <= 0) break; line += buf.subarray(0, n).toString("utf8"); if (line.includes("\n") || line.length > 60) break; }
  const ok = line.trim().toUpperCase() === challenge;
  writeSync(fd, ok ? t("consent.confirmed") : t("consent.not_confirmed")); closeSync(fd);
  return ok ? { consent: "tty-challenge" } : { error: "" };
}
