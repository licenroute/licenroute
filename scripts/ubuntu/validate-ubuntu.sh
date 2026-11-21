#!/usr/bin/env bash
# Independent validation on Ubuntu 24.04 AMD64, on a machine you control, at no cost. It does not install anything
# system-wide, does not use Docker and does not need the private LicenRoute monorepo (the machine should not have it).
#   scripts/ubuntu/validate-ubuntu.sh            # from a clean clone of this repository, as a normal user
# Requirements: Node.js 24+ with npm (from nodejs.org, NodeSource or nvm, verified the usual way), git, util-linux
# `script`, coreutils. Network: the public npm registry for development dependencies.
# Output: validation-results/<timestamp>/ plus ubuntu-environment.txt with what the run really was (native,
# container, VM or emulated). Only a native or VM run on real x86_64 hardware counts as "Ubuntu 24.04 AMD64".
set -euo pipefail
cd "$(dirname "$0")/../.."
fail() { echo "validate-ubuntu: $*" >&2; exit 2; }

. /etc/os-release 2>/dev/null || fail "no /etc/os-release: not a Linux distribution"
[ "${ID:-}" = "ubuntu" ] && [ "${VERSION_ID:-}" = "24.04" ] || echo "WARNING: this is ${PRETTY_NAME:-unknown}, not Ubuntu 24.04; the result is recorded as such"
ARCH=$(uname -m)
[ "$ARCH" = "x86_64" ] || echo "WARNING: architecture $ARCH, not x86_64 (AMD64)"
[ "$(id -u)" != "0" ] || fail "run as a normal user (root bypasses the file-permission checks the tests rely on)"

# What kind of machine is this? Recorded, never guessed in the summary.
CONTAINER=$(systemd-detect-virt --container 2>/dev/null || true)
VM=$(systemd-detect-virt --vm 2>/dev/null || true)
if [ -z "$CONTAINER" ] || [ "$CONTAINER" = "none" ]; then
  if [ -f /.dockerenv ] || [ -f /run/.containerenv ]; then CONTAINER=yes; else CONTAINER=none; fi
fi
[ -n "$VM" ] || VM=unknown
EMULATED=no
[ -e /proc/sys/fs/binfmt_misc/qemu-x86_64 ] && EMULATED="possible (qemu-x86_64 binfmt handler present)"
[ "$ARCH" = "x86_64" ] || EMULATED="not x86_64"
if [ "$CONTAINER" = "none" ] && [ "$EMULATED" = "no" ]; then KIND="native or VM ($VM) on x86_64"; else KIND="container=$CONTAINER vm=$VM emulation=$EMULATED: NOT a clean native Ubuntu install"; fi

# Resources: refuse to start on an exhausted machine instead of failing halfway.
FREE_MB=$(df -Pm . | awk 'NR==2 {print $4}')
MEM_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
[ "${FREE_MB:-0}" -ge 1500 ] || fail "less than 1.5 GB free disk here (${FREE_MB} MB)"
[ "${MEM_MB:-0}" -ge 1500 ] || fail "less than 1.5 GB available memory (${MEM_MB} MB)"

for t in node npm git script sha256sum mkfifo tar bash; do command -v "$t" >/dev/null || fail "missing tool: $t"; done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail "Node 24+ required (found $(node -v))"

ENVFILE=$(mktemp)
{
  echo "date          $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "os            ${PRETTY_NAME:-?} (ID=${ID:-?} VERSION_ID=${VERSION_ID:-?})"
  echo "kernel        $(uname -srvm)"
  echo "arch          $ARCH"
  echo "cpu           $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ //')"
  echo "container     $CONTAINER"
  echo "vm            $VM"
  echo "emulation     $EMULATED"
  echo "kind          $KIND"
  echo "resources     ${FREE_MB} MB disk free · ${MEM_MB} MB memory available · $(nproc) CPUs"
  echo "node          $(node -v) · npm $(npm -v) · $(git --version)"
  echo "commit        $(git rev-parse HEAD 2>/dev/null || echo 'not a git checkout')"
} | tee "$ENVFILE"

npm ci --ignore-scripts --no-audit --no-fund
set +e
npm run validate:distribution -- --skip-install
status=$?
set -e
latest=$(ls -1d validation-results/*/ | tail -1)
cp "$ENVFILE" "$latest/ubuntu-environment.txt" && rm -f "$ENVFILE"
echo "Results: $latest (attach summary.txt and ubuntu-environment.txt to the report)"
exit $status
