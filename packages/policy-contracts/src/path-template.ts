/**
 * Plantilla de ruta para eventos y métricas: reduce cardinalidad y evita guardar
 * identificadores en claro. Se aplica sobre una ruta ya normalizada (normalizePath).
 * Un segmento se sustituye por `:id` si es: número, UUID, hex largo (>= 16), o un token de
 * >= 20 caracteres alfanuméricos con dígitos (ids opacos, hashes, tokens en la ruta).
 */
import { pathSegments } from "./path.ts";

const NUMERIC = /^\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{16,}$/;
const OPAQUE = /^(?=.*\d)[a-z0-9_-]{20,}$/;
export const MAX_TEMPLATE_LENGTH = 512;

export function pathTemplate(normalized: string): string {
  const segments = pathSegments(normalized).map((s) => (NUMERIC.test(s) || UUID.test(s) || HEX.test(s) || OPAQUE.test(s) ? ":id" : s));
  const template = "/" + segments.join("/");
  return template.length <= MAX_TEMPLATE_LENGTH ? template : template.slice(0, MAX_TEMPLATE_LENGTH - 2) + "/…";
}
