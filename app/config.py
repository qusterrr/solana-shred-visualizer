import os
from pathlib import Path


DATABASE_ENV = "SHRED_DATABASE_PATH"
DEFAULT_DATABASE_PATH = Path(__file__).resolve().parent.parent / "data" / "shreds.db"


def resolve_database_path(override: str | Path | None = None) -> Path:
    configured = override if override is not None else os.getenv(DATABASE_ENV)
    return Path(configured or DEFAULT_DATABASE_PATH).expanduser().resolve()
