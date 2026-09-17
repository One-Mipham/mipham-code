"""Harbor adapter for Mipham Code (T2, spec §三).

Route A+: the adapter drives the daemon's REST API inside the task container,
because the daemon binds loopback *inside* the container and a host-side Python
process cannot reach it. One driver process per trial performs all seven steps
of spec §3.3 (see ``driver/main.py`` for why they cannot be split).

Auth is by source address alone — loopback needs no token (spec §3.4). The only
credential is ``DEEPSEEK_API_KEY``, forwarded from the host environment through
``--ae`` and never written to a file, a log, or the results.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class MiphamCodeOptions(InstalledAgentOptions):
    """No adapter-specific knobs.

    Every tunable travels as agent environment (``--ae KEY=VALUE``) read back
    through ``self._get_env`` or ``driver_env``. That is deliberate: an
    undeclared ``-ak`` kwarg is accepted into ``kwargs`` without complaint and
    then silently ignored, so a typo there fails invisibly. Declared anyway
    because ``harbor agent schema`` requires an ``options_model``.
    """


class MiphamCode(BaseInstalledAgent):
    capabilities = AgentCapabilities()
    options_model = MiphamCodeOptions

    _BINARY_URL = (
        "https://github.com/One-Mipham/mipham-code/releases/download/v0.81.6/mipham-linux-x64"
    )
    _BINARY_PATH = "/tmp/mipham/mipham"
    _DRIVER_DIR = "/logs/agent/mipham-driver"
    _PROMPT_PATH = "/logs/agent/mipham-prompt.txt"
    _RESULT_FILENAME = "mipham-result.json"
    _TRANSCRIPT_FILENAME = "mipham-transcript.jsonl"
    _DRIVER_LOG_FILENAME = "mipham-driver.log"

    @staticmethod
    @override
    def name() -> str:
        return "mipham-code"

    @override
    def get_version_command(self) -> str | None:
        return f"{self._BINARY_PATH} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip()

    @staticmethod
    def install_command() -> str:
        """The shell that fetches the prebuilt binary.

        spec §3.2: the prebuilt binary, never ``install.sh`` — on a bare
        Debian the script reported "No runtime detected", installed Bun, and
        then died on ``error: unzip is required to install bun`` without
        getting mipham onto the box at all.
        """
        return (
            "set -euo pipefail; "
            f"mkdir -p {Path(MiphamCode._BINARY_PATH).parent.as_posix()} && "
            f"curl -fsSL {MiphamCode._BINARY_URL} -o {MiphamCode._BINARY_PATH} && "
            f"chmod 0755 {MiphamCode._BINARY_PATH} && "
            f"{MiphamCode._BINARY_PATH} --version"
        )

    def driver_env(self) -> dict[str, str]:
        """Environment for the single ``exec_as_agent`` call that runs the driver.

        The returned dict must cover every key in ``driver/main.py``'s
        ``REQUIRED_ENV`` except ``MIPHAM_BUDGET_TOKENS``, which ``run()`` adds
        from the live ledger balance. The driver raises ``DriverConfigError``
        on a missing key *before* it does anything else, so an omission here
        fails every trial rather than one — and it fails for a reason that has
        nothing to do with the model under test. ``DriverEnvContractTest`` in
        ``benchmarks/test/test_adapter.py`` is what keeps the two ends in step.
        """
        api_key = self._get_env("DEEPSEEK_API_KEY")
        if not api_key:
            raise ValueError(
                "DEEPSEEK_API_KEY is required. Set it on the host or pass it "
                "with --ae DEEPSEEK_API_KEY=..."
            )
        return {
            # HOME decides where the daemon puts its port file, pid file, token
            # and SQLite database. All four land under the 0777, mount-backed
            # /logs/agent, so they come back to the host with the trial.
            "HOME": (EnvironmentPaths.agent_dir / "home").as_posix(),
            "MIPHAM_BINARY": self._BINARY_PATH,
            "MIPHAM_PROMPT_PATH": self._PROMPT_PATH,
            "MIPHAM_RESULT_PATH": (EnvironmentPaths.agent_dir / self._RESULT_FILENAME).as_posix(),
            "MIPHAM_TRANSCRIPT_PATH": (
                EnvironmentPaths.agent_dir / self._TRANSCRIPT_FILENAME
            ).as_posix(),
            "MIPHAM_DRIVER_LOG_PATH": (
                EnvironmentPaths.agent_dir / self._DRIVER_LOG_FILENAME
            ).as_posix(),
            "DEEPSEEK_API_KEY": api_key,
            "MIPHAM_SESSION_PROVIDER": self._get_env("MIPHAM_SESSION_PROVIDER") or "deepseek",
            "MIPHAM_SESSION_MODEL": self._get_env("MIPHAM_SESSION_MODEL")
            or (self.model_name or "deepseek-v4-pro"),
            "MIPHAM_EXEC_TIMEOUT_SEC": self._get_env("MIPHAM_EXEC_TIMEOUT_SEC") or "840",
            # Required by REQUIRED_ENV, so it has to be supplied here: without
            # it the driver raises before its first step and *every* trial
            # fails. --ae can override it; the default is the tier spec §3.4
            # fixes for this benchmark (the default mode blocks Bash/Write).
            "MIPHAM_DAEMON_PERMISSION": self._get_env("MIPHAM_DAEMON_PERMISSION")
            or "bypassPermissions",
        }

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment,
            ("curl", "bash", "ca_certificates", "coreutils", "python3"),
        )
        await self.exec_as_agent(environment, command=self.install_command())
