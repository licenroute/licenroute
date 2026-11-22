# Limitaciones de la versión preliminar

## Modo demo

- **Un simulador, no un servicio.** `licenroute dev` arranca un simulador local (solo en loopback) que emite credenciales
  sintéticas para una sesión. `SIMULATED PASS` significa que tu integración responde como se espera contra ese
  simulador; no es una verificación contra un servicio real ni una certificación de seguridad.
- **Solo credenciales sintéticas.** Las claves con formato real (`bg_live_…`, `bg_test_…`) las rechaza el simulador
  (`503`), `licenroute env` las señala como credenciales mezcladas y nunca se muestran. No pongas secretos reales en un
  proyecto de demo.
- **Las escrituras no se ejercitan contra tu app.** En los métodos con efectos (`POST`…), `licenroute test` comprueba la
  declaración en tu código y la decisión del simulador, pero nunca envía la petición a tu app.
- **Aprobación.** El reto prueba que alguien lo tecleó en el terminal de control, no quién fue ni que leyera el diff.
  El hook de Claude Code y Cursor es una ayuda; la barrera real es la CLI.
- **Instalar la CLI.** El hook deniega ejecutar `licenroute` con ejecutores de paquetes que descargan del registro, pero
  **no** bloquea `npm install licenroute`: en npm el nombre sin ámbito no es este paquete y cualquiera puede publicar con
  él.
  Instala solo desde los paquetes locales que construiste y verificaste (`dist-packages/*.tgz` comprobados con
  `SHA256SUMS`), como enseña el tutorial.
- **Heurísticas.** La detección de autenticación existente es estática y heurística. Un esquema de login que LicenRoute no
  reconozca no impide que se proponga un plan: lee siempre la lista «Requieren tu decisión» y el diff. Los solapes con
  rutas con parámetros en la raíz (p. ej. `/:a/:b`) no se tienen en cuenta al buscar conflictos.
- **Formas que se rechazan.** Una app creada por una función fábrica (en lugar de `const app = express()` en el nivel
  superior) se rechaza sin escribir nada; intégrala a mano.

## No está lista para producción

- No hay servicio alojado: ni licencias, cuotas, facturación ni cobros reales. LicenRoute no cobra dinero.
- Sin revisión de endurecimiento para producción y sin auditoría de seguridad externa todavía.
- El SDK incluye opciones para el servicio alojado (sincronización de políticas, atestaciones, seudónimos de
  identidad). Tienen pruebas unitarias, pero no hay ningún endpoint público para ellas.
- Las integraciones escritas con versiones internas antiguas (licencias declaradas como cadenas) cobran todos los
  métodos; `licenroute test` las da por fallo. Rehazlas con `undo` + `init`.

## Plataformas e idiomas

- Node.js 24 o posterior (la CLI usa el modelo de permisos de Node). El SDK por sí solo admite Node 20+.
- Estado de la validación de este repositorio (`npm run validate:distribution`, Node.js 24):
  - macOS en Apple silicon (arm64): pasa con la CLI 0.3.2.
  - Ubuntu 24.04 x86_64 en una máquina virtual completa (no un contenedor): pasó con la CLI 0.3.1; no se ha repetido con la 0.3.2.
  - Ubuntu 24.04 arm64 en un contenedor: pasó con la CLI 0.3.0; no se ha repetido después.
  - x86_64 emulado (Rosetta en Apple silicon): falla una prueba interna del modelo de permisos de Node. En x86_64 real
    no falla.
  - Windows: no probado.
  - No probado contra un servicio LicenRoute de producción: todo funciona en modo demo.
  - En Ubuntu puedes ejecutarla tú con `scripts/ubuntu/validate-ubuntu.sh`, que registra si la máquina es nativa, una
    máquina virtual, un contenedor o emulada.
- Rails queda fuera de alcance: `licenroute detect` y `licenroute plan` pueden analizar una app Rails en solo lectura, pero
  `init` y `apply` se niegan a escribir una integración (el SDK de Rails no forma parte de este repositorio).
- Idiomas: inglés (por defecto) y español para la CLI, los mensajes del SDK, la Skill y las reglas de Cursor
  ([i18n.md](i18n.md)). La salida `--json` va siempre en inglés.

## Nombres

`@licenroute/cli` y `@licenroute/connect-express` son nombres provisionales. No están publicados en npm y pueden cambiar
antes de cualquier versión.
