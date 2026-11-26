import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.analysis import analyze_slot
from app.database import ShredArrival, ShredDatabase
from app.main import build_slot_response, get_live_slot, get_slot


def arrival(index, ms, *, shred_type="data", fec=32, slot=100):
    return {
        "slot": slot,
        "fec_set_index": fec,
        "shred_type": shred_type,
        "shred_index": index,
        "arrival_us": 1_000_000 + ms * 1000,
    }


class FecAnalysisTests(unittest.TestCase):
    def test_decode_at_32_and_stays_there(self):
        for size, decode_time in [(31, None), (32, 31), (33, 31)]:
            with self.subTest(size=size):
                events = [
                    arrival(index, index, shred_type="data" if index % 2 else "code")
                    for index in range(size)
                ]
                stats, = build_slot_response(100, events)["fec_analysis"]
                self.assertEqual(stats["unique_recognized_shred_count"], size)
                self.assertEqual(stats["decode_time_ms"], decode_time)

    def test_duplicates_and_unknowns_do_not_advance_decode(self):
        events = [arrival(i, i) for i in range(31)]
        events.extend([
            arrival(5, 31),
            arrival(5, 32, shred_type="unknown"),
            arrival(5, 33, shred_type="unknown"),
        ])
        stats, = build_slot_response(100, events)["fec_analysis"]
        self.assertIsNone(stats["decode_time_ms"])
        self.assertEqual(stats["unique_recognized_shred_count"], 31)

        events.append(arrival(5, 34, shred_type="code"))
        stats, = build_slot_response(100, events)["fec_analysis"]
        self.assertEqual(stats["total_arrivals"], 35)
        self.assertEqual(stats["recognized_arrivals"], 33)
        self.assertEqual(stats["unique_recognized_shred_count"], 32)
        self.assertEqual(stats["duplicate_arrival_count"], 1)
        self.assertEqual(stats["data_arrival_count"], 32)
        self.assertEqual(stats["coding_arrival_count"], 1)
        self.assertEqual(stats["unique_data_shred_count"], 31)
        self.assertEqual(stats["unique_coding_shred_count"], 1)
        self.assertEqual(stats["decode_time_ms"], 34)
        self.assertEqual(
            stats["cumulative_unique_points"][-1],
            {"arrival_ms": 34, "count": 32, "shred_type": "code", "shred_index": 5},
        )

    def test_raw_fec_sets_remain_isolated(self):
        events = [arrival(i, i, fec=fec) for fec in (96, 0, 64, 32) for i in range(16)]
        stats = build_slot_response(100, events)["fec_analysis"]
        self.assertEqual([item["fec_set_index"] for item in stats], [0, 32, 64, 96])
        for item in stats:
            self.assertEqual(item["unique_recognized_shred_count"], 16)
            self.assertIsNone(item["decode_time_ms"])

    def test_out_of_order_arrivals_use_time_and_stable_ties(self):
        events = [arrival(9, 5), arrival(3, 1), arrival(1, 1), arrival(9, 3)]
        stats, = build_slot_response(100, events)["fec_analysis"]
        self.assertEqual(
            [(point["arrival_ms"], point["shred_index"]) for point in
             stats["cumulative_unique_points"]],
            [(0, 3), (0, 1), (2, 9)],
        )

    def test_analysis_rejects_mixed_slot_input(self):
        with self.assertRaisesRegex(ValueError, "single slot"):
            analyze_slot(100, [arrival(0, 0), arrival(1, 1, slot=101)])

    def test_slot_endpoints_keep_ties_stable_and_preserve_raw_duplicates(self):
        events = [
            arrival(i, 0, slot=slot)
            for slot in (100, 101)
            for i in range(15, -1, -1)
        ]
        events.append(events[-1])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "shreds.db"
            database = ShredDatabase(path)
            try:
                database.insert_many([
                    ShredArrival(**event, sender_ip="127.0.0.1", sender_port=8002,
                                 packet_size=1203, version=1, variant=0x80)
                    for event in events
                ])
            finally:
                database.close()

            with patch("app.main.ShredDatabase", side_effect=lambda: ShredDatabase(path)):
                historical = get_slot(100)
                live = get_live_slot()
                self.assertEqual(live, get_slot(101))

        self.assertEqual([historical["slot"], live["slot"]], [100, 101])
        self.assertEqual([historical["arrivals"], live["arrivals"]], [16, 17])
        self.assertEqual(live["decode_threshold"], 32)
        self.assertEqual(live["events"][-1], live["events"][-2])
        for response in (historical, live):
            stats, = response["fec_analysis"]
            self.assertIsNone(stats["decode_time_ms"])
            self.assertEqual(
                [point["shred_index"] for point in stats["cumulative_unique_points"]],
                list(range(15, -1, -1)),
            )
