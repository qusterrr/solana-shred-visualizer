from __future__ import annotations

import argparse
import logging
import socket
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from threading import Event, Thread

from app.config import DATABASE_ENV, resolve_database_path
from app.database import DEFAULT_RETENTION_HOURS, ShredArrival, ShredDatabase
from app.receiver_status import publish_accepted_arrival
from app.shred import ShredType, parse_shred_header


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8002
MAX_UDP_PACKET_SIZE = 65535

BATCH_SIZE = 500
FLUSH_INTERVAL_SECONDS = 0.5
CLEANUP_INTERVAL_SECONDS = 60.0


logger = logging.getLogger(__name__)


def prune_expired_slots(database_path: Path, stop: Event) -> None:
    while not stop.wait(CLEANUP_INTERVAL_SECONDS):
        total = 0
        try:
            with closing(ShredDatabase(database_path, timeout=0.25)) as database:
                while not stop.is_set():
                    deleted = database.delete_older_than(hours=DEFAULT_RETENTION_HOURS)
                    if not deleted:
                        break
                    total += deleted
                    stop.wait(0.05)
        except sqlite3.Error:
            logger.exception("Could not prune expired slots from %s", database_path)
        if total:
            print(f"[cleanup] deleted={total}")


def receive_arrivals(sock: socket.socket, database: ShredDatabase) -> None:
    pending: list[ShredArrival] = []
    packet_count = parsed_count = invalid_count = committed_count = 0
    failed_batches = failed_records = 0
    last_accepted_us = last_published_us = None

    started_at = time.monotonic()
    last_flush = last_stats = started_at
    last_status_attempt = float("-inf")

    def publish_status() -> None:
        nonlocal last_published_us
        if last_accepted_us is None or last_accepted_us == last_published_us:
            return
        try:
            publish_accepted_arrival(database.path, last_accepted_us)
        except OSError:
            logger.exception("Could not publish receiver status for %s", database.path)
        else:
            last_published_us = last_accepted_us

    def flush() -> None:
        nonlocal pending, committed_count, failed_batches, failed_records
        if not pending:
            return

        # Detach before the write so shutdown never replays an attempted batch.
        batch, pending = pending, []
        try:
            committed_count += database.insert_many(batch)
        except (sqlite3.Error, OverflowError):
            failed_batches += 1
            failed_records += len(batch)
            logger.exception("Could not commit %d arrivals to %s", len(batch), database.path)

    def report_stats() -> None:
        elapsed = time.monotonic() - started_at
        rate = packet_count / elapsed if elapsed > 0 else 0.0
        print(
            f"[stats] packets={packet_count} parsed={parsed_count} "
            f"invalid={invalid_count} committed={committed_count} pending={len(pending)} "
            f"failed_batches={failed_batches} failed_records={failed_records} "
            f"rate={rate:.1f} pkt/s"
        )

    try:
        while True:
            try:
                payload, sender = sock.recvfrom(MAX_UDP_PACKET_SIZE)
            except socket.timeout:
                pass
            else:
                packet_count += 1
                arrival_us = time.time_ns() // 1000
                try:
                    shred = parse_shred_header(payload)
                except ValueError:
                    invalid_count += 1
                else:
                    parsed_count += 1
                    arrival = ShredArrival(
                        arrival_us=arrival_us,
                        sender_ip=sender[0],
                        sender_port=sender[1],
                        packet_size=len(payload),
                        slot=shred.slot,
                        shred_index=shred.index,
                        fec_set_index=shred.fec_set_index,
                        shred_type=shred.shred_type.value,
                        version=shred.version,
                        variant=shred.variant,
                    )
                    if arrival.has_storable_integers():
                        pending.append(arrival)
                        if shred.shred_type != ShredType.UNKNOWN:
                            last_accepted_us = arrival_us
                    else:
                        invalid_count += 1

            now = time.monotonic()
            if now - last_status_attempt >= FLUSH_INTERVAL_SECONDS:
                publish_status()
                last_status_attempt = now

            if len(pending) >= BATCH_SIZE or (pending and now - last_flush >= FLUSH_INTERVAL_SECONDS):
                flush()
                last_flush = now

            if now - last_stats >= 1.0:
                report_stats()
                last_stats = now
    except KeyboardInterrupt:
        print("\nStopping receiver...")
        publish_status()
        flush()
        report_stats()


def run_receiver(host: str, port: int, database_path: str | Path | None = None) -> None:
    path = resolve_database_path(database_path)
    shared_path = resolve_database_path()
    if path != shared_path:
        logger.warning(
            "Receiver database override %s differs from the shared path %s. "
            "Set %s to the same absolute path for the API.",
            path, shared_path, DATABASE_ENV,
        )

    with closing(ShredDatabase(path, timeout=0.25)) as database:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.bind((host, port))
            sock.settimeout(0.2)
            print(f"Listening on UDP {host}:{port}")
            print(f"Database: {database.path}")
            stop_cleanup = Event()
            cleanup = Thread(target=prune_expired_slots, args=(path, stop_cleanup))
            cleanup.start()
            try:
                receive_arrivals(sock, database)
            finally:
                stop_cleanup.set()
                cleanup.join()
    print("Receiver stopped.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Receive Solana shred UDP packets "
            "and store their metadata in SQLite."
        )
    )

    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
    )

    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
    )

    parser.add_argument(
        "--database",
        help=f"Override {DATABASE_ENV} and the default data/shreds.db path",
    )

    args = parser.parse_args()

    run_receiver(
        host=args.host,
        port=args.port,
        database_path=args.database,
    )


if __name__ == "__main__":
    main()
