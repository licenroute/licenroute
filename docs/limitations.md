# Limitations of the developer preview

## Demo mode

- **Simulator, not a service.** `licenroute dev` starts a local simulator (loopback only) that issues synthetic
  credentials for one session. `SIMULATED PASS` means your integration answers as expected against that simulator;
  it is not a verification against a real service and not a security certification.
- **Synthetic credentials only.** Real-format API keys (`bg_live_…`, `bg_test_…`) are refused by the simulator
  (`503`), flagged by `licenroute env` as mixed credentials and never printed. Do not put real secrets in a demo project.
- **Writes are not exercised against your app.** For methods with side effects, `licenroute test` checks the declaration
  in your code and the simulator's decision, but never sends the request to your app.
- **Approval.** The challenge proves that someone typed it on the controlling terminal, not who it was or that they
  read the diff. The hook for Claude Code and Cursor is a convenience; the real barrier is the CLI.
- **Installing the CLI.** The hook denies running `licenroute` through package runners that download from the registry,
  but it does **not** block `npm install licenroute`: the unscoped name on npm is not this package and anyone may publish
  under it. Install only from the local packages you built and verified (`dist-packages/*.tgz` checked against
  `SHA256SUMS`), as the tutorial shows.
- **Heuristics.** Detection of existing authentication is static and heuristic. A login scheme LicenRoute does not
  recognise does not stop a plan from being proposed: always read the "Need your decision" list and the diff.
  Overlaps with parameter routes at the root (e.g. `/:a/:b`) are not considered when looking for conflicts.
- **Known rejected shapes.** An app created by a factory function (instead of `const app = express()` at top level)
  is refused without writing anything; integrate it by hand.

## Not ready for production

- No hosted service: no real licences, quotas, billing or payment collection. LicenRoute does not charge money.
- No production hardening review and no external security audit yet.
- The SDK includes options for the hosted service (policy sync, attestations, identity pseudonyms). They are unit
  tested but there is no public endpoint for them.
- Integrations written with older internal builds (licences declared as plain strings) charge every method;
  `licenroute test` reports them as a failure. Redo them with `undo` + `init`.

## Platforms and languages

- Node.js 24 or later (the CLI uses Node's permission model). The SDK itself supports Node 20+.
- Validation status of this repository (`npm run validate:distribution`, Node.js 24):
  - macOS on Apple silicon (arm64): passes with CLI 0.3.3.
  - Ubuntu 24.04 x86_64 on a full virtual machine (not a container): passed with CLI 0.3.1; not repeated with 0.3.2 or 0.3.3.
  - Ubuntu 24.04 arm64 in a container: passed with CLI 0.3.0; not repeated since.
  - x86_64 under emulation (Rosetta on Apple silicon): one internal test of Node's permission model fails. It does not
    fail on real x86_64.
  - Windows: not tested.
  - Not tested against a production LicenRoute service: everything runs in demo mode.
  - Run it yourself on Ubuntu with `scripts/ubuntu/validate-ubuntu.sh`, which records whether the machine is native, a
    virtual machine, a container or emulated.
- Rails is out of scope: `licenroute detect` and `licenroute plan` can analyse a Rails app read-only, but `init` and `apply` refuse to write an integration (the Rails SDK is not part of this repository).
- Languages: English (default) and Spanish for the CLI, the SDK messages, the Skill and the Cursor rules
  ([i18n.md](i18n.md)). `--json` output is always English.

## Names

`@licenroute/cli` and `@licenroute/connect-express` are published on npm (CLI 0.3.3 and SDK 0.8.1 onwards). The unscoped name
`licenroute` on npm is not this project.
