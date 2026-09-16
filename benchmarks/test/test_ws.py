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


if __name__ == "__main__":
    unittest.main()
