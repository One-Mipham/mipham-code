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

    # --- the shape arm is anchored at a leading boundary ---------------------
    # `flask` contains `sk`; without an anchor the shape arm eats the trial
    # name that `integration_gate.py` writes into the committed archive.

    def test_a_trial_name_from_the_archive_survives_the_shape_arm(self):
        self.assertEqual(
            redact.redact("pallets__flask-5014__uXpLmU7", secret=FAKE_KEY),
            "pallets__flask-5014__uXpLmU7",
        )

    def test_a_second_trial_name_from_the_archive_survives_the_shape_arm(self):
        self.assertEqual(
            redact.redact("pallets__flask-5014__4qvoGWk", secret=FAKE_KEY),
            "pallets__flask-5014__4qvoGWk",
        )

    def test_the_json_shape_of_a_trial_record_is_byte_identical(self):
        text = '{"trial": "pallets__flask-5014__uXpLmU7"}'
        self.assertEqual(
            redact.redact(text, secret=FAKE_KEY).encode("utf-8"),
            text.encode("utf-8"),
        )

    def test_sk_inside_an_identifier_is_not_a_token(self):
        # Deliberately *not* a list of known prefixes: any word character
        # before `sk-` makes it part of the identifier, whatever the word is.
        for word in (
            "disk-0123456789",
            "risk-abcdefgh",
            "task-00000000",
            "mask-zzzzzzzz",
        ):
            with self.subTest(word=word):
                self.assertEqual(redact.redact(word, secret=FAKE_KEY), word)

    def test_a_standalone_sk_token_is_still_replaced(self):
        self.assertEqual(
            redact.redact(" sk-0123456789", secret=FAKE_KEY), " <redacted>"
        )

    def test_a_non_word_character_before_sk_does_not_block_the_anchor(self):
        # The asymmetry is deliberate: only positive evidence that the `sk-`
        # sits inside an identifier lets it through. `-` must not go into the
        # lookbehind, so all of these stay fail-closed.
        for text in (
            "-sk-0123456789",
            '"/sk-0123456789"',
            "=sk-0123456789",
            ":sk-0123456789",
        ):
            with self.subTest(text=text):
                out = redact.redact(text, secret=FAKE_KEY)
                self.assertIn(redact.PLACEHOLDER, out)
                self.assertNotIn("sk-0123456789", out)

    def test_sk_at_the_start_of_the_string_is_still_replaced(self):
        # A negative lookbehind holds at position 0 -- there is no character
        # behind it -- which is the easiest boundary to get wrong.
        self.assertEqual(
            redact.redact("sk-0123456789", secret=FAKE_KEY), redact.PLACEHOLDER
        )


if __name__ == "__main__":
    unittest.main()
