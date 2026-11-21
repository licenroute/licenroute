/**
 * Repositorio público (L6): solo el estado de un sitio que leen `test` y `doctor`. Sin la salida ni los errores del
 * controlador del Sandbox privado.
 */
export interface AppStatus {
  /** methods (D4.1): los que exige el plan en el servicio; ausente si el proveedor no lo informa. */
  plans: { pattern: string; state: string; quota: number; methods?: string[] }[];
  attestations: { sdk: string; freshness: string; mode: string; paths: string[] }[];
}
