# Usar LicenRoute con Claude Code o Cursor

LicenRoute incluye una **Skill** de Claude Code y unas **reglas de Cursor** equivalentes, más un **hook** de aprobación
para cada uno. Son ficheros normales de este repositorio (`integrations/assistants/generated/en/` y `generated/es/`) y
del paquete de la CLI; no hay servidor MCP y nada se ejecuta en la nube.

## Instalarlos en un proyecto

```bash
./node_modules/.bin/licenroute assistant . --claude-code --lang es     # vista previa de los ficheros que crearía; no escribe nada
./node_modules/.bin/licenroute assistant . --claude-code --lang es --approve asst_…   # los escribe cuando tecleas el reto
./node_modules/.bin/licenroute assistant . --cursor --lang es          # lo mismo para Cursor
```

`--lang es` (o `LICENROUTE_LANG=es`, o un locale del sistema en español) instala la versión en español; sin él, la
inglesa. El código `asst_…` cubre el contenido de los ficheros: el de una vista previa en un idioma no escribe el otro.

Solo crea ficheros que no existen y nunca sobrescribe ninguno. Para Claude Code crea `.claude/skills/licenroute/`, el hook
`.claude/hooks/licenroute-guard.mjs` y `.claude/settings.json`; para Cursor, `.cursor/rules/licenroute.mdc`,
`.cursor/licenroute/`, `.cursor/hooks/licenroute-guard.mjs` y `.cursor/hooks.json`. Si `settings.json` o `hooks.json` ya
existen, te muestra la versión fusionada para que la apliques tú (solo añade las restricciones de LicenRoute).

## Qué aprende el asistente

- Cuándo encaja LicenRoute (terceros que pagan, tienen licencia o cuota en rutas de una API Express 4 o 5 que ya existe)
  y cuándo no (login y roles, rate limiting sin cobro, DDoS, APIs por escribir, otros frameworks). Rails queda
  explícitamente fuera de alcance: el asistente no debe proponer `init` ni `apply` en una app Rails, y la CLI se niega
  a escribirla de todos modos.
- El flujo `init` → enseñarte el diff → **tú** apruebas → `dev` → `test` → `undo`, y repetir la vista previa si algo
  cambia.
- A informar con honestidad de la cobertura parcial y no afirmar nunca que la API queda protegida entera si no es así.
- A no leer ni mostrar nunca ficheros `.env*`, claves ni tokens, y a no usar nunca atajos de aprobación.

## Qué impone el hook

| Acción | Claude Code | Cursor |
|---|---|---|
| Escrituras de LicenRoute (`init --write`, `apply --approve`, `assistant --approve`, `dev --start-app`, `undo --resolve`) | te pregunta | bloqueada (ejecútala tú) |
| `LICENROUTE_APPROVAL=…`, `LICENROUTE_INSECURE_TEST=…` | denegado | denegado |
| Leer `.env`, `.env.*`, `.env.licenroute` | denegado | denegado |
| Leer el entorno de otros procesos (`ps eww`, `/proc/*/environ`) | denegado | denegado |
| `detect`, `plan`, vistas previas de `init`, `test`, `env`, `doctor` | permitido | permitido |

Aunque el hook permita una escritura, la CLI sigue exigiendo el reto de un solo uso en tu terminal: un asistente sin
ese terminal no puede confirmar. El hook compara el texto de la orden, así que una orden ofuscada puede escaparse; esa
limitación está documentada y probada. Tampoco bloquea `npm install licenroute` (el nombre sin ámbito en npm no es este
paquete): instala solo desde tus paquetes locales verificados. La barrera real es la CLI.

## Idioma

La Skill y las reglas existen en inglés y en español y dicen exactamente las mismas reglas (el generador lo
comprueba). El hook es un único fichero para los dos idiomas: decide lo mismo y solo muestra su mensaje en el idioma
instalado. El asistente te seguirá hablando en tu idioma. Detalle: [i18n.md](i18n.md).
