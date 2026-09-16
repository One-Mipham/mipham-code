import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.harbor.driver import main


class DriverEnvTest(unittest.TestCase):
    def test_required_keys_are_all_read_from_the_environment(self):
        self.assertIn("MIPHAM_BUDGET_TOKENS", main.REQUIRED_ENV)
        self.assertIn("DEEPSEEK_API_KEY", main.REQUIRED_ENV)
        self.assertIn("MIPHAM_DAEMON_PERMISSION", main.REQUIRED_ENV)

    def test_missing_required_key_names_itself(self):
        # Failing loudly here is the difference between "the score is 0" and
        # "we never got a key" — the two look identical from the results file.
        with self.assertRaises(main.DriverConfigError) as caught:
            main.driver_env({})
        self.assertIn("MIPHAM_BUDGET_TOKENS", str(caught.exception))

    def test_defaults_fill_in_the_paths(self):
        env = main.driver_env(
            {
                "HOME": "/logs/agent/home",
                "MIPHAM_BUDGET_TOKENS": "1000",
                "DEEPSEEK_API_KEY": "secret-value",
                "MIPHAM_DAEMON_PERMISSION": "bypassPermissions",
            }
        )
        self.assertEqual(env["MIPHAM_BINARY"], "/tmp/mipham/mipham")
        self.assertEqual(env["MIPHAM_RESULT_PATH"], "/logs/agent/mipham-result.json")
        self.assertEqual(env["MIPHAM_EXEC_TIMEOUT_SEC"], "840")

    def test_the_permission_mode_is_pinned_to_bypass(self):
        # spec §3.4: the default mode blocks Bash/Write/Edit, so every task
        # would fail for a reason that has nothing to do with the model.
        env = main.driver_env(
            {
                "HOME": "/logs/agent/home",
                "MIPHAM_BUDGET_TOKENS": "1000",
                "DEEPSEEK_API_KEY": "k",
                "MIPHAM_DAEMON_PERMISSION": "default",
            }
        )
        self.assertEqual(env["MIPHAM_DAEMON_PERMISSION"], "bypassPermissions")


class StepOrderTest(unittest.TestCase):
    def test_the_websocket_is_connected_before_the_prompt_is_sent(self):
        # Not a style choice: getOrCreateWorker registers the clients already
        # in wsClients for that session, so a prompt sent first would stream
        # into nothing and the run would hang with no `done` (spec §3.4).
        self.assertLess(main.STEP_ORDER.index("websocket"), main.STEP_ORDER.index("prompt"))

    def test_all_seven_steps_are_present(self):
        self.assertEqual(len(main.STEP_ORDER), 7)


class _FakeCompletedProcess:
    def __init__(self, stdout: str = "", stderr: str = "", returncode: int = 0) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


class _FakeSubprocess:
    """Stands in for the ``subprocess`` module ``main`` imports.

    ``run()`` shells out three times before it reaches the socket
    (``--version``, ``sha256sum``, ``daemon start``). On a dev machine none of
    those binaries exist at the container's paths, so the module is replaced
    rather than the calls being skipped.
    """

    STDOUT = -2

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def run(self, argv, **kwargs) -> _FakeCompletedProcess:
        argv = list(argv)
        self.calls.append(argv)
        if argv[-1] == "--version":
            return _FakeCompletedProcess(stdout="9.9.9\n")
        if argv[0] == "sha256sum":
            return _FakeCompletedProcess(stdout="f" * 64 + "  " + argv[1] + "\n")
        return _FakeCompletedProcess()


class _FakeConnection:
    """Replays canned frames and then closes, like the peer hanging up."""

    def __init__(self, frames: list[str]) -> None:
        self._frames = list(frames)
        self.sent: list[str] = []
        self.closed = False

    def send_text(self, text: str) -> None:
        self.sent.append(text)

    def recv_text(self) -> str | None:
        return self._frames.pop(0) if self._frames else None

    def close(self) -> None:
        self.closed = True


class _FakeClientError(Exception):
    pass


class _FakeDaemon:
    """The REST half of the driver's world, with no HTTP in it."""

    def __init__(self) -> None:
        self.port = 45123
        self.session_id = "sess-test"
        self.prompts: list[tuple[str, str]] = []
        self.created: dict = {}

    def wait_until_ready(self) -> dict:
        return {"ok": True}

    def create_session(self, *, name: str, cwd: str, provider: str, model: str) -> str:
        self.created = {"name": name, "cwd": cwd, "provider": provider, "model": model}
        return self.session_id

    def prompt(self, session_id: str, text: str) -> None:
        self.prompts.append((session_id, text))

    def session(self, session_id: str) -> dict:
        return {"id": session_id, "usage": {"inputTokens": 1, "outputTokens": 1}}


class _RunHarness(unittest.TestCase):
    """Drives ``main.run()`` with the network, the subprocess and the clock
    replaced.

    ``run()`` reaches outside itself through exactly those module attributes,
    which is what lets the whole state machine be walked without a daemon.
    """

    budget = "100"
    frames: tuple[str, ...] = ()

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        prompt_path = root / "prompt.txt"
        prompt_path.write_text("do the task", encoding="utf-8")

        # Resolved by the real function, so the defaults the driver relies on
        # are the ones under test rather than a second copy here.
        self.env = main.driver_env(
            {
                "HOME": str(root / "home"),
                "MIPHAM_BUDGET_TOKENS": self.budget,
                "DEEPSEEK_API_KEY": "secret-value",
                "MIPHAM_DAEMON_PERMISSION": "bypassPermissions",
                "MIPHAM_BINARY": str(root / "mipham"),
                "MIPHAM_PROMPT_PATH": str(prompt_path),
                "MIPHAM_RESULT_PATH": str(root / "result.json"),
                "MIPHAM_TRANSCRIPT_PATH": str(root / "transcript.jsonl"),
                "MIPHAM_DRIVER_LOG_PATH": str(root / "driver.log"),
                "MIPHAM_EXEC_TIMEOUT_SEC": "840",
            }
        )
        self.result_path = Path(self.env["MIPHAM_RESULT_PATH"])
        self.connection = _FakeConnection(list(self.frames))
        self.connect_args: dict = {}
        self.daemon = _FakeDaemon()

        self._patch("driver_env", lambda source=None: dict(self.env))
        self._patch("subprocess", _FakeSubprocess())
        self._patch(
            "client_module",
            types.SimpleNamespace(
                read_port=lambda home, timeout_sec=30.0: self.daemon.port,
                DaemonClient=lambda port: self.daemon,
                DaemonError=_FakeClientError,
            ),
        )
        self._patch("ws", types.SimpleNamespace(WsConnection=self._ws_connection_class()))

    def _ws_connection_class(self):
        harness = self

        class _WsConnection:
            @classmethod
            def connect(cls, host, port, path, *, timeout_sec=None):
                harness.connect_args = {
                    "host": host,
                    "port": port,
                    "path": path,
                    "timeout_sec": timeout_sec,
                }
                return harness.connection

        return _WsConnection

    def _patch(self, name: str, value: object) -> None:
        patcher = mock.patch.object(main, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def result_on_disk(self) -> dict:
        return json.loads(self.result_path.read_text(encoding="utf-8"))

    def sent_types(self) -> list[str]:
        return [json.loads(frame)["type"] for frame in self.connection.sent]


class StreamClosedStickinessTest(_RunHarness):
    """One frame over budget, then the connection dies before ``done``.

    The ordering is the whole point: the daemon answers our interrupt with
    ``done``, so on the happy path ``budget_exceeded`` is the status anyway and
    a broken guard hides behind a green test. Only a stream that closes first
    can tell the two implementations apart.
    """

    budget = "100"
    frames = (json.dumps({"type": "usage", "inputTokens": 80, "outputTokens": 80}),)

    def test_over_budget_is_not_relabelled_when_the_stream_closes_first(self):
        result = main.run()

        self.assertEqual(
            self.sent_types(),
            ["interrupt"],
            "the budget branch was never reached, so this test proves nothing",
        )
        self.assertEqual(result["status"], "budget_exceeded")
        # The results file is the artifact Harbor reads; our in-memory dict
        # agreeing with itself would not be evidence.
        self.assertEqual(self.result_on_disk()["status"], "budget_exceeded")


class DeadlineStickinessTest(_RunHarness):
    """The other terminal branch, pinned the same way.

    A second overspend frame would be needed to keep the loop in budget, so the
    clock is the seam that reaches this branch: two reads on time, then a read
    that lands past the deadline. Patching ``main.time`` keeps it local —
    ``time`` is a module the driver imported, not the global one.
    """

    budget = "100"
    frames = (json.dumps({"type": "usage", "inputTokens": 80, "outputTokens": 80}),)
    clock = (0.0, 0.0, 10_000.0)

    def setUp(self) -> None:
        super().setUp()
        self._remaining_clock = list(self.clock)
        self._patch("time", types.SimpleNamespace(monotonic=self._monotonic))

    def _monotonic(self) -> float:
        return self._remaining_clock.pop(0) if self._remaining_clock else 10_000.0

    def test_over_budget_is_not_relabelled_by_a_deadline_that_arrives_later(self):
        result = main.run()

        self.assertEqual(
            self.sent_types(),
            ["interrupt", "interrupt"],
            "both the budget branch and the deadline branch should have run",
        )
        self.assertEqual(result["status"], "budget_exceeded")
        self.assertEqual(self.result_on_disk()["status"], "budget_exceeded")


class ConnectionTimeoutTest(_RunHarness):
    def test_the_socket_timeout_is_the_deadline_not_a_round_number(self):
        # The loop's deadline check only runs between reads, so a daemon that
        # goes quiet with the connection open parks in recv_text() forever
        # unless the socket itself carries a timeout. It has to be the deadline
        # and not a small constant: a tool call may legitimately be silent for
        # minutes, while any silence longer than the whole task budget has by
        # definition already blown it.
        main.run()
        self.assertEqual(self.connect_args["timeout_sec"], 840.0 - 20.0)


if __name__ == "__main__":
    unittest.main()
