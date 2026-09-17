import unittest

from benchmarks import tasks


class SelectFirstTest(unittest.TestCase):
    def test_lexicographic_prefix(self):
        names = ["delta", "alpha", "charlie", "bravo"]
        self.assertEqual(tasks.select_first(names, 2), ["alpha", "bravo"])

    def test_does_not_mutate_its_input(self):
        names = ["b", "a"]
        tasks.select_first(names, 1)
        self.assertEqual(names, ["b", "a"])

    def test_n_larger_than_the_dataset_returns_everything(self):
        self.assertEqual(tasks.select_first(["b", "a"], 10), ["a", "b"])


class SelectFirstReposTest(unittest.TestCase):
    def test_one_task_per_repository_in_lexicographic_order(self):
        names = [
            "astropy__astropy-6938",
            "django__django-10874",
            "astropy__astropy-12907",
            "django__django-10097",
            "psf__requests-1142",
        ]
        self.assertEqual(
            tasks.select_first_repos(names, 3),
            ["astropy__astropy-12907", "django__django-10097", "psf__requests-1142"],
        )

    def test_n_zero_selects_nothing(self):
        # The exit guard sits *after* the append, so `len(chosen) == n` is
        # never 0 on entry and `break` is unreachable when n == 0: the loop
        # runs to the end and returns one entry per repository, which is the
        # opposite of "the first zero of them" and disagrees with
        # `select_first(names, 0) == []`.
        names = ["astropy__astropy-6938", "django__django-10874", "psf__requests-1142"]
        self.assertEqual(tasks.select_first_repos(names, 0), [])
        self.assertEqual(tasks.select_first(names, 0), [])

    def test_a_name_without_a_separator_is_its_own_repository(self):
        # The second name must come from a *different* repository prefix: a
        # separator-less name's repository is the whole name, so pairing it with
        # "alpha__x-1" would collide on "alpha" and be deduped away.
        self.assertEqual(tasks.select_first_repos(["alpha", "beta__x-1"], 2), ["alpha", "beta__x-1"])


class RecordedSelectionTest(unittest.TestCase):
    def test_phase1_records_ten_distinct_names(self):
        self.assertEqual(len(tasks.PHASE1_EXPECTED), 10)
        self.assertEqual(len(set(tasks.PHASE1_EXPECTED)), 10)
        self.assertEqual(list(tasks.PHASE1_EXPECTED), sorted(tasks.PHASE1_EXPECTED))

    def test_phase2_records_ten_distinct_repositories(self):
        self.assertEqual(len(tasks.PHASE2_EXPECTED), 10)
        repos = [name.split("__", 1)[0] for name in tasks.PHASE2_EXPECTED]
        self.assertEqual(len(set(repos)), 10)

    def test_phase2_names_are_in_lexicographic_order(self):
        # A necessary condition of the rule, not the rule itself: taking the
        # first name per repository in lexicographic order can only ever yield a
        # sorted list, so an out-of-order record means the rule was not applied.
        # It cannot pin the rule — a list holding each repository's *last* name
        # would also be sorted. Pinning it needs the dataset, which Phase 2 has.
        self.assertEqual(list(tasks.PHASE2_EXPECTED), sorted(tasks.PHASE2_EXPECTED))


if __name__ == "__main__":
    unittest.main()
