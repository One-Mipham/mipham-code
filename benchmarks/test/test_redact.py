import os
import unittest
from unittest import mock

from benchmarks import redact

#: Deliberately **not** ``sk``-shaped. The arms that remove *this exact value*
#: are the ones under test here; an ``sk``-shaped stand-in would also be caught
#: by the shape arm, which would let those arms be deleted while the tests that
#: are named for them stayed green.
FAKE_KEY = "zzz-not-a-shape-0001"

#: ``sk``-shaped, for the arms that are about the shape rather than the value.
SHAPED = "sk-not-a-real-shape-0000000000"


class RedactTest(unittest.TestCase):
    def test_the_secret_value_is_replaced(self):
        text = f'{{"error": "auth failed for {FAKE_KEY}"}}'
        out = redact.redact(text, secret=FAKE_KEY)
        self.assertNotIn(FAKE_KEY, out)
        self.assertIn(redact.PLACEHOLDER, out)

    def test_an_sk_shaped_token_is_replaced_even_when_it_is_not_the_secret(self):
        out = redact.redact(f"echoed {SHAPED}", secret=FAKE_KEY)
        self.assertNotIn(SHAPED, out)
        self.assertIn(redact.PLACEHOLDER, out)

    def test_the_secret_is_read_from_the_environment(self):
        # `secret` is deliberately omitted: the value has to reach redact()
        # through API_KEY_ENV or not at all. patch.dict restores the variable,
        # and only the stand-in is ever set -- never a real key.
        with mock.patch.dict(os.environ, {redact.API_KEY_ENV: FAKE_KEY}):
            out = redact.redact(f"leaked {FAKE_KEY}")
        self.assertNotIn(FAKE_KEY, out)
        self.assertIn(redact.PLACEHOLDER, out)

    def test_an_unset_variable_leaves_the_shape_arm_working(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(redact.redact(f"leaked {SHAPED}"), "leaked <redacted>")

    def test_ordinary_text_passes_through_untouched(self):
        text = '{"status": "done", "error": null}'
        self.assertEqual(redact.redact(text, secret=FAKE_KEY), text)


if __name__ == "__main__":
    unittest.main()
