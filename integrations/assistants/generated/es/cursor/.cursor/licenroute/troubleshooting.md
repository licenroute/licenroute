<!-- Generado por LicenRoute (perfil del repositorio público): no edites este fichero. -->

# Problemas frecuentes

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `apply` con `--approve` responde «hace falta tu confirmación en un terminal» | La escritura necesita que una persona la confirme en su terminal | Pide al desarrollador que ejecute esa orden en su terminal; nunca intentes responder al reto |
| `apply`: «el plan ha cambiado» | Un fichero cambió desde `plan` | Repite `plan`, vuelve a presentarlo y pide aprobación otra vez |
| `apply`: «no entiende del todo» / «posición insegura» / «integra a mano» | Ruta dinámica, parcial o middleware antes de LicenRoute | Explícalo; **no** edites a mano; la decisión es del desarrollador |
| `test`: «el simulador no responde» | Simulador parado | Pide al desarrollador que vuelva a arrancar `./node_modules/.bin/licenroute dev <dir>` |
| `test`: «sin activar» | El SDK de la app no ha atestado los patrones | ¿La app arrancó con `.env.licenroute`? Espera a `/health/ready` y repite |
| `doctor`: «simulador caído», «puerto», «credenciales mezcladas» | `licenroute dev` parado, o `.env.licenroute` de otra ejecución o real | `./node_modules/.bin/licenroute env <dir>` (sin secretos) y que el desarrollador vuelva a arrancar `./node_modules/.bin/licenroute dev <dir>` |
| `undo`: conflicto | El desarrollador cambió el fichero después de `apply` | Muestra el conflicto; `--resolve` solo con su permiso |
| Código de salida 4 | Límite de tiempo o memoria del análisis | Proyecto muy grande o patológico: dilo; no reintentes en bucle |

## Puerta de aprobación del entorno (opcional, la instala el desarrollador)

Plantillas en `assistants/` del paquete instalado de la CLI (`node_modules/@licenroute/cli/assistants/`), que instala
`./node_modules/.bin/licenroute assistant`:

- **Claude Code**: reglas `ask`/`deny` y un hook `PreToolUse` (`.claude/settings.json` + `.claude/hooks/`) que obligan a
  que el desarrollador apruebe en la interfaz cualquier `licenroute apply --approve` o `undo --resolve`, y bloquean
  `LICENROUTE_APPROVAL`, `LICENROUTE_INSECURE_TEST` y la lectura de `.env*`. Esa aprobación de la interfaz no sustituye el
  reto del terminal: la escritura la hace el desarrollador en su terminal.
- **Cursor**: un hook `beforeShellExecution` (`.cursor/hooks.json`) que **bloquea** esas órdenes cuando las lanza el
  agente (la opción `ask` de Cursor no es fiable en todas las versiones): el desarrollador las ejecuta en su terminal.

Ninguna plantilla prueba que una persona aprobó: reducen el riesgo. Si no están instaladas, usa el camino por defecto.
