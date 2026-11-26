import os
import sqlite3
import struct
import tempfile
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from io import StringIO
from pathlib import Path
from unittest.mock import Mock, patch

from app.config import DATABASE_ENV, DEFAULT_DATABASE_PATH, resolve_database_path
from app.database import SQLITE_INTEGER_MAX, WRITE_ATTEMPTS, ShredArrival, ShredDatabase
from app.main import get_live_slot, health
from app.receiver_status import publish_accepted_arrival
from app.udp_receiver import receive_arrivals, run_receiver


def arrival(slot=10, arrival_us=10_000_000, shred_type="data"):
    return ShredArrival(arrival_us, "127.0.0.1", 8002, 83, slot, 0, 0, shred_type, 1, 0xA5)


def packet(slot, variant=0xA5):
    return b"\0" * 64 + struct.pack("<BQIHI", variant, slot, 0, 1, 0)


class IngestionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "shreds.db"
        self.database = ShredDatabase(self.path, timeout=0)
        self.addCleanup(self.database.close)

    def test_database_path_is_shared_and_override_takes_precedence(self):
        with patch.dict(os.environ, {DATABASE_ENV: str(self.path)}):
            self.assertEqual(resolve_database_path(), self.path.resolve())
            override = self.path.with_name("override.db")
            self.assertEqual(resolve_database_path(override), override.resolve())
            self.assertEqual(health()["state"], "no_data")
            self.database.insert_many([arrival()])
            self.assertEqual(get_live_slot()["slot"], 10)
        with patch.dict(os.environ, {DATABASE_ENV: ""}):
            self.assertEqual(resolve_database_path(), DEFAULT_DATABASE_PATH)

    def test_receiver_continues_after_malformed_and_unstoreable_packets(self):
        sock = Mock()
        sender = ("127.0.0.1", 8002)
        sock.recvfrom.side_effect = [
            (b"too short", sender),
            (packet(SQLITE_INTEGER_MAX + 1), sender),
            (packet(8, variant=0), sender),
            (packet(SQLITE_INTEGER_MAX), sender),
            (packet(SQLITE_INTEGER_MAX), sender),
            KeyboardInterrupt(),
        ]
        output = StringIO()
        with redirect_stdout(output):
            receive_arrivals(sock, self.database)
        self.assertEqual(self.database.count_records(), 3)
        self.assertEqual(self.database.count_slot_records(SQLITE_INTEGER_MAX), 2)
        self.assertEqual(self.database.get_slot(8)[0]["shred_type"], "unknown")
        self.assertIn("packets=5 parsed=4 invalid=2 committed=3 pending=0", output.getvalue())

    def test_receiver_uses_the_shared_path_and_warns_on_override(self):
        override = self.path.with_name("override.db")
        with (
            patch.dict(os.environ, {DATABASE_ENV: str(self.path)}),
            patch("app.udp_receiver.socket.socket"),
            patch("app.udp_receiver.receive_arrivals") as receive,
            redirect_stdout(StringIO()),
        ):
            run_receiver("127.0.0.1", 8002)
            with self.assertLogs("app.udp_receiver", level="WARNING") as logs:
                run_receiver("127.0.0.1", 8002, override)

        self.assertEqual(
            [call.args[1].path for call in receive.call_args_list],
            [self.path.resolve(), override.resolve()],
        )
        self.assertIn(DATABASE_ENV, logs.output[0])

    def test_failed_batch_rolls_back_and_connection_is_reusable(self):
        good = arrival()
        bad = replace(good, sender_ip=None)
        with self.assertRaises(sqlite3.IntegrityError):
            self.database.insert_many([good, bad])
        self.assertFalse(self.database.connection.in_transaction)
        self.assertEqual(self.database.count_records(), 0)
        self.assertEqual(self.database.insert_many([good, good]), 2)
        self.assertEqual(self.database.count_records(), 2)

    def test_busy_write_retries_are_bounded_and_transaction_is_closed(self):
        writer = ShredDatabase(self.path, timeout=0)
        self.addCleanup(writer.close)
        self.database.connection.execute("BEGIN IMMEDIATE")
        with patch("app.database.time.sleep") as sleep:
            with self.assertRaises(sqlite3.OperationalError):
                writer.insert_many([arrival()])
        self.assertEqual(sleep.call_count, WRITE_ATTEMPTS - 1)
        self.assertFalse(writer.connection.in_transaction)
        self.database.connection.rollback()
        self.assertEqual(writer.insert_many([arrival()]), 1)

    def test_busy_write_recovers_when_the_lock_clears(self):
        writer = ShredDatabase(self.path, timeout=0)
        self.addCleanup(writer.close)
        self.database.connection.execute("BEGIN IMMEDIATE")
        with patch(
            "app.database.time.sleep",
            side_effect=lambda _delay: self.database.connection.rollback(),
        ) as sleep:
            self.assertEqual(writer.insert_many([arrival(), arrival()]), 2)
        sleep.assert_called_once()
        self.assertEqual(self.database.count_records(), 2)

    def test_receiver_reports_failed_batch_and_does_not_replay_it_on_shutdown(self):
        sock = Mock()
        sender = ("127.0.0.1", 8002)
        sock.recvfrom.side_effect = [(packet(10), sender), (packet(11), sender), KeyboardInterrupt()]
        output = StringIO()
        with (
            patch("app.udp_receiver.BATCH_SIZE", 1),
            patch.object(self.database, "insert_many", side_effect=[
                sqlite3.OperationalError("write failed"), 1,
            ]) as insert,
            self.assertLogs("app.udp_receiver", level="ERROR") as logs,
            redirect_stdout(output),
        ):
            receive_arrivals(sock, self.database)
        self.assertEqual([call.args[0][0].slot for call in insert.call_args_list], [10, 11])
        self.assertIn("Could not commit 1 arrivals", logs.output[0])
        self.assertIn("failed_batches=1 failed_records=1", output.getvalue())

    def test_receiver_does_not_replay_a_batch_interrupted_during_write(self):
        sock = Mock()
        sock.recvfrom.return_value = (packet(10), ("127.0.0.1", 8002))
        with (
            patch("app.udp_receiver.BATCH_SIZE", 1),
            patch.object(self.database, "insert_many", side_effect=KeyboardInterrupt) as insert,
            redirect_stdout(StringIO()),
        ):
            receive_arrivals(sock, self.database)
        insert.assert_called_once()


class LiveHealthTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "shreds.db"
        self.database = ShredDatabase(self.path)
        self.addCleanup(self.database.close)
        self.now = 10_000_000
        environment = patch.dict(os.environ, {DATABASE_ENV: str(self.path)})
        clock = patch("app.main.time.time_ns", return_value=self.now * 1000)
        for patcher in (environment, clock):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_empty_and_unknown_only_database_report_no_data(self):
        for rows in ([], [arrival(shred_type="unknown")]):
            self.database.insert_many(rows)
            status = health()
            self.assertEqual(status["status"], "ok")
            self.assertEqual(status["state"], "no_data")
            self.assertFalse(status["accepted_recent"])
            self.assertFalse(status["committed_recent"])
            self.assertEqual(get_live_slot(), {"slot": None})

    def test_fresh_committed_data_establishes_accepted_traffic_without_status_file(self):
        self.database.insert_many([arrival(arrival_us=self.now - 3_000_000)])
        status = health()
        self.assertEqual(status["state"], "live")
        self.assertTrue(status["accepted_recent"])
        self.assertTrue(status["committed_recent"])
        self.assertEqual(status["last_arrival_age_ms"], 3000)

    def test_stale_data_remains_available(self):
        self.database.insert_many([arrival(arrival_us=self.now - 3_000_001)])
        status = health()
        self.assertEqual(status["state"], "stale")
        self.assertFalse(status["accepted_recent"])
        self.assertFalse(status["committed_recent"])
        self.assertEqual(get_live_slot()["slot"], 10)

    def test_recent_accepted_traffic_with_stale_committed_data_signals_lag(self):
        self.database.insert_many([arrival(arrival_us=self.now - 4_000_000)])
        publish_accepted_arrival(self.path, self.now - 100_000)
        status = health()
        self.assertEqual(status["state"], "lagging")
        self.assertTrue(status["accepted_recent"])
        self.assertFalse(status["committed_recent"])

    def test_future_timestamps_do_not_make_traffic_live(self):
        publish_accepted_arrival(self.path, self.now + 1)
        self.database.insert_many([arrival(slot=999, arrival_us=self.now + 1)])
        self.assertEqual(health()["state"], "no_data")
        self.assertEqual(get_live_slot(), {"slot": None})
        self.database.insert_many([arrival(arrival_us=self.now - 4_000_000)])
        self.assertEqual(health()["state"], "stale")
        self.assertEqual(get_live_slot()["slot"], 10)

    def test_live_slot_prefers_higher_fresh_slot_despite_late_older_arrivals(self):
        self.database.insert_many([
            arrival(slot=10, arrival_us=self.now - 500_000),
            arrival(slot=9, arrival_us=self.now),
        ])
        self.assertEqual(get_live_slot()["slot"], 10)
        status = health()
        self.assertEqual(status["latest_slot"], 10)
        self.assertEqual(status["last_arrival_age_ms"], 500)

    def test_stale_high_slot_cannot_pin_live_view(self):
        self.database.insert_many([
            arrival(slot=999, arrival_us=self.now - 4_000_000),
            arrival(slot=10, arrival_us=self.now - 1),
        ])
        self.assertEqual(health()["latest_slot"], 10)
        self.assertEqual(get_live_slot()["slot"], 10)

    def test_live_records_use_same_snapshot_as_slot_selection(self):
        self.database.insert_many([arrival()])
        writer = ShredDatabase(self.path)
        self.addCleanup(writer.close)
        read_slot = self.database.get_slot

        def commit_while_reading(slot):
            writer.insert_many([arrival()])
            return read_slot(slot)

        with patch.object(self.database, "get_slot", side_effect=commit_while_reading):
            slot, records = self.database.get_live_slot(self.now, self.now - 3_000_000)
        self.assertEqual(slot, 10)
        self.assertEqual(len(records), 1)
        self.assertEqual(self.database.count_slot_records(slot), 2)
