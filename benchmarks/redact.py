"""Redaction for the artifacts that are written into ``benchmarks/results/``.

``benchmarks/jobs/`` holds the raw container output and is gitignored; that is
what you read when a run goes wrong, so it stays verbatim. ``results/`` is the
committed record, and this repository is public -- so the archive is redacted
at the moment it is written there. The boundary is the write, not the
collection.
"""

from __future__ import annotations

import os
import re

PLACEHOLDER = "<redacted>"

#: The variable holding the model API key. Its *value* is read from the host
#: environment at call time and is never printed, logged, or written anywhere.
API_KEY_ENV = "DEEPSEEK_API_KEY"

#: A *standalone* ``sk-`` followed by a token run (not preceded by a word character). Independent of `API_KEY_ENV` on purpose:
#: the driver and the daemon surface text that came from elsewhere, and whether
#: that text can echo some *other* key has never been measured. This arm does
#: not depend on that measurement.
_TOKEN_SHAPE = re.compile(r"(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{8,}")


def redact(text: str, secret: str | None = None) -> str:
    """Return ``text`` with the API key removed.

    ``secret`` defaults to the host's ``DEEPSEEK_API_KEY``. When that variable
    is unset the exact-value arm is inert and the shape arm still applies.
    """
    if secret is None:
        secret = os.environ.get(API_KEY_ENV, "")
    if secret:
        text = text.replace(secret, PLACEHOLDER)
    return _TOKEN_SHAPE.sub(PLACEHOLDER, text)
