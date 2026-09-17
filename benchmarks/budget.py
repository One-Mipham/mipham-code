"""Job-level token ledger (spec §六).

Harbor runs one agent instance per task, so a job-level ceiling cannot live in
any instance. This is a file plus an exclusive lock: each task's budget is the
remaining headroom, so the job stops at the ceiling instead of at whichever
task happens to overshoot it.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

DEFAULT_CEILING = 50_505_050


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Ledger:
    def __init__(self, path: str | os.PathLike[str], ceiling: int = DEFAULT_CEILING) -> None:
        self.path = os.fspath(path)
        self.ceiling = ceiling

    def _read(self) -> dict:
        try:
            with open(self.path, encoding="utf-8") as handle:
                state = json.load(handle)
        except FileNotFoundError:
            return {"ceiling": self.ceiling, "entries": []}
        state.setdefault("ceiling", self.ceiling)
        state.setdefault("entries", [])
        return state

    def entries(self) -> list[dict]:
        return list(self._read()["entries"])

    def remaining(self) -> int:
        state = self._read()
        return int(state["ceiling"]) - sum(int(entry["tokens"]) for entry in state["entries"])

    def reset(self) -> None:
        self._write(self._read()["ceiling"], [])

    def record(self, tokens: int, *, note: str = "", at: str | None = None) -> int:
        """Append usage and return the new remaining headroom."""
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        lock_path = self.path + ".lock"
        with open(lock_path, "a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                state = self._read()
                state["entries"].append({"tokens": int(tokens), "note": note, "at": at or _now()})
                self._write(state["ceiling"], state["entries"])
                return int(state["ceiling"]) - sum(int(e["tokens"]) for e in state["entries"])
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _write(self, ceiling: int, entries: list[dict]) -> None:
        # The temp name is unique per call. A fixed `self.path + ".tmp"` is
        # one file shared by every writer, so two writers that overlap inside
        # it truncate and interleave each other's bytes and the ledger lands
        # unparseable (measured: `JSONDecodeError: Extra data`). The file has
        # to sit in the ledger's own directory for the rename to be atomic.
        directory = os.path.dirname(os.path.abspath(self.path))
        handle_fd, tmp = tempfile.mkstemp(
            dir=directory, prefix=os.path.basename(self.path) + ".", suffix=".tmp"
        )
        with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
            json.dump({"ceiling": ceiling, "entries": entries}, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, self.path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect or create the benchmark token ledger.")
    parser.add_argument("--path", required=True)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--ceiling", type=int, default=DEFAULT_CEILING)
    init.add_argument("--fresh", action="store_true", help="Discard recorded usage.")

    sub.add_parser("show")

    args = parser.parse_args(argv)
    ledger = Ledger(args.path, ceiling=getattr(args, "ceiling", DEFAULT_CEILING))

    if args.command == "init":
        if args.fresh:
            ledger.reset()
        else:
            ledger._write(ledger._read()["ceiling"], ledger._read()["entries"])
        # Print the ceiling that is actually on disk, not the one this process
        # was constructed with. They differ whenever the ledger already exists
        # with a different ceiling, and `--ceiling` does not override it: a
        # number that contradicts the file it just wrote is the wrong number.
        persisted_ceiling = ledger._read()["ceiling"]
        print(f"ceiling={persisted_ceiling} remaining={ledger.remaining()} entries={len(ledger.entries())}")
        return 0

    state = ledger._read()
    print(json.dumps({"ceiling": state["ceiling"], "remaining": ledger.remaining(),
                      "entries": state["entries"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
