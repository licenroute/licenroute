# LicenRoute — licence keys, quotas and revocation for your Express API (developer preview)

> **Developer preview. Demo mode only.** Everything in this repository runs on your machine against a **local
> simulator** with **synthetic credentials**. There is no hosted LicenRoute service behind it, it does **not** charge
> money, process payments or protect anything in production, and it must not be used with real credentials. Test
> results are `SIMULATED PASS`, never a security certification.
>
> Messages in English (default) or Spanish: `--lang es` or `LICENROUTE_LANG=es`. **Documentación en español:
> [docs/es/README.md](docs/es/README.md).**

LicenRoute puts **paid or metered access in front of selected routes of an existing Express API**: a request to a
licensed route without a valid licence gets `402`, an invented or revoked licence gets `403`, and a licence that runs
out of quota stops being served — while your public routes, health checks, login and your own authenticated writes
keep working exactly as before.

It is built to be integrated **by you or by your coding assistant (Claude Code, Cursor) without giving up control**:
the CLI reads your code without running it, proposes plans, shows the exact diff, and writes nothing until a person
types a one-time challenge in their own terminal. `licenroute undo` reverts it exactly.

## What is in this repository

| Path | What it is |
|---|---|
| `packages/cli` | `@licenroute/cli` 0.3.1 — the `licenroute` command (TypeScript source) |
| `sdks/node-express` | `@licenroute/connect-express` 0.8.0 — Express 4/5 middleware (TypeScript source) |
| `packages/simulator` | local decision simulator for demo mode (bundled into the CLI package) |
| `packages/policy-contracts` | schemas, route matching and canonical JSON shared by the SDK and the simulator (bundled) |
| `integrations/assistants` | Claude Code Skill + approval hook, and Cursor rules + hook |
| `examples/express-demo` | a small Express API to try it on |
| `docs/` | [tutorial](docs/tutorial-express.md), [assistants](docs/assistants.md), [limitations](docs/limitations.md), [uninstall](docs/uninstall.md), [languages](docs/i18n.md) · in Spanish: [docs/es/](docs/es/README.md) |
| `scripts/validate-distribution.mjs` | the full local validation (`npm run validate:distribution`) |

LicenRoute Central (the hosted service that would issue real licences and enforce real quotas) is proprietary and is
**not** part of this repository.

## Try it in 5 minutes

Requirements: Node.js 24 or later with npm, git, and (Linux) `script` from util-linux. No Docker, no account.

```bash
git clone https://github.com/licenroute/licenroute.git licenroute && cd licenroute
npm ci --ignore-scripts          # dev dependencies from the public npm registry
npm run build                    # dist-packages/licenroute-cli-0.3.1.tgz and licenroute-connect-express-0.8.0.tgz
./demo/demo.sh                   # read-only: copies the example API, shows the plans and the exact diff
```

Then follow the [tutorial](docs/tutorial-express.md) to write the integration (you type the challenge), start the
simulator and your app with `licenroute dev`, and run `licenroute test`:

```text
SIMULATED PASS api-informes:sin-licencia /api/informes: 402 payment_required
SIMULATED PASS api-informes:licencia-valida: 200
SIMULATED PASS api-informes:licencia-inventada: 403 forbidden
SIMULATED PASS api-informes:cuota: GET 200 · HEAD 200 · GET 200 · HEAD 402 (quota 3)
SIMULATED PASS api-informes:revocada: before 200 · after 403 forbidden
SIMULATED PASS central-caido:api-informes: /api/informes 503 service_unavailable · /api/informes/:id 503 service_unavailable · HEAD /api/informes 503
SIMULATED PASS: the integration responds as expected against the SIMULATOR. It does not certify the security of Central or any real charge.
```

The Spanish words above are fixed identifiers, not untranslated messages: the example API's routes and plan names
(`/api/informes` = reports, `api-informes`) and the check ids (`sin-licencia` = no licence, `licencia-valida` = valid
licence, `licencia-inventada` = invented licence, `cuota` = quota, `revocada` = revoked, `central-caido` = decision
service down). They are the same in every language ([docs/i18n.md](docs/i18n.md)).

## Adding licences and quotas to your own Express API

```bash
cd your-api
npm install --save-dev --ignore-scripts <licenroute>/dist-packages/licenroute-cli-0.3.1.tgz
npm install --ignore-scripts <licenroute>/dist-packages/licenroute-connect-express-0.8.0.tgz
npm ls @licenroute/cli                    # must list the package you just installed
./node_modules/.bin/licenroute init .                      # numbered plans; routes it will never touch; routes left to you
./node_modules/.bin/licenroute init . --plans 1 --app your-api          # full diff preview, writes nothing
./node_modules/.bin/licenroute init . --plans 1 --app your-api --write --approve apr_…   # you type the challenge shown on your terminal
./node_modules/.bin/licenroute dev . --start-app           # simulator + your app (asks before running `node <entry>`)
./node_modules/.bin/licenroute test .                      # in a second terminal
./node_modules/.bin/licenroute undo .                      # exact revert whenever you want
```

Run LicenRoute from the project where you installed it, as `./node_modules/.bin/licenroute …`, after checking that it is the
package you built (`npm ls @licenroute/cli`). **Never use `npx licenroute`**: on npm the unscoped name `licenroute` is not this
package (anyone may publish under it), and `npx` downloads and runs a package that is not installed (outside an interactive terminal, without asking).

The inserted middleware declares each paid route **with its methods** (`{ path: "/api/reports/**", methods: ["GET",
"HEAD"] }`), so a `POST` under the same prefix that has its own authentication is left alone. Plans that would cover a
route with its own authentication are not proposed; they are listed for your decision.

## Claude Code and Cursor

`./node_modules/.bin/licenroute assistant . --claude-code` (or `--cursor`) installs a Skill (or rules) that teaches the assistant when
LicenRoute is and is not the right tool and the safe flow `detect → plan → preview → your approval → test → undo`, plus a
hook that makes the assistant ask you before any LicenRoute write and blocks it from reading `.env*` files or setting
approval shortcuts. The assistant can prepare everything, but it must never type the challenge for you: the CLI asks
for it on your terminal, and it proves that someone typed it there, not who. Details:
[docs/assistants.md](docs/assistants.md).

## What works in this preview

- Express 4 and 5, JavaScript and TypeScript, ESM and CommonJS, routers mounted with `app.use`.
- Static analysis without running your code; detection of health, login, public and existing authenticated routes.
- Plans per route prefix, licences per HTTP method (`GET` + `HEAD`), `OPTIONS` never charged.
- Approval bound to the exact diff + a one-time challenge on `/dev/tty`; Node permission model as a second barrier.
- Local simulator: licences, quotas, revocation, another plan's licence, invented licences, outage and recovery.
- Exact `undo` that never overwrites later changes.

## Limits of demo mode

- The simulator listens on loopback only and accepts only its own synthetic credentials (`bg_dev_…`); real-format
  credentials are refused (`503`) and never printed.
- `SIMULATED PASS` checks your integration against the simulator, not against a real service.
- Writes with side effects (e.g. `POST`) are checked in your code and in the simulator's decision, but `licenroute test`
  never sends them to your app.
- Approvals prove that someone typed the challenge on the terminal, not who was at the keyboard.

## Not ready for production

- There is no hosted service: no real licences, quotas, billing or payments.
- Not reviewed for production traffic or real credentials; no security audit yet.
- Rails is out of scope: `licenroute detect` and `licenroute plan` can analyse a Rails app read-only, but `init` and `apply` refuse to write an integration (the Rails SDK is not part of this repository).
- Platforms: see [docs/limitations.md](docs/limitations.md#platforms-and-languages). Windows is not tested.
- Package names under `@licenroute` are provisional and **not published** on npm.

Full list: [docs/limitations.md](docs/limitations.md).

## Validate it yourself

```bash
npm run validate:distribution     # exit code ≠ 0 on any failure; results in validation-results/
```

It checks package integrity, typecheck and build, the CLI, SDK, simulator, contracts and assistant tests, an
end-to-end run on the example Express API (existing authentication, HTTP methods and the F-D4-1 regression, quotas,
revocation, `undo`), a scan for secrets and private code, the third-party licences and that nothing depends on paths
outside this repository. No CI service is required.

## Languages

English by default, Spanish on request (`--lang es`, `LICENROUTE_LANG=es` or a Spanish system locale). The language only
changes the text people read: `--json` output, approval codes, the code written into your project, check ids and
behaviour are identical in both. See [docs/i18n.md](docs/i18n.md).

## Privacy

No telemetry. The CLI, SDK and simulator do not phone home; in demo mode the SDK only talks to the local simulator.

## License

Apache-2.0 for the code in this repository (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Third-party packages keep
their own licences ([THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)). The LicenRoute name is not licensed.
Security reports: [SECURITY.md](SECURITY.md).
