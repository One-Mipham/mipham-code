"""Pure reducers over the daemon attach protocol.

The wire shapes mirror ``apps/cli/src/daemon/attach-protocol.ts``. Keeping the
reduction separate from the socket and the subprocess is what makes "tokens are
a protocol fact, not an estimate" (spec §3.6) testable without a daemon.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

TEXT = "text"
TOOL_USE = "tool_use"
TOOL_RESULT = "tool_result"
USAGE = "usage"
TASK_NOTIFICATION = "task_notification"
DONE = "done"
ERROR = "error"
SESSION_STATE = "session_state"

SERVER_TYPES = frozenset(
    {TEXT, TOOL_USE, TOOL_RESULT, USAGE, TASK_NOTIFICATION, DONE, ERROR, SESSION_STATE}
)


class ProtocolError(Exception):
    """A frame we do not understand, or one we cannot parse."""


@dataclass
class TurnState:
    input_tokens: int = 0
    output_tokens: int = 0
    turns: int = 0
    tool_results: int = 0
    tool_errors: int = 0
    stop_reason: str | None = None
    last_error: str | None = None
    finished: bool = False

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


def reduce_message(state: TurnState, raw: str) -> dict:
    """Fold one server frame into ``state``; return the parsed message.

    Extends ``state`` in place and returns the parsed dict so the caller can
    persist the frame verbatim as the transcript line.
    """
    try:
        message = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"unparseable frame: {raw[:200]!r}") from exc
    if not isinstance(message, dict):
        raise ProtocolError(f"frame is not a JSON object: {raw[:200]!r}")

    kind = message.get("type")
    if kind not in SERVER_TYPES:
        raise ProtocolError(f"unknown server frame type {kind!r}")

    if kind == USAGE:
        state.input_tokens += int(message.get("inputTokens") or 0)
        state.output_tokens += int(message.get("outputTokens") or 0)
    elif kind == TOOL_RESULT:
        state.tool_results += 1
        if message.get("isError"):
            state.tool_errors += 1
    elif kind == DONE:
        state.turns += 1
        state.stop_reason = message.get("stopReason")
        state.finished = True
    elif kind == ERROR:
        state.last_error = message.get("message")
        state.finished = True

    return message
