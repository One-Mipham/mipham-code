import unittest

from benchmarks.harbor.driver import protocol


class ReduceMessageTest(unittest.TestCase):
    def test_usage_frames_accumulate(self):
        # The daemon emits one usage frame per LLM call (spec §3.6), so a
        # task's token count is a sum, never a single frame.
        state = protocol.TurnState()
        protocol.reduce_message(
            state, '{"type":"usage","sessionId":"s","inputTokens":100,"outputTokens":20}'
        )
        protocol.reduce_message(
            state, '{"type":"usage","sessionId":"s","inputTokens":300,"outputTokens":40}'
        )
        self.assertEqual(state.input_tokens, 400)
        self.assertEqual(state.output_tokens, 60)
        self.assertEqual(state.total_tokens, 460)

    def test_text_frame_moves_no_counters(self):
        state = protocol.TurnState()
        protocol.reduce_message(state, '{"type":"text","sessionId":"s","content":"hi"}')
        self.assertEqual(state.total_tokens, 0)

    def test_tool_result_counts_errors_only_when_iserror_is_true(self):
        state = protocol.TurnState()
        protocol.reduce_message(
            state, '{"type":"tool_result","sessionId":"s","toolId":"t1","content":"ok"}'
        )
        protocol.reduce_message(
            state,
            '{"type":"tool_result","sessionId":"s","toolId":"t2","content":"boom","isError":true}',
        )
        self.assertEqual(state.tool_results, 2)
        self.assertEqual(state.tool_errors, 1)

    def test_done_ends_the_turn(self):
        state = protocol.TurnState()
        protocol.reduce_message(
            state, '{"type":"done","sessionId":"s","stopReason":"end_turn"}'
        )
        self.assertTrue(state.finished)
        self.assertEqual(state.stop_reason, "end_turn")

    def test_error_is_recorded_and_ends_the_turn(self):
        state = protocol.TurnState()
        protocol.reduce_message(state, '{"type":"error","sessionId":"s","message":"nope"}')
        self.assertTrue(state.finished)
        self.assertEqual(state.last_error, "nope")

    def test_unknown_type_is_loud(self):
        # Protocol drift must not be silently swallowed: a new server frame
        # that we ignore is a counter we never see.
        state = protocol.TurnState()
        with self.assertRaises(protocol.ProtocolError):
            protocol.reduce_message(state, '{"type":"something_new","sessionId":"s"}')

    def test_malformed_json_is_loud(self):
        state = protocol.TurnState()
        with self.assertRaises(protocol.ProtocolError):
            protocol.reduce_message(state, "not json at all")

    def test_reduce_returns_the_parsed_message(self):
        state = protocol.TurnState()
        parsed = protocol.reduce_message(
            state, '{"type":"text","sessionId":"s","content":"hi"}'
        )
        self.assertEqual(parsed["content"], "hi")


if __name__ == "__main__":
    unittest.main()
