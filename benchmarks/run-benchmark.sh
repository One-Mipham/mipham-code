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
    --phase) PHASE="$2"; shift 2 ;;
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
JOBS="$BENCH/jobs/phase$PHASE"
RESULTS="$BENCH/results"
DATASET_DIR="$DATASETS/$DATASET_DIR_NAME"
LEDGER="${MIPHAM_BENCH_LEDGER:-$RESULTS/ledger.json}"
PROXY="${MIPHAM_BENCH_PROXY:-http://127.0.0.1:7897}"

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
printf 'tasks: %s\n' "${TASKS[*]}"

# ── 3. ledger ───────────────────────────────────────────────────────────────
if [ "$FRESH" -eq 1 ]; then
  "$PYTHON" -m benchmarks.budget --path "$LEDGER" init --ceiling "${MIPHAM_LEDGER_CEILING:-50505050}" --fresh
else
  "$PYTHON" -m benchmarks.budget --path "$LEDGER" init --ceiling "${MIPHAM_LEDGER_CEILING:-50505050}"
fi
"$PYTHON" -m benchmarks.budget --path "$LEDGER" show

# ── 4. the run ──────────────────────────────────────────────────────────────
if [ "$TASKS_ONLY" -eq 0 ]; then
  : "${DEEPSEEK_API_KEY:?DEEPSEEK_API_KEY must be set in the host environment}"
  mkdir -p "$JOBS"
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
    "${INCLUDE[@]}" \
    -a 'benchmarks.harbor.mipham_code:MiphamCode' \
    -m 'deepseek/deepseek-v4-pro' \
    -n 1 -k 1 \
    -o "$JOBS" --job-name "phase$PHASE" \
    --ae "DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY" \
    --ae MIPHAM_DAEMON_PERMISSION=bypassPermissions \
    --ae "MIPHAM_EXEC_TIMEOUT_SEC=$EXEC_TIMEOUT" \
    --ae "MIPHAM_BENCH_LEDGER=$LEDGER" \
    -y
fi

# ── 5. assembly ─────────────────────────────────────────────────────────────
"$PYTHON" - "$JOBS" "$RESULTS/phase$PHASE-${DATASET%%@*}.json" "$LEDGER" <<'PY'
import json, sys
from pathlib import Path

# What is written below is committed to a public repository; jobs/ keeps the
# verbatim original for diagnosis and is gitignored. If this import were to
# fail, the script stops before writing -- which is the direction to fail in.
from benchmarks.redact import redact

jobs_dir, out_path, ledger_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
ledger = json.loads(Path(ledger_path).read_text()) if Path(ledger_path).exists() else {"ceiling": None, "entries": []}

rows = []
for result_file in sorted(jobs_dir.rglob("mipham-result.json")):
    trial_dir = result_file.parent.parent
    rows.append({"trial": trial_dir.name, "result": json.loads(result_file.read_text())})

total_in = sum((r["result"].get("usage") or {}).get("inputTokens", 0) for r in rows)
total_out = sum((r["result"].get("usage") or {}).get("outputTokens", 0) for r in rows)
summary = {
    "schemaVersion": 1,
    "dataset": sys.argv[2],
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
