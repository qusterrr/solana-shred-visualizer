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
