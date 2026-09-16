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


class FrameParser:
    """Incremental frame decoder: feed arbitrary chunks, get whole frames.

    Buffers whatever cannot be completed yet, so the caller never has to
    think about TCP segmentation.
    """

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[tuple[int, bytes]]:
        self._buf += data
        frames: list[tuple[int, bytes]] = []
        while True:
            frame = self._take()
            if frame is None:
                return frames
            frames.append(frame)

    def _take(self) -> tuple[int, bytes] | None:
        buf = self._buf
        if len(buf) < 2:
            return None
        first, second = buf[0], buf[1]
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        offset = 2
        if length == 126:
            if len(buf) < offset + 2:
                return None
            length = struct.unpack("!H", bytes(buf[offset : offset + 2]))[0]
            offset += 2
        elif length == 127:
            if len(buf) < offset + 8:
                return None
            length = struct.unpack("!Q", bytes(buf[offset : offset + 8]))[0]
            offset += 8
        key = b""
        if masked:
            if len(buf) < offset + 4:
                return None
            key = bytes(buf[offset : offset + 4])
            offset += 4
        if len(buf) < offset + length:
            return None
        payload = bytes(buf[offset : offset + length])
        del buf[: offset + length]
        if masked:
            payload = _xor(payload, key)
        if not first & 0x80:
            raise WsError("fragmented frames are not supported")
        return opcode, payload
