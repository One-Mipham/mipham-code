#!/usr/bin/env bash
# Smoke-test the published npm package tarball the way a user would install it.
#
# Guards against the v0.39.0 regression: source tests were green but the npm
# package crashed on install because a workspace-only dependency (@mipham/shared)
# was referenced but never published. This script packs the tarball, installs it
# into a clean directory, then:
#   (1) resolves the full module graph with `bun build` — any missing import
#       fails here; and
#   (2) runs the binary through its `bin/mipham` shim (bun relaunch → --version)
#       — any startup failure fails here.
#
# Usage: scripts/smoke.sh [cli-dir]   (default: apps/cli)

set -euo pipefail

CLI_DIR="${1:-apps/cli}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ Packing @miphamai/cli from $CLI_DIR"
(cd "$CLI_DIR" && npm pack --pack-destination "$WORK" >/dev/null)
TARBALL="$(ls "$WORK"/*.tgz | head -1)"
echo "  tarball: $(basename "$TARBALL")"

echo "→ Installing into a clean directory"
cd "$WORK"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "$TARBALL" >/dev/null 2>&1

echo "→ Resolving full module graph (bun build)"
(cd "$WORK/node_modules/@miphamai/cli" &&
  bun build ./bin/mipham.ts --outfile "$WORK/out.js" --target=bun)

echo "→ Running bin shim --version"
(cd "$WORK" && ./node_modules/.bin/mipham --version)

echo "✓ npm package smoke test passed"
