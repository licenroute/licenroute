# LicenRoute — licencias, cuotas y revocación para tu API Express (versión preliminar)

> **Versión preliminar para desarrolladores. Solo modo demo.** Todo lo de este repositorio se ejecuta en tu máquina
> contra un **simulador local** con **credenciales sintéticas**. No hay ningún servicio alojado de LicenRoute detrás, **no**
> cobra dinero, no procesa pagos ni protege nada en producción, y no debe usarse con credenciales reales. Los resultados
> de las pruebas son `SIMULATED PASS`, nunca una certificación de seguridad.
>
> Esta es la documentación en español; la de referencia es la inglesa ([README.md](../../README.md)). Para ver los
> mensajes de la CLI en español: `--lang es`, `LICENROUTE_LANG=es` o un locale del sistema en español (por defecto, inglés).

LicenRoute pone **acceso de pago o con cuota delante de algunas rutas de una API Express que ya existe**: una petición a
una ruta con licencia sin una licencia válida recibe `402`, una licencia inventada o revocada recibe `403`, y una
licencia que agota su cuota deja de ser atendida — mientras tus rutas públicas, las comprobaciones de salud, el login y
tus propias escrituras autenticadas siguen funcionando exactamente igual que antes.

Está pensado para que lo integres **tú o tu asistente de programación (Claude Code, Cursor) sin perder el control**: la
CLI lee tu código sin ejecutarlo, propone planes, enseña el diff exacto y no escribe nada hasta que una persona teclea un
reto de un solo uso en su propio terminal. `licenroute undo` lo revierte exactamente.

## Qué hay en este repositorio

| Ruta | Qué es |
|---|---|
| `packages/cli` | `@licenroute/cli` 0.3.2 — la orden `licenroute` (código TypeScript) |
| `sdks/node-express` | `@licenroute/connect-express` 0.8.0 — middleware para Express 4/5 (código TypeScript) |
| `packages/simulator` | simulador local de decisiones para el modo demo (va dentro del paquete de la CLI) |
| `packages/policy-contracts` | esquemas, comparación de rutas y JSON canónico que comparten el SDK y el simulador (incrustado) |
| `integrations/assistants` | Skill de Claude Code + hook de aprobación, y reglas de Cursor + hook (en inglés y en español) |
| `examples/express-demo` | una API Express pequeña para probarlo |
| `docs/es/` | [tutorial](tutorial-express.md), [asistentes](assistants.md), [limitaciones](limitations.md), [desinstalar](uninstall.md), [idiomas](i18n.md), [seguridad](security.md) |
| `scripts/validate-distribution.mjs` | la validación local completa (`npm run validate:distribution`) |

LicenRoute Central (el servicio alojado que emitiría licencias reales y aplicaría cuotas reales) es propietario y **no**
forma parte de este repositorio.

## Pruébalo en 5 minutos

Requisitos: Node.js 24 o posterior con npm, git y (en Linux) `script` de util-linux. Sin Docker y sin cuenta.

```bash
git clone https://github.com/licenroute/licenroute.git licenroute && cd licenroute
npm ci --ignore-scripts          # dependencias de desarrollo del registro público de npm
npm run build                    # dist-packages/licenroute-cli-0.3.2.tgz y licenroute-connect-express-0.8.0.tgz
export LICENROUTE_LANG=es           # mensajes en español
./demo/demo.sh                   # solo lectura: copia la API de ejemplo y enseña los planes y el diff exacto
```

Después sigue el [tutorial](tutorial-express.md) para escribir la integración (tecleas tú el reto), arrancar el
simulador y tu app con `licenroute dev`, y ejecutar `licenroute test`:

```text
SIMULATED PASS api-informes:sin-licencia /api/informes: 402 payment_required
SIMULATED PASS api-informes:licencia-valida: 200
SIMULATED PASS api-informes:licencia-inventada: 403 forbidden
SIMULATED PASS api-informes:cuota: GET 200 · HEAD 200 · GET 200 · HEAD 402 (cuota 3)
SIMULATED PASS api-informes:revocada: antes 200 · después 403 forbidden
SIMULATED PASS central-caido:api-informes: /api/informes 503 service_unavailable · /api/informes/:id 503 service_unavailable · HEAD /api/informes 503
SIMULATED PASS: la integración responde como se espera contra el SIMULADOR. No certifica la seguridad de Central ni ningún cobro real.
```

## Añadir licencias y cuotas a tu propia API Express

```bash
cd tu-api
npm install --save-dev --ignore-scripts <licenroute>/dist-packages/licenroute-cli-0.3.2.tgz
npm install --ignore-scripts <licenroute>/dist-packages/licenroute-connect-express-0.8.0.tgz
npm ls @licenroute/cli                    # debe listar el paquete que acabas de instalar
./node_modules/.bin/licenroute init . --lang es                           # planes numerados; rutas que nunca tocará; rutas que decides tú
./node_modules/.bin/licenroute init . --plans 1 --app tu-api --lang es    # vista previa del diff completo; no escribe nada
./node_modules/.bin/licenroute init . --plans 1 --app tu-api --write --approve apr_… --lang es   # tecleas el reto que aparece en tu terminal
./node_modules/.bin/licenroute dev . --start-app --lang es                # simulador + tu app (pregunta antes de ejecutar `node <entrada>`)
./node_modules/.bin/licenroute test . --lang es                           # en un segundo terminal
./node_modules/.bin/licenroute undo . --lang es                           # reversión exacta cuando quieras
```

Ejecuta LicenRoute desde el proyecto donde lo instalaste, como `./node_modules/.bin/licenroute …`, después de comprobar que es el
paquete que construiste (`npm ls @licenroute/cli`). **Nunca uses `npx licenroute`**: en npm el nombre sin ámbito `licenroute` no es
este paquete (cualquiera puede publicar con él), y `npx` descarga y ejecuta un paquete que no está instalado (fuera de un terminal interactivo, sin preguntar).

El middleware que se inserta declara cada ruta de pago **con sus métodos** (`{ path: "/api/reports/**", methods:
["GET", "HEAD"] }`), así que un `POST` bajo el mismo prefijo que tiene su propia autenticación se queda como estaba. Los
planes que cubrirían una ruta con autenticación propia no se proponen; se enumeran para que decidas tú. El código que se
escribe en tu proyecto (comentarios incluidos) va en inglés sea cual sea el idioma, para que el diff que apruebas sea
siempre el mismo.

## Claude Code y Cursor

`./node_modules/.bin/licenroute assistant . --claude-code --lang es` (o `--cursor`) instala una Skill (o reglas) en español que enseña al
asistente cuándo LicenRoute es la herramienta adecuada y cuándo no, y el flujo seguro `detect → plan → vista previa → tu
aprobación → test → undo`, más un hook que hace que el asistente te pregunte antes de cualquier escritura de LicenRoute y le
impide leer ficheros `.env*` o usar atajos de aprobación. El asistente puede prepararlo todo, pero nunca debe teclear el
reto por ti: la CLI lo pide en tu terminal y prueba que alguien lo tecleó allí, no quién. Detalle:
[assistants.md](assistants.md).

## Qué funciona en esta versión preliminar

- Express 4 y 5, JavaScript y TypeScript, ESM y CommonJS, routers montados con `app.use`.
- Análisis estático sin ejecutar tu código; detección de rutas de salud, login, públicas y ya autenticadas.
- Planes por prefijo de ruta, licencias por método HTTP (`GET` + `HEAD`); `OPTIONS` nunca se cobra.
- Aprobación ligada al diff exacto + un reto de un solo uso en `/dev/tty`; el modelo de permisos de Node como segunda
  barrera.
- Simulador local: licencias, cuotas, revocación, licencia de otro plan, licencias inventadas, caída y recuperación.
- `undo` exacto que nunca sobrescribe cambios posteriores.
- Mensajes en inglés y en español; la salida `--json` es idéntica en los dos.

## Límites del modo demo

- El simulador solo escucha en loopback y solo acepta sus propias credenciales sintéticas (`bg_dev_…`); las credenciales
  con formato real se rechazan (`503`) y nunca se muestran.
- `SIMULATED PASS` comprueba tu integración contra el simulador, no contra un servicio real.
- Las escrituras con efectos (p. ej. `POST`) se comprueban en tu código y en la decisión del simulador, pero
  `licenroute test` nunca las envía a tu app.
- Las aprobaciones prueban que alguien tecleó el reto en el terminal, no quién estaba al teclado.

## No está lista para producción

- No hay servicio alojado: ni licencias, cuotas, facturación ni pagos reales.
- Sin revisión para tráfico de producción ni credenciales reales; todavía sin auditoría de seguridad.
- Rails queda fuera de alcance: `licenroute detect` y `licenroute plan` pueden analizar una app Rails en solo lectura, pero
  `init` y `apply` se niegan a escribir una integración (el SDK de Rails no forma parte de este repositorio).
- Plataformas: ver [limitations.md](limitations.md#plataformas-e-idiomas). Windows no está probado.
- Los nombres de paquete bajo `@licenroute` son provisionales y **no están publicados** en npm.

Lista completa: [limitations.md](limitations.md).

## Valídalo tú

```bash
npm run validate:distribution     # código de salida ≠ 0 ante cualquier fallo; resultados en validation-results/
```

Comprueba la integridad de los paquetes, la compilación y el empaquetado, las pruebas de la CLI, el SDK, el simulador,
los contratos y los asistentes (incluidos los dos idiomas), una ejecución de principio a fin sobre la API Express de
ejemplo **en inglés y en español** (autenticación existente, métodos HTTP y la regresión F-D4-1, cuotas, revocación,
`undo`), una búsqueda de secretos y de código privado, las licencias de terceros y que nada dependa de rutas de fuera
de este repositorio. No hace falta ningún servicio de CI.

## Privacidad

Sin telemetría. La CLI, el SDK y el simulador no llaman a casa; en modo demo el SDK solo habla con el simulador local.

## Licencia

Apache-2.0 para el código de este repositorio (ver [LICENSE](../../LICENSE) y [NOTICE](../../NOTICE)). Los paquetes de
terceros conservan sus licencias ([THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md)). El nombre LicenRoute no se
licencia. Informes de seguridad: [security.md](security.md).
