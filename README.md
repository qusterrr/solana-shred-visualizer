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