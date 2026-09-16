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

    def test_phase2_names_are_the_first_of_their_repository(self):
        # Pins the *rule*, not just the list: any name that sorts before a
        # recorded one but shares its repository would mean the rule changed.
        for name in tasks.PHASE2_EXPECTED:
            repo = name.split("__", 1)[0]
            earlier = [n for n in tasks.PHASE2_EXPECTED if n.split("__", 1)[0] == repo]
            self.assertEqual(earlier, [name])


if __name__ == "__main__":
    unittest.main()
