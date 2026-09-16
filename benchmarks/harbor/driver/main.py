"""Drive the Mipham daemon through one task, inside the task container.

All seven steps of spec §3.3 live in one process because ``HOME`` has to stay
identical across the daemon's whole lifetime — the port file, pid file, token
and SQLite database all live under ``$HOME/.mipham``, so splitting the steps
across shell invocations means any missed ``HOME`` makes the second call
invisible to the first's daemon.

Runs as ``python3 /logs/agent/mipham-driver/main.py``; the ``__package__``
check below lets the same file be imported as ``benchmarks.harbor.driver.main``
by the test suite.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

if __package__:
    from . import client as client_module
    from . import protocol, ws
else:  # pragma: no cover — the container runs this file as a script
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import client as client_module
    import protocol
    import ws

STEP_ORDER = (
    "start_daemon",
    "health",
    "session",
    "websocket",
    "prompt",
    "wait_done",
    "persist",
)

REQUIRED_ENV = ("HOME", "MIPHAM_BUDGET_TOKENS", "DEEPSEEK_API_KEY", "MIPHAM_DAEMON_PERMISSION")

_DEFAULTS = {
    "MIPHAM_BINARY": "/tmp/mipham/mipham",
    "MIPHAM_PROMPT_PATH": "/logs/agent/mipham-prompt.txt",
    "MIPHAM_RESULT_PATH": "/logs/agent/mipham-result.json",
    "MIPHAM_TRANSCRIPT_PATH": "/logs/agent/mipham-transcript.jsonl",
    "MIPHAM_DRIVER_LOG_PATH": "/logs/agent/mipham-driver.log",
    "MIPHAM_EXEC_TIMEOUT_SEC": "840",
    "MIPHAM_SESSION_PROVIDER": "deepseek",
    "MIPHAM_SESSION_MODEL": "deepseek-v4-pro",
}


class DriverConfigError(Exception):
    """The driver was started without something it cannot invent."""


def driver_env(source: dict[str, str] | None = None) -> dict[str, str]:
    """Resolve the driver's environment, failing loudly on anything required."""
    source = dict(os.environ if source is None else source)
    missing = [key for key in REQUIRED_ENV if not source.get(key)]
    if missing:
        raise DriverConfigError(f"missing required environment: {', '.join(sorted(missing))}")

    env = dict(_DEFAULTS)
    env.update({key: value for key, value in source.items() if key in _DEFAULTS})
    env["HOME"] = source["HOME"]
    env["DEEPSEEK_API_KEY"] = source["DEEPSEEK_API_KEY"]
    env["MIPHAM_BUDGET_TOKENS"] = source["MIPHAM_BUDGET_TOKENS"]
    # Pinned, never inherited: spec §3.4 fixes this to bypassPermissions because
    # the default mode blocks Bash/Write/Edit and every task would fail for a
    # reason that has nothing to do with the model under test.
    env["MIPHAM_DAEMON_PERMISSION"] = "bypassPermissions"
    return env


def _write_result(path: Path, result: dict) -> None:
    """Rewrite the result file. Called on every state change, so a SIGKILL
    (harbor's own agent timeout) leaves the last state on disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def _start_daemon(env: dict[str, str], binary: str, log_path: Path) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as log:
        completed = subprocess.run(
            [binary, "daemon", "start"],
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=180,
            check=False,
        )
    return completed.returncode


def run() -> dict:
    env = driver_env()
    workdir = os.getcwd()
    prompt = Path(env["MIPHAM_PROMPT_PATH"]).read_text(encoding="utf-8")
    budget = int(env["MIPHAM_BUDGET_TOKENS"])
    deadline_sec = float(env["MIPHAM_EXEC_TIMEOUT_SEC"]) - 20.0

    result: dict = {
        "schemaVersion": 1,
        "status": "started",
        "error": None,
        "workdir": workdir,
        "budgetTokens": budget,
        "usage": {"inputTokens": 0, "outputTokens": 0},
        "sessionCounters": None,
        "turns": 0,
        "toolResults": {"total": 0, "errors": 0},
        "stopReason": None,
        "binaryPath": env["MIPHAM_BINARY"],
        "binaryVersion": None,
        "binarySha256": None,
        "sessionId": None,
    }
    result_path = Path(env["MIPHAM_RESULT_PATH"])
    transcript_path = Path(env["MIPHAM_TRANSCRIPT_PATH"])
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    _write_result(result_path, result)

    if budget <= 0:
        # The job-level ledger has nothing left; the honest move is to record
        # that this task was never attempted, not to run it unbounded.
        result["status"] = "budget_exceeded"
        _write_result(result_path, result)
        return result

    started = time.monotonic()
    connection = None
    state = protocol.TurnState()
    try:
        version = subprocess.run(
            [env["MIPHAM_BINARY"], "--version"], capture_output=True, text=True, timeout=60, check=False
        )
        result["binaryVersion"] = (version.stdout or version.stderr or "").strip() or None
        digest = subprocess.run(
            ["sha256sum", env["MIPHAM_BINARY"]], capture_output=True, text=True, timeout=60, check=False
        )
        result["binarySha256"] = (digest.stdout or "").split()[0] if digest.stdout else None

        code = _start_daemon(env, env["MIPHAM_BINARY"], Path(env["MIPHAM_DRIVER_LOG_PATH"]))
        if code != 0:
            result["status"] = "daemon_start_failed"
            result["error"] = f"`daemon start` exited {code}"
            return result

        port = client_module.read_port(env["HOME"])
        daemon = client_module.DaemonClient(port)
        daemon.wait_until_ready()

        session_id = daemon.create_session(
            name="mipham-code-t2",
            cwd=workdir,
            provider=env["MIPHAM_SESSION_PROVIDER"],
            model=env["MIPHAM_SESSION_MODEL"],
        )
        result["sessionId"] = session_id
        result["status"] = "session_created"
        _write_result(result_path, result)

        # §3.3 step ④ before ⑤: see StepOrderTest for why.
        #
        # The socket carries a timeout because the deadline check below only
        # runs *between* reads: a daemon that goes quiet with the connection
        # open would otherwise park in recv_text() past the deadline, past the
        # `finally`, until harbor SIGKILLs us — leaving the result file on
        # `running` with no error, which reads the same as "still working".
        # The value is the deadline rather than a small constant because a tool
        # call is legitimately silent for minutes, while any silence that long
        # has by definition already blown the deadline: waking up then is the
        # deadline arriving late, not a healthy task being cut short.
        connection = ws.WsConnection.connect(
            "127.0.0.1", port, f"/api/v1/sessions/{session_id}/stream", timeout_sec=deadline_sec
        )
        daemon.prompt(session_id, prompt)
        result["status"] = "running"
        _write_result(result_path, result)

        with transcript_path.open("a", encoding="utf-8") as transcript:
            while True:
                if time.monotonic() - started > deadline_sec:
                    # Guarded, like the `done` branch below: the statuses are
                    # not interchangeable. `budget_exceeded` is a disclosed
                    # overspend (spec §六) and exits 0; `deadline_exceeded` is
                    # infrastructure. Overwriting one with the other hides the
                    # disclosure and flips the exit code to 1.
                    if result["status"] == "running":
                        result["status"] = "deadline_exceeded"
                    connection.send_text(json.dumps({"type": "interrupt", "sessionId": session_id}))
                    break
                raw = connection.recv_text()
                if raw is None:
                    # Same guard, same reason: `done` may never arrive (worker
                    # crashed, socket dropped), and a closed stream must not
                    # relabel a run we already stopped for budget.
                    if result["status"] == "running":
                        result["status"] = "stream_closed"
                    break
                message = protocol.reduce_message(state, raw)
                transcript.write(raw + "\n")
                transcript.flush()  # survive a SIGKILL from harbor's agent timeout

                result["usage"] = {
                    "inputTokens": state.input_tokens,
                    "outputTokens": state.output_tokens,
                }
                result["turns"] = state.turns
                result["toolResults"] = {"total": state.tool_results, "errors": state.tool_errors}
                result["stopReason"] = state.stop_reason

                if message["type"] == protocol.USAGE and state.total_tokens > budget:
                    # spec §六: over the ceiling means interrupt and disclose,
                    # never keep spending because the task looks close to done.
                    result["status"] = "budget_exceeded"
                    connection.send_text(json.dumps({"type": "interrupt", "sessionId": session_id}))
                if message["type"] == protocol.DONE:
                    # The completion criterion is the `done` frame and nothing
                    # else (spec §3.3). `state.finished` is also set by an
                    # `error` frame (protocol.py:77), and the daemon broadcasts
                    # `error` *and then* `done` (session-worker.ts:164, :197) —
                    # breaking on `finished` stops one frame early, loses the
                    # turn the `done` would have counted, and swallows the
                    # daemon's error text.
                    if result["status"] == "running":
                        result["status"] = "done"
                    break
                _write_result(result_path, result)

        # The daemon's own persisted counters are an independent reading of the
        # same quantity (daemon/types.ts:19-20). Recording both means a
        # divergence is visible instead of being resolved in our favour.
        try:
            result["sessionCounters"] = daemon.session(session_id)
        except client_module.DaemonError as exc:
            result["sessionCounters"] = {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — the result file is the report
        result["status"] = result["status"] if result["status"] != "started" else "failed"
        result["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if connection is not None:
            connection.close()
        # The daemon's error frame is the only place its failure text exists;
        # without this an errored run is recorded with `error: null`. It never
        # overwrites an existing value, so a more specific exception raised on
        # our side keeps priority.
        if result["error"] is None and state.last_error:
            result["error"] = state.last_error
        result["elapsedSec"] = round(time.monotonic() - started, 3)
        _write_result(result_path, result)
    return result


def main() -> int:
    result = run()
    print(json.dumps({k: v for k, v in result.items() if k != "sessionCounters"}, indent=2))
    return 0 if result["status"] in {"done", "budget_exceeded"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
