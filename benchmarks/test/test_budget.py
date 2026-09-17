import json
import os
import tempfile
import threading
import unittest
from unittest import mock

from benchmarks import budget


class LedgerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "ledger.json")

    def test_a_fresh_ledger_has_the_whole_ceiling_left(self):
        ledger = budget.Ledger(self.path, ceiling=1000)
        self.assertEqual(ledger.remaining(), 1000)
        self.assertEqual(ledger.entries(), [])

    def test_recording_subtracts_from_the_remaining(self):
        ledger = budget.Ledger(self.path, ceiling=1000)
        self.assertEqual(ledger.record(400, note="task-a"), 600)
        self.assertEqual(ledger.record(100, note="task-b"), 500)

    def test_the_ceiling_survives_a_new_instance(self):
        budget.Ledger(self.path, ceiling=1000).record(250)
        self.assertEqual(budget.Ledger(self.path, ceiling=999).remaining(), 750)

    def test_overspending_goes_negative_rather_than_clamping(self):
        # Clamping would hide how far past the ceiling a run actually went.
        ledger = budget.Ledger(self.path, ceiling=100)
        self.assertEqual(ledger.record(150), -50)

    def test_notes_and_timestamps_are_persisted(self):
        budget.Ledger(self.path, ceiling=100).record(5, note="circuit-fibsqrt", at="2026-09-17T00:00:00Z")
        with open(self.path, encoding="utf-8") as handle:
            state = json.load(handle)
        self.assertEqual(state["ceiling"], 100)
        self.assertEqual(state["entries"][0]["note"], "circuit-fibsqrt")
        self.assertEqual(state["entries"][0]["at"], "2026-09-17T00:00:00Z")

    def test_each_write_works_in_its_own_temp_file(self):
        # A fixed `path + ".tmp"` is shared by every writer, so two writers
        # interleave inside the same file and the ledger lands unparseable —
        # measured as `JSONDecodeError: Extra data` before this was fixed.
        # This pins the naming, which is what makes that tear impossible;
        # that the outcome holds under the lock is
        # `test_concurrent_records_do_not_lose_a_write`'s job, not this one's.
        ledger = budget.Ledger(self.path, ceiling=1000)
        sources: list[str] = []
        real_replace = os.replace

        def recording_replace(src, dst):
            sources.append(os.fspath(src))
            return real_replace(src, dst)

        with mock.patch.object(budget.os, "replace", recording_replace):
            ledger._write(1000, [])
            ledger._write(1000, [])
        self.assertEqual(len(sources), 2)
        self.assertNotEqual(sources[0], sources[1])

    def test_concurrent_records_do_not_lose_a_write(self):
        # The adapter is one process per task; without the lock two tasks
        # racing here would silently overwrite each other's usage.
        ledger = budget.Ledger(self.path, ceiling=10_000)
        threads = [
            threading.Thread(target=ledger.record, args=(1,), kwargs={"note": f"t{i}"})
            for i in range(20)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(ledger.entries()), 20)
        self.assertEqual(ledger.remaining(), 10_000 - 20)

    def test_reset_clears_the_entries_but_keeps_the_ceiling(self):
        ledger = budget.Ledger(self.path, ceiling=500)
        ledger.record(10)
        ledger.reset()
        self.assertEqual(ledger.remaining(), 500)
        self.assertEqual(ledger.entries(), [])


if __name__ == "__main__":
    unittest.main()
