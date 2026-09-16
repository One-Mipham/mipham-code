"""Minimal RFC 6455 client, text frames only.

The Python standard library ships no WebSocket client and this repository
takes no third-party dependencies, so the ~130 lines here *are* the client
(spec §3.5 calls this the one real cost of the adapter approach).

Client-to-server frames MUST be masked and server-to-client frames MUST NOT
be (RFC 6455 §5.1) — the asymmetry is why :func:`encode_frame` takes a
``mask`` flag rather than picking a side.
"""

from __future__ import annotations

import base64
import hashlib
import os
import struct

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class WsError(Exception):
    """A protocol violation, or a close we did not ask for."""


def compute_accept(key: str) -> str:
    """``Sec-WebSocket-Accept`` for a client's ``Sec-WebSocket-Key``."""
    digest = hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _xor(payload: bytes, key: bytes) -> bytes:
    return bytes(byte ^ key[index % 4] for index, byte in enumerate(payload))


def encode_frame(opcode: int, payload: bytes, *, mask: bool, fin: bool = True) -> bytes:
    """Encode one unfragmented frame."""
    out = bytearray()
    out.append((0x80 if fin else 0x00) | opcode)
    length = len(payload)
    flag = 0x80 if mask else 0x00
    if length < 126:
        out.append(flag | length)
    elif length < 65536:
        out.append(flag | 126)
        out += struct.pack("!H", length)
    else:
        out.append(flag | 127)
        out += struct.pack("!Q", length)
    if mask:
        key = os.urandom(4)
        out += key
        out += _xor(payload, key)
    else:
        out += payload
    return bytes(out)
