#!/usr/bin/env bash
# Reproduce one phase of the T2 benchmark run.
#
# Two network dependencies, deliberately kept apart:
#   * the dataset comes from github.com and needs a local proxy on this host —
#     the proxy is set on that one command, below, and nowhere else;
#   * the model runs inside the container against api.deepseek.com, which is
#     reachable from the mainland directly (measured: TLS 1.3, 0.96s). Harbor
#     never fetches the dataset during the run because we hand it -p <dir>.
set -euo pipefail

PHASE=""
FRESH=0
TASKS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --phase) [ $# -ge 2 ] || { echo "usage: $0 --phase 1|2 [--fresh] [--tasks-only]" >&2; exit 2; }; PHASE="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --tasks-only) TASKS_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$PHASE" in
  1) DATASET="terminal-bench@2.0";  DATASET_DIR_NAME="terminal-bench";     RULE="first";       N=10; EXEC_TIMEOUT=840  ;;
  2) DATASET="swebench-verified@1.0"; DATASET_DIR_NAME="swebench-verified"; RULE="first-repos"; N=10; EXEC_TIMEOUT=2940 ;;
  *) echo "usage: $0 --phase 1|2 [--fresh] [--tasks-only]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH="$REPO_ROOT/benchmarks"
DATASETS="$BENCH/.datasets"
# harbor builds the directory it writes as `jobs_dir / job_name`, so the name
# below is not a label -- it is half of a path, and the other half is -o. All
# three uses (the --job-name flag, the fail-closed precheck, the assembly root)
# read it from here so they cannot drift apart: two expressions that happen to
# spell the same path today would stop agreeing silently. Of the two failure
# directions, one is still quiet -- if these expressions ever stopped agreeing,
# the precheck would guard a directory nobody writes to, and nothing would ever
# say it had stopped protecting anything. That silence is why it has to be one
# expression. The other direction, the assembly reading a directory nobody
# wrote, is no longer silent in two shapes: a root that is not a directory, and
# a root holding no trial, each make the assembly exit non-zero and name the
# directory. One shape still slips through -- a root that exists and holds
# trials that are not this run's, e.g. the drifted parent, where both tests pass
# and the archive is written. Only the expressions agreeing prevents that one.
JOB_NAME="phase$PHASE"
JOBS="$BENCH/jobs/$JOB_NAME"
JOB_DIR="$JOBS/$JOB_NAME"
RESULTS="$BENCH/results"
DATASET_DIR="$DATASETS/$DATASET_DIR_NAME"
LEDGER="${MIPHAM_BENCH_LEDGER:-$RESULTS/ledger.json}"
PROXY="${MIPHAM_BENCH_PROXY:-http://127.0.0.1:7897}"
# Harbor's default agent_setup gate is 360 s. The in-container install path --
# apt-get (110 s) plus the 85 MB binary download (145 s) -- took 255 s end to
# end, 71% of the gate, and one trial has already been killed at exactly
# 360.0 s. Read 255 s as one measurement, not the expected cost: the same
# agent_setup step produced 125.3 s the same morning, so the spread across
# observations -- 125 s / 255 s / over 360 s -- straddles the gate.
# The gate is instrument boot time, not the task's own clock (that stays at
# task.toml's [agent] timeout_sec -- 900-12000 s across phase 1's ten tasks --
# untouched), so widening it makes measurement possible rather than making the
# benchmark easier. 3 is the only multiplier with a clean record -- the default
# gate is one for two (125.3 s through, 360.0 s killed), 3 is two for two (239.5 s,
# 249.2 s). An un-run value would leave the real run's gate unproven.
SETUP_TIMEOUT_MULT="${MIPHAM_BENCH_SETUP_TIMEOUT_MULT:-3}"

# The adapter imports harbor, so every Python here has to run under an
# interpreter that can import it. Find one instead of assuming.
PYTHON="${MIPHAM_BENCH_PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for candidate in python3 "$HOME/.local/share/uv/tools/harbor/bin/python"; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import harbor' >/dev/null 2>&1; then
      PYTHON="$candidate"; break
    fi
  done
fi
[ -n "$PYTHON" ] || { echo "no interpreter on this host can import harbor" >&2; exit 1; }
export PYTHONPATH="$REPO_ROOT${PYTHONPATH:+:$PYTHONPATH}"

echo "phase=$PHASE dataset=$DATASET runner=$PYTHON"

# ── 1. dataset (proxy here, and only here) ──────────────────────────────────
if [ ! -d "$DATASET_DIR" ]; then
  mkdir -p "$DATASETS"
  HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" \
    harbor datasets download "$DATASET" -o "$DATASETS"
fi

# ── 2. selection: recomputed from the download, asserted against the record ──
# Read the list through a file rather than `mapfile`: that builtin is bash 4+,
# and the bash on this host is 3.2.57. `set -e` still propagates the assertion.
SELECTION="$(mktemp)"
trap 'rm -f "$SELECTION"' EXIT
"$PYTHON" -m benchmarks.tasks \
  --dataset-dir "$DATASET_DIR" --rule "$RULE" --n "$N" --expect-recorded > "$SELECTION"
TASKS=()
while IFS= read -r task; do
  if [ -n "$task" ]; then TASKS+=("$task"); fi
done < "$SELECTION"
[ "${#TASKS[@]}" -eq "$N" ] || { echo "expected $N tasks, got ${#TASKS[@]}" >&2; exit 1; }
INCLUDE=()
for task in "${TASKS[@]}"; do INCLUDE+=(-i "$task"); done
printf 'tasks: %s\n' "${TASKS[*]:-}"

# ── 3. ledger ───────────────────────────────────────────────────────────────
if [ "$FRESH" -eq 1 ]; then
  "$PYTHON" -m benchmarks.budget --path "$LEDGER" init --ceiling "${MIPHAM_LEDGER_CEILING:-50505050}" --fresh
else
  "$PYTHON" -m benchmarks.budget --path "$LEDGER" init --ceiling "${MIPHAM_LEDGER_CEILING:-50505050}"
fi
"$PYTHON" -m benchmarks.budget --path "$LEDGER" show

# ── 4. the run ──────────────────────────────────────────────────────────────
if [ "$TASKS_ONLY" -eq 0 ]; then
  mkdir -p "$JOBS"

  # ── fail-closed: never run into a job directory that already exists ─────────
  # harbor writes to `jobs_dir / job_name` and mkdirs it with `exist_ok=True`
  # (harbor/job.py:113, :638), so a second run under the same --job-name lands in
  # the same directory as the first. harbor will not stop it: when the recorded
  # config matches, `Job.create` resumes the old job and the final result.json is
  # `self._existing_trial_results + trial_results` (harbor/job.py:1056) -- one
  # number covering two different moments. harbor does refuse some resumptions,
  # each on a named condition: a config.json that differs -- FileExistsError in
  # `_maybe_init_existing_job` (harbor/job.py:256); a trial config matching no
  # existing trial -- ValueError in `_init_remaining_trial_configs` (:363); a
  # lock.json that will not parse -- ValueError, "refusing to overwrite it"
  # (:904); or one that parses but differs -- FileExistsError in `_write_job_lock`
  # (:911). None of those is the case that does the damage -- with one
  # exception. Config equal and trials equal is exactly the case harbor lets
  # through *except* for lock.json, a gate of its own that compares task contents.
  # A plain repeated run is still let through.
  # (Read from harbor's source on 2026-09-17, not measured by running it: that
  # would mean starting containers. Fix B is written so this path is unreachable
  # either way, which is why we can leave it unmeasured.)
  # Those trials are money already spent (phase 1: 7.97M tokens), so this stops
  # and hands the decision back: move the directory aside or delete it by hand.
  # This script does neither -- it is in no position to judge which trials are
  # still wanted.
  if [ -e "$JOB_DIR" ]; then
    {
      echo "refusing to run: job directory already exists: $JOB_DIR"
      echo "  it holds:"
      shown=0
      for entry in "$JOB_DIR"/*; do
        [ -e "$entry" ] || continue
        echo "    ${entry##*/}"
        shown=$((shown + 1))
      done
      # The glob above never matches dotfiles, and an unmatched glob stays
      # literal (that is what the -e test is for, since dotglob/nullglob are
      # off -- bash 3.2.57 on this host). So an empty directory and one whose
      # every entry is hidden from this glob print the same nothing above, and
      # the reader cannot tell which of the two they are looking at. That is the
      # problem: this listing is what they decide on, and deleting an empty
      # directory is not the same act as deleting a non-empty one. Hence the
      # counter below -- say which case this is.
      if [ "$shown" -eq 0 ]; then
        hidden=0
        for entry in "$JOB_DIR"/.[!.]* "$JOB_DIR"/..?*; do
          [ -e "$entry" ] || continue
          hidden=$((hidden + 1))
        done
        if [ "$hidden" -eq 0 ]; then
          echo "    (nothing at all: the directory is empty)"
        else
          echo "    (no non-hidden entries; $hidden hidden one(s) exist but"
          echo "    are not listed above)"
        fi
      fi
      echo "  a run started here would be merged into it, and the assembly step"
      echo "  would then report both runs as one phase. Move it aside or delete"
      echo "  it by hand, then re-run."
      echo "  Harbor can also resume: when the recorded config matches it claims"
      echo "  the trials already there, runs only the missing ones, and folds the"
      echo "  new results into the same result.json. Whether to spend on that"
      echo "  resume or start the phase over is a person's decision, not this"
      echo "  script's -- and reaching that path means stepping around this gate"
      echo "  deliberately. This refusal is deliberate too."
    } >&2
    exit 1
  fi

  : "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set in the host environment}"
  # The adapter is the only writer of the ledger, and it resolves that path from
  # its own process environment (`mipham_code.ledger_path()`). The --ae line
  # below goes to the *container*, where nothing reads it, so it cannot be the
  # channel. Without this export the two sides agree only by coincidence: the
  # script's default and the adapter's fallback are two independently written
  # expressions that happen to spell the same file today. Were they ever to
  # diverge, the ceiling would silently stop biting — every task would get the
  # full budget — while the archive still read as "nothing was spent".
  export MIPHAM_BENCH_LEDGER="$LEDGER"
  harbor run \
    -p "$DATASET_DIR" \
    "${INCLUDE[@]:-}" \
    -a 'benchmarks.harbor.mipham_code:MiphamCode' \
    -m 'deepseek/deepseek-v4-pro' \
    -n 1 -k 1 \
    -o "$JOBS" --job-name "$JOB_NAME" \
    --ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" \
    --ae MIPHAM_DAEMON_PERMISSION=bypassPermissions \
    --ae "MIPHAM_EXEC_TIMEOUT_SEC=$EXEC_TIMEOUT" \
    --ae "MIPHAM_BENCH_LEDGER=$LEDGER" \
    --agent-setup-timeout-multiplier "$SETUP_TIMEOUT_MULT" \
    -y
fi

# ── 5. assembly ─────────────────────────────────────────────────────────────
# Guarded on the same flag as step 4: with --tasks-only there are no trials to
# assemble, and an archive written under this name would be a 0-trial file
# wearing the deliverable's exact name. `results/` is not gitignored and the
# commit step adds the whole directory, so that file would be committed as the
# phase's record if a real run later failed and left it on disk.
# The root handed over is this run's own job directory, not $JOBS: rglob from
# $JOBS would also swallow any directory that ever lands beside it. Phase 1 got
# away with it only because a person moved its failed attempts out to
# jobs/prior-phase1 by hand -- that was a naming convention, not a guarantee.
if [ "$TASKS_ONLY" -eq 0 ]; then
  "$PYTHON" - "$JOB_DIR" "$RESULTS/phase$PHASE-${DATASET%%@*}.json" "$LEDGER" "$DATASET" <<'PY'
import json, sys
from pathlib import Path

# What is written below is committed to a public repository; jobs/ keeps the
# verbatim original for diagnosis and is gitignored. If this import were to
# fail, the script stops before writing -- which is the direction to fail in.
from benchmarks.redact import redact

job_dir, out_path, ledger_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])

# The root must be this run's job directory and it must hold trials. A missing
# or empty one means the run did not happen the way step 4 believes it did, and
# the archive below would then be written anyway -- as a 0-trial file wearing
# the phase's name. Stop instead; saying "nothing was spent" is the one reading
# that must never be produced by accident.
if not job_dir.is_dir():
    sys.exit(f"assembly root is not a directory: {job_dir}")

ledger = json.loads(Path(ledger_path).read_text()) if Path(ledger_path).exists() else {"ceiling": None, "entries": []}

rows = []
for result_file in sorted(job_dir.rglob("mipham-result.json")):
    trial_dir = result_file.parent.parent
    rows.append({"trial": trial_dir.name, "result": json.loads(result_file.read_text())})

if not rows:
    sys.exit(f"assembly root holds no trials: {job_dir}")

total_in = sum((r["result"].get("usage") or {}).get("inputTokens", 0) for r in rows)
total_out = sum((r["result"].get("usage") or {}).get("outputTokens", 0) for r in rows)
summary = {
    "schemaVersion": 1,
    "dataset": sys.argv[4],
    "trials": rows,
    "totals": {
        "inputTokens": total_in,
        "outputTokens": total_out,
        "tokens": total_in + total_out,
        "budgetExceededTasks": sum(1 for r in rows if r["result"].get("status") == "budget_exceeded"),
        "completedTasks": sum(1 for r in rows if r["result"].get("status") == "done"),
    },
    "ledger": ledger,
}
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(redact(json.dumps(summary, indent=2) + "\n"))
print(f"wrote {out_path}: {len(rows)} trials, {total_in + total_out} tokens")
PY
fi
