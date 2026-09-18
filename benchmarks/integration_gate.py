"""Assemble ``benchmarks/results/integration-gate.json`` (T2 Plan B, task 12).

One paid trial's evidence, recorded in the one place that survives: the raw
artifacts live under ``benchmarks/jobs/``, which is gitignored, so
``results/integration-gate.json`` is the only thing a later task can read. Task
13 Step 3 and Task 14's instrumentation section consume it directly, which is
why the field set is fixed by the task brief and not by this file's convenience.

Two artifacts share this writer, and they do **not** carry the same field set:

* ``results/integration-gate.json`` (Task 12) -- seven keys:
  ``{schemaVersion, hostArch, dockerPlatform, image, trial, result, driverLogTail}``
* ``results/phase2-integration-gate.json`` (Task 16) -- nine keys: the same
  seven, plus ``declaredArtifacts`` (the verifier-mode / ``task.toml``
  measurement) and ``manifests`` (the platform disclosure), both named in Task
  16's Produces block and absent from Task 12's.

The two extra blocks are assembled by the **caller** and merged into the record
this module builds -- this module does not produce them, and Task 16's Produces
block is where their names and shapes come from. That is not licence to drop
them: re-running this module against the Phase-2 output path without them would
silently delete the only place the ``SHARED`` / ``"N/A · 机制不适用"`` finding
lives.

Why this is a module rather than a shell heredoc: the record is committed to a
public repository and ``driverLogTail`` is text produced inside the container —
in the same environment that carries ``DEEPSEEK_API_KEY``. The boundary that
keeps the key off disk is the *write*, so the write has to be a write point
someone can review. ``benchmarks/redact.py`` is the one redactor for
``results/``; this module calls it and nothing else does the replacement.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from benchmarks.redact import redact

SCHEMA_VERSION = 1

#: How much of the driver log travels with the record. The log is the only
#: place the driver's stderr exists, so the tail is the diagnostic; the whole
#: original stays in ``jobs/`` for the deep read.
TAIL_LINES = 200

_IMAGE_PATTERNS = (
    re.compile(r"^Skipping image OS validation for (\S+?): ", re.MULTILINE),
    re.compile(r"^.*\bimage[\"']?\s*[:=]\s*[\"']?([\w./-]+:[\w.-]+)", re.MULTILINE),
)


def host_arch() -> str:
    return subprocess.run(["uname", "-m"], capture_output=True, text=True, check=False).stdout.strip()


def docker_platform() -> str:
    completed = subprocess.run(
        ["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return (completed.stdout or completed.stderr or "").strip()


def trial_image(trial_dir: Path) -> tuple[str, list[str]]:
    """The image this trial actually ran, read from the trial's own artifacts.

    Harbor does not write a structured image field into the trial's JSON
    artifacts, so the value comes from ``trial.log``. Guessing a tag is worse
    than saying "not recorded": Task 14's platform section reads this field.
    Returns the name plus every path looked at, so a miss can be reported as
    "searched these" rather than as an impression.
    """
    searched: list[str] = []
    for name in ("trial.log", "config.json", "result.json"):
        path = trial_dir / name
        searched.append(str(path))
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for pattern in _IMAGE_PATTERNS:
            match = pattern.search(text)
            if match:
                return match.group(1), searched
    return "未记录", searched


def build(trial_dir: Path) -> dict:
    result_path = trial_dir / "agent" / "mipham-result.json"
    driver_log_path = trial_dir / "agent" / "mipham-driver.log"

    result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else None
    if driver_log_path.exists():
        lines = driver_log_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    else:
        lines = []

    image, searched = trial_image(trial_dir)
    if image == "未记录":
        print(f"image not recorded; looked at: {searched}", file=sys.stderr)

    return {
        "schemaVersion": SCHEMA_VERSION,
        "hostArch": host_arch(),
        "dockerPlatform": docker_platform(),
        "image": image,
        "trial": trial_dir.name,
        "result": result,
        "driverLogTail": "\n".join(lines[-TAIL_LINES:]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--trial-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)

    summary = build(args.trial_dir)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    # The redaction is the write, not the collection: everything under jobs/
    # stays verbatim because that is what a failed run is diagnosed from.
    args.out.write_text(redact(json.dumps(summary, indent=2) + "\n"), encoding="utf-8")
    status = (summary["result"] or {}).get("status")
    print(f"wrote {args.out}: trial={summary['trial']} image={summary['image']} status={status}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
