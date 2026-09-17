import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harbor.models.agent.context import AgentContext

from benchmarks import budget
from benchmarks.harbor import mipham_code
from benchmarks.harbor.driver import main as driver_main


class ModuleShapeTest(unittest.TestCase):
    def test_name_is_set(self):
        self.assertEqual(mipham_code.MiphamCode.name(), "mipham-code")

    def test_options_model_is_declared(self):
        # Without this, `harbor agent schema` refuses the agent outright:
        # "Agent 'mipham-code' does not declare an options_model".
        self.assertIsNotNone(mipham_code.MiphamCode.options_model)

    def test_the_binary_url_is_pinned_to_a_release_tag(self):
        # `releases/latest` would silently change the artifact under a
        # published score; the whole point of the results file is that it
        # names a version someone else can reinstall.
        self.assertIn("/releases/download/v", mipham_code.MiphamCode._BINARY_URL)
        self.assertNotIn("/latest/", mipham_code.MiphamCode._BINARY_URL)

    def test_the_binary_lands_somewhere_an_agent_user_can_write(self):
        # exec_as_agent runs as the agent user; /usr/local/bin is not
        # guaranteed writable, /tmp always is.
        self.assertTrue(mipham_code.MiphamCode._BINARY_PATH.startswith("/tmp/"))

    def test_the_driver_directory_is_under_the_agent_logs(self):
        self.assertTrue(mipham_code.MiphamCode._DRIVER_DIR.startswith("/logs/agent/"))


class InstallCommandTest(unittest.TestCase):
    def test_install_downloads_the_binary_and_runs_its_version(self):
        command = mipham_code.MiphamCode.install_command()
        self.assertIn(mipham_code.MiphamCode._BINARY_URL, command)
        self.assertIn(mipham_code.MiphamCode._BINARY_PATH, command)
        self.assertIn("--version", command)
        self.assertNotIn("install.sh", command)


class DriverEnvContractTest(unittest.TestCase):
    """The one seam where two tasks must agree, checked where it is free.

    ``driver/main.py`` (Task 8) raises ``DriverConfigError`` when any key of
    ``REQUIRED_ENV`` is missing, and ``run()`` (Task 10) hands it whatever
    ``driver_env()`` returned. Nothing else in the suite covers that seam, so
    without these two tests the first thing to notice a missing key is a paid
    trial — every task fails, for a reason that has nothing to do with the
    model under test.
    """

    def _agent(self, **extra: str) -> mipham_code.MiphamCode:
        # logs_dir is the only required constructor argument; model_name=None
        # makes _init_model_info() return early, so this touches no registry
        # and no network. extra_env is the same slot `--ae` fills.
        env = {"DEEPSEEK_API_KEY": "placeholder"}
        env.update(extra)
        return mipham_code.MiphamCode(
            logs_dir=Path(tempfile.mkdtemp()), extra_env=env
        )

    def test_driver_env_supplies_every_key_the_driver_requires(self):
        supplied = set(self._agent().driver_env())
        missing = set(driver_main.REQUIRED_ENV) - supplied
        # MIPHAM_BUDGET_TOKENS is the one key run() adds from the live ledger
        # balance, so it is legitimately absent here. Asserting the *exact*
        # difference — not a subset — means a fifth required key added later
        # fails this test instead of a paid trial.
        self.assertEqual(missing, {"MIPHAM_BUDGET_TOKENS"})

    def test_the_permission_tier_is_pinned_and_not_merely_hoped_for(self):
        # spec §3.4 fixes bypassPermissions: the default mode blocks Bash and
        # Write, and every task would then fail for a reason unrelated to the
        # model. The driver pins it too (driver/main.py driver_env), but the
        # adapter must supply it — REQUIRED_ENV demands it.
        self.assertEqual(
            self._agent().driver_env()["MIPHAM_DAEMON_PERMISSION"],
            "bypassPermissions",
        )

    def test_the_ae_channel_can_still_override_the_tier(self):
        # --ae is the only documented tuning channel; a pin that ignores it
        # would make the env var look supported while doing nothing.
        self.assertEqual(
            self._agent(MIPHAM_DAEMON_PERMISSION="acceptEdits").driver_env()[
                "MIPHAM_DAEMON_PERMISSION"
            ],
            "acceptEdits",
        )


class ParseResultTest(unittest.TestCase):
    def test_round_trips_the_driver_json(self):
        parsed = mipham_code.MiphamCode.parse_result('{"status":"done","usage":{"inputTokens":7}}')
        self.assertEqual(parsed["status"], "done")

    def test_an_empty_stdout_is_an_empty_result_not_a_crash(self):
        # A run that died before writing anything still has to produce a
        # results row — that row is the disclosure.
        self.assertEqual(mipham_code.MiphamCode.parse_result(""), {})

    def test_garbage_is_reported_not_swallowed(self):
        with self.assertRaises(ValueError):
            mipham_code.MiphamCode.parse_result("cat: no such file")


class ApplyContextTest(unittest.TestCase):
    def _result(self) -> dict:
        return {
            "status": "done",
            "usage": {"inputTokens": 1234, "outputTokens": 567},
            "turns": 3,
            "toolResults": {"total": 9, "errors": 2},
            "sessionCounters": {"tokenIn": 1234, "tokenOut": 567},
            "binaryVersion": "@miphamai/cli v0.81.7",
            "binarySha256": "deadbeef",
            "budgetTokens": 50_000_000,
            "workdir": "/app",
        }

    def test_tokens_come_from_the_protocol(self):
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, self._result())
        self.assertEqual(context.n_input_tokens, 1234)
        self.assertEqual(context.n_output_tokens, 567)

    def test_cost_and_cache_are_left_unset(self):
        # usage carries two totals and no cache-hit split (spec §六), so any
        # number here would be invented.
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, self._result())
        self.assertIsNone(context.cost_usd)
        self.assertIsNone(context.n_cache_tokens)

    def test_metadata_carries_what_the_results_file_needs(self):
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, self._result())
        self.assertEqual(context.metadata["mipham"]["toolResults"]["errors"], 2)
        self.assertEqual(context.metadata["mipham"]["binarySha256"], "deadbeef")

    def test_missing_usage_leaves_the_tokens_unset_rather_than_zero(self):
        context = AgentContext()
        mipham_code.MiphamCode.apply_context(context, {"status": "budget_exceeded"})
        self.assertIsNone(context.n_input_tokens)


class LedgerPathTest(unittest.TestCase):
    def test_ledger_path_is_inside_the_package(self):
        path = mipham_code.MiphamCode.ledger_path()
        self.assertEqual(path.parent.name, "results")
        self.assertEqual(path.parent.parent.name, "benchmarks")


class _CompletedExec:
    """Stands in for harbor's CommandResult: ``run()`` only reads ``stdout``."""

    def __init__(self, stdout: str) -> None:
        self.stdout = stdout


class _FakeEnvironment:
    """Only the two channel calls ``run()`` makes."""

    def __init__(self) -> None:
        self.prompt: str | None = None
        self.driver_source_dir: Path | None = None
        self.targets: list[str] = []

    async def upload_dir(self, source_dir, target_dir) -> None:
        self.driver_source_dir = Path(source_dir)
        self.targets.append(target_dir)

    async def upload_file(self, source_path, target_path) -> None:
        self.prompt = Path(source_path).read_text(encoding="utf-8")
        self.targets.append(target_path)


class RunTest(unittest.TestCase):
    """``run()`` end to end against a fake environment.

    The branches below — driver exits non-zero, readback unreadable or absent,
    spend that cannot be known — are exactly the trials the result file exists
    to disclose, so they are the ones most worth pinning. Every other test in
    this suite is synchronous, so ``run()`` is driven with ``asyncio.run``
    rather than through an async test case class.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.ledger_path = Path(self._tmp.name) / "ledger.json"
        self._previous_ledger_env = os.environ.get(mipham_code.MiphamCode._LEDGER_ENV)
        os.environ[mipham_code.MiphamCode._LEDGER_ENV] = str(self.ledger_path)
        self.addCleanup(self._restore_ledger_env)

    def _restore_ledger_env(self) -> None:
        if self._previous_ledger_env is None:
            os.environ.pop(mipham_code.MiphamCode._LEDGER_ENV, None)
        else:
            os.environ[mipham_code.MiphamCode._LEDGER_ENV] = self._previous_ledger_env

    def _run(self, *, driver_raises: Exception | None = None, readback: str = ""):
        captured: dict = {}

        class Probe(mipham_code.MiphamCode):
            async def exec_as_agent(
                self, environment, command, env=None, cwd=None, timeout_sec=None
            ):
                if command.startswith("cat "):
                    return _CompletedExec(readback)
                captured["driver_env"] = env
                if driver_raises is not None:
                    raise driver_raises
                return _CompletedExec("")

        agent = Probe(
            logs_dir=Path(self._tmp.name),
            extra_env={"DEEPSEEK_API_KEY": "placeholder"},
        )
        environment = _FakeEnvironment()
        context = AgentContext()
        asyncio.run(agent.run("do the task", environment, context))
        return context, captured, environment

    def _ledger_entries(self) -> list[dict]:
        return budget.Ledger(self.ledger_path).entries()

    def test_a_failed_driver_still_reports(self):
        # exec_as_agent raises on any non-zero exit, and the driver exits 1 for
        # every status except done and budget_exceeded — so deadline_exceeded,
        # stream_closed and failed all land here. While that exception escaped,
        # apply_context never ran and those trials reported nothing at all.
        context, _, _ = self._run(
            driver_raises=RuntimeError("exit status 1"),
            readback=json.dumps({"status": "deadline_exceeded"}),
        )
        self.assertEqual(context.metadata["mipham"]["status"], "deadline_exceeded")
        self.assertIn("exit status 1", context.metadata["mipham"]["execError"])

    def test_the_exec_error_survives_an_unreadable_readback(self):
        context, _, _ = self._run(driver_raises=RuntimeError("exit status 1"))
        self.assertIn("exit status 1", context.metadata["mipham"]["execError"])

    def test_valid_json_that_is_not_an_object_is_reported_not_swallowed(self):
        # dict([1, 2]) raises TypeError, not ValueError, so it slipped past the
        # unreadable branch and was swallowed by the surrounding suppress —
        # reproducing the very ambiguity between "wrote nothing" and "what it
        # wrote cannot be read" that the branch exists to remove.
        context, _, _ = self._run(readback="[1, 2]")
        error = context.metadata["mipham"]["error"]
        self.assertIsNotNone(error, "an unparsable result must not look like a run that never wrote one")
        self.assertIn("unreadable driver result", error)

    def test_a_ledger_failure_still_lands_in_the_metadata(self):
        # apply_context has to run *after* ledger.record, or a ledgerError set
        # by record's own except branch never reaches the results file.
        with mock.patch.object(budget.Ledger, "record", side_effect=OSError("read-only")):
            context, _, _ = self._run(readback=json.dumps({"status": "done", "sessionId": "s-1"}))
        self.assertEqual(context.metadata["mipham"]["ledgerError"], "read-only")
        self.assertEqual(context.metadata["mipham"]["status"], "done")

    def test_a_named_session_is_still_the_ledger_note(self):
        # Task 13 joins ledger entries to trials through this value; it must
        # stay the bare session id whenever there is one.
        self._run(
            readback=json.dumps(
                {
                    "status": "done",
                    "sessionId": "s-42",
                    "usage": {"inputTokens": 3, "outputTokens": 2},
                }
            )
        )
        entries = self._ledger_entries()
        self.assertEqual([entry["note"] for entry in entries], ["s-42"])
        self.assertEqual(entries[0]["tokens"], 5)

    def test_an_unreadable_readback_records_unknown_spend_not_zero(self):
        # A bare 0 here is indistinguishable from a task that genuinely spent
        # nothing, and remaining() is the ceiling's only enforcement point.
        self._run(readback='{"status": "do')
        self.assertEqual([entry["note"] for entry in self._ledger_entries()], ["spend-unknown"])

    def test_an_absent_result_records_unknown_spend(self):
        self._run(readback="")
        self.assertEqual([entry["note"] for entry in self._ledger_entries()], ["spend-unknown"])

    def test_a_readable_result_with_no_session_is_a_genuine_zero(self):
        # The result was read, so the driver accounted for itself: 0 tokens is
        # its answer rather than our ignorance.
        self._run(readback=json.dumps({"status": "failed"}))
        entries = self._ledger_entries()
        self.assertEqual([entry["note"] for entry in entries], ["no-session"])
        self.assertEqual(entries[0]["tokens"], 0)


if __name__ == "__main__":
    unittest.main()
