"""Phase 2 ceiling calibration: derive it from Phase 1's real usage.

This is the corrected implementation of the rule sentence in the plan,
`docs/superpowers/plans/2026-09-16-t2-harbor-adapter.md` Task 15 (the paragraph
beginning "**规则（写进 `benchmarks/results/phase2-calibration.json`…" in
Step 1):

    ceiling = ceil_to_100k( 10 * max(true_median, mean) )

over the SELECTED set = every Phase 1 trial carrying a result/usage, whatever
its status (done / deadline_exceeded / budget_exceeded) -- so that truncated
spend is not silently mistaken for completed spend. Sets A and B are reported
alongside for the impact surface. The `rule` string committed in the artifact is
the authoritative wording; the formula above is its shape.

"Corrected" is doing real work in that first sentence: the plan's own Step 1
script (`per_task = [... for r in completed]`, where `completed` filters
`status == 'done'`) computes over a different set than the rule sentence beside
it declares, and takes the upper-middle element rather than the median. This
file follows the sentence, as the artifact does. The mismatch is filed as an
amendment application (see `docs/superpowers/specs/2026-09-17-t2-spec-amendments.md`)
-- the sentences diverge, they are not both right.

Why this lives in the repository rather than only in a task report: the
amendment argues "the rule sentence says X while the plan's script computes Y".
Without a script that can be re-run, that argument is an assertion with no way to
check it. This file is that check.

Two readings, both free and offline (stdlib only, no network):

    # 1. print the derivation subtree
    python3 benchmarks/calibrate-phase2.py

    # 2. assert it still reproduces the committed artifact
    python3 benchmarks/calibrate-phase2.py --check

`--check` compares against the `derivation` subtree of
`benchmarks/results/phase2-calibration.json` and exits non-zero on any
difference, naming the keys that differ. It never writes to that file -- the
artifact is the record, this script is how the record was computed.
"""

import json
import math
import sys
from pathlib import Path

UNIT = 100_000

# Resolved relative to the repository root (the parent of the directory holding
# this file) so the script behaves the same whatever the caller's cwd is -- the
# same reason the rest of benchmarks/ runs as `python3 -m benchmarks.…` from the
# root rather than by relative path.
REPO_ROOT = Path(__file__).resolve().parent.parent
P1 = REPO_ROOT / "benchmarks" / "results" / "phase1-terminal-bench.json"
ARTIFACT = REPO_ROOT / "benchmarks" / "results" / "phase2-calibration.json"


def per_task(r):
    u = r["result"]["usage"]
    return u["inputTokens"] + u["outputTokens"]


def median_exact(xs):
    xs = sorted(xs)
    n = len(xs)
    if n == 0:
        return 0
    if n % 2:
        return float(xs[n // 2])
    return (xs[n // 2 - 1] + xs[n // 2]) / 2


def mean_exact(xs):
    return sum(xs) / len(xs) if xs else 0


def ceil100k(x):
    return math.ceil(x / UNIT) * UNIT


def group(rows, definition):
    ts = sorted(per_task(r) for r in rows)
    med = median_exact(ts)
    mean = mean_exact(ts)
    base = max(med, mean)
    return {
        "definition": definition,
        "n": len(ts),
        "perTaskTokens": ts,
        "median": med,
        "medianIfUpperMiddle": float(ts[len(ts) // 2]) if ts else 0,
        "mean": mean,
        "meanIfFloored": sum(ts) // len(ts) if ts else 0,
        "max": ts[-1] if ts else 0,
        "maxOfMedianMeanTimes10": base * 10,
        "ceilingIfSelected": ceil100k(base * 10),
    }


def compute():
    p1 = json.loads(P1.read_text())
    tot = p1["totals"]
    trials = p1["trials"]

    done = [r for r in trials if r["result"]["status"] == "done"]
    budget = [r for r in trials if r["result"]["status"] == "budget_exceeded"]
    with_result = [r for r in trials if r["result"].get("usage") is not None]

    # The three `definition` strings below are reproduced verbatim from the
    # committed artifact. They are prose, not numbers, so it is tempting to
    # rewrite them -- doing so makes `--check` fail on a difference that means
    # nothing. The record's wording is part of the record.
    A = group(done, "trials whose result.status == 'done' (brief Step 1 script as written)")
    B = group(
        done + budget,
        "done + budget_exceeded (carry item 1 ruling (3) literal scope; identical to A when none were budget-stopped)",
    )
    C = group(
        with_result,
        "every trial carrying a result/usage, whatever its status (done / deadline_exceeded / budget_exceeded) -- SELECTED, per carry item 4",
    )

    selected = C
    ceiling = selected["ceilingIfSelected"]

    out = {
        "phase1_total_tokens": tot["tokens"],
        "phase1_completed_tasks": tot["completedTasks"],
        "phase1_budget_exceeded_tasks": tot["budgetExceededTasks"],
        "budget_exceeded_by_status_count": len(budget),
        "trials_with_result": len(with_result),
        "selected_set": "C",
        "per_task_median": selected["median"],
        "per_task_mean": selected["mean"],
        "per_task_max": selected["max"],
        "suggested_phase2_ceiling": ceiling,
        "sets": {"A": A, "B": B, "C": C},
        "crosschecks": {
            "ceiling_unchanged_if_mean_floored": ceil100k(max(selected["median"], selected["meanIfFloored"]) * 10) == ceiling,
            "ceiling_unchanged_if_upper_middle_median": ceil100k(max(selected["medianIfUpperMiddle"], selected["mean"]) * 10) == ceiling,
            "totals_tokens_equals_all_trials_sum": tot["tokens"] == sum(per_task(r) for r in with_result),
            "totals_tokens_equals_done_only_sum": tot["tokens"] == sum(per_task(r) for r in done),
            "ceiling_is_int": isinstance(ceiling, int),
        },
    }
    return out


def main(argv):
    derivation = compute()
    if "--check" in argv:
        artifact = json.loads(ARTIFACT.read_text())
        recorded = artifact.get("derivation")
        if recorded == derivation:
            print(
                f"derivation matches {ARTIFACT.relative_to(REPO_ROOT)} "
                f"(ceiling {derivation['suggested_phase2_ceiling']})"
            )
            return 0
        print(f"derivation DIFFERS from {ARTIFACT.relative_to(REPO_ROOT)}", file=sys.stderr)
        for key in sorted(set(derivation) | set(recorded or {})):
            if derivation.get(key) != (recorded or {}).get(key):
                print(f"  {key}: recomputed={derivation.get(key)!r} recorded={(recorded or {}).get(key)!r}", file=sys.stderr)
        return 1
    print(json.dumps(derivation, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
