"""Share accepted-traffic timestamps independently of SQLite writes."""

import json
import os
from pathlib import Path


def status_path(database_path: Path) -> Path:
    return database_path.with_name(f"{database_path.name}.receiver.json")


def publish_accepted_arrival(database_path: Path, arrival_us: int) -> None:
    path = status_path(database_path)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"last_accepted_us": arrival_us}), encoding="utf-8")
    temporary.replace(path)


def read_accepted_arrival(database_path: Path) -> int | None:
    try:
        status = json.loads(status_path(database_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    arrival_us = status.get("last_accepted_us") if isinstance(status, dict) else None
    return arrival_us if type(arrival_us) is int else None
