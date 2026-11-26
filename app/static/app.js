const slotSelect =
    document.getElementById(
        "slot-select"
    );

const autoModeSelect =
    document.getElementById(
        "auto-mode"
    );

const refreshButton =
    document.getElementById(
        "refresh-button"
    );

const cdfButton =
    document.getElementById(
        "cdf-button"
    );

const timelineButton =
    document.getElementById(
        "timeline-button"
    );

const densityButton =
    document.getElementById(
        "density-button"
    );

const olderButton =
    document.getElementById(
        "older-button"
    );

const newerButton =
    document.getElementById(
        "newer-button"
    );

const goSlotInput =
    document.getElementById(
        "go-slot-input"
    );

const goSlotButton =
    document.getElementById(
        "go-slot-button"
    );

const observedTimeInput = document.getElementById("observed-time-input");
const goTimeButton = document.getElementById("go-time-button");
const slotObservedTime = document.getElementById("slot-observed-time");
const navigationStatus = document.getElementById("navigation-status");
const historyPageStatus = document.getElementById("history-page-status");

const connectionStatus =
    document.getElementById(
        "connection-status"
    );

const slotTitle =
    document.getElementById(
        "slot-title"
    );

const slotSummary =
    document.getElementById(
        "slot-summary"
    );

const viewHelp =
    document.getElementById(
        "view-help"
    );


const POLL_INTERVAL_MS = 500;

const DENSITY_BUCKET_MS = 10;
const MAX_DENSITY_BUCKETS = 1024;
const MAX_DENSITY_CELLS = 262144;

const SLOT_REFERENCE_MS = 200;



let selectedSlot = null;

let currentView = "cdf";

let currentData = null;

let historyPage = { slots: [], oldest_slot: null, newest_slot: null };
let outsidePageKey = null;

let requestGeneration = 0;
let refreshingGeneration = null;
let healthInProgress = false;
let currentHealth = null;


async function fetchJson(url) {
    const response =
        await fetch(url);

    if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }

    return await response.json();
}


function setConnectionStatus(
    text,
    state = ""
) {
    connectionStatus.textContent =
        text;

    connectionStatus.className =
        `connection-status ${state}`;
}


function renderHealth() {
    if (currentHealth === null) return;

    const health = currentHealth;
    if (health.state === "live") {
        const label = selectedSlot !== null && selectedSlot !== health.latest_slot
            ? `LIVE \u00b7 Slot ${health.latest_slot}`
            : "LIVE";
        setConnectionStatus(label, "ok");
    } else if (health.state === "lagging") {
        setConnectionStatus("INGEST LAG", "error");
    } else if (health.state === "no_data") {
        setConnectionStatus("NO DATA", "error");
    } else {
        setConnectionStatus(`STALE \u00b7 ${(health.last_arrival_age_ms / 1000).toFixed(1)}s`, "error");
    }
}


async function refreshHealth() {
    if (healthInProgress) return;

    healthInProgress = true;
    try {
        currentHealth = await fetchJson("/api/health");
        renderHealth();
    } catch (error) {
        console.error(error);
        currentHealth = null;
        setConnectionStatus("OFFLINE", "error");
    } finally {
        healthInProgress = false;
    }
}


function setView(view) {
    currentView = view;

    cdfButton.classList.toggle(
        "active",
        view === "cdf"
    );

    timelineButton.classList.toggle(
        "active",
        view === "timeline"
    );

    densityButton.classList.toggle(
        "active",
        view === "density"
    );

    updateViewHelp();

    if (currentData !== null) {
        renderCurrentView();
    }
}


function updateViewHelp() {
    if (currentView === "cdf") {
        viewHelp.textContent =
            "CDF shows how the number of unique received shreds grows over time for each FEC set. " +
            "A diamond marks the point where 32 unique shreds have been received and the FEC set becomes decodable.";

        return;
    }

    if (currentView === "timeline") {
        viewHelp.textContent =
            "Timeline shows every observed shred arrival. Blue circles are data shreds, yellow squares are coding shreds. " +
            "A diamond marks when a FEC set becomes decodable.";

        return;
    }

    viewHelp.textContent =
        "Density groups arrivals into time buckets. Long spans use wider buckets.";
}


function formatObservedTime(arrivalUs) {
    const date = new Date(Math.floor(arrivalUs / 1000));
    return Number.isFinite(date.getTime())
        ? date.toISOString().replace("T", " ").replace("Z", " UTC")
        : "Unavailable";
}


function updateSlotOptions(pageChanged = false) {
    const slots = historyPage.slots;
    const outsidePage = currentData !== null && !slots.some(item => item.slot === currentData.slot);
    const key = outsidePage ? `${currentData.slot}:${currentData.first_arrival_us}` : null;
    if (pageChanged || key !== outsidePageKey) {
        outsidePageKey = key;
        slotSelect.innerHTML = "";
        for (const item of outsidePage ? [currentData, ...slots] : slots) {
            const option = document.createElement("option");
            option.value = String(item.slot);
            option.textContent = `Slot ${item.slot} | ${formatObservedTime(item.first_arrival_us)}`;
            slotSelect.appendChild(option);
        }
    }
    slotSelect.value = currentData === null ? "" : String(currentData.slot);
}


function showHistoryPage(page) {
    historyPage = page;
    updateSlotOptions(true);
    if (page.slots.length === 0) {
        historyPageStatus.textContent = "No retained slots in history.";
        return;
    }

    const boundaries = [];
    if (!page.has_older) boundaries.push("No older slots");
    if (!page.has_newer) boundaries.push("No newer slots at last check");
    historyPageStatus.textContent = [
        `History slots ${page.oldest_slot} to ${page.newest_slot}`, ...boundaries,
    ].join(" | ");
}


function fetchPage(cursor = "") {
    return fetchJson(`/api/slots?limit=100${cursor}`);
}


async function reloadHistoryPage() {
    const anchor = historyPage.newest_slot;
    const page = await fetchPage(anchor === null ? "" : `&at=${anchor}`);
    return page.slots.length === 0 && anchor !== null ? fetchPage() : page;
}


async function recoverHistoryPage(generation, replacement = null) {
    const displayed = selectedSlot;
    const wasInPage = historyPage.slots.some(item => item.slot === displayed);
    const page = replacement ?? await reloadHistoryPage();
    if (generation !== requestGeneration) return null;

    showHistoryPage(page);
    if (!page.slots.length) {
        showSlot({ slot: null });
    } else if (wasInPage && !page.slots.some(item => item.slot === displayed)) {
        try {
            await fetchJson(`/api/slots/${displayed}`);
        } catch (error) {
            if (generation !== requestGeneration) return null;
            if (error.status !== 404) throw error;
            showSlot({ slot: null });
        }
    }
    return generation === requestGeneration ? page : null;
}


function updateSummary(data) {
    slotTitle.textContent =
        `Slot ${data.slot}`;
    slotObservedTime.textContent = `Observed time ${formatObservedTime(data.first_arrival_us)}`;

    slotSummary.textContent =
        [
            `${data.arrivals.toLocaleString()} arrivals`,
            `${data.fec_count} FEC`,
            `${data.data_shreds} data`,
            `${data.code_shreds} code`,
            `observed ${data.observed_span_ms.toFixed(1)} ms`,
        ].join(" · ");
}


function getFecSets(events) {
    return [
        ...new Set(
            events.map(
                event =>
                    event.fec_set_index
            )
        ),
    ].sort(
        (a, b) => a - b
    );
}


function getTimelineRange(data) {
    const maximum =
        Math.max(
            SLOT_REFERENCE_MS,
            data.observed_span_ms
        );

    return [
        0,

        Math.ceil(
            maximum / 50
        ) * 50 + 20,
    ];
}


function createReferenceLine() {
    return {
        type: "line",

        x0: SLOT_REFERENCE_MS,
        x1: SLOT_REFERENCE_MS,

        y0: 0,
        y1: 1,

        yref: "paper",

        line: {
            color: "#737b85",
            width: 1,
            dash: "dash",
        },
    };
}


function createReferenceAnnotation() {
    return {
        x: SLOT_REFERENCE_MS,
        y: 1,

        xref: "x",
        yref: "paper",

        text: "200 ms",

        showarrow: false,

        xanchor: "left",
        yanchor: "bottom",

        font: {
            size: 10,
            color: "#737b85",
        },
    };
}


function createCdf(data) {
    const threshold = data.decode_threshold;
    const traces = [];
    const range = getTimelineRange(data);

    const colors = [
        "#5b8def",
        "#62b7a5",
        "#d6a84b",
        "#b879d9",
        "#db7b72",
        "#7ca7c9",
        "#93b86b",
        "#c98fbd",
        "#9d9d9d",
    ];

    data.fec_analysis.forEach(
        (stats, index) => {
            const fec = stats.fec_set_index;
            const points = stats.cumulative_unique_points;
            if (!points.length) return;

            const last = points.at(-1);
            const cumulativeHover = "<b>FEC set index %{customdata[0]}</b>" +
                "<br>Time: %{x:.2f} ms<br>Unique shreds: %{y}";
            const arrivalHover = cumulativeHover +
                "<br>Index: %{customdata[1]}<br>Type: %{customdata[2]}<extra></extra>";

            const color =
                colors[
                    index
                    % colors.length
                ];

            traces.push(
                {
                    type: "scatter",

                    mode: "lines",

                    name:
                        `FEC ${fec}`,

                    x: [...points.map(point => point.arrival_ms), range[1]],
                    y: [...points.map(point => point.count), last.count],

                    line: {
                        color: color,
                        width: 2,
                        shape: "hv",
                    },

                    customdata: [
                        ...points.map(point => [fec, point.shred_index, point.shred_type]),
                        [fec],
                    ],
                    hovertemplate: [
                        ...points.map(() => arrivalHover),
                        cumulativeHover + "<extra></extra>",
                    ],
                }
            );

            if (
                stats.decode_time_ms
                !== null
            ) {
                traces.push(
                    {
                        type: "scatter",

                        mode: "markers",

                        name:
                            `FEC ${fec} decodable`,

                        showlegend: false,

                        x: [
                            stats.decode_time_ms
                        ],

                        y: [
                            threshold
                        ],

                        customdata: [
                            [fec]
                        ],

                        marker: {
                            size: 10,

                            symbol:
                                "diamond-open",

                            color: color,

                            line: {
                                width: 2,
                                color: color,
                            },
                        },

                        hovertemplate:
                            "<b>FEC decodable</b>" +
                            "<br>FEC set index: %{customdata[0]}" +
                            "<br>Time: %{x:.2f} ms" +
                            `<br>Unique shreds: ${threshold}` +
                            "<extra></extra>",
                    }
                );
            }
        }
    );

    const maximumUnique =
        Math.max(
            threshold + 4,

            ...data.fec_analysis.map(
                stats =>
                    stats.unique_recognized_shred_count
            )
        );

    const layout = {
        paper_bgcolor:
            "#0b0e11",

        plot_bgcolor:
            "#0b0e11",

        font: {
            color: "#c9d1d9",
            size: 12,
        },

        margin: {
            l: 75,
            r: 30,
            t: 25,
            b: 65,
        },

        hovermode:
            "closest",

        legend: {
            orientation: "h",

            x: 0,
            y: 1.08,

            font: {
                size: 11,
                color: "#8b949e",
            },
        },

        xaxis: {
            title:
                "Time since first shred (ms)",

            range: range,

            gridcolor:
                "#1f252c",

            zeroline:
                false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        yaxis: {
            title:
                "Unique shreds received",

            range: [
                0,
                maximumUnique
            ],

            gridcolor:
                "#1f252c",

            zeroline:
                false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        shapes: [
            createReferenceLine(),

            {
                type: "line",

                x0: 0,
                x1: 1,

                xref: "paper",

                y0:
                    threshold,

                y1:
                    threshold,

                line: {
                    color: "#737b85",
                    width: 1,
                    dash: "dot",
                },
            },
        ],

        annotations: [
            createReferenceAnnotation(),

            {
                x: 1,
                y:
                    threshold,

                xref: "paper",
                yref: "y",

                text:
                    `decode threshold (${threshold})`,

                showarrow: false,

                xanchor: "right",
                yanchor: "bottom",

                font: {
                    size: 10,
                    color: "#737b85",
                },
            },
        ],
    };

    Plotly.react(
        "chart",
        traces,
        layout,
        {
            responsive: true,
            displaylogo: false,

            modeBarButtonsToRemove: [
                "lasso2d",
                "select2d",
            ],
        }
    );
}


function createTimeline(data) {
    const events =
        data.events;

    const fecSets =
        getFecSets(events);

    const dataEvents =
        events.filter(
            event =>
                event.shred_type
                === "data"
        );

    const codeEvents =
        events.filter(
            event =>
                event.shred_type
                === "code"
        );

    const dataTrace = {
        type: "scattergl",

        mode: "markers",

        name: "Data",

        x:
            dataEvents.map(
                event =>
                    event.arrival_ms
            ),

        y:
            dataEvents.map(
                event =>
                    String(
                        event.fec_set_index
                    )
            ),

        customdata:
            dataEvents.map(
                event => [
                    event.shred_index,
                    event.sender_ip,
                    event.sender_port,
                    event.version,
                ]
            ),

        marker: {
            size: 7,
            color: "#5b8def",
            symbol: "circle",
            opacity: 0.8,
        },

        hovertemplate:
            "<b>Data shred</b>" +
            "<br>Arrival: %{x:.2f} ms" +
            "<br>FEC set index: %{y}" +
            "<br>Index: %{customdata[0]}" +
            "<br>Sender: %{customdata[1]}:%{customdata[2]}" +
            "<br>Version: %{customdata[3]}" +
            "<extra></extra>",
    };

    const codeTrace = {
        type: "scattergl",

        mode: "markers",

        name: "Coding",

        x:
            codeEvents.map(
                event =>
                    event.arrival_ms
            ),

        y:
            codeEvents.map(
                event =>
                    String(
                        event.fec_set_index
                    )
            ),

        customdata:
            codeEvents.map(
                event => [
                    event.shred_index,
                    event.sender_ip,
                    event.sender_port,
                    event.version,
                ]
            ),

        marker: {
            size: 7,
            color: "#d6a84b",
            symbol: "square",
            opacity: 0.8,
        },

        hovertemplate:
            "<b>Coding shred</b>" +
            "<br>Arrival: %{x:.2f} ms" +
            "<br>FEC set index: %{y}" +
            "<br>Index: %{customdata[0]}" +
            "<br>Sender: %{customdata[1]}:%{customdata[2]}" +
            "<br>Version: %{customdata[3]}" +
            "<extra></extra>",
    };

    const decodeX = [];
    const decodeY = [];
    const decodeCustom = [];

    for (const stats of data.fec_analysis) {
        const fec = stats.fec_set_index;
        if (
            stats.decode_time_ms
            === null
        ) {
            continue;
        }

        decodeX.push(
            stats.decode_time_ms
        );

        decodeY.push(
            String(fec)
        );

        decodeCustom.push(
            [
                fec,
                stats.unique_recognized_shred_count,
            ]
        );
    }

    const decodeTrace = {
        type: "scatter",

        mode: "markers",

        name:
            "FEC decodable",

        x: decodeX,
        y: decodeY,

        customdata:
            decodeCustom,

        marker: {
            size: 11,

            color: "#e8eaed",

            symbol:
                "diamond-open",

            line: {
                width: 2,
                color: "#e8eaed",
            },
        },

        hovertemplate:
            "<b>FEC decodable</b>" +
            "<br>FEC set index: %{customdata[0]}" +
            "<br>Time: %{x:.2f} ms" +
            `<br>Threshold: ${data.decode_threshold} unique shreds` +
            "<extra></extra>",
    };

    const layout = {
        paper_bgcolor:
            "#0b0e11",

        plot_bgcolor:
            "#0b0e11",

        font: {
            color: "#c9d1d9",
            size: 12,
        },

        margin: {
            l: 85,
            r: 30,
            t: 25,
            b: 65,
        },

        showlegend: false,

        hovermode:
            "closest",

        xaxis: {
            title:
                "Time since first shred (ms)",

            range:
                getTimelineRange(data),

            fixedrange:
                false,

            gridcolor:
                "#1f252c",

            zeroline:
                false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        yaxis: {
            title:
                "FEC set index",

            type:
                "category",

            categoryorder:
                "array",

            categoryarray:
                fecSets.map(
                    String
                ),

            gridcolor:
                "#1f252c",

            zeroline:
                false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        shapes: [
            createReferenceLine(),
        ],

        annotations: [
            createReferenceAnnotation(),
        ],
    };

    Plotly.react(
        "chart",

        [
            dataTrace,
            codeTrace,
            decodeTrace,
        ],

        layout,

        {
            responsive: true,
            displaylogo: false,

            modeBarButtonsToRemove: [
                "lasso2d",
                "select2d",
            ],
        }
    );
}


function percentile(
    values,
    percentileValue
) {
    if (values.length === 0) {
        return 1;
    }

    const sorted =
        [...values].sort(
            (a, b) => a - b
        );

    const index =
        Math.floor(
            (sorted.length - 1)
            * percentileValue
        );

    return sorted[index];
}


function createDensity(data) {
    const events =
        data.events;

    const fecSets =
        getFecSets(events);

    const maximum =
        Math.max(
            SLOT_REFERENCE_MS,
            data.observed_span_ms
        );

    const bucketLimit = Math.max(1, Math.min(
        MAX_DENSITY_BUCKETS, Math.floor(MAX_DENSITY_CELLS / Math.max(1, fecSets.length)),
    ));
    const bucketMs = Math.max(
        DENSITY_BUCKET_MS,
        Math.ceil(maximum / bucketLimit / DENSITY_BUCKET_MS) * DENSITY_BUCKET_MS,
    );
    const bucketCount = Math.min(bucketLimit, Math.floor(maximum / bucketMs) + 1);

    const x =
        Array.from(
            {
                length:
                    bucketCount,
            },

            (_, index) =>
                index
                * bucketMs + bucketMs / 2
        );

    const fecMap =
        new Map();

    fecSets.forEach(
        (fec, index) => {
            fecMap.set(
                fec,
                index
            );
        }
    );

    const z =
        fecSets.map(
            () =>
                Array(
                    bucketCount
                ).fill(null)
        );

    for (const event of events) {
        const row =
            fecMap.get(
                event.fec_set_index
            );

        const column =
            Math.min(
                Math.floor(
                    event.arrival_ms
                    / bucketMs
                ),

                bucketCount - 1
            );

        if (
            z[row][column]
            === null
        ) {
            z[row][column] = 1;

        } else {
            z[row][column] += 1;
        }
    }

    const values =
        z.flat().filter(
            value =>
                value !== null
        );

    const zMax =
        Math.max(
            1,

            percentile(
                values,
                0.95
            )
        );

    const trace = {
        type: "heatmap",

        x: x,

        y:
            fecSets.map(
                String
            ),

        z: z,

        zmin: 1,
        zmax: zMax,

        hoverongaps: false,

        colorscale: [
            [
                0.0,
                "#182432"
            ],

            [
                0.35,
                "#284e70"
            ],

            [
                0.7,
                "#3f78a8"
            ],

            [
                1.0,
                "#8cb8d8"
            ],
        ],

        colorbar: {
            title: "Arrivals",

            thickness: 12,

            outlinewidth: 0,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        hovertemplate:
            "FEC set index %{y}" +
            "<br>Bucket center %{x} ms" +
            `<br>Bucket width ${bucketMs} ms` +
            "<br>Arrivals %{z}" +
            "<extra></extra>",
    };

    const layout = {
        paper_bgcolor:
            "#0b0e11",

        plot_bgcolor:
            "#0b0e11",

        font: {
            color: "#c9d1d9",
        },

        margin: {
            l: 85,
            r: 70,
            t: 25,
            b: 65,
        },

        xaxis: {
            title:
                "Time since first shred (ms)",

            range: [0, Math.max(SLOT_REFERENCE_MS + 20, bucketCount * bucketMs)],

            gridcolor:
                "#1f252c",

            zeroline:
                false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        yaxis: {
            title:
                "FEC set index",

            type:
                "category",

            categoryorder:
                "array",

            categoryarray:
                fecSets.map(
                    String
                ),

            gridcolor:
                "#1f252c",

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        shapes: [
            createReferenceLine(),
        ],

        annotations: [
            createReferenceAnnotation(),
        ],
    };

    Plotly.react(
        "chart",
        [trace],
        layout,
        {
            responsive: true,
            displaylogo: false,
        }
    );
}


function renderCurrentView() {
    if (currentData === null) {
        return;
    }

    if (currentView === "cdf") {
        createCdf(
            currentData
        );

        return;
    }

    if (
        currentView
        === "density"
    ) {
        createDensity(
            currentData
        );

        return;
    }

    createTimeline(
        currentData
    );
}


function showSlot(data) {
    const hadChart = currentData !== null;
    selectedSlot = data.slot;
    currentData = data.slot === null ? null : data;
    renderHealth();
    updateSlotOptions();
    if (currentData === null) {
        slotTitle.textContent = "Slot \u2013";
        slotSummary.textContent = "No data";
        slotObservedTime.textContent = "";
        if (hadChart) Plotly.purge("chart");
        return;
    }

    updateSummary(data);
    renderCurrentView();
}


function showRequestError(error) {
    console.error(error);
    navigationStatus.textContent = "Unable to load data from the API. Try again.";
}


async function handleSlotError(error, slot, generation) {
    if (generation !== requestGeneration) return;
    if (error.status !== 404) {
        showRequestError(error);
        return;
    }

    const knownSlot = selectedSlot === slot || historyPage.slots.some(item => item.slot === slot);
    navigationStatus.textContent = knownSlot
        ? `Slot ${slot} is no longer retained.`
        : `Slot ${slot} was not found in retained history.`;
    if (selectedSlot === slot) showSlot({ slot: null });
    if (!knownSlot) return;

    try {
        const page = await reloadHistoryPage();
        if (generation === requestGeneration) showHistoryPage(page);
    } catch (pageError) {
        if (generation === requestGeneration) console.error(pageError);
    }
}


async function selectSlot(slot, generation) {
    try {
        const data = await fetchJson(`/api/slots/${slot}`);
        if (generation !== requestGeneration) return;
        showSlot(data);
        navigationStatus.textContent = "";
    } catch (error) {
        await handleSlotError(error, slot, generation);
    }
}


async function refresh(generation = requestGeneration) {
    if (generation !== requestGeneration || refreshingGeneration === generation) return;

    const mode = autoModeSelect.value;
    refreshingGeneration = generation;

    try {
        if (mode !== "off") {
            const data = await fetchJson(mode === "live" ? "/api/live" : "/api/previous");
            if (generation !== requestGeneration) return;
            showSlot(data);
            navigationStatus.textContent = data.slot === null
                ? (mode === "live" ? "No eligible live slot." : "No previous observed slot.")
                : "";
            if (data.slot !== null && !historyPage.slots.length) {
                const page = await fetchPage();
                if (generation === requestGeneration) showHistoryPage(page);
            }
            return;
        }

        if (selectedSlot !== null) {
            await selectSlot(selectedSlot, generation);
            return;
        }

        const page = await fetchPage();
        if (generation !== requestGeneration) return;
        showHistoryPage(page);
        if (page.slots.length) {
            await selectSlot(page.newest_slot, generation);
        } else {
            navigationStatus.textContent = "No retained slots.";
        }
    } catch (error) {
        if (generation === requestGeneration) showRequestError(error);
    } finally {
        if (refreshingGeneration === generation) refreshingGeneration = null;
    }
}


function beginHistoryRequest() {
    autoModeSelect.value = "off";
    updateSlotOptions();
    return ++requestGeneration;
}


function goToSlot() {
    const generation = beginHistoryRequest();
    const input = goSlotInput.value.trim();
    const slot = Number(input);
    if (!/^\d+$/.test(input) || !Number.isSafeInteger(slot)) {
        navigationStatus.textContent = "Enter a valid whole slot number.";
        return;
    }
    return selectSlot(slot, generation);
}


async function goToObservedTime() {
    const generation = beginHistoryRequest();
    const timestamp = new Date(`${observedTimeInput.value}Z`);
    if (!observedTimeInput.value || !Number.isFinite(timestamp.getTime())) {
        navigationStatus.textContent = "Enter a valid observed date and time in UTC.";
        return;
    }

    let match;
    try {
        const query = encodeURIComponent(timestamp.toISOString());
        ({ match } = await fetchJson(`/api/slots/nearest?observed_at=${query}`));
        if (generation !== requestGeneration) return;
        if (!match) {
            navigationStatus.textContent = "No retained data for this time search.";
            return;
        }

        const [data, page] = await Promise.all([
            fetchJson(`/api/slots/${match.slot}`),
            fetchPage(`&at=${match.slot}`),
        ]);
        if (generation !== requestGeneration) return;
        if (page.newest_slot !== match.slot) {
            if (selectedSlot === match.slot) showSlot({ slot: null });
            showHistoryPage(page);
            navigationStatus.textContent = "The matched slot is no longer retained.";
            return;
        }
        showSlot(data);
        showHistoryPage(page);
        const distance = Math.abs(match.difference_us) / 1000;
        const outsideRange = match.range === "within" ? "" : "Requested time is outside retained history. ";
        navigationStatus.textContent = `${outsideRange}Closest observed slot is ${distance.toLocaleString()} ms away.`;
    } catch (error) {
        if (generation !== requestGeneration) return;
        if (match && error.status === 404) {
            if (selectedSlot === match.slot) showSlot({ slot: null });
            navigationStatus.textContent = "The matched slot is no longer retained.";
        } else {
            showRequestError(error);
        }
    }
}


slotSelect.addEventListener("change", () => {
    const target = slotSelect.value;
    if (!target) return;
    return selectSlot(Number(target), beginHistoryRequest());
});


autoModeSelect.addEventListener("change", () => refresh(++requestGeneration));
refreshButton.addEventListener("click", () => refresh(++requestGeneration));


cdfButton.addEventListener(
    "click",
    () => {
        setView(
            "cdf"
        );
    }
);


timelineButton.addEventListener(
    "click",
    () => {
        setView(
            "timeline"
        );
    }
);


densityButton.addEventListener(
    "click",
    () => {
        setView(
            "density"
        );
    }
);


async function navigateHistory(direction) {
    const generation = beginHistoryRequest();
    const boundary = direction === "older" ? historyPage.oldest_slot : historyPage.newest_slot;
    const cursor = direction === "older" ? "before" : "after";

    try {
        const page = await fetchPage(boundary === null ? "" : `&${cursor}=${boundary}`);
        if (generation !== requestGeneration) return;
        if (!page.slots.length) {
            const replacement = await recoverHistoryPage(generation, boundary === null ? page : null);
            if (replacement === null) return;
            navigationStatus.textContent = replacement.slots.length
                ? `No ${direction} retained slots.`
                : "No retained slots. The history page may have expired.";
            return;
        }

        const target = direction === "older" ? page.newest_slot : page.oldest_slot;
        try {
            const data = await fetchJson(`/api/slots/${target}`);
            if (generation !== requestGeneration) return;
            showSlot(data);
            showHistoryPage(page);
            navigationStatus.textContent = "";
        } catch (error) {
            if (generation !== requestGeneration) return;
            if (error.status !== 404) throw error;

            if (await recoverHistoryPage(generation) === null) return;
            navigationStatus.textContent = `Slot ${target} is no longer retained. History has been refreshed.`;
        }
    } catch (error) {
        if (generation === requestGeneration) showRequestError(error);
    }
}


olderButton.addEventListener("click", () => navigateHistory("older"));
newerButton.addEventListener("click", () => navigateHistory("newer"));

goSlotButton.addEventListener("click", goToSlot);
goTimeButton.addEventListener("click", goToObservedTime);
goSlotInput.addEventListener("keydown", event => {
    if (event.key === "Enter") return goToSlot();
});
observedTimeInput.addEventListener("keydown", event => {
    if (event.key === "Enter") return goToObservedTime();
});


setInterval(
    async () => {
        if (
            autoModeSelect.value
            !== "off"
        ) {
            await refresh();
        }
    },

    POLL_INTERVAL_MS
);


updateViewHelp();
refreshHealth();
setInterval(refreshHealth, POLL_INTERVAL_MS);

const initialGeneration = requestGeneration;
fetchPage()
    .then(page => {
        if (initialGeneration === requestGeneration) showHistoryPage(page);
    })
    .catch(error => {
        if (initialGeneration === requestGeneration) showRequestError(error);
    })
    .then(() => refresh(initialGeneration));
