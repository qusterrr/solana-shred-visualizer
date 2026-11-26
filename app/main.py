from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import (
    FastAPI,
    HTTPException,
    Path as PathParam,
    Query,
)
from fastapi.staticfiles import StaticFiles

from app.analysis import DECODE_THRESHOLD, analyze_slot
from app.config import resolve_database_path
from app.database import SQLITE_INTEGER_MAX, ShredDatabase
from app.receiver_status import read_accepted_arrival


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.getLogger("uvicorn.error").info("API database: %s", resolve_database_path())
    yield


app = FastAPI(
    title="Solana Shred Visualizer",
    version="0.1.0",
    lifespan=lifespan,
)


LIVE_TIMEOUT_MS = 3000
SlotCursor = Annotated[int | None, Query(ge=0, le=SQLITE_INTEGER_MAX)]


def live_window() -> tuple[int, int]:
    now_us = time.time_ns() // 1000
    return now_us, now_us - LIVE_TIMEOUT_MS * 1000


def build_slot_response(
    slot: int,
    records: list[dict],
) -> dict:
    if not records:
        raise HTTPException(
            status_code=404,
            detail="Slot not found",
        )

    first_arrival_us = (
        min(record["arrival_us"] for record in records)
    )

    last_arrival_us = (
        max(record["arrival_us"] for record in records)
    )

    fec_sets = sorted(
        {
            record["fec_set_index"]
            for record in records
        }
    )

    data_shreds = sum(
        record["shred_type"] == "data"
        for record in records
    )

    code_shreds = sum(
        record["shred_type"] == "code"
        for record in records
    )

    events = []

    for record in records:
        events.append(
            {
                **record,

                "arrival_ms": round(
                    (
                        record["arrival_us"]
                        - first_arrival_us
                    )
                    / 1000,
                    3,
                ),
            }
        )

    return {
        "slot": slot,

        "first_arrival_us":
            first_arrival_us,

        "last_arrival_us":
            last_arrival_us,

        "observed_span_ms":
            round(
                (
                    last_arrival_us
                    - first_arrival_us
                )
                / 1000,
                3,
            ),

        "arrivals":
            len(records),

        "fec_sets":
            fec_sets,

        "fec_count":
            len(fec_sets),

        "data_shreds":
            data_shreds,

        "code_shreds":
            code_shreds,

        "events":
            events,

        "decode_threshold": DECODE_THRESHOLD,
        "fec_analysis": analyze_slot(slot, events),
    }


@app.get("/api/health")
def health() -> dict:
    database = ShredDatabase()

    try:
        last_accepted_us = read_accepted_arrival(database.path)
        now_us, cutoff_us = live_window()
        observation = database.live_observation(now_us, cutoff_us)
    finally:
        database.close()

    latest_slot, last_arrival_us = observation if observation is not None else (None, None)
    committed_recent = last_arrival_us is not None and last_arrival_us >= cutoff_us
    accepted_recent = committed_recent or (
        last_accepted_us is not None and cutoff_us <= last_accepted_us <= now_us
    )
    if committed_recent:
        state = "live"
    elif accepted_recent:
        state = "lagging"
    elif observation is None:
        state = "no_data"
    else:
        state = "stale"

    return {
        "status": "ok",
        "state": state,
        "live": state == "live",
        "accepted_recent": accepted_recent,
        "committed_recent": committed_recent,
        "latest_slot": latest_slot,
        "last_arrival_us": last_arrival_us,
        "last_arrival_age_ms": (
            round((now_us - last_arrival_us) / 1000, 1)
            if last_arrival_us is not None else None
        ),
    }


@app.get("/api/slots")
def get_slots(
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    before: SlotCursor = None,
    after: SlotCursor = None,
    at: SlotCursor = None,
) -> dict:
    if sum(cursor is not None for cursor in (before, after, at)) > 1:
        raise HTTPException(status_code=400, detail="Use only one history cursor")

    database = ShredDatabase()

    try:
        page = database.slot_page(limit, before, after, at)

    finally:
        database.close()

    for slot in page["slots"]:
        slot["observed_span_ms"] = round(
            (slot["last_arrival_us"] - slot["first_arrival_us"]) / 1000, 3,
        )
    return page


@app.get("/api/slots/nearest")
def get_nearest_slot(observed_at: str) -> dict:
    try:
        iso_time = observed_at[:-1] + "+00:00" if observed_at.endswith("Z") else observed_at
        timestamp = datetime.fromisoformat(iso_time)
        if timestamp.utcoffset() is None:
            raise ValueError("Missing UTC offset")
        elapsed = timestamp - datetime(1970, 1, 1, tzinfo=timezone.utc)
    except (ValueError, OverflowError) as error:
        raise HTTPException(422, "Supply an ISO 8601 date/time with a UTC offset") from error
    requested_us = (elapsed.days * 86400 + elapsed.seconds) * 1_000_000 + elapsed.microseconds

    database = ShredDatabase()
    try:
        return {"requested_us": requested_us, "match": database.nearest_observed_slot(requested_us)}
    finally:
        database.close()


@app.get("/api/slots/{slot}")
def get_slot(slot: Annotated[int, PathParam(ge=0, le=SQLITE_INTEGER_MAX)]) -> dict:
    database = ShredDatabase()

    try:
        records = (
            database.get_slot(slot)
        )

    finally:
        database.close()

    return build_slot_response(
        slot,
        records,
    )


@app.get("/api/live")
def get_live_slot() -> dict:
    return live_slot_response(previous=False)


@app.get("/api/previous")
def get_previous_slot() -> dict:
    return live_slot_response(previous=True)


def live_slot_response(*, previous: bool) -> dict:
    database = ShredDatabase()

    try:
        selected = database.get_live_slot(*live_window(), previous=previous)
    finally:
        database.close()

    if selected is None:
        return {"slot": None}

    slot, records = selected
    return build_slot_response(
        slot,
        records,
    )


STATIC_DIRECTORY = (
    Path(__file__).resolve().parent
    / "static"
)

app.mount(
    "/",
    StaticFiles(
        directory=STATIC_DIRECTORY,
        html=True,
    ),
    name="static",
)
