from __future__ import annotations

import argparse
import struct
from dataclasses import dataclass
from enum import IntFlag
from ipaddress import IPv4Address
from itertools import islice
from pathlib import Path
from typing import Iterator


RECORD_STRUCT = struct.Struct("<QQIIB")
RECORD_SIZE = RECORD_STRUCT.size


class ShredFlags(IntFlag):
    REPAIR = 0b0000_0001
    MULTICAST = 0b0000_0010
    CODE_SHRED = 0b0000_0100


@dataclass(frozen=True, slots=True)
class ShredRecord:
    timestamp_us: int
    slot: int
    index: int
    sender_ip_raw: int
    flags: int

    @property
    def sender_ip(self) -> str:
        return str(IPv4Address(self.sender_ip_raw))

    @property
    def fec_index(self) -> int:
        return self.index // 64

    @property
    def fec_offset(self) -> int:
        return self.index % 64

    @property
    def is_repair(self) -> bool:
        return bool(self.flags & ShredFlags.REPAIR)

    @property
    def is_multicast(self) -> bool:
        return bool(self.flags & ShredFlags.MULTICAST)

    @property
    def is_code(self) -> bool:
        return bool(self.flags & ShredFlags.CODE_SHRED)

    def to_dict(self) -> dict:
        return {
            "timestamp_us": self.timestamp_us,
            "slot": self.slot,
            "index": self.index,
            "fec_index": self.fec_index,
            "fec_offset": self.fec_offset,
            "sender_ip": self.sender_ip,
            "flags": self.flags,
            "is_repair": self.is_repair,
            "is_multicast": self.is_multicast,
            "is_code": self.is_code,
        }


def validate_file(path: str | Path) -> Path:
    file_path = Path(path)

    if not file_path.exists():
        raise FileNotFoundError(file_path)

    if not file_path.is_file():
        raise ValueError(f"Not a file: {file_path}")

    size = file_path.stat().st_size

    if size % RECORD_SIZE != 0:
        raise ValueError(
            f"Invalid binary log size: {size} bytes. "
            f"Expected a multiple of {RECORD_SIZE} bytes."
        )

    return file_path


def count_records(path: str | Path) -> int:
    file_path = validate_file(path)
    return file_path.stat().st_size // RECORD_SIZE


def iter_records(
    path: str | Path,
    *,
    slot: int | None = None,
) -> Iterator[ShredRecord]:
    file_path = validate_file(path)

    with file_path.open("rb") as file:
        while True:
            raw = file.read(RECORD_SIZE)

            if not raw:
                break

            timestamp_us, slot_number, index, sender_ip, flags = RECORD_STRUCT.unpack(
                raw
            )

            record = ShredRecord(
                timestamp_us=timestamp_us,
                slot=slot_number,
                index=index,
                sender_ip_raw=sender_ip,
                flags=flags,
            )

            if slot is None or record.slot == slot:
                yield record


def get_slots(path: str | Path) -> list[int]:
    return sorted({record.slot for record in iter_records(path)})


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Inspect Solana wire-format binary shred logs."
    )

    parser.add_argument(
        "path",
        type=Path,
        help="Path to time_log_*.bin",
    )

    parser.add_argument(
        "--slot",
        type=int,
        default=None,
        help="Show only records belonging to this slot.",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Maximum number of records to display.",
    )

    args = parser.parse_args()

    total_records = count_records(args.path)

    print(f"Record size: {RECORD_SIZE} bytes")
    print(f"Total records: {total_records}")

    records = iter_records(args.path, slot=args.slot)

    for record in islice(records, args.limit):
        print(record.to_dict())


if __name__ == "__main__":
    main()