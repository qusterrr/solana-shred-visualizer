from __future__ import annotations

import argparse
import socket
import time

from app.shred import parse_shred_header


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8002
MAX_UDP_PACKET_SIZE = 65535


def run_receiver(host: str, port: int) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    sock.bind((host, port))

    print(f"Listening for UDP shreds on {host}:{port}")

    packet_count = 0
    started_at = time.monotonic()

    while True:
        payload, sender = sock.recvfrom(MAX_UDP_PACKET_SIZE)

        arrival_us = time.time_ns() // 1000

        packet_count += 1

        try:
            shred = parse_shred_header(payload)

            print(
                f"arrival={arrival_us} "
                f"sender={sender[0]}:{sender[1]} "
                f"bytes={len(payload)} "
                f"slot={shred.slot} "
                f"index={shred.index} "
                f"fec={shred.fec_set_index} "
                f"type={shred.shred_type.value} "
                f"version={shred.version}"
            )

        except ValueError as exc:
            print(
                f"arrival={arrival_us} "
                f"sender={sender[0]}:{sender[1]} "
                f"bytes={len(payload)} "
                f"invalid={exc}"
            )

        if packet_count % 1000 == 0:
            elapsed = time.monotonic() - started_at

            packets_per_second = (
                packet_count / elapsed
                if elapsed > 0
                else 0.0
            )

            print(
                f"[stats] packets={packet_count} "
                f"rate={packets_per_second:.1f} pkt/s"
            )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Receive and inspect live Solana shred UDP packets."
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

    args = parser.parse_args()

    run_receiver(
        host=args.host,
        port=args.port,
    )


if __name__ == "__main__":
    main()