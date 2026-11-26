from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from app.config import resolve_database_path

DEFAULT_RETENTION_HOURS = 48
SQLITE_INTEGER_MIN = -(1 << 63)
SQLITE_INTEGER_MAX = (1 << 63) - 1
WRITE_ATTEMPTS = 3


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

    def has_storable_integers(self) -> bool:
        return all(
            type(value) is int and SQLITE_INTEGER_MIN <= value <= SQLITE_INTEGER_MAX
            for value in (
                self.arrival_us, self.sender_port, self.packet_size, self.slot,
                self.shred_index, self.fec_set_index, self.version, self.variant,
            )
        )


class ShredDatabase:
    def __init__(
        self,
        path: str | Path | None = None,
        *,
        timeout: float = 5.0,
    ) -> None:
        self.path = resolve_database_path(path)

        self.path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        self.connection = sqlite3.connect(
            self.path,
            timeout=timeout,
        )

        self.connection.row_factory = sqlite3.Row

        self.connection.execute(
            "PRAGMA journal_mode=WAL"
        )

        self.connection.execute(
            "PRAGMA synchronous=NORMAL"
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
            ON shred_arrivals(
                slot,
                fec_set_index
            );

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

        statement = """
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
            """
        for attempt in range(WRITE_ATTEMPTS):
            try:
                with self.connection:
                    self.connection.executemany(statement, rows)
                return len(rows)
            except sqlite3.OperationalError as error:
                name = getattr(error, "sqlite_errorname", None)
                is_lock = (
                    name.startswith(("SQLITE_BUSY", "SQLITE_LOCKED")) if name else
                    str(error) in ("database is locked", "database table is locked")
                )
                if (
                    not is_lock
                    or attempt == WRITE_ATTEMPTS - 1
                    or self.connection.in_transaction
                ):
                    raise
                time.sleep(0.05)

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
        return self.list_slots(
            limit=limit,
        )

    def list_slots(
        self,
        limit: int = 100,
        before: int | None = None,
        after: int | None = None,
    ) -> list[dict]:
        if (
            before is not None
            and after is not None
        ):
            raise ValueError(
                "before and after cannot be used together"
            )

        where_clause = ""
        parameters: list[int] = []

        if before is not None:
            where_clause = "WHERE slot < ?"
            parameters.append(before)

        elif after is not None:
            where_clause = "WHERE slot > ?"
            parameters.append(after)

        if after is not None:
            order = "ASC"
        else:
            order = "DESC"

        parameters.append(limit)

        rows = self.connection.execute(
            f"""
            SELECT
                slot,
                MIN(arrival_us) AS first_arrival_us,
                MAX(arrival_us) AS last_arrival_us,
                COUNT(*) AS arrivals,
                COUNT(DISTINCT fec_set_index) AS fec_sets
            FROM shred_arrivals
            {where_clause}
            GROUP BY slot
            ORDER BY slot {order}
            LIMIT ?
            """,
            parameters,
        ).fetchall()

        result = [
            dict(row)
            for row in rows
        ]

        if after is not None:
            result.reverse()

        return result

    def latest_slot(self) -> int | None:
        row = self.connection.execute(
            """
            SELECT MAX(slot) AS slot
            FROM shred_arrivals
            """
        ).fetchone()

        if row["slot"] is None:
            return None

        return int(row["slot"])

    def latest_arrival_us(
        self,
    ) -> int | None:
        row = self.connection.execute(
            """
            SELECT MAX(arrival_us) AS arrival_us
            FROM shred_arrivals
            """
        ).fetchone()

        if row["arrival_us"] is None:
            return None

        return int(
            row["arrival_us"]
        )

    def get_slot(
        self,
        slot: int,
    ) -> list[dict]:
        rows = self.connection.execute(
            """
            SELECT
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
            FROM shred_arrivals
            WHERE slot = ?
            ORDER BY arrival_us ASC, id ASC
            """,
            (slot,),
        ).fetchall()

        return [
            dict(row)
            for row in rows
        ]

    def live_observation(self, now_us: int, cutoff_us: int) -> tuple[int, int] | None:
        """Return the preferred live slot and its latest eligible arrival."""
        row = self.connection.execute(
            """
            WITH selected AS (
                SELECT slot, arrival_us
                FROM shred_arrivals INDEXED BY idx_shred_arrivals_arrival_us
                WHERE arrival_us BETWEEN ? AND ?
                    AND shred_type IN ('data', 'code')
                ORDER BY slot DESC, arrival_us DESC, id DESC
                LIMIT 1
            )
            SELECT slot, arrival_us FROM selected
            UNION ALL
            SELECT slot, arrival_us FROM (
                SELECT slot, arrival_us
                FROM shred_arrivals
                WHERE arrival_us < ? AND shred_type IN ('data', 'code')
                ORDER BY arrival_us DESC, id DESC
                LIMIT CASE WHEN EXISTS (SELECT 1 FROM selected) THEN 0 ELSE 1 END
            )
            """,
            (cutoff_us, now_us, cutoff_us),
        ).fetchone()
        return (row["slot"], row["arrival_us"]) if row is not None else None

    def get_live_slot(self, now_us: int, cutoff_us: int) -> tuple[int, list[dict]] | None:
        with self.connection:
            self.connection.execute("BEGIN")
            observation = self.live_observation(now_us, cutoff_us)
            if observation is not None:
                slot, _ = observation
                return slot, self.get_slot(slot)
        return None

    def delete_older_than(
        self,
        hours: int = DEFAULT_RETENTION_HOURS,
    ) -> int:
        cutoff_us = (
            time.time_ns() // 1000
            - hours
            * 60
            * 60
            * 1_000_000
        )

        with self.connection:
            cursor = self.connection.execute(
                """
                DELETE FROM shred_arrivals
                WHERE arrival_us < ?
                """,
                (cutoff_us,),
            )

        return cursor.rowcount

    def close(self) -> None:
        self.connection.close()
