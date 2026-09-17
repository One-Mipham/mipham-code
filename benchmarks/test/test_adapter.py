import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
