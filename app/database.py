from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from app.config import resolve_database_path

DEFAULT_RETENTION_HOURS = 48
RETENTION_BATCH_SLOTS = 128
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
        self._create_slot_observations()

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

    def _create_slot_observations(self) -> None:
        exists = "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'slot_observations'"
        if self.connection.execute(exists).fetchone():
            return
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            if self.connection.execute(exists).fetchone():
                return
            self.connection.execute("""
                CREATE TABLE slot_observations (
                    slot INTEGER PRIMARY KEY,
                    first_arrival_us INTEGER NOT NULL,
                    last_arrival_us INTEGER NOT NULL
                )
            """)
            self.connection.execute("""
                INSERT INTO slot_observations
                SELECT slot, MIN(arrival_us), MAX(arrival_us)
                FROM shred_arrivals GROUP BY slot
            """)
            self.connection.execute(
                "CREATE INDEX idx_slot_observations_first ON slot_observations(first_arrival_us)"
            )
            self.connection.execute(
                "CREATE INDEX idx_slot_observations_last ON slot_observations(last_arrival_us)"
            )
            self.connection.execute(
                "CREATE INDEX idx_shred_arrivals_slot_time ON shred_arrivals(slot, arrival_us)"
            )
            self.connection.execute("DROP INDEX IF EXISTS idx_shred_arrivals_slot")

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

        observations = {}
        for arrival_us, _, _, _, slot, *_ in rows:
            first, last = observations.get(slot, (arrival_us, arrival_us))
            observations[slot] = (min(first, arrival_us), max(last, arrival_us))

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
                    self.connection.executemany(
                        """
                        INSERT INTO slot_observations VALUES (?, ?, ?)
                        ON CONFLICT(slot) DO UPDATE SET
                            first_arrival_us = MIN(first_arrival_us, excluded.first_arrival_us),
                            last_arrival_us = MAX(last_arrival_us, excluded.last_arrival_us)
                        """,
                        [(slot, *times) for slot, times in observations.items()],
                    )
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
        *,
        at: int | None = None,
    ) -> list[dict]:
        cursors = [(op, value) for op, value in (("<", before), (">", after), ("<=", at))
                   if value is not None]
        if len(cursors) > 1:
            raise ValueError("Use only one history cursor")
        where_clause = f"WHERE slot {cursors[0][0]} ?" if cursors else ""
        parameters = [value for _, value in cursors] + [limit]
        order = "ASC" if after is not None else "DESC"

        rows = self.connection.execute(
            f"""
            SELECT page.*,
                (SELECT COUNT(*) FROM shred_arrivals WHERE slot = page.slot) AS arrivals,
                (SELECT COUNT(DISTINCT fec_set_index)
                 FROM shred_arrivals WHERE slot = page.slot) AS fec_sets
            FROM (
                SELECT slot, first_arrival_us, last_arrival_us
                FROM slot_observations
                {where_clause}
                ORDER BY slot {order}
                LIMIT ?
            ) AS page
            ORDER BY page.slot DESC
            """,
            parameters,
        ).fetchall()

        return [dict(row) for row in rows]

    def slot_page(
        self, limit: int, before: int | None, after: int | None, at: int | None,
    ) -> dict:
        with self.connection:
            self.connection.execute("BEGIN")
            slots = self.list_slots(limit, before, after, at=at)
            oldest = slots[-1]["slot"] if slots else None
            newest = slots[0]["slot"] if slots else None
            bounds = self.connection.execute(
                """
                SELECT EXISTS(SELECT 1 FROM slot_observations WHERE slot < ?),
                       EXISTS(SELECT 1 FROM slot_observations WHERE slot > ?)
                """,
                (oldest, newest),
            ).fetchone()
        return {
            "slots": slots,
            "oldest_slot": oldest,
            "newest_slot": newest,
            "has_older": bool(bounds[0]),
            "has_newer": bool(bounds[1]),
        }

    def nearest_observed_slot(self, requested_us: int) -> dict | None:
        with self.connection:
            self.connection.execute("BEGIN")
            before, after = self.connection.execute(
                """
                SELECT (SELECT MAX(first_arrival_us) FROM slot_observations
                        WHERE first_arrival_us <= ?),
                       (SELECT MIN(first_arrival_us) FROM slot_observations
                        WHERE first_arrival_us >= ?)
                """,
                (requested_us, requested_us),
            ).fetchone()
            if before is None and after is None:
                return None

            candidates = [value for value in (before, after) if value is not None]
            matched_us = min(candidates, key=lambda value: (abs(value - requested_us), value))
            row = self.connection.execute(
                """
                SELECT slot FROM slot_observations
                WHERE first_arrival_us = ? ORDER BY slot LIMIT 1
                """,
                (matched_us,),
            ).fetchone()
        return {
            "slot": row["slot"],
            "first_arrival_us": matched_us,
            "difference_us": matched_us - requested_us,
            "range": "before" if before is None else "after" if after is None else "within",
        }

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

    def get_live_slot(
        self, now_us: int, cutoff_us: int, *, previous: bool = False,
    ) -> tuple[int, list[dict]] | None:
        with self.connection:
            self.connection.execute("BEGIN")
            observation = self.live_observation(now_us, cutoff_us)
            if observation is not None:
                slot, _ = observation
                if previous:
                    predecessor = self.connection.execute(
                        """
                        SELECT slot FROM shred_arrivals
                        WHERE slot < ? AND arrival_us <= ? AND shred_type IN ('data', 'code')
                        ORDER BY slot DESC LIMIT 1
                        """,
                        (slot, now_us),
                    ).fetchone()
                    if predecessor is None:
                        return None
                    slot = predecessor["slot"]
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
            self.connection.execute("BEGIN IMMEDIATE")
            slots = self.connection.execute(
                """
                SELECT slot FROM slot_observations
                WHERE last_arrival_us < ? ORDER BY last_arrival_us, slot LIMIT ?
                """,
                (cutoff_us, RETENTION_BATCH_SLOTS),
            ).fetchall()
            if not slots:
                return 0
            placeholders = ", ".join("?" for _ in slots)
            parameters = [row["slot"] for row in slots]
            deleted = self.connection.execute(
                f"DELETE FROM shred_arrivals WHERE slot IN ({placeholders})", parameters,
            ).rowcount
            self.connection.executemany(
                "DELETE FROM slot_observations WHERE slot = ?",
                [(slot,) for slot in parameters],
            )
            return deleted

    def close(self) -> None:
        self.connection.close()
