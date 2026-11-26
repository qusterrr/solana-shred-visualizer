Solana Shred Visualizer

Web-based visualization and monitoring tool for Solana shred arrival data.

The project is based on data collected by the existing Agave wire-format monitoring tool. The goal is to replace the current Python/Matplotlib visualization with a clearer browser-based interface that supports both current data and historical analysis.

Goals

Visualize Solana shred arrivals by slot and FEC group

Provide a clear alternative to the existing line-based plots

Experiment with heatmap-based visualization

Store at least 48 hours of historical data

Allow browsing historical slots

Periodically update the current data in the browser

Support repair, duplicate, overlapping and other special cases in later development stages

Planned Stack

Backend: Python + FastAPI

Frontend: HTML, CSS and vanilla JavaScript

Visualization: Plotly.js

Storage: SQLite

API: REST/HTTP

Live updates: HTTP polling

Deployment: Linux server

## Receiver and API configuration

Run `python -m app.udp_receiver` for UDP port 8002 and
`uvicorn app.main:app` for the API. Both default to `data/shreds.db`
under the project root. Set `SHRED_DATABASE_PATH` to the same absolute
path in both processes to use another database. The receiver's
`--database` option takes precedence for that process and emits a warning
if it differs from the shared setting. Both processes log their resolved
database path at startup. Relative overrides resolve against each process's
working directory.

## Live slot and health

The live view selects the highest slot with a committed data or coding
arrival in the last three seconds. A late arrival for a lower slot won't
displace a higher slot that still has recent traffic. Once no slot has
recent traffic, the view shows the slot of the most recent eligible
committed arrival. Timestamps later than the API clock and unknown shred
types are ineligible for live selection. Live selection and its arrival
records are read from one SQLite snapshot. If there is no eligible slot,
`/api/live` returns `{"slot": null}`.

`/api/health` reports API availability through `status` and stream
freshness through `state`. `live` means the selected live slot has recent
committed arrivals. `lagging` means the receiver recently accepted a data
or coding shred and there is no recent eligible committed arrival.
`stale` means eligible committed arrivals exist but have aged out of the
freshness window. `no_data` means neither signal is available. The
receiver publishes the last accepted arrival in a small status file next
to the database, independently of commits. Both signals expire after
three seconds. If the status file is unavailable, recent committed data
still establishes recent traffic. The lag state describes a gap in
freshness, which can include failed commits. It does not measure queue
latency.

## Browsing history

**Observed time** is the timestamp of the first retained arrival the receiver
recorded for a slot. It describes receiver observation, rather than Solana block
production. The picker and displayed timestamps use UTC.

`GET /api/slots/nearest?observed_at=...` accepts an ISO 8601 datetime with
`Z` or an explicit UTC offset. Percent-encode a positive offset's `+`.
It returns `requested_us` and a `match` containing `slot`, `first_arrival_us`,
`difference_us` (matched minus requested), and `range` (`within`, `before`,
or `after`). Timestamps are Unix microseconds. Equal distances favor the
earlier observation. Among slots with the same observation timestamp, the
lowest slot wins. Outside the retained range, the nearest endpoint is selected
and the browser reports the boundary. An empty store returns `match: null`.

`GET /api/slots` returns one bounded page sorted by descending slot number,
along with `oldest_slot`, `newest_slot`, `has_older`, and `has_newer` from the
same snapshot. Older uses the exclusive `before` cursor at the oldest slot.
Newer uses the exclusive `after` cursor at the newest slot and takes the
nearest greater slots. A successful time lookup starts a page at the matched
slot with the inclusive `at` cursor. Exact slot lookup and Live/Previous
selection leave the history boundaries in place. Each page reflects the
database at request time, so newly retained or pruned slots may change the
next page. The browser revalidates the page when navigation encounters an
empty boundary or an expired slot.

Previous follows the greatest retained slot below the current live selection
with a recognized arrival at or before the API clock. The API chooses and
reads it in the same snapshot. It returns an empty selection when there is no
eligible predecessor.

## Retention and release verification

Retention targets 48 hours from a slot's **last** recorded arrival. Cleanup
removes a slot and all its arrivals together when that timestamp is strictly
older than the cutoff. Slots ending exactly at the cutoff keep every arrival.
A slot can retain early arrivals beyond 48 hours if a later arrival keeps it
eligible. A packet arriving for a slot after the slot has been fully pruned
starts a new retained observation. Cleanup runs on a separate SQLite connection
in batches of up to 128 slots.

The first Phase 3 open of an existing database backfills the observation
summary and creates its indexes in a transaction. Schedule the upgrade with
the old receiver stopped so there is no old writer bypassing the summary.
The backfill uses the rows still present at upgrade time. Page seeks use the
slot primary key, time lookup and expiry use the first/last arrival indexes,
and detail reads use the `(slot, arrival_us)` index.

For the release soak, run representative sustained UDP traffic across a
48-hour retention boundary while exercising live views and history queries.
Record receiver commit and failure counters, socket drops, API latency,
SQLite/WAL size, free space, and CPU/memory usage during cleanup. Verify
live/stale transitions, restart recovery, and time navigation against captured
observations. Measure migration time separately on a copy of the deployment
database.
