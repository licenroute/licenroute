# Security policy

Spanish version: [docs/es/security.md](docs/es/security.md).

## Scope

This repository is a **developer preview in demo mode**: the CLI, the Express SDK, the local simulator and the
assistant files. There is no hosted LicenRoute service in scope, and none of this is meant to handle real credentials or
production traffic yet.

In scope, for example:

- a way to make the CLI write to a project without the one-time challenge typed on the terminal (in any language:
  the language must not change anything about approval);
- the CLI reading or writing outside the project and its own state under Node's permission model;
- secrets (including demo credentials) printed by any command;
- the simulator accepting connections from outside loopback or accepting real-format credentials;
- the SDK letting a request reach a licensed route without a valid licence, or charging a method that was not
  declared;
- the Claude Code or Cursor hook allowing something its documentation says it denies (beyond the documented limit on
  obfuscated commands), or deciding differently depending on the language.

## Reporting

Please report vulnerabilities **privately** through GitHub's "Report a vulnerability" (private vulnerability
reporting) on this repository. Do not open a public issue. Include the version (`./node_modules/.bin/licenroute --version`), your OS and
Node version, and the smallest reproduction you can. Use synthetic data only.

This is a preview maintained on a best-effort basis: there is no bug bounty and no guaranteed response time.

## Verifying what you run

- `npm run build` writes `dist-packages/SHA256SUMS`; compare it with the checksums published with a release.
- `npm run validate:distribution` rebuilds and re-tests everything locally, including a scan for secrets and private
  code, and the acceptance test in English and in Spanish.
- Install with `--ignore-scripts`: no LicenRoute package needs install scripts.
