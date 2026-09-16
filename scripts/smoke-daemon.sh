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
HOME_ISOLATED=0

# PATH used for *invoking the artifact* only. Stripping it around the whole
# script would break the compile step, and a compile failure (127) would then
# be misread as "the fix didn't land" — the one judgement this script exists to
# make, decided by the wrong evidence. The compile step always keeps the
# ambient PATH: `bun build` needs bun, the artifact must not.
RUN_PATH="${RUN_PATH:-$PATH}"
run_cli() { env PATH="$RUN_PATH" "$WORK/mipham" "$@"; }

# Bound on how long teardown waits for the daemon to finish exiting — see the
# cleanup() comment. Small on purpose: this only covers the gap between "SIGTERM
# delivered" and "pid file unlinked", which is process shutdown, not a timeout
# for a healthy daemon to do anything else.
EXIT_WAIT_TRIES=10
EXIT_WAIT_INTERVAL=0.2

# Teardown stops the daemon *before* deleting its HOME. The daemon's pid/port/db
# files all live under $WORK/home and its cwd is $WORK/task, so `rm -rf $WORK`
# under a live process deletes the state out from under it and leaves it holding
# port 45671 with nothing on disk left to find it by. What reaches that is any
# `set -e` abort after a start: the daemon is up, a later step fails, and this
# trap runs with the daemon still alive. (The FAIL path further down is *not* an
# instance — its `exit 1` reaches this same trap, whose `stop` succeeds, so
# nothing is left listening. Latent on that path is the opposite hazard, a probe
# misreading a live daemon as stopped; see the `grep -q` note below. Latent
# today, not observed.)
#
# The delete is gated on *proved not running*, never on "we tried": `daemon stop`
# can fail while the daemon lives on, and `|| true` is exactly what hides that.
# So: stop (best effort) → ask status → only if it no longer says running is
# $WORK deleted. When it does still say running, $WORK is *kept* and its path
# printed, so a live orphan's state stays findable on disk instead of being
# destroyed. The `exit` in that branch is load-bearing, not merely a status
# choice: `rm -rf` sits *after* the `case`, so deleting the `exit` falls straight
# through to it — same WARN text, $WORK gone while the daemon's pid is still
# listening (measured; the exit *status* in that variant depends on how the trap
# was reached, the deletion does not). Where the script body ran to completion,
# that `exit` is *also* the only thing keeping the status non-zero: the trap's own
# return value becomes the script's, and the fall-through ends on a succeeding
# `rm -rf`. The clean-success path takes neither branch and still exits 0.
#
# The status question is a *bounded wait*, not a one-shot probe: `daemon stop`
# returns as soon as it has signalled, so the daemon's shutdown (unlink pid/port,
# close sqlite) can still be in flight, and a single immediate probe would read
# "still running" on a perfectly healthy run — turning the WARN below into a red
# gate that lies. Retry up to EXIT_WAIT_TRIES times, EXIT_WAIT_INTERVAL apart,
# before concluding it is genuinely still running.
#
# Status output is captured, not piped into `grep -q`: `grep -q` exits on its
# first match, and `set -o pipefail` turns a producer's SIGPIPE into a non-zero
# pipeline — under `if` that reads as "no match", i.e. a live daemon as stopped,
# i.e. exactly the delete being prevented. The hazard belongs to any producer
# still writing when the reader exits, not to `daemon status` specifically: the
# 141 was measured on a synthetic slow producer. The real status does not
# exercise it today — its four short lines are all in the pipe before `grep -q`
# exits, so no write ever sees EPIPE (measured rc=0, repeatedly) — but that is a
# timing property, and capturing the output does not depend on it.
#
# Guarded on HOME_ISOLATED: before HOME is redirected, `daemon stop` and
# `daemon status` would both read the *developer's* real ~/.mipham/daemon.pid.
cleanup() {
  if [ "$HOME_ISOLATED" = 1 ]; then
    run_cli daemon stop >/dev/null 2>&1 || true
    tries=0
    while :; do
      status_out="$(run_cli daemon status 2>/dev/null || true)"
      case "$status_out" in
        *'Daemon: running'*) ;;
        *) break ;;
      esac
      tries=$((tries + 1))
      if [ "$tries" -ge "$EXIT_WAIT_TRIES" ]; then
        echo "✗ WARN: daemon is still running — keeping $WORK so its state stays findable"
        exit 1
      fi
      sleep "$EXIT_WAIT_INTERVAL"
    done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "→ Compiling the CLI into $WORK"
(cd "$CLI_DIR" &&
  bun run scripts/generate-bundled-skills.ts >/dev/null &&
  bun build --compile --minify ./bin/mipham.ts --outfile "$WORK/mipham")

# Isolate HOME: the daemon writes ~/.mipham/{daemon.pid,daemon.port,daemon.db}.
# Never touch the developer's real daemon state.
export HOME="$WORK/home"
mkdir -p "$HOME"
# From here on a `daemon stop` in the EXIT trap can only reach the isolated daemon.
HOME_ISOLATED=1

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
