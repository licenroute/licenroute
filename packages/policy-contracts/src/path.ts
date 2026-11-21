/**
 * Normalización de rutas compartida por la Decision API y los SDKs (threat model T10).
 *
 * Objetivo: que variantes de una misma ruta no eludan una regla. Criterio conservador:
 * ante la duda se normaliza hacia la forma que MÁS reglas pueda coincidir.
 *
 *  1. Se descarta query string y fragmento.
 *  2. Se decodifica el percent-encoding UNA vez (como la mayoría de servidores). `%2F` y `%5C`
 *     decodificados actúan como separadores. La doble codificación (`%252e`) queda literal.
 *  3. `\` se trata como `/`.
 *  4. Se eliminan parámetros de matriz (`/admin;x=1` -> `/admin`) y bytes nulos.
 *  5. Minúsculas (las reglas se comparan sin distinguir mayúsculas).
 *  6. Se resuelven `.` y `..` (sin salir de la raíz) y se colapsan `//`.
 *  7. Sin barra final, salvo la raíz.
 *  8. Los caracteres con significado sintáctico que queden tras decodificar se re-escapan:
 *     `%` -> `%25`, `?` -> `%3F`, `#` -> `%23`. Así la salida es canónica e idempotente:
 *     normalizar dos veces (SDK y API) nunca decodifica dos veces ni convierte un `%3F` del
 *     camino en el inicio de una query. Express y Rails tampoco tratan `%3F`/`%23` como
 *     separadores (verificado en tests/compat y spec/compat).
 */
export const MAX_PATH_LENGTH = 2048;

export function normalizePath(raw: string): string {
  let path = raw.slice(0, MAX_PATH_LENGTH * 3);
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);

  path = percentDecodeOnce(path).replace(/\\/g, "/").replace(/\0/g, "").toLowerCase();

  const out: string[] = [];
  for (const rawSegment of path.split("/")) {
    const segment = rawSegment.split(";", 1)[0] ?? "";
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return ("/" + out.join("/").replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23")).slice(0, MAX_PATH_LENGTH);
}

/** Decodifica secuencias %XX válidas; las inválidas o bytes UTF-8 mal formados se dejan tal cual. */
function percentDecodeOnce(input: string): string {
  if (!input.includes("%")) return input;
  return input.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // Secuencia UTF-8 inválida: se decodifican solo los bytes ASCII, el resto queda literal.
      return run.replace(/%([0-7][0-9a-fA-F])/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
}

/** Segmentos de una ruta ya normalizada ("/" -> []). */
export function pathSegments(normalized: string): string[] {
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}
