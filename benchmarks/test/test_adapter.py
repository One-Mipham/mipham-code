import tempfile
import unittest
from pathlib import Path

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
            "binaryVersion": "@miphamai/cli v0.81.6",
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


if __name__ == "__main__":
    unittest.main()
