# @licenroute/cli — developer preview

> **Status: developer preview, demo mode only. Not published to npm.** Messages are in Spanish. Tests run against a
> local simulator with synthetic credentials; results are `SIMULATED PASS`, never a real verification.

The `licenroute` command analyses an Express 4/5 API (JavaScript or TypeScript) **without running its code**, proposes
which routes could require a licence and a quota, shows the exact diff, and writes it only after a person approves
it in their own terminal. Everything it writes can be reverted with `licenroute undo`.

| Command | What it does | Writes? |
|---|---|---|
| `detect`, `plan` | routes, existing authentication, proposed plans (JSON schemas in `schema/`) | no |
| `init` | numbered plans + full diff preview; `--write --approve apr_…` needs a one-time challenge typed on `/dev/tty` | only with the challenge |
| `apply` | the same write step with explicit flags | only with the challenge |
| `dev` | starts the local simulator (loopback only) and, with `--start-app`, your app under Node's permission model | `.env.licenroute`, `.licenroute/` |
| `env`, `doctor` | demo state and diagnostics; never print keys or tokens | no |
| `test` | licence, other plan, invented licence, quota, revocation, outage and recovery against the simulator | no |
| `assistant` | installs the Claude Code Skill or the Cursor rules (with the challenge) | only with the challenge |
| `undo` | exact revert of what was written; never overwrites later changes | yes (revert) |

## Safety model

- **No write without approval.** `--approve apr_…` binds the write to the diff you saw (hash of plan, files and
  methods). On top of that, a random challenge must be typed on the controlling terminal; an agent without that
  terminal cannot confirm. Nothing inside the project counts as approval. Since 0.2.4 the challenge is asked by the
  process that writes, so running the internal write phase directly does not skip it, and there is no test mode in
  this repository that writes without it (the test suite types the real challenge in a pseudo-terminal).
- **Second barrier:** each command runs under Node's permission model with read/write limited to what it needs.
- **No package scripts:** `licenroute dev --start-app` runs `node <entry>` directly and never `npm start`/`postinstall`.
- **Methods (0.2.3):** plans declare `GET` + `HEAD`; a plan is withheld if its pattern would also cover a route with
  its own authentication (fix for F-D4-1).
- **Express 4 and 5 only.** Rails is out of scope: `licenroute detect` and `licenroute plan` can analyse a Rails app read-only, but `init` and `apply` refuse to write an integration (the Rails SDK is not part of this repository).

## Source layout

`src/` (TypeScript, run directly by Node 24 in development; the published package runs on Node 22.13+), `bin/` (launchers), `schema/` (JSON schemas),
`scripts/pack.mjs` (bundles `dist/main.cjs` and the simulator into a self-contained tarball, with the licences of
the bundled TypeScript compiler and typebox), `test/` (vitest).

`src/live/sandbox-external.ts` and `sandbox-locator.json` describe an optional external sandbox controller used by the
hosted product; in this repository the locator is empty (`command: null`), so nothing is ever launched.

```bash
npm test -w @licenroute/cli          # unit + end-to-end tests (spawn the real CLI)
npm run pack -w @licenroute/cli      # packages/cli/.pack/licenroute-cli-<version>.tgz
```

License: Apache-2.0 (see `LICENSE` and `NOTICE` at the repository root).
