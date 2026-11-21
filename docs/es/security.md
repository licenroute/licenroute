# Política de seguridad

Versión en español de [SECURITY.md](../../SECURITY.md); en caso de duda, prevalece la inglesa.

## Alcance

Este repositorio es una **versión preliminar para desarrolladores en modo demo**: la CLI, el SDK de Express, el
simulador local y los ficheros para asistentes. No hay ningún servicio alojado de LicenRoute en el alcance, y nada de esto
está pensado todavía para credenciales reales ni tráfico de producción.

Dentro del alcance, por ejemplo:

- una forma de que la CLI escriba en un proyecto sin el reto de un solo uso tecleado en el terminal (en cualquier
  idioma: el idioma no debe cambiar nada de la aprobación);
- que la CLI lea o escriba fuera del proyecto y de su propio estado con el modelo de permisos de Node;
- secretos (también las credenciales de demo) mostrados por cualquier orden;
- que el simulador acepte conexiones de fuera de loopback o credenciales con formato real;
- que el SDK deje llegar una petición a una ruta con licencia sin una licencia válida, o que cobre un método que no se
  declaró;
- que el hook de Claude Code o de Cursor permita algo que su documentación dice que deniega (más allá del límite
  documentado de las órdenes ofuscadas), o que decida distinto según el idioma.

## Cómo informar

Informa de las vulnerabilidades **en privado** mediante «Report a vulnerability» de GitHub (informe privado de
vulnerabilidades) en este repositorio. No abras una incidencia pública. Incluye la versión (`./node_modules/.bin/licenroute --version`), tu
sistema operativo y versión de Node, y la reproducción más pequeña que puedas. Usa solo datos sintéticos.

Es una versión preliminar mantenida en la medida de lo posible: no hay recompensa por fallos ni tiempo de respuesta
garantizado.

## Verificar lo que ejecutas

- `npm run build` escribe `dist-packages/SHA256SUMS`; compáralo con las sumas publicadas con una versión.
- `npm run validate:distribution` reconstruye y vuelve a probar todo en local, incluida una búsqueda de secretos y de
  código privado, y la prueba de aceptación en inglés y en español.
- Instala con `--ignore-scripts`: ningún paquete de LicenRoute necesita scripts de instalación.
