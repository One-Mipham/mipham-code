import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from benchmarks.harbor.driver import client


class _Handler(BaseHTTPRequestHandler):
    """A stand-in daemon that records requests and replays canned replies."""

    responses: dict[tuple[str, str], tuple[int, dict]] = {}
    seen: list[tuple[str, str, dict | None]] = []

    def _reply(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 — BaseHTTPRequestHandler's API
        _Handler.seen.append(("GET", self.path, None))
        status, body = _Handler.responses.get(
            ("GET", self.path), (404, {"ok": False, "error": "Not found"})
        )
        self._reply(status, body)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        parsed = json.loads(raw) if raw else None
        _Handler.seen.append(("POST", self.path, parsed))
        status, body = _Handler.responses.get(
            ("POST", self.path), (404, {"ok": False, "error": "Not found"})
        )
        self._reply(status, body)

    def log_message(self, *args: object) -> None:
        pass


class DaemonClientTest(unittest.TestCase):
    def setUp(self) -> None:
        _Handler.responses = {}
        _Handler.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        # addCleanup runs LIFO, so these must be registered in reverse of the
        # order they have to run (shutdown -> server_close -> join):
        # join() on a thread parked in serve_forever() only returns once
        # shutdown() has been called, and shutdown() does not close the
        # listening socket — skipping server_close() leaks it until GC, which
        # surfaces as a ResourceWarning in the middle of the next test.
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_read_port_returns_the_integer_in_the_port_file(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, ".mipham"))
            with open(os.path.join(home, ".mipham", "daemon.port"), "w") as handle:
                handle.write("45671\n")
            self.assertEqual(client.read_port(home, timeout_sec=0.5), 45671)

    def test_read_port_gives_up_loudly(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaises(client.DaemonError):
                client.read_port(home, timeout_sec=0.3)

    def test_create_session_sends_cwd_and_returns_the_id(self):
        path = "/api/v1/sessions"
        _Handler.responses[("POST", path)] = (
            201,
            {"ok": True, "data": {"session": {"id": "sess-1", "cwd": "/task"}}},
        )
        session_id = client.DaemonClient(self.port).create_session(
            name="t2", cwd="/task", provider="deepseek", model="deepseek-v4-pro"
        )
        self.assertEqual(session_id, "sess-1")
        _, _, body = _Handler.seen[-1]
        self.assertEqual(body, {
            "name": "t2",
            "cwd": "/task",
            "provider": "deepseek",
            "model": "deepseek-v4-pro",
        })

    def test_a_403_carries_the_daemon_explanation(self):
        # The cwd whitelist is the failure this adapter is most likely to hit
        # (spec §3.4), so the error text has to survive the trip.
        path = "/api/v1/sessions"
        _Handler.responses[("POST", path)] = (
            403,
            {
                "ok": False,
                "error": "cwd must be a trusted workspace or inside the daemon directory",
            },
        )
        with self.assertRaises(client.DaemonError) as caught:
            client.DaemonClient(self.port).create_session(
                name="t2", cwd="/elsewhere", provider="deepseek", model="m"
            )
        self.assertIn("trusted workspace", str(caught.exception))

    def test_prompt_posts_the_text_to_the_session(self):
        path = "/api/v1/sessions/sess-1/prompt"
        _Handler.responses[("POST", path)] = (
            202,
            {"ok": True, "data": {"sessionId": "sess-1", "status": "processing"}},
        )
        client.DaemonClient(self.port).prompt("sess-1", "do the thing")
        _, _, body = _Handler.seen[-1]
        self.assertEqual(body, {"prompt": "do the thing"})

    def test_wait_until_ready_polls_health_then_returns_it(self):
        _Handler.responses[("GET", "/api/v1/health")] = (200, {"ok": True, "pid": 7})
        health = client.DaemonClient(self.port).wait_until_ready(timeout_sec=5.0)
        self.assertTrue(health["ok"])

    def test_session_returns_the_row(self):
        path = "/api/v1/sessions/sess-1"
        _Handler.responses[("GET", path)] = (
            200,
            {"ok": True, "data": {"session": {"id": "sess-1", "tokenIn": 12}}},
        )
        row = client.DaemonClient(self.port).session("sess-1")
        self.assertEqual(row["tokenIn"], 12)


if __name__ == "__main__":
    unittest.main()
