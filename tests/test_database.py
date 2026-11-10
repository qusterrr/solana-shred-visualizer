import tempfile
import unittest
from pathlib import Path

from app.database import (
    ShredArrival,
    ShredDatabase,
)


class DatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = (
            tempfile.TemporaryDirectory()
        )

        self.database_path = (
            Path(self.temp_dir.name)
            / "test.db"
        )

        self.database = ShredDatabase(
            self.database_path
        )

    def tearDown(self) -> None:
        self.database.close()
        self.temp_dir.cleanup()

    def make_arrival(
        self,
        *,
        slot: int,
        index: int,
        fec: int,
    ) -> ShredArrival:
        return ShredArrival(
            arrival_us=1_800_000_000_000_000,
            sender_ip="127.0.0.1",
            sender_port=8002,
            packet_size=1203,
            slot=slot,
            shred_index=index,
            fec_set_index=fec,
            shred_type="data",
            version=52352,
            variant=0x80,
        )

    def test_insert_many(self):
        arrivals = [
            self.make_arrival(
                slot=100,
                index=1,
                fec=0,
            ),
            self.make_arrival(
                slot=100,
                index=2,
                fec=0,
            ),
        ]

        inserted = (
            self.database.insert_many(
                arrivals
            )
        )

        self.assertEqual(
            inserted,
            2,
        )

        self.assertEqual(
            self.database.count_records(),
            2,
        )

    def test_count_slot_records(self):
        self.database.insert_many(
            [
                self.make_arrival(
                    slot=100,
                    index=1,
                    fec=0,
                ),
                self.make_arrival(
                    slot=100,
                    index=2,
                    fec=0,
                ),
                self.make_arrival(
                    slot=101,
                    index=3,
                    fec=32,
                ),
            ]
        )

        self.assertEqual(
            self.database.count_slot_records(
                100
            ),
            2,
        )

        self.assertEqual(
            self.database.count_slot_records(
                101
            ),
            1,
        )

    def test_duplicate_arrivals_are_preserved(
        self,
    ):
        arrival = self.make_arrival(
            slot=100,
            index=5,
            fec=0,
        )

        self.database.insert_many(
            [
                arrival,
                arrival,
            ]
        )

        self.assertEqual(
            self.database.count_records(),
            2,
        )

    def test_latest_slots(self):
        self.database.insert_many(
            [
                self.make_arrival(
                    slot=100,
                    index=1,
                    fec=0,
                ),
                self.make_arrival(
                    slot=100,
                    index=2,
                    fec=32,
                ),
                self.make_arrival(
                    slot=101,
                    index=3,
                    fec=0,
                ),
            ]
        )

        slots = (
            self.database.latest_slots()
        )

        self.assertEqual(
            slots[0]["slot"],
            101,
        )

        self.assertEqual(
            slots[1]["slot"],
            100,
        )

        self.assertEqual(
            slots[1]["arrivals"],
            2,
        )

        self.assertEqual(
            slots[1]["fec_sets"],
            2,
        )


if __name__ == "__main__":
    unittest.main()