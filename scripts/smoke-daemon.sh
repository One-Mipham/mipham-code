#!/usr/bin/env bash
# Guard the class of bug that unit tests structurally cannot catch: source tests
# were green while `daemon start` in the *compiled binary* reported success and
# started nothing (spawn('bun', ...) + a $bunfs script path).
#
# Usage: scripts/smoke-daemon.sh [cli-dir]   (default: apps/cli)
#        RUN_PATH=/usr/bin:/bin scripts/smoke-daemon.sh apps/cli
#          → invoke the artifact with bun off PATH (the container user's world)

set -euo pipefail

CLI_DIR="${1:-apps/cli}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# PATH used for *invoking the artifact* only. Stripping it around the whole
# script would break the compile step, and a compile failure (127) would then
# be misread as "the fix didn't land" — the one judgement this script exists to
# make, decided by the wrong evidence. The compile step always keeps the
# ambient PATH: `bun build` needs bun, the artifact must not.
RUN_PATH="${RUN_PATH:-$PATH}"
run_cli() { env PATH="$RUN_PATH" "$WORK/mipham" "$@"; }

echo "→ Compiling the CLI into $WORK"
(cd "$CLI_DIR" &&
  bun run scripts/generate-bundled-skills.ts >/dev/null &&
  bun build --compile --minify ./bin/mipham.ts --outfile "$WORK/mipham")

# Isolate HOME: the daemon writes ~/.mipham/{daemon.pid,daemon.port,daemon.db}.
# Never touch the developer's real daemon state.
export HOME="$WORK/home"
mkdir -p "$HOME"

# Run from a dedicated directory: cwd is contract, not incidental — the daemon
# uses it as its path allowlist root.
TASK_DIR="$WORK/task"
mkdir -p "$TASK_DIR"
cd "$TASK_DIR"

echo "→ daemon start (compiled binary, PATH=$RUN_PATH)"
run_cli daemon start

echo "→ daemon status"
if ! run_cli daemon status | grep -q 'Daemon: running'; then
  echo "✗ FAIL: daemon start returned success but status is not running"
  exit 1
fi

echo "→ daemon stop"
run_cli daemon stop

echo "✓ compiled-binary daemon smoke test passed"
