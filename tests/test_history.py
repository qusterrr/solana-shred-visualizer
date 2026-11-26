import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from app.config import DATABASE_ENV
from app.database import ShredArrival, ShredDatabase
from app.main import get_nearest_slot, get_previous_slot, get_slot, get_slots


SECOND = 1_000_000
NOW = 200_000 * SECOND
CUTOFF = NOW - 48 * 3600 * SECOND


def arrival(slot, arrival_us, shred_type="data"):
    return ShredArrival(arrival_us, "127.0.0.1", 8002, 83, slot, 0, 0, shred_type, 1, 0xA5)


class HistoryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "shreds.db"
        self.database = ShredDatabase(self.path)
        self.addCleanup(self.database.close)
        environment = patch.dict(os.environ, {DATABASE_ENV: str(self.path)})
        environment.start()
        self.addCleanup(environment.stop)

    def test_nearest_observed_time_direction_ties_and_range(self):
        self.database.insert_many([
            arrival(60, 10 * SECOND),
            arrival(50, 10 * SECOND),
            arrival(30, 20 * SECOND),
            arrival(50, 25 * SECOND),
        ])
        for seconds, expected_slot, difference, bounds in [
            (10, 50, 0, "within"),
            (12, 50, -2, "within"),
            (18, 30, 2, "within"),
            (15, 50, -5, "within"),
            (8, 50, 2, "before"),
            (25, 30, -5, "after"),
        ]:
            with self.subTest(seconds=seconds):
                match = get_nearest_slot(f"1970-01-01T00:00:{seconds:02d}Z")["match"]
                self.assertEqual((match["slot"], match["difference_us"], match["range"]),
                                 (expected_slot, difference * SECOND, bounds))

    def test_time_requires_offset_and_preserves_microseconds(self):
        self.database.insert_many([arrival(50, 10 * SECOND + 123456)])
        utc = get_nearest_slot("1970-01-01T00:00:10.123456Z")
        offset = get_nearest_slot("1970-01-01T03:00:10.123456+03:00")
        self.assertEqual(offset, utc)
        self.assertEqual(utc["requested_us"], 10 * SECOND + 123456)
        self.assertEqual(utc["match"]["difference_us"], 0)
        with self.assertRaises(HTTPException) as raised:
            get_nearest_slot("1970-01-01T00:00:10")
        self.assertEqual(raised.exception.status_code, 422)

    def test_empty_time_and_history(self):
        self.assertIsNone(get_nearest_slot("1970-01-01T00:00:00Z")["match"])
        self.assertEqual(get_slots(), {
            "slots": [], "oldest_slot": None, "newest_slot": None,
            "has_older": False, "has_newer": False,
        })

    def test_sparse_pages_round_trip_with_partial_page_and_boundaries(self):
        for slot in (1, 9, 15, 30, 31, 70, 118):
            self.database.insert_many([arrival(slot, 10 * SECOND)])
        latest = get_slots(limit=3)
        middle = get_slots(limit=3, before=latest["oldest_slot"])
        oldest = get_slots(limit=3, before=middle["oldest_slot"])
        self.assertEqual([row["slot"] for row in latest["slots"]], [118, 70, 31])
        self.assertEqual([row["slot"] for row in middle["slots"]], [30, 15, 9])
        self.assertEqual([row["slot"] for row in oldest["slots"]], [1])
        self.assertTrue(middle["has_older"] and middle["has_newer"])
        self.assertFalse(latest["has_newer"])
        self.assertFalse(oldest["has_older"])
        self.assertEqual(get_slots(limit=3, after=oldest["newest_slot"]), middle)
        self.assertEqual(get_slots(limit=3, after=middle["newest_slot"]), latest)
        self.assertEqual(get_slots(limit=3, after=118)["slots"], [])
        self.assertEqual(get_slots(limit=3, before=1)["slots"], [])
        self.assertEqual(get_slots(limit=3, at=30), middle)

    def test_insertions_are_navigated_relative_to_the_given_boundary(self):
        self.database.insert_many([arrival(slot, NOW) for slot in (10, 20, 30, 40)])
        first = get_slots(limit=2)
        self.database.insert_many([arrival(slot, NOW) for slot in (25, 50)])
        older = get_slots(limit=2, before=first["oldest_slot"])
        newer = get_slots(limit=2, after=first["newest_slot"])
        self.assertEqual([row["slot"] for row in older["slots"]], [25, 20])
        self.assertEqual([row["slot"] for row in newer["slots"]], [50])
        self.assertFalse(newer["has_newer"])

    def test_cursors_work_after_pruning_and_expired_slot_is_missing(self):
        self.database.insert_many([
            arrival(20, CUTOFF - 1), arrival(30, CUTOFF - 1), arrival(40, CUTOFF),
        ])
        first = get_slots(limit=2)
        with patch("app.database.time.time_ns", return_value=NOW * 1000):
            self.assertEqual(self.database.delete_older_than(), 2)
        self.assertEqual(get_slots(limit=2, before=first["oldest_slot"])["slots"], [])
        self.assertEqual([row["slot"] for row in get_slots(limit=2, after=30)["slots"]], [40])
        with self.assertRaises(HTTPException) as raised:
            get_slot(30)
        self.assertEqual(raised.exception.status_code, 404)

    def test_previous_uses_current_relevant_slots_and_skips_unknown_and_future(self):
        self.database.insert_many([
            arrival(10, NOW), arrival(30, NOW), arrival(20, NOW, "unknown"),
            arrival(25, NOW + SECOND),
        ])
        with patch("app.main.time.time_ns", return_value=NOW * 1000):
            self.assertEqual(get_previous_slot()["slot"], 10)
            self.database.insert_many([arrival(15, NOW)])
            self.assertEqual(get_previous_slot()["slot"], 15)
            self.database.insert_many([arrival(40, NOW)])
            self.assertEqual(get_previous_slot()["slot"], 30)

    def test_previous_without_a_lower_relevant_slot_is_empty(self):
        self.database.insert_many([arrival(10, NOW)])
        with patch("app.main.time.time_ns", return_value=NOW * 1000):
            self.assertEqual(get_previous_slot(), {"slot": None})

    def test_retention_keeps_complete_slots_at_and_after_cutoff(self):
        self.database.insert_many([
            arrival(10, CUTOFF - 2), arrival(10, CUTOFF - 1),
            arrival(20, CUTOFF - 10), arrival(20, CUTOFF),
            arrival(30, CUTOFF - 5), arrival(30, CUTOFF + 1),
        ])
        with patch("app.database.time.time_ns", return_value=NOW * 1000):
            self.assertEqual(self.database.delete_older_than(), 2)
            self.assertEqual(self.database.delete_older_than(), 0)
        self.assertEqual(self.database.get_slot(10), [])
        self.assertEqual(get_slot(20)["first_arrival_us"], CUTOFF - 10)
        self.assertEqual(get_slot(30)["first_arrival_us"], CUTOFF - 5)
        self.assertEqual([row["arrivals"] for row in get_slots()["slots"]], [2, 2])
        self.assertNotEqual(self.database.nearest_observed_slot(CUTOFF - 2)["slot"], 10)

    def test_retention_batches_delete_whole_slots(self):
        self.database.insert_many([arrival(slot, CUTOFF - 1) for slot in (10, 10, 20)])
        with (
            patch("app.database.RETENTION_BATCH_SLOTS", 1),
            patch("app.database.time.time_ns", return_value=NOW * 1000),
        ):
            self.assertEqual(self.database.delete_older_than(), 2)
            self.assertEqual(self.database.delete_older_than(), 1)
        self.assertEqual(get_slots()["slots"], [])

    def test_existing_raw_arrivals_are_backfilled_once(self):
        self.database.insert_many([arrival(10, NOW), arrival(10, NOW - SECOND)])
        with self.database.connection:
            self.database.connection.execute("DROP TABLE slot_observations")
            self.database.connection.execute("DROP INDEX idx_shred_arrivals_slot_time")
        for _ in range(2):
            self.assertEqual(get_slots()["slots"][0]["first_arrival_us"], NOW - SECOND)
        self.assertEqual(get_slot(10)["arrivals"], 2)

    def test_new_earlier_arrival_updates_indexed_observed_time(self):
        self.database.insert_many([arrival(10, NOW)])
        self.database.insert_many([arrival(10, NOW - SECOND)])
        self.assertEqual(self.database.nearest_observed_slot(NOW)["first_arrival_us"], NOW - SECOND)

    def test_summary_failure_rolls_back_the_raw_batch(self):
        self.database.connection.execute("""
            CREATE TRIGGER fail_summary BEFORE INSERT ON slot_observations
            BEGIN SELECT RAISE(ABORT, 'summary failed'); END
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.insert_many([arrival(10, NOW), arrival(20, NOW)])
        self.assertEqual(self.database.count_records(), 0)
        self.assertEqual(get_slots()["slots"], [])
