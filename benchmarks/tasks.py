"""Which tasks each phase runs, decided before any result exists (spec §4.2).

Phase 1 uses the dataset's own lexicographic order, exactly as the spec states.
Phase 2 needs a variant because SWE-bench Verified task names are
``<owner>__<repo>-<pr>``: lexicographic order is expected to concentrate on
whichever owner-repo sorts first — measuring one codebase rather than ten (not
verified: that listing is not downloaded yet). The variant is the same rule with
the repository as the unit — still no human judgement, still
computable from the dataset listing alone.
"""

from __future__ import annotations

import argparse
import os
import sys

PHASE1_DATASET = "terminal-bench@2.0"
PHASE2_DATASET = "swebench-verified@1.0"

# Both lists are assertions, not inputs: the reproduce script recomputes the
# phase's selection from the downloaded files and refuses to run if it differs.

# The real directory listing of benchmarks/.datasets/terminal-bench (89 task
# dirs, 2026-09-17), recomputed from those files — the two agree.
PHASE1_EXPECTED: tuple[str, ...] = (
    "adaptive-rejection-sampler",
    "bn-fit-modify",
    "break-filter-js-from-html",
    "build-cython-ext",
    "build-pmars",
    "build-pov-ray",
    "caffe-cifar-10",
    "cancel-async-tasks",
    "chess-best-move",
    "circuit-fibsqrt",
)
# Checked: the dataset is downloaded (benchmarks/.datasets/swebench-verified,
# 500 tasks, gitignored) and `--rule first-repos --expect-recorded` recomputed
# the list below from those files and agreed with it, so this is a validated
# assertion rather than a plan artefact carried forward unchecked.
PHASE2_EXPECTED: tuple[str, ...] = (
    "astropy__astropy-12907",
    "django__django-10097",
    "matplotlib__matplotlib-13989",
    "mwaskom__seaborn-3069",
    "pallets__flask-5014",
    "psf__requests-1142",
    "pydata__xarray-2905",
    "pylint-dev__pylint-4551",
    "pytest-dev__pytest-10051",
    "scikit-learn__scikit-learn-10297",
)


def _repository(name: str) -> str:
    return name.split("__", 1)[0]


def select_first(names: list[str], n: int) -> list[str]:
    """The lexicographically first ``n`` names (spec §4.2's rule)."""
    return sorted(names)[:n]


def select_first_repos(names: list[str], n: int) -> list[str]:
    """The first task of each of the lexicographically first ``n`` repositories."""
    chosen: list[str] = []
    seen: set[str] = set()
    for name in sorted(names):
        repository = _repository(name)
        if repository in seen:
            continue
        seen.add(repository)
        chosen.append(name)
        if len(chosen) == n:
            break
    return chosen


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Recompute a phase's task selection.")
    parser.add_argument("--dataset-dir", required=True, help="Directory holding the task dirs.")
    parser.add_argument("--rule", choices=("first", "first-repos"), required=True)
    parser.add_argument("--n", type=int, required=True)
    parser.add_argument("--expect-recorded", action="store_true")
    args = parser.parse_args(argv)

    names = sorted(
        entry
        for entry in os.listdir(args.dataset_dir)
        if os.path.isdir(os.path.join(args.dataset_dir, entry))
    )
    selected = select_first(names, args.n) if args.rule == "first" else select_first_repos(names, args.n)

    if args.expect_recorded:
        recorded = PHASE1_EXPECTED if args.rule == "first" else PHASE2_EXPECTED
        if tuple(selected) != recorded:
            print(
                "selection drifted from the recorded list:\n"
                f"  computed: {selected}\n"
                f"  recorded: {list(recorded)}",
                file=sys.stderr,
            )
            return 1

    for name in selected:
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
