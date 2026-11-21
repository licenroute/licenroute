import { createHash, createHmac } from "node:crypto";

/**
 * Identidad seudónima de LicenRoute Trust (Fase 10). La calcula el SDK en el servidor de la app;
 * LicenRoute solo recibe el resultado. Es un SEUDÓNIMO (HMAC con clave), no una anonimización: quien tenga
 * la clave del sitio y el id puede recalcularlo.
 *   key_id = primeros 16 hex de SHA-256("botgate-identity-key\0" + clave)   (huella pública de la clave)
 *   hash   = HMAC-SHA256(clave, "v1:" + site_id + ":" + id)                  (por sitio: no enlaza sitios)
 */
export const IDENTITY_SECRET_MIN_LENGTH = 32;
export const IDENTITY_MAX_ID_LENGTH = 256;

export function identityKeyId(secret: string): string {
  return createHash("sha256").update(`botgate-identity-key\0${secret}`).digest("hex").slice(0, 16);
}

export function identityHash(secret: string, siteId: string, id: string): string {
  return createHmac("sha256", secret).update(`v1:${siteId}:${id}`).digest("hex");
}
