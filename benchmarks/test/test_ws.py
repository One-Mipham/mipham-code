import unittest

from benchmarks.harbor.driver import ws


class ComputeAcceptTest(unittest.TestCase):
    def test_rfc6455_section_1_3_vector(self):
        # The canonical example from RFC 6455 §1.3.
        self.assertEqual(
            ws.compute_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        )


class EncodeFrameTest(unittest.TestCase):
    def test_short_text_frame_is_masked_and_round_trips(self):
        frame = ws.encode_frame(ws.OP_TEXT, b"hello", mask=True)
        self.assertEqual(len(frame), 11)  # 2 header + 4 mask + 5 payload
        self.assertEqual(frame[0], 0x81)  # FIN + text opcode
        self.assertEqual(frame[1], 0x85)  # mask bit + length 5
        key = frame[2:6]
        # This verifies the payload against the key read out of the *same*
        # frame, so it is satisfied by any key at all — including a constant.
        # It pins the layout and the XOR, not the entropy: that is what the
        # next test is for.
        self.assertEqual(
            bytes(b ^ key[i % 4] for i, b in enumerate(frame[6:])),
            b"hello",
        )

    def test_masking_key_is_not_a_constant(self):
        # RFC 6455 §5.3 requires the masking key to come from a strong source
        # of entropy. Nothing above tests that: reading the key back out of the
        # frame and un-XORing with it proves consistency, never randomness, and
        # b"\x00\x00\x00\x00" is a valid-looking key (the XOR is the identity).
        # So pin the property directly — two encodes of the same payload must
        # not reuse a key. That kills every key computed from this call's own
        # inputs (constant, all-zero, payload- or opcode-derived) at a
        # false-failure probability of 2**-32 — but it does *not* catch a key
        # derived from call history: a counter returns two different values
        # here while staying fully deterministic. Separating that from
        # os.urandom needs statistical testing, which is out of scope. This
        # pins the property every honest implementation satisfies.
        first = ws.encode_frame(ws.OP_TEXT, b"hello", mask=True)[2:6]
        second = ws.encode_frame(ws.OP_TEXT, b"hello", mask=True)[2:6]
        self.assertNotEqual(first, second)

    def test_unmasked_frame_carries_payload_verbatim(self):
        frame = ws.encode_frame(ws.OP_TEXT, b"hello", mask=False)
        self.assertEqual(frame, b"\x81\x05hello")

    def test_length_encoding_boundaries(self):
        self.assertEqual(ws.encode_frame(ws.OP_TEXT, b"x" * 125, mask=False)[1], 125)
        two = ws.encode_frame(ws.OP_TEXT, b"x" * 126, mask=False)
        self.assertEqual(two[1], 126)
        self.assertEqual(two[2:4], b"\x00\x7e")
        eight = ws.encode_frame(ws.OP_TEXT, b"x" * 65536, mask=False)
        self.assertEqual(eight[1], 127)
        self.assertEqual(eight[2:10], b"\x00\x00\x00\x00\x00\x01\x00\x00")

    def test_masked_extended_lengths_keep_the_mask_bit(self):
        # Every boundary case above passes mask=False, so the `flag | 126` and
        # `flag | 127` branches are never exercised with the mask bit set — a
        # mutant dropping `flag` in either survives. A masked frame's key sits
        # at 2 + len(extended length): 4 for 16-bit, 10 for 64-bit, versus 2
        # for the 7-bit case the first test covers. Pin the bit *and* the
        # layout, since Task 2's parser must read that offset back.
        for payload, key_at in ((b"x" * 126, 4), (b"x" * 65536, 10)):
            frame = ws.encode_frame(ws.OP_TEXT, payload, mask=True)
            self.assertEqual(frame[1] & 0x80, 0x80, len(payload))
            key = frame[key_at : key_at + 4]
            self.assertEqual(
                bytes(b ^ key[i % 4] for i, b in enumerate(frame[key_at + 4 :])),
                payload,
                len(payload),
            )

    def test_fin_flag_is_clearable(self):
        self.assertEqual(ws.encode_frame(ws.OP_TEXT, b"", mask=False, fin=False)[0], 0x01)


class FrameParserTest(unittest.TestCase):
    def test_whole_frame(self):
        parser = ws.FrameParser()
        self.assertEqual(parser.feed(b"\x81\x05hello"), [(ws.OP_TEXT, b"hello")])

    def test_split_across_every_boundary_is_identical(self):
        parser_whole = ws.FrameParser()
        frame = ws.encode_frame(ws.OP_TEXT, b"a longer payload", mask=True)
        self.assertEqual(parser_whole.feed(frame), [(ws.OP_TEXT, b"a longer payload")])

        for cut in range(1, len(frame)):
            parser = ws.FrameParser()
            frames = parser.feed(frame[:cut]) + parser.feed(frame[cut:])
            self.assertEqual(frames, [(ws.OP_TEXT, b"a longer payload")], f"cut={cut}")

    def test_partial_frame_is_withheld(self):
        parser = ws.FrameParser()
        self.assertEqual(parser.feed(b"\x81\x05hel"), [])
        self.assertEqual(parser.feed(b"lo"), [(ws.OP_TEXT, b"hello")])

    def test_two_frames_in_one_chunk(self):
        parser = ws.FrameParser()
        chunk = b"\x81\x03one" + b"\x81\x03two"
        self.assertEqual(parser.feed(chunk), [(ws.OP_TEXT, b"one"), (ws.OP_TEXT, b"two")])

    def test_extended_length_16_bit(self):
        parser = ws.FrameParser()
        payload = b"x" * 300
        frame = ws.encode_frame(ws.OP_TEXT, payload, mask=False)
        self.assertEqual(parser.feed(frame), [(ws.OP_TEXT, payload)])

    def test_extended_length_64_bit(self):
        parser = ws.FrameParser()
        payload = b"y" * 70000
        frame = ws.encode_frame(ws.OP_TEXT, payload, mask=False)
        self.assertEqual(parser.feed(frame), [(ws.OP_TEXT, payload)])

    def test_fragmented_frame_is_rejected_loudly(self):
        parser = ws.FrameParser()
        with self.assertRaises(ws.WsError):
            parser.feed(ws.encode_frame(ws.OP_TEXT, b"ab", mask=False, fin=False))

    def test_masked_extended_length_round_trips(self):
        # Every extended-length case above passes mask=False, and every masked
        # case above is short — so no test reads a masked frame whose length
        # sits in the extended field. That is the one combination where the
        # masking key's offset moves (2+2 for 16-bit, 2+8 for 64-bit, versus
        # 2 for the 7-bit case), so a parser that read the key at a fixed
        # offset would pass every other test here and still mangle this one.
        for payload in (b"x" * 300, b"y" * 70000):
            parser = ws.FrameParser()
            frame = ws.encode_frame(ws.OP_TEXT, payload, mask=True)
            self.assertEqual(parser.feed(frame), [(ws.OP_TEXT, payload)], len(payload))

    def test_masked_extended_length_split_at_every_header_boundary(self):
        # The split test above sweeps a *short* masked frame, so it reaches
        # only two of the four `return None` exits. These cuts land in each of
        # them on the extended-length path: mid-length-field, mid-key, and
        # with a complete header but an incomplete payload.
        for payload, header in ((b"x" * 300, 2 + 2 + 4), (b"y" * 70000, 2 + 8 + 4)):
            frame = ws.encode_frame(ws.OP_TEXT, payload, mask=True)
            for cut in [1, *range(2, header + 1), len(frame) - 1]:
                parser = ws.FrameParser()
                label = f"payload={len(payload)} cut={cut}"
                self.assertEqual(parser.feed(frame[:cut]), [], label)
                self.assertEqual(parser.feed(frame[cut:]), [(ws.OP_TEXT, payload)], label)

    def test_a_complete_frame_before_a_half_frame_is_delivered_first(self):
        # What is whole must come back without waiting for what follows: a
        # parser that only returned on an empty buffer would deadlock a caller
        # that reads one frame at a time.
        parser = ws.FrameParser()
        self.assertEqual(parser.feed(b"\x81\x03one" + b"\x81\x05he"), [(ws.OP_TEXT, b"one")])
        self.assertEqual(parser.feed(b"llo"), [(ws.OP_TEXT, b"hello")])


class FakeSocket:
    """A socket-shaped object that replays canned bytes and records writes."""

    def __init__(self, incoming: bytes) -> None:
        self._incoming = bytearray(incoming)
        self.sent = bytearray()
        self.closed = False

    def recv(self, _size: int) -> bytes:
        if not self._incoming:
            return b""
        chunk = bytes(self._incoming[:7])  # deliberately not aligned to frames
        del self._incoming[:7]
        return chunk

    def sendall(self, data: bytes) -> None:
        self.sent += data

    def close(self) -> None:
        self.closed = True


class WsConnectionTest(unittest.TestCase):
    def _connection(self, incoming: bytes) -> tuple[ws.WsConnection, FakeSocket]:
        sock = FakeSocket(incoming)
        return ws.WsConnection(sock), sock

    def test_recv_text_returns_the_payload(self):
        conn, _ = self._connection(ws.encode_frame(ws.OP_TEXT, b"hi", mask=False))
        self.assertEqual(conn.recv_text(), "hi")

    def test_recv_text_answers_ping_with_pong_then_yields_text(self):
        conn, sock = self._connection(
            ws.encode_frame(ws.OP_PING, b"ping-payload", mask=False)
            + ws.encode_frame(ws.OP_TEXT, b"after-ping", mask=False)
        )
        self.assertEqual(conn.recv_text(), "after-ping")
        expected = ws.encode_frame(ws.OP_PONG, b"ping-payload", mask=True)
        self.assertEqual(sock.sent[:2], expected[:2])  # opcode + masked length
        self.assertEqual(
            bytes(b ^ sock.sent[2:6][i % 4] for i, b in enumerate(sock.sent[6:])),
            b"ping-payload",
        )

    def test_recv_text_returns_none_on_close(self):
        conn, _ = self._connection(ws.encode_frame(ws.OP_CLOSE, b"", mask=False))
        self.assertIsNone(conn.recv_text())

    def test_recv_text_raises_when_peer_disappears(self):
        sock = FakeSocket(b"")
        with self.assertRaises(ws.WsError):
            ws.WsConnection(sock).recv_text()

    def test_close_sends_a_close_frame_and_closes_the_socket(self):
        conn, sock = self._connection(b"")
        conn.close()
        self.assertEqual(sock.sent[0], 0x88)  # FIN + close opcode
        self.assertTrue(sock.closed)

    def test_connect_accepts_a_correct_accept(self):
        # Positive control. Without it, every negative test below would still
        # pass against an implementation that raised unconditionally.
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        self.assertEqual(ws.compute_accept(key), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

        class AcceptingSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(
                    b"HTTP/1.1 101 Switching Protocols\r\n"
                    b"Upgrade: websocket\r\n"
                    b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
                    b"\r\n"
                )

        conn = ws.WsConnection._from_socket(AcceptingSocket(), key)
        self.assertIsInstance(conn, ws.WsConnection)

    def test_connect_rejects_a_non_101_status(self):
        class RefusingSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(b"HTTP/1.1 403 Forbidden\r\n\r\n")

        with self.assertRaises(ws.WsError):
            ws.WsConnection._from_socket(RefusingSocket(), "dGhlIHNhbXBsZSBub25jZQ==")

    def test_connect_rejects_a_mismatched_accept(self):
        # The header carries a *real* accept value — just one computed from a
        # different key — so this proves the comparison is keyed to the key we
        # actually sent, not merely that some header was present.
        class MismatchedSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(
                    b"HTTP/1.1 101 Switching Protocols\r\n"
                    b"Upgrade: websocket\r\n"
                    b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
                    b"\r\n"
                )

        with self.assertRaises(ws.WsError):
            ws.WsConnection._from_socket(
                MismatchedSocket(), "AAAAAAAAAAAAAAAAAAAAAA=="
            )

    def test_connect_rejects_a_101_without_an_accept_header(self):
        class NoHeaderSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"
                )

        with self.assertRaises(ws.WsError):
            ws.WsConnection._from_socket(NoHeaderSocket(), "dGhlIHNhbXBsZSBub25jZQ==")

    def test_recv_text_raises_on_invalid_utf8(self):
        frame = ws.encode_frame(ws.OP_TEXT, b"\xff\xfe", mask=False)
        conn, _ = self._connection(frame)
        with self.assertRaises(ws.WsError):
            conn.recv_text()

    def test_recv_text_ignores_a_pong_and_yields_the_next_text(self):
        # A pong is a control frame the peer may send at any time; it carries
        # no message, so it must be stepped over rather than handed to the
        # caller or treated as unknown.
        conn, _ = self._connection(
            ws.encode_frame(ws.OP_PONG, b"unsolicited", mask=False)
            + ws.encode_frame(ws.OP_TEXT, b"after-pong", mask=False)
        )
        self.assertEqual(conn.recv_text(), "after-pong")

    def test_recv_text_raises_on_an_unknown_opcode(self):
        # 0x3 is a reserved non-control opcode. RFC 6455 §5.2 says a peer must
        # fail the connection on one, and silently skipping it would leave the
        # caller reading a stream whose framing it cannot account for. A valid
        # text frame trails it, and the message is checked, so this cannot be
        # satisfied by a socket that merely ran dry — either would raise
        # WsError too, and only one of them is the behaviour under test.
        conn, _ = self._connection(
            ws.encode_frame(0x3, b"", mask=False) + ws.encode_frame(ws.OP_TEXT, b"after", mask=False)
        )
        with self.assertRaises(ws.WsError) as caught:
            conn.recv_text()
        self.assertIn("0x3", str(caught.exception))

    def test_a_frame_in_the_handshake_segment_is_not_lost(self):
        # A server may write the 101 response and the first frame without
        # waiting for us in between. Those bytes arrive in the same `recv` as
        # the headers, so they have to be handed to the parser rather than
        # discarded with `raw` — and FakeSocket hands them over in 7-byte
        # chunks, so the tail also crosses a recv boundary mid-frame.
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        greeting = ws.encode_frame(ws.OP_TEXT, b"already-here", mask=False)

        class GreetingSocket(FakeSocket):
            def __init__(self) -> None:
                super().__init__(
                    b"HTTP/1.1 101 Switching Protocols\r\n"
                    b"Upgrade: websocket\r\n"
                    b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
                    b"\r\n" + greeting
                )

        conn = ws.WsConnection._from_socket(GreetingSocket(), key)
        self.assertEqual(conn.recv_text(), "already-here")


if __name__ == "__main__":
    unittest.main()
