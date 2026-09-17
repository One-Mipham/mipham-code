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

import contextlib
import json
import os
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from benchmarks import budget  # adapter is imported by harbor, so this needs PYTHONPATH=<repo root>


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
        "https://github.com/One-Mipham/mipham-code/releases/download/v0.81.7/mipham-linux-x64"
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
            # `--ae` stays the explicit override; otherwise take harbor's own
            # parse of `-m provider/model` (base.py `_init_model_info`, which
            # splits on the first "/"). Forwarding `self.model_name` raw is what
            # sent `deepseek/deepseek-v4-pro` to an endpoint that accepts only
            # the bare name: harbor *displays* the parsed name and *stores* the
            # fused one, and only the display path was right.
            "MIPHAM_SESSION_PROVIDER": self._get_env("MIPHAM_SESSION_PROVIDER")
            or self._parsed_model_provider
            or "deepseek",
            "MIPHAM_SESSION_MODEL": self._get_env("MIPHAM_SESSION_MODEL")
            or self._parsed_model_name
            or "deepseek-v4-pro",
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

    _DRIVER_MODULE = "benchmarks.harbor.driver"
    _LEDGER_ENV = "MIPHAM_BENCH_LEDGER"

    @staticmethod
    def ledger_path() -> Path:
        """``benchmarks/results/ledger.json``.

        Resolved from this file's own location rather than the process's cwd:
        harbor imports the adapter from wherever it happens to be running, and
        a cwd-relative path would silently write a *second* ledger — which
        looks exactly like a fresh, unspent budget.
        """
        override = os.environ.get(MiphamCode._LEDGER_ENV)
        if override:
            return Path(override)
        return Path(__file__).resolve().parents[1] / "results" / "ledger.json"

    @staticmethod
    def parse_result(stdout: str) -> dict:
        text = (stdout or "").strip()
        if not text:
            return {}
        try:
            return dict(json.loads(text))
        except json.JSONDecodeError as exc:
            raise ValueError(f"driver produced no parsable result: {text[:200]!r}") from exc

    @staticmethod
    def apply_context(context: AgentContext, result: dict) -> None:
        """Fill AgentContext from the driver's report.

        ``n_cache_tokens`` and ``cost_usd`` stay None on purpose: the WS usage
        frame carries two totals and no cache-hit split, so anything filled in
        there would be invented (spec §六).
        """
        usage = result.get("usage") or {}
        if usage.get("inputTokens") is not None:
            context.n_input_tokens = int(usage["inputTokens"])
        if usage.get("outputTokens") is not None:
            context.n_output_tokens = int(usage["outputTokens"])
        context.metadata = {
            "mipham": {
                "status": result.get("status"),
                "error": result.get("error"),
                "turns": result.get("turns"),
                "stopReason": result.get("stopReason"),
                "toolResults": result.get("toolResults"),
                "sessionCounters": result.get("sessionCounters"),
                "binaryVersion": result.get("binaryVersion"),
                "binarySha256": result.get("binarySha256"),
                "budgetTokens": result.get("budgetTokens"),
                "elapsedSec": result.get("elapsedSec"),
                "workdir": result.get("workdir"),
                "sessionId": result.get("sessionId"),
                "ledgerError": result.get("ledgerError"),
                "ledgerNote": result.get("ledgerNote"),
                "execError": result.get("execError"),
            }
        }

    async def _upload_driver(self, environment: BaseEnvironment) -> None:
        await environment.upload_dir(
            Path(__file__).resolve().parent / "driver",
            self._DRIVER_DIR,
        )

    async def _upload_prompt(self, environment: BaseEnvironment, instruction: str) -> None:
        """Upload the task text as a file.

        Never interpolate it into a shell command: task instructions contain
        quotes, backticks and newlines, and a quoting bug here would corrupt
        the prompt in a way that still produces a plausible-looking score.
        """
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False)
        try:
            with handle:
                handle.write(instruction)
            await environment.upload_file(handle.name, self._PROMPT_PATH)
        finally:
            with contextlib.suppress(OSError):
                os.unlink(handle.name)

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self.driver_env()
        ledger = budget.Ledger(self.ledger_path())
        env["MIPHAM_BUDGET_TOKENS"] = str(ledger.remaining())

        await self._upload_driver(environment)
        await self._upload_prompt(environment, instruction)

        result: dict = {}
        readable = False
        exec_error: str | None = None
        readback = "cat " + (EnvironmentPaths.agent_dir / self._RESULT_FILENAME).as_posix()
        try:
            # One call, all seven steps: HOME has to be identical for the whole
            # daemon lifetime, and this is the only frame that guarantees it.
            await self.exec_as_agent(
                environment,
                command=f"python3 {self._DRIVER_DIR}/main.py",
                env=env,
                cwd=None,  # harbor discovered the workdir itself (see below)
                timeout_sec=int(env["MIPHAM_EXEC_TIMEOUT_SEC"]),
            )
        except Exception as exc:
            # exec_as_agent raises on any non-zero exit, and the driver exits 1
            # for every status except ``done`` and ``budget_exceeded``, so
            # deadline_exceeded / stream_closed / failed all arrive here.
            # Letting that escape would skip apply_context below — reporting
            # nothing for exactly the trials the result file exists to disclose.
            exec_error = f"{type(exc).__name__}: {exc}"
        finally:
            # The driver rewrites its result on every state change, so even a
            # killed run leaves something to read back. Best effort: never mask
            # the run's own exception.
            with contextlib.suppress(Exception):
                completed = await self.exec_as_agent(environment, command=readback)
                try:
                    parsed = self.parse_result(completed.stdout)
                except (ValueError, TypeError) as exc:
                    # A truncated write looks exactly like "the driver never
                    # wrote anything" once the suppress swallows it, and this
                    # file is the only disclosure the paid run leaves behind.
                    # TypeError as well as ValueError: valid JSON that is not an
                    # object (e.g. "[1,2]") makes parse_result's dict() raise
                    # TypeError, which would otherwise slip past this branch and
                    # be swallowed into the very ambiguity it exists to remove.
                    result = {"error": f"unreadable driver result: {exc}"}
                else:
                    result = parsed
                    # A non-empty report means the driver accounted for itself;
                    # an empty readback means it never got that far.
                    readable = bool(parsed)
            # remaining() is the ceiling's only enforcement point and Task 13
            # audits the ledger arithmetically, so a 0 recorded because nothing
            # could be read must not be written the same way as a 0 the driver
            # actually reported. A real session id stays the bare note — Task 13
            # joins ledger entries to trials through it.
            note = str(result.get("sessionId") or "")
            if not note:
                note = "no-session" if readable else "spend-unknown"
            result["ledgerNote"] = note
            try:
                ledger.record(
                    (result.get("usage") or {}).get("inputTokens", 0)
                    + (result.get("usage") or {}).get("outputTokens", 0),
                    note=note,
                )
            except Exception as exc:
                result["ledgerError"] = str(exc)

        if exec_error is not None:
            result["execError"] = exec_error

        self.apply_context(context, result)
