/**
 * JSON canónico (claves ordenadas, sin espacios). Gemelo de Botgate::CanonicalJson (Ruby).
 * Contrato común: fixtures/canonical-json.json. Solo enteros: los floats no son portables.
 */
import { createHash } from "node:crypto";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])]),
    );
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError(`JSON canónico solo admite enteros seguros (${value})`);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`tipo no admitido en JSON canónico: ${typeof value}`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
