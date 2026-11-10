from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_DATABASE_PATH = Path("data/shreds.db")
DEFAULT_RETENTION_HOURS = 48


@dataclass(frozen=True, slots=True)
class ShredArrival:
    arrival_us: int
    sender_ip: str
    sender_port: int
    packet_size: int
    slot: int
    shred_index: int
    fec_set_index: int
    shred_type: str
    version: int
    variant: int


class ShredDatabase:
    def __init__(
        self,
        path: str | Path = DEFAULT_DATABASE_PATH,
    ) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        self.connection = sqlite3.connect(
            self.path,
        )

        self.connection.row_factory = sqlite3.Row

        self.connection.execute(
            "PRAGMA journal_mode=WAL"
        )
        self.connection.execute(
            "PRAGMA synchronous=NORMAL"
        )
        self.connection.execute(
            "PRAGMA busy_timeout=5000"
        )

        self._create_schema()

    def _create_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS shred_arrivals (
                id INTEGER PRIMARY KEY,
                arrival_us INTEGER NOT NULL,
                sender_ip TEXT NOT NULL,
                sender_port INTEGER NOT NULL,
                packet_size INTEGER NOT NULL,
                slot INTEGER NOT NULL,
                shred_index INTEGER NOT NULL,
                fec_set_index INTEGER NOT NULL,
                shred_type TEXT NOT NULL,
                version INTEGER NOT NULL,
                variant INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS
                idx_shred_arrivals_arrival_us
            ON shred_arrivals(arrival_us);

            CREATE INDEX IF NOT EXISTS
                idx_shred_arrivals_slot
            ON shred_arrivals(slot);

            CREATE INDEX IF NOT EXISTS
                idx_shred_arrivals_slot_fec
            ON shred_arrivals(slot, fec_set_index);

            CREATE INDEX IF NOT EXISTS
                idx_shred_arrivals_slot_index
            ON shred_arrivals(
                slot,
                shred_index
            );
            """
        )

        self.connection.commit()

    def insert_many(
        self,
        arrivals: Iterable[ShredArrival],
    ) -> int:
        rows = [
            (
                arrival.arrival_us,
                arrival.sender_ip,
                arrival.sender_port,
                arrival.packet_size,
                arrival.slot,
                arrival.shred_index,
                arrival.fec_set_index,
                arrival.shred_type,
                arrival.version,
                arrival.variant,
            )
            for arrival in arrivals
        ]

        if not rows:
            return 0

        self.connection.executemany(
            """
            INSERT INTO shred_arrivals (
                arrival_us,
                sender_ip,
                sender_port,
                packet_size,
                slot,
                shred_index,
                fec_set_index,
                shred_type,
                version,
                variant
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

        self.connection.commit()

        return len(rows)

    def count_records(self) -> int:
        row = self.connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM shred_arrivals
            """
        ).fetchone()

        return int(row["count"])

    def count_slot_records(
        self,
        slot: int,
    ) -> int:
        row = self.connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM shred_arrivals
            WHERE slot = ?
            """,
            (slot,),
        ).fetchone()

        return int(row["count"])

    def latest_slots(
        self,
        limit: int = 20,
    ) -> list[dict]:
        rows = self.connection.execute(
            """
            SELECT
                slot,
                MIN(arrival_us) AS first_arrival_us,
                MAX(arrival_us) AS last_arrival_us,
                COUNT(*) AS arrivals,
                COUNT(DISTINCT fec_set_index)
                    AS fec_sets
            FROM shred_arrivals
            GROUP BY slot
            ORDER BY slot DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        return [
            dict(row)
            for row in rows
        ]

    def delete_older_than(
        self,
        hours: int = DEFAULT_RETENTION_HOURS,
    ) -> int:
        cutoff_us = (
            time.time_ns() // 1000
            - hours * 60 * 60 * 1_000_000
        )

        cursor = self.connection.execute(
            """
            DELETE FROM shred_arrivals
            WHERE arrival_us < ?
            """,
            (cutoff_us,),
        )

        self.connection.commit()

        return cursor.rowcount

    def close(self) -> None:
        self.connection.close()