from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from app.database import ShredDatabase


app = FastAPI(
    title="Solana Shred Visualizer",
    version="0.1.0",
)


@app.get("/api/health")
def health() -> dict:
    database = ShredDatabase()

    try:
        records = database.count_records()

        return {
            "status": "ok",
            "records": records,
        }
    finally:
        database.close()


@app.get("/api/slots")
def get_slots(
    limit: int = Query(
        default=50,
        ge=1,
        le=500,
    ),
) -> dict:
    database = ShredDatabase()

    try:
        slots = database.latest_slots(limit)

        result = []

        for slot in slots:
            duration_ms = (
                slot["last_arrival_us"]
                - slot["first_arrival_us"]
            ) / 1000

            result.append(
                {
                    **slot,
                    "duration_ms": round(
                        duration_ms,
                        3,
                    ),
                }
            )

        return {
            "slots": result,
        }

    finally:
        database.close()


@app.get("/api/slots/{slot}")
def get_slot(slot: int) -> dict:
    database = ShredDatabase()

    try:
        records = database.get_slot(slot)

    finally:
        database.close()

    if not records:
        raise HTTPException(
            status_code=404,
            detail="Slot not found",
        )

    first_arrival_us = records[0]["arrival_us"]
    last_arrival_us = records[-1]["arrival_us"]

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
        "first_arrival_us": first_arrival_us,
        "last_arrival_us": last_arrival_us,
        "duration_ms": round(
            (
                last_arrival_us
                - first_arrival_us
            )
            / 1000,
            3,
        ),
        "arrivals": len(records),
        "fec_sets": fec_sets,
        "fec_count": len(fec_sets),
        "data_shreds": data_shreds,
        "code_shreds": code_shreds,
        "events": events,
    }


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