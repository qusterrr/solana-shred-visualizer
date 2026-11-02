import struct
import tempfile
import unittest
from ipaddress import IPv4Address
from pathlib import Path

from app.parser import (
    RECORD_SIZE,
    ShredFlags,
    count_records,
    iter_records,
)


class ParserTests(unittest.TestCase):
    def create_log(self, records: list[tuple[int, int, int, int, int]]) -> Path:
        self.temp_dir = tempfile.TemporaryDirectory()

        path = Path(self.temp_dir.name) / "time_log_test.bin"

        record_struct = struct.Struct("<QQIIB")

        with path.open("wb") as file:
            for record in records:
                file.write(record_struct.pack(*record))

        return path

    def tearDown(self) -> None:
        if hasattr(self, "temp_dir"):
            self.temp_dir.cleanup()

    def test_record_size_is_25_bytes(self):
        self.assertEqual(RECORD_SIZE, 25)

    def test_parse_record(self):
        sender_ip = int(IPv4Address("1.2.3.4"))

        path = self.create_log(
            [
                (
                    1_780_000_000_000_000,
                    423_633_196,
                    512 * 64 + 15,
                    sender_ip,
                    0,
                )
            ]
        )

        records = list(iter_records(path))

        self.assertEqual(len(records), 1)

        record = records[0]

        self.assertEqual(record.slot, 423_633_196)
        self.assertEqual(record.fec_index, 512)
        self.assertEqual(record.fec_offset, 15)
        self.assertEqual(record.sender_ip, "1.2.3.4")

        self.assertFalse(record.is_repair)
        self.assertFalse(record.is_multicast)
        self.assertFalse(record.is_code)

    def test_flags(self):
        sender_ip = int(IPv4Address("10.20.30.40"))

        flags = (
            ShredFlags.REPAIR
            | ShredFlags.MULTICAST
            | ShredFlags.CODE_SHRED
        )

        path = self.create_log(
            [
                (
                    1_780_000_000_000_000,
                    100,
                    64,
                    sender_ip,
                    int(flags),
                )
            ]
        )

        record = next(iter_records(path))

        self.assertTrue(record.is_repair)
        self.assertTrue(record.is_multicast)
        self.assertTrue(record.is_code)

    def test_count_records(self):
        sender_ip = int(IPv4Address("127.0.0.1"))

        path = self.create_log(
            [
                (1, 10, 64, sender_ip, 0),
                (2, 10, 65, sender_ip, 0),
                (3, 11, 128, sender_ip, 0),
            ]
        )

        self.assertEqual(count_records(path), 3)

    def test_filter_by_slot(self):
        sender_ip = int(IPv4Address("127.0.0.1"))

        path = self.create_log(
            [
                (1, 100, 64, sender_ip, 0),
                (2, 101, 128, sender_ip, 0),
                (3, 100, 65, sender_ip, 0),
            ]
        )

        records = list(iter_records(path, slot=100))

        self.assertEqual(len(records), 2)

        for record in records:
            self.assertEqual(record.slot, 100)


if __name__ == "__main__":
    unittest.main()