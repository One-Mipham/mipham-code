"""REST client for the Mipham daemon (spec §3.3 steps ②③⑤).

Loopback needs no token (spec §3.4), so there is nothing to authenticate with
here — ``/api/v1/health`` is unauthenticated by design (``auth.ts:87``) and the
rest trusts a genuine loopback source address (``auth.ts:89-92``).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

PORT_FILE_RELATIVE = os.path.join(".mipham", "daemon.port")


class DaemonError(Exception):
    """The daemon refused, vanished, or answered with something we cannot use."""


def read_port(home: str, timeout_sec: float = 30.0) -> int:
    """Wait for ``$HOME/.mipham/daemon.port`` to appear and parse it."""
    path = os.path.join(home, PORT_FILE_RELATIVE)
    deadline = time.monotonic() + timeout_sec
    while True:
        try:
            with open(path, encoding="utf-8") as handle:
                return int(handle.read().strip())
        except (OSError, ValueError):
            if time.monotonic() >= deadline:
                raise DaemonError(f"no readable port file at {path} after {timeout_sec}s")
            time.sleep(0.2)


class DaemonClient:
    def __init__(self, port: int) -> None:
        self._base = f"http://127.0.0.1:{port}"

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            self._base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            # urllib hands the error response to us unclosed so we can read the
            # body; closing it is on us, and skipping that leaks the socket.
            try:
                detail = exc.read().decode("utf-8", "replace")
            finally:
                exc.close()
            raise DaemonError(f"{method} {path} → HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise DaemonError(f"{method} {path} → {exc.reason}") from exc

    def health(self) -> dict:
        return self._request("GET", "/api/v1/health")

    def wait_until_ready(self, timeout_sec: float = 60.0) -> dict:
        deadline = time.monotonic() + timeout_sec
        last: Exception | None = None
        while time.monotonic() < deadline:
            try:
                health = self.health()
                if health.get("ok"):
                    return health
            except DaemonError as exc:
                last = exc
            time.sleep(0.25)
        raise DaemonError(f"daemon never became ready: {last}")

    def create_session(self, *, name: str, cwd: str, provider: str, model: str) -> str:
        reply = self._request(
            "POST",
            "/api/v1/sessions",
            {"name": name, "cwd": cwd, "provider": provider, "model": model},
        )
        try:
            return str(reply["data"]["session"]["id"])
        except (KeyError, TypeError) as exc:
            raise DaemonError(f"unexpected session reply: {reply!r}") from exc

    def prompt(self, session_id: str, text: str) -> None:
        self._request("POST", f"/api/v1/sessions/{session_id}/prompt", {"prompt": text})

    def session(self, session_id: str) -> dict:
        reply = self._request("GET", f"/api/v1/sessions/{session_id}")
        try:
            return dict(reply["data"]["session"])
        except (KeyError, TypeError) as exc:
            raise DaemonError(f"unexpected session reply: {reply!r}") from exc
