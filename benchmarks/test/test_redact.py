import os
import unittest
from unittest import mock

from benchmarks import redact

FAKE_KEY = "sk-not-a-real-key-0000000000"


class RedactTest(unittest.TestCase):
    def test_the_secret_value_is_replaced(self):
        text = f'{{"error": "auth failed for {FAKE_KEY}"}}'
        self.assertNotIn(FAKE_KEY, redact.redact(text, secret=FAKE_KEY))
        self.assertIn(redact.PLACEHOLDER, redact.redact(text, secret=FAKE_KEY))

    def test_an_sk_shaped_token_is_replaced_even_when_it_is_not_the_secret(self):
        other = "sk-some-other-token-abcdefgh"
        self.assertNotIn(other, redact.redact(f"echoed {other}", secret=FAKE_KEY))

    def test_the_secret_is_read_from_the_environment(self):
        with mock.patch.dict(os.environ, {redact.API_KEY_ENV: FAKE_KEY}):
            self.assertNotIn(FAKE_KEY, redact.redact(f"leaked {FAKE_KEY}"))

    def test_an_unset_variable_leaves_the_shape_arm_working(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(redact.redact(f"leaked {FAKE_KEY}"), "leaked <redacted>")

    def test_ordinary_text_passes_through_untouched(self):
        text = '{"status": "done", "error": null}'
        self.assertEqual(redact.redact(text, secret=FAKE_KEY), text)


if __name__ == "__main__":
    unittest.main()
