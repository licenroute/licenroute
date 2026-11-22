# Tutorial: licences and quotas on an Express API, end to end (demo mode)

Time: about 10 minutes. Everything runs locally against the LicenRoute simulator with synthetic credentials. Nothing is
charged and nothing leaves your machine. The CLI speaks English by default (`--lang es` for Spanish; the
[Spanish tutorial](es/tutorial-express.md) shows the Spanish output).

You need Node.js 24+, npm and git. Run the commands **yourself, in a real terminal**: two steps ask you to type a
challenge that only appears there.

## 1. Build the packages

```bash
cd licenroute                       # this repository
npm ci --ignore-scripts
npm run build
cat dist-packages/SHA256SUMS     # the two .tgz files you will install
B=$(pwd)/dist-packages
```

## 2. Copy the example API and install LicenRoute into it

```bash
cp -R examples/express-demo /tmp/my-api && cd /tmp/my-api
git init -q && git add -A && git commit -qm "before LicenRoute"     # so you can see every change LicenRoute makes
npm install --ignore-scripts
npm install --save-dev --ignore-scripts "$B/licenroute-cli-0.3.3.tgz"
npm install --ignore-scripts "$B/licenroute-connect-express-0.8.1.tgz"
npm ls @licenroute/cli          # must list the package you just installed
```

`--ignore-scripts` is deliberate: no package script ever needs to run for LicenRoute.

Run LicenRoute from the project where you installed it, as `./node_modules/.bin/licenroute …`, after checking that it is the
package you built (`npm ls @licenroute/cli`). **Never use `npx licenroute`**: on npm the unscoped name `licenroute` is not this
package (anyone may publish under it), and `npx` downloads and runs a package that is not installed (outside an interactive terminal, without asking).

## 3. See the proposed plans (read-only)

```bash
./node_modules/.bin/licenroute init .
```

```text
LicenRoute init — express 5.3.0 · app "demo-express" (change it with --app)
  SDK: declared in package.json (file:…/licenroute-connect-express-0.8.1.tgz)

Proposed plans (choose with --plans 1,2 or by name):
   1  api-catalogo             /api/catalogo/**             GET /api/catalogo
   2  api-informes             /api/informes/**             GET /api/informes, GET /api/informes/:id
      licence only on GET, HEAD; other methods on those routes (e.g. POST) stay as they are now

Left untouched (public, health, static or login):
      GET /health (server.js:5) — health check: it must respond even if LicenRoute is unavailable
      POST /login (server.js:7) — authentication (login, session, OAuth, passwords): protecting it with licences would block access to your own app

Need your decision (init does not propose them; integrate them by hand if you want):
      GET / (server.js:6) — home page: usually public
      POST /api/pedidos (server.js:11) — write: usually needs user authentication, not a commercial licence; you decide

Next: licenroute init . --plans 1,2   (preview; does not write)
```

The example API's routes are Spanish words (`/api/catalogo` = catalogue, `/api/informes` = reports, `/api/pedidos` =
orders), so the proposed plan names are too. They are identifiers taken from your code, not untranslated messages.

LicenRoute never proposes health checks, login or writes; it lists them so you can decide.

## 4. Preview the exact diff (still read-only)

```bash
./node_modules/.bin/licenroute init . --plans 1,2 --app my-api
```

The output is the full diff of `server.js` and `.gitignore`, ending with:

```text
Nothing was written. Code of this diff: apr_…. To write EXACTLY this diff, run this yourself in your terminal:
  licenroute init . --plans api-catalogo,api-informes --app my-api --write --approve apr_…
To write, LicenRoute asks for a human confirmation in your terminal: you type a challenge that only appears there. No environment variable or approval code replaces it, and no assistant should type it for you. It shows that someone typed it in that terminal, not who.
```

The `apr_…` code is bound to this exact diff: if any file changes, the code no longer works.

## 5. Write it — you type the challenge

```bash
./node_modules/.bin/licenroute init . --plans 1,2 --app my-api --write --approve apr_…   # the code from step 4
```

```text
LicenRoute is going to write:
  modify server.js
  modify .gitignore
  plans: /api/catalogo/**, /api/informes/**
  code: apr_…
If you approve, type BHKW-R8A2 and press Enter (anything else cancels): BHKW-R8A2
Approval confirmed.
LicenRoute apply — applied (server.js, .gitignore). Journal: .licenroute/journal/….json
Confirmation: a person typed the challenge on the terminal (it does not prove who was at the keyboard)
```

`git diff` now shows the middleware in `server.js`, with one entry per plan in `licensedPaths`, e.g.
`{ path: "/api/informes/**", methods: ["GET", "HEAD"] }`. The code LicenRoute writes is in English whatever the language
of the messages, so the diff you approve is the same in both.

## 6. Start the simulator and your app

```bash
./node_modules/.bin/licenroute dev . --start-app
```

It shows the exact command it will run (`node --permission … server.js`, never an npm script) and asks for a new
challenge. Then it prints `DEMO MODE · LOCAL SIMULATION`, the simulator URL (loopback only) and your app URL. The
synthetic credentials for this session are written to `.env.licenroute` (mode 0600, git-ignored) and are never printed.

## 7. Test the integration (second terminal)

```bash
cd /tmp/my-api && ./node_modules/.bin/licenroute test .
```

```text
DEMO MODE · LOCAL SIMULATION · not a security test
SIMULATED PASS api-informes:sin-licencia /api/informes: 402 payment_required
SIMULATED PASS api-informes:licencia-valida: 200
SIMULATED PASS api-informes:options-sin-cobro: 200
SIMULATED PASS api-informes:licencia-de-otro-plan: 402 payment_required
SIMULATED PASS api-informes:licencia-inventada: 403 forbidden
SIMULATED PASS api-informes:cuota: GET 200 · HEAD 200 · GET 200 · HEAD 402 (quota 3)
SIMULATED PASS api-informes:revocada: before 200 · after 403 forbidden
SIMULATED PASS publica /health: 200
SIMULATED PASS central-caido:api-informes: /api/informes 503 service_unavailable · /api/informes/:id 503 service_unavailable · HEAD /api/informes 503
SIMULATED PASS central-caido:publica /health: 200
SIMULATED PASS central-recuperado: /api/catalogo/** 200 · /api/informes/** 200
SIMULATED PASS: the integration responds as expected against the SIMULATOR. It does not certify the security of Central or any real charge.
```

What was checked: no licence → `402`; valid licence → `200`; `OPTIONS` never charged; invented licence → `403`; the
quota of 3 is shared by `GET` and `HEAD` and the 4th request gets `402`; a revoked licence → `403`; public routes stay
open; when the decision service is down, paid routes fail closed (`503`) and public routes keep answering; it recovers
when the service is back.

The check ids are fixed identifiers, the same in every language, not untranslated messages ([i18n.md](i18n.md)):
`sin-licencia` = no licence, `licencia-valida` = valid licence, `options-sin-cobro` = OPTIONS not charged,
`licencia-de-otro-plan` = licence for another plan, `licencia-inventada` = invented licence, `cuota` = quota,
`revocada` = revoked, `publica` = public route, `central-caido` / `central-recuperado` = decision service down /
recovered.

`./node_modules/.bin/licenroute env .` and `./node_modules/.bin/licenroute doctor .` show the state and diagnostics without printing any secret.

## 8. Stop and undo

```bash
./node_modules/.bin/licenroute dev . --stop
./node_modules/.bin/licenroute undo .
git status
```

`undo` restores `server.js` and `.gitignore` byte for byte and tells you what it left for you to decide (the
`.env.licenroute` file and the SDK dependency you installed with npm). See [uninstall.md](uninstall.md).

## Using an assistant instead

`./node_modules/.bin/licenroute assistant . --claude-code` (or `--cursor`) installs the Skill or the rules, with a challenge. The
assistant can run steps 3, 4, 6 and 7 for you and show you the diff; steps 5 and 6 still need you to type the
challenge in your terminal. See [assistants.md](assistants.md).
