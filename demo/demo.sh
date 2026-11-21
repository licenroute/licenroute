#!/usr/bin/env bash
# Read-only demo: copies the example API to a temporary directory, installs the packages built from this repository
# (npm run build) and shows the plans and the exact diff. It never writes the integration: that step needs YOUR
# challenge (see docs/tutorial-express.md). No private service, no network for LicenRoute, synthetic data only.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo "Node 24+ required"; exit 2; }
CLI=$(ls "$ROOT"/dist-packages/*-cli-*.tgz 2>/dev/null | head -1 || true)
SDK=$(ls "$ROOT"/dist-packages/*-connect-express-*.tgz 2>/dev/null | head -1 || true)
[ -n "$CLI" ] && [ -n "$SDK" ] || { echo "Run 'npm run build' first (dist-packages/ is empty)"; exit 2; }
(cd "$ROOT/dist-packages" && if command -v sha256sum >/dev/null; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi)
W=$(mktemp -d "${TMPDIR:-/tmp}/licenroute-demo-XXXXXX")
cp -R "$ROOT/examples/express-demo" "$W/my-api"
cd "$W/my-api"
git init -q && git add -A && git -c user.email=demo@example.invalid -c user.name=demo commit -qm "before LicenRoute"
npm install --ignore-scripts --no-audit --no-fund --save-dev "$CLI" >/dev/null
npm install --ignore-scripts --no-audit --no-fund "$SDK" >/dev/null
# Only the binary of the package installed above, never npx: the unscoped `licenroute` on npm is not this package (anyone may publish under it), and
# npx would download and run it if the install had failed.
BG=./node_modules/.bin/licenroute
npm ls @licenroute/cli --depth=0 >/dev/null 2>&1 && [ -x "$BG" ] || { echo "the LicenRoute CLI is not installed in $W/my-api: stopping"; exit 2; }
echo "== $BG init .   (read-only: plans)"; "$BG" init .
echo; echo "== $BG init . --plans api-informes --app my-api   (read-only: the exact diff)"
"$BG" init . --plans api-informes --app my-api
git diff --quiet -- server.js .gitignore && echo && echo "Nothing was written (git diff is empty)."
echo; echo "Demo project: $W/my-api"
echo "Next, yourself, in that directory: run the --write command printed above (you type the challenge),"
echo "then '$BG dev . --start-app' and, in a second terminal, '$BG test .'. Remove it with: rm -rf \"$W\""
