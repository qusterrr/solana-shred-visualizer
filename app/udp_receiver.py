from __future__ import annotations

import argparse
import socket
import time

from app.database import (
    DEFAULT_DATABASE_PATH,
    ShredArrival,
    ShredDatabase,
)
from app.shred import parse_shred_header


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8002

MAX_UDP_PACKET_SIZE = 65535

BATCH_SIZE = 500
FLUSH_INTERVAL_SECONDS = 0.5
CLEANUP_INTERVAL_SECONDS = 60.0


def run_receiver(
    host: str,
    port: int,
    database_path: str,
) -> None:
    database = ShredDatabase(
        database_path,
    )

    sock = socket.socket(
        socket.AF_INET,
        socket.SOCK_DGRAM,
    )

    sock.bind(
        (host, port)
    )

    sock.settimeout(0.2)

    print(
        f"Listening for UDP shreds "
        f"on {host}:{port}"
    )

    print(
        f"SQLite database: "
        f"{database.path}"
    )

    pending: list[ShredArrival] = []

    packet_count = 0
    parsed_count = 0
    invalid_count = 0

    started_at = time.monotonic()
    last_flush = time.monotonic()
    last_stats = time.monotonic()
    last_cleanup = time.monotonic()

    try:
        while True:
            now = time.monotonic()

            try:
                payload, sender = sock.recvfrom(
                    MAX_UDP_PACKET_SIZE
                )

            except socket.timeout:
                payload = None
                sender = None

            if payload is not None and sender is not None:
                packet_count += 1

                arrival_us = (
                    time.time_ns()
                    // 1000
                )

                try:
                    shred = parse_shred_header(
                        payload
                    )

                except ValueError:
                    invalid_count += 1

                else:
                    parsed_count += 1

                    pending.append(
                        ShredArrival(
                            arrival_us=arrival_us,
                            sender_ip=sender[0],
                            sender_port=sender[1],
                            packet_size=len(payload),
                            slot=shred.slot,
                            shred_index=shred.index,
                            fec_set_index=(
                                shred.fec_set_index
                            ),
                            shred_type=(
                                shred.shred_type.value
                            ),
                            version=shred.version,
                            variant=shred.variant,
                        )
                    )

            now = time.monotonic()

            should_flush = (
                len(pending) >= BATCH_SIZE
                or (
                    pending
                    and now - last_flush
                    >= FLUSH_INTERVAL_SECONDS
                )
            )

            if should_flush:
                database.insert_many(
                    pending
                )

                pending.clear()

                last_flush = now

            if (
                now - last_cleanup
                >= CLEANUP_INTERVAL_SECONDS
            ):
                deleted = (
                    database.delete_older_than(
                        hours=48
                    )
                )

                if deleted:
                    print(
                        f"[cleanup] "
                        f"deleted={deleted}"
                    )

                last_cleanup = now

            if (
                now - last_stats
                >= 1.0
            ):
                elapsed = (
                    now - started_at
                )

                rate = (
                    packet_count / elapsed
                    if elapsed > 0
                    else 0.0
                )

                stored = (
                    database.count_records()
                )

                print(
                    f"[stats] "
                    f"packets={packet_count} "
                    f"parsed={parsed_count} "
                    f"invalid={invalid_count} "
                    f"stored={stored} "
                    f"buffered={len(pending)} "
                    f"rate={rate:.1f} pkt/s"
                )

                last_stats = now

    except KeyboardInterrupt:
        print(
            "\nStopping receiver..."
        )

    finally:
        if pending:
            inserted = (
                database.insert_many(
                    pending
                )
            )

            print(
                f"Flushed {inserted} "
                f"remaining records"
            )

        total = database.count_records()

        database.close()
        sock.close()

        print(
            f"Receiver stopped. "
            f"Total stored records: {total}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Receive live Solana shreds "
            "over UDP and store metadata "
            "in SQLite."
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
        default=str(
            DEFAULT_DATABASE_PATH
        ),
    )

    args = parser.parse_args()

    run_receiver(
        host=args.host,
        port=args.port,
        database_path=args.database,
    )


if __name__ == "__main__":
    main()