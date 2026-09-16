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
        self.assertEqual(
            bytes(b ^ key[i % 4] for i, b in enumerate(frame[6:])),
            b"hello",
        )

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

    def test_fin_flag_is_clearable(self):
        self.assertEqual(ws.encode_frame(ws.OP_TEXT, b"", mask=False, fin=False)[0], 0x01)


if __name__ == "__main__":
    unittest.main()
