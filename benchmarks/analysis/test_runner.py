import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from benchmarks.analysis import runner


class BundledCasesTest(unittest.TestCase):
    """用例文件本身也是被测对象：字段缺了、id 重了，评测会静默少算。"""

    def setUp(self) -> None:
        self.cases = runner.load_cases()

    def test_ids_are_unique(self):
        ids = [c.id for c in self.cases]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_case_carries_a_probe_and_an_expectation(self):
        # 没有 probe 的用例只是一个「说法」，不是判据。
        for case in self.cases:
            self.assertTrue(case.probe, case.id)
            self.assertIn(case.match, {"digits", "contains", "exact"}, case.id)

    def test_zero_expectation_cases_carry_a_positive_control(self):
        # 「0 个匹配」与「探针压根没读到文件」打印同一个读数 —— 前者必须配正对照。
        for case in self.cases:
            if case.expect == "0" and case.match == "digits":
                self.assertIsNotNone(case.control, case.id)

    def test_forms_are_the_taxonomy_or_control(self):
        allowed = {"E1", "E2", "E3", "E4", "E5", "E6", "control"}
        for case in self.cases:
            self.assertIn(case.form, allowed, case.id)

    def test_the_set_keeps_negative_controls(self):
        # 只有「抓错」的题目时，一个乱答的代理也可能拿到高分；control 是这套集子的负控。
        self.assertTrue(any(c.form == "control" for c in self.cases))


class MatchesTest(unittest.TestCase):
    def test_digits_tolerates_units_and_thousands_separators(self):
        self.assertTrue(runner.matches("65 处", "65", "digits"))
        self.assertTrue(runner.matches("1,234", "1234", "digits"))

    def test_digits_reads_chinese_zero(self):
        self.assertTrue(runner.matches("零处", "0", "digits"))

    def test_digits_rejects_a_neighbouring_number(self):
        self.assertFalse(runner.matches("48 处", "65", "digits"))

    def test_contains_is_case_insensitive(self):
        self.assertTrue(runner.matches("这是 Fallback 路径", "fallback", "contains"))

    def test_exact_collapses_whitespace(self):
        self.assertTrue(runner.matches("  a   b ", "a b", "exact"))


class CheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = Path(self.tmp.name)

    def _case(self, **overrides):
        base = dict(
            id="T-1",
            form="E1",
            klass="reading",
            question="q",
            probe="echo 65",
            match="digits",
            expect="65",
        )
        base.update(overrides)
        return runner.Case(**base)

    def test_a_matching_probe_passes(self):
        ok, out, note = runner.check(self._case(), self.cwd)
        self.assertTrue(ok, note)
        self.assertEqual(out, "65")

    def test_a_nonzero_exit_is_a_failure_not_a_reading(self):
        # 探针崩了若只比对 stdout，空输出会被当成「没匹配」而不是「命令没跑成」。
        ok, _, note = runner.check(self._case(probe="exit 2"), self.cwd)
        self.assertFalse(ok)
        self.assertIn("退出码", note)

    def test_a_broken_control_is_reported_as_such(self):
        case = self._case(expect="0", control="echo 0", control_expect="6")
        ok, _, note = runner.check(case, self.cwd)
        self.assertFalse(ok)
        self.assertIn("正对照", note)

    def test_a_good_control_lets_the_reading_stand(self):
        case = self._case(
            probe="echo 0", expect="0", control="echo 6", control_expect="6"
        )
        ok, _, note = runner.check(case, self.cwd)
        self.assertTrue(ok, note)


class SkipTest(unittest.TestCase):
    def test_missing_sibling_repo_skips_instead_of_failing(self):
        case = runner.Case(
            id="T-2",
            form="E1",
            klass="reading",
            question="q",
            probe="echo 1",
            match="digits",
            expect="1",
            requires="astra-khadga",
        )
        with mock.patch.object(
            runner, "megasystem_root", return_value=Path("/nonexistent")
        ):
            self.assertIsNone(runner.resolve_cwd(case))


class ScoreTest(unittest.TestCase):
    def test_an_unanswered_case_counts_as_wrong(self):
        cases = [
            runner.Case(
                id="A",
                form="E1",
                klass="reading",
                question="q",
                probe="echo 1",
                match="digits",
                expect="1",
            ),
            runner.Case(
                id="B",
                form="E2",
                klass="reading",
                question="q",
                probe="echo 2",
                match="digits",
                expect="2",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            answers = Path(tmp) / "a.jsonl"
            answers.write_text(
                json.dumps({"id": "A", "answer": "1"}) + "\n", encoding="utf-8"
            )
            with mock.patch.object(runner, "resolve_cwd", return_value=Path(".")):
                with mock.patch("builtins.print"):
                    code = runner.cmd_score(cases, answers)
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
