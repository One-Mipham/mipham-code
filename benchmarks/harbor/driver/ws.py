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
import socket
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


class WsConnection:
    """One WebSocket connection: text in, text out, control frames handled."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._parser = FrameParser()
        self._ready: list[tuple[int, bytes]] = []

    @classmethod
    def connect(
        cls,
        host: str,
        port: int,
        path: str,
        *,
        timeout_sec: float | None = None,
    ) -> "WsConnection":
        sock = socket.create_connection((host, port), timeout=timeout_sec)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("ascii"))
        return cls._from_socket(sock, key)

    @classmethod
    def _from_socket(cls, sock: socket.socket, key: str) -> "WsConnection":
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = sock.recv(4096)
            if not chunk:
                raise WsError("connection closed during handshake")
            raw += chunk
        header = raw.decode("latin-1")
        status = header.split("\r\n", 1)[0]
        if "101" not in status:
            raise WsError(f"handshake rejected: {status}")
        expected = compute_accept(key)
        for line in header.split("\r\n"):
            name, _, value = line.partition(":")
            if name.strip().lower() == "sec-websocket-accept":
                if value.strip() != expected:
                    raise WsError("Sec-WebSocket-Accept does not match the key we sent")
                conn = cls(sock)
                # Anything the server sent after the handshake is already ours.
                _, _, rest = raw.partition(b"\r\n\r\n")
                if rest:
                    conn._ready.extend(conn._parser.feed(rest))
                return conn
        raise WsError("handshake carried no Sec-WebSocket-Accept")

    def _next_frame(self) -> tuple[int, bytes]:
        while not self._ready:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise WsError("connection closed by peer")
            self._ready.extend(self._parser.feed(chunk))
        return self._ready.pop(0)

    def send_text(self, text: str) -> None:
        self._sock.sendall(encode_frame(OP_TEXT, text.encode("utf-8"), mask=True))

    def recv_text(self) -> str | None:
        """The next text message, or ``None`` once the peer closes."""
        while True:
            opcode, payload = self._next_frame()
            if opcode == OP_TEXT:
                try:
                    return payload.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise WsError("text frame is not valid UTF-8") from exc
            if opcode == OP_CLOSE:
                return None
            if opcode == OP_PING:
                self._sock.sendall(encode_frame(OP_PONG, payload, mask=True))
                continue
            if opcode == OP_PONG:
                continue
            raise WsError(f"unsupported opcode 0x{opcode:x}")

    def close(self) -> None:
        try:
            self._sock.sendall(encode_frame(OP_CLOSE, b"", mask=True))
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass
