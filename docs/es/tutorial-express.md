# Tutorial: licencias y cuotas en una API Express, de principio a fin (modo demo)

Tiempo: unos 10 minutos. Todo se ejecuta en local contra el simulador de LicenRoute con credenciales sintéticas. No se
cobra nada y nada sale de tu máquina. Los mensajes de la CLI salen en español con `LICENROUTE_LANG=es` (o `--lang es`, o un
locale del sistema en español); sin eso, en inglés ([tutorial en inglés](../tutorial-express.md)).

Necesitas Node.js 24+, npm y git. Ejecuta las órdenes **tú, en un terminal de verdad**: dos pasos te piden teclear un
reto que solo aparece allí.

## 1. Construye los paquetes

```bash
cd licenroute                       # este repositorio
npm ci --ignore-scripts
npm run build
cat dist-packages/SHA256SUMS     # los dos .tgz que vas a instalar
B=$(pwd)/dist-packages
export LICENROUTE_LANG=es           # mensajes en español en el resto del tutorial
```

## 2. Copia la API de ejemplo e instala LicenRoute en ella

```bash
cp -R examples/express-demo /tmp/mi-api && cd /tmp/mi-api
git init -q && git add -A && git commit -qm "antes de LicenRoute"     # para ver cada cambio que haga LicenRoute
npm install --ignore-scripts
npm install --save-dev --ignore-scripts "$B/licenroute-cli-0.3.1.tgz"
npm install --ignore-scripts "$B/licenroute-connect-express-0.8.0.tgz"
npm ls @licenroute/cli          # debe listar el paquete que acabas de instalar
```

`--ignore-scripts` es deliberado: ningún script de paquete necesita ejecutarse para LicenRoute.

Ejecuta LicenRoute desde el proyecto donde lo instalaste, como `./node_modules/.bin/licenroute …`, después de comprobar que es el
paquete que construiste (`npm ls @licenroute/cli`). **Nunca uses `npx licenroute`**: en npm el nombre sin ámbito `licenroute` no es
este paquete (cualquiera puede publicar con él), y `npx` descarga y ejecuta un paquete que no está instalado (fuera de un terminal interactivo, sin preguntar).

## 3. Mira los planes propuestos (solo lectura)

```bash
./node_modules/.bin/licenroute init .
```

```text
LicenRoute init — express 5.3.0 · app «demo-express» (cámbiala con --app)
  SDK: declarado en package.json (file:…/licenroute-connect-express-0.8.0.tgz)

Planes propuestos (elige con --plans 1,2 o por nombre):
   1  api-catalogo             /api/catalogo/**             GET /api/catalogo
   2  api-informes             /api/informes/**             GET /api/informes, GET /api/informes/:id
      licencia solo en GET, HEAD; otros métodos en esas rutas (p. ej. POST) siguen como hasta ahora

No se tocan (públicas, salud, estáticos o login):
      GET /health (server.js:5) — comprobación de salud: debe responder aunque LicenRoute no esté disponible
      POST /login (server.js:7) — autenticación (login, sesión, OAuth, contraseñas): protegerla con licencias bloquearía el acceso a tu propia app

Requieren tu decisión (init no las propone; intégralas a mano si quieres):
      GET / (server.js:6) — página de inicio: normalmente pública
      POST /api/pedidos (server.js:11) — escritura: suele requerir autenticación de usuario, no una licencia comercial; decide tú

Siguiente: licenroute init . --plans 1,2   (vista previa; no escribe)
```

LicenRoute nunca propone comprobaciones de salud, login ni escrituras; las enumera para que decidas tú.

## 4. Vista previa del diff exacto (sigue sin escribir)

```bash
./node_modules/.bin/licenroute init . --plans 1,2 --app mi-api
```

La salida es el diff completo de `server.js` y `.gitignore`, y termina así:

```text
Nada se ha escrito. Código de este diff: apr_…. Para escribir EXACTAMENTE este diff, ejecuta tú en tu terminal:
  licenroute init . --plans api-catalogo,api-informes --app mi-api --write --approve apr_…
Para escribir, LicenRoute pide una confirmación humana en tu terminal: tecleas un reto que solo aparece allí. Ninguna variable de entorno ni ningún código de aprobación lo sustituye, y ningún asistente debe teclearlo por ti. Muestra que alguien lo tecleó en ese terminal, no quién.
```

El código `apr_…` está ligado a este diff exacto: si cambia cualquier fichero, el código deja de valer. Es el mismo en
los dos idiomas.

## 5. Escríbelo — tecleas tú el reto

```bash
./node_modules/.bin/licenroute init . --plans 1,2 --app mi-api --write --approve apr_…   # el código del paso 4
```

```text
LicenRoute va a escribir:
  modificar server.js
  modificar .gitignore
  planes: /api/catalogo/**, /api/informes/**
  código: apr_…
Si lo apruebas, escribe 5QPE-95MJ y pulsa Intro (cualquier otra cosa cancela): 5QPE-95MJ
Aprobación confirmada.
LicenRoute apply — aplicado (server.js, .gitignore). Diario: .licenroute/journal/….json
Confirmación: una persona tecleó el reto en el terminal (no prueba quién estaba al teclado)
```

`git diff` muestra ahora el middleware en `server.js`, con una entrada por plan en `licensedPaths`, p. ej.
`{ path: "/api/informes/**", methods: ["GET", "HEAD"] }`. El código que escribe LicenRoute va en inglés sea cual sea el
idioma de los mensajes, así que el diff que apruebas es el mismo en los dos.

## 6. Arranca el simulador y tu app

```bash
./node_modules/.bin/licenroute dev . --start-app
```

Enseña el comando exacto que va a ejecutar (`node --permission … server.js`, nunca un script de npm) y pide un reto
nuevo. Después muestra `MODO DEMO · SIMULACIÓN LOCAL`, la URL del simulador (solo loopback) y la de tu app. Las
credenciales sintéticas de esta sesión se escriben en `.env.licenroute` (permisos 0600, ignorado por git) y nunca se
muestran.

## 7. Prueba la integración (segundo terminal)

```bash
cd /tmp/mi-api && LICENROUTE_LANG=es ./node_modules/.bin/licenroute test .
```

```text
MODO DEMO · SIMULACIÓN LOCAL · no es una prueba de seguridad
SIMULATED PASS api-informes:sin-licencia /api/informes: 402 payment_required
SIMULATED PASS api-informes:licencia-valida: 200
SIMULATED PASS api-informes:options-sin-cobro: 200
SIMULATED PASS api-informes:licencia-de-otro-plan: 402 payment_required
SIMULATED PASS api-informes:licencia-inventada: 403 forbidden
SIMULATED PASS api-informes:cuota: GET 200 · HEAD 200 · GET 200 · HEAD 402 (cuota 3)
SIMULATED PASS api-informes:revocada: antes 200 · después 403 forbidden
SIMULATED PASS publica /health: 200
SIMULATED PASS central-caido:api-informes: /api/informes 503 service_unavailable · /api/informes/:id 503 service_unavailable · HEAD /api/informes 503
SIMULATED PASS central-caido:publica /health: 200
SIMULATED PASS central-recuperado: /api/catalogo/** 200 · /api/informes/** 200
SIMULATED PASS: la integración responde como se espera contra el SIMULADOR. No certifica la seguridad de Central ni ningún cobro real.
```

Qué se comprobó: sin licencia → `402`; licencia válida → `200`; `OPTIONS` nunca se cobra; licencia inventada → `403`;
la cuota de 3 la comparten `GET` y `HEAD` y la 4.ª petición recibe `402`; una licencia revocada → `403`; las rutas
públicas siguen abiertas; con el servicio de decisiones caído, las rutas de pago se cierran (`503`) y las públicas siguen
respondiendo; se recupera cuando vuelve el servicio. Los ids de las comprobaciones (`api-informes:licencia-valida`…) son
los mismos en los dos idiomas.

`./node_modules/.bin/licenroute env .` y `./node_modules/.bin/licenroute doctor .` muestran el estado y el diagnóstico sin mostrar ningún secreto.

## 8. Para y deshaz

```bash
./node_modules/.bin/licenroute dev . --stop
./node_modules/.bin/licenroute undo .
git status
```

`undo` restaura `server.js` y `.gitignore` byte a byte y te dice qué dejó para que decidas tú (el fichero
`.env.licenroute` y la dependencia del SDK que instalaste con npm). Ver [uninstall.md](uninstall.md).

## Con un asistente

`./node_modules/.bin/licenroute assistant . --claude-code` (o `--cursor`) instala la Skill o las reglas en español (con
`LICENROUTE_LANG=es`), con un reto. El asistente puede ejecutar por ti los pasos 3, 4, 6 y 7 y enseñarte el diff; los
pasos 5 y 6 siguen necesitando que teclees tú el reto en tu terminal. Ver [assistants.md](assistants.md).
