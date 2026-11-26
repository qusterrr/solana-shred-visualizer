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

const SLOT_REFERENCE_MS = 200;

const DECODE_THRESHOLD = 32;


let selectedSlot = null;

let currentView = "cdf";

let currentData = null;

let currentSlotPage = [];

let refreshInProgress = false;


async function fetchJson(url) {
    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `${response.status} ${response.statusText}`
        );
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


async function setConnectionStatusFromHealth() {
    try {
        const health =
            await fetchJson(
                "/api/health"
            );

        if (health.live) {
            setConnectionStatus(
                "LIVE",
                "ok"
            );

            return;
        }

        if (
            health.last_arrival_age_ms
            === null
        ) {
            setConnectionStatus(
                "NO DATA",
                "error"
            );

            return;
        }

        setConnectionStatus(
            `STALE · ${(
                health.last_arrival_age_ms
                / 1000
            ).toFixed(1)}s`,
            "error"
        );

    } catch (error) {
        console.error(error);

        setConnectionStatus(
            "OFFLINE",
            "error"
        );
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
        "Density groups arrivals into 10 ms buckets. Color intensity represents the number of arrivals in each bucket.";
}


function updateSlotOptions(slots) {
    const available =
        new Set(
            slots.map(
                item => item.slot
            )
        );

    slotSelect.innerHTML = "";

    for (const item of slots) {
        const option =
            document.createElement(
                "option"
            );

        option.value =
            String(item.slot);

        option.textContent =
            `Slot ${item.slot}`;

        slotSelect.appendChild(
            option
        );
    }

    if (
        selectedSlot !== null
        && available.has(
            selectedSlot
        )
    ) {
        slotSelect.value =
            String(selectedSlot);
    }
}


function ensureSlotOption(slot) {
    const exists =
        [...slotSelect.options]
            .some(
                option =>
                    Number(
                        option.value
                    ) === slot
            );

    if (exists) {
        return;
    }

    const option =
        document.createElement(
            "option"
        );

    option.value =
        String(slot);

    option.textContent =
        `Slot ${slot}`;

    slotSelect.prepend(
        option
    );
}


async function loadSlotPage(
    direction = "latest"
) {
    let url =
        "/api/slots?limit=100";

    if (
        direction === "older"
        && currentSlotPage.length > 0
    ) {
        const oldestSlot =
            Math.min(
                ...currentSlotPage.map(
                    item => item.slot
                )
            );

        url +=
            `&before=${oldestSlot}`;
    }

    if (
        direction === "newer"
        && currentSlotPage.length > 0
    ) {
        const newestSlot =
            Math.max(
                ...currentSlotPage.map(
                    item => item.slot
                )
            );

        url +=
            `&after=${newestSlot}`;
    }

    const result =
        await fetchJson(url);

    if (
        result.slots.length === 0
    ) {
        return false;
    }

    currentSlotPage =
        result.slots;

    updateSlotOptions(
        currentSlotPage
    );

    return true;
}


function updateSummary(data) {
    slotTitle.textContent =
        `Slot ${data.slot}`;

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


function getUniqueShredKey(event) {
    return (
        `${event.shred_type}:` +
        `${event.shred_index}`
    );
}


function calculateFecStats(events) {
    const groups =
        new Map();

    for (const event of events) {
        if (
            !groups.has(
                event.fec_set_index
            )
        ) {
            groups.set(
                event.fec_set_index,
                []
            );
        }

        groups
            .get(
                event.fec_set_index
            )
            .push(event);
    }

    const result =
        new Map();

    for (
        const [fec, fecEvents]
        of groups
    ) {
        const sorted =
            [...fecEvents].sort(
                (a, b) =>
                    a.arrival_ms
                    - b.arrival_ms
            );

        const seen =
            new Set();

        const cumulative = [];

        let decodeTime = null;

        for (const event of sorted) {
            const key =
                getUniqueShredKey(
                    event
                );

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);

            cumulative.push(
                {
                    arrival_ms:
                        event.arrival_ms,

                    count:
                        seen.size,

                    event:
                        event,
                }
            );

            if (
                seen.size
                === DECODE_THRESHOLD
            ) {
                decodeTime =
                    event.arrival_ms;
            }
        }

        result.set(
            fec,
            {
                fec: fec,

                events:
                    sorted,

                cumulative:
                    cumulative,

                uniqueCount:
                    seen.size,

                decodeTime:
                    decodeTime,
            }
        );
    }

    return result;
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
    const fecStats =
        calculateFecStats(
            data.events
        );

    const fecSets =
        [...fecStats.keys()].sort(
            (a, b) => a - b
        );

    const traces = [];

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

    fecSets.forEach(
        (fec, index) => {
            const stats =
                fecStats.get(fec);

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

                    x:
                        stats.cumulative.map(
                            point =>
                                point.arrival_ms
                        ),

                    y:
                        stats.cumulative.map(
                            point =>
                                point.count
                        ),

                    line: {
                        color: color,
                        width: 2,
                        shape: "hv",
                    },

                    customdata:
                        stats.cumulative.map(
                            point => [
                                fec,
                                point.event
                                    .shred_index,
                                point.event
                                    .shred_type,
                            ]
                        ),

                    hovertemplate:
                        "<b>FEC set index %{customdata[0]}</b>" +
                        "<br>Arrival: %{x:.2f} ms" +
                        "<br>Unique shreds: %{y}" +
                        "<br>Index: %{customdata[1]}" +
                        "<br>Type: %{customdata[2]}" +
                        "<extra></extra>",
                }
            );

            if (
                stats.decodeTime
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
                            stats.decodeTime
                        ],

                        y: [
                            DECODE_THRESHOLD
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
                            "<br>Unique shreds: 32" +
                            "<extra></extra>",
                    }
                );
            }
        }
    );

    const maximumUnique =
        Math.max(
            DECODE_THRESHOLD + 4,

            ...[
                ...fecStats.values()
            ].map(
                stats =>
                    stats.uniqueCount
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

            range:
                getTimelineRange(data),

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
                    DECODE_THRESHOLD,

                y1:
                    DECODE_THRESHOLD,

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
                    DECODE_THRESHOLD,

                xref: "paper",
                yref: "y",

                text:
                    "decode threshold (32)",

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

    const fecStats =
        calculateFecStats(events);

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

    for (
        const [fec, stats]
        of fecStats
    ) {
        if (
            stats.decodeTime
            === null
        ) {
            continue;
        }

        decodeX.push(
            stats.decodeTime
        );

        decodeY.push(
            String(fec)
        );

        decodeCustom.push(
            [
                fec,
                stats.uniqueCount,
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
            "<br>Threshold: 32 unique shreds" +
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

    const chartEnd =
        Math.ceil(
            maximum
            / DENSITY_BUCKET_MS
        )
        * DENSITY_BUCKET_MS;

    const bucketCount =
        Math.floor(
            chartEnd
            / DENSITY_BUCKET_MS
        ) + 1;

    const x =
        Array.from(
            {
                length:
                    bucketCount,
            },

            (_, index) =>
                index
                * DENSITY_BUCKET_MS
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
                    / DENSITY_BUCKET_MS
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
            "<br>Time %{x} ms" +
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


async function loadSlot(slot) {
    const data =
        await fetchJson(
            `/api/slots/${slot}`
        );

    selectedSlot =
        data.slot;

    currentData =
        data;

    ensureSlotOption(
        data.slot
    );

    slotSelect.value =
        String(data.slot);

    updateSummary(data);

    renderCurrentView();
}


async function refreshLive() {
    if (refreshInProgress) {
        return;
    }

    refreshInProgress = true;

    try {
        const data =
            await fetchJson(
                "/api/live"
            );

        selectedSlot =
            data.slot;

        currentData =
            data;

        ensureSlotOption(
            data.slot
        );

        slotSelect.value =
            String(data.slot);

        updateSummary(data);

        renderCurrentView();

        await (
            setConnectionStatusFromHealth()
        );

    } catch (error) {
        console.error(error);

        setConnectionStatus(
            "ERROR",
            "error"
        );

    } finally {
        refreshInProgress = false;
    }
}


async function refresh() {
    if (
        autoModeSelect.value
        === "live"
    ) {
        await refreshLive();

        return;
    }

    if (refreshInProgress) {
        return;
    }

    refreshInProgress = true;

    try {
        if (
            currentSlotPage.length
            === 0
        ) {
            await loadSlotPage(
                "latest"
            );
        }

        const slots =
            currentSlotPage;

        if (slots.length === 0) {
            throw new Error(
                "No slots available"
            );
        }

        if (
            autoModeSelect.value
            === "previous"
        ) {
            selectedSlot =
                slots.length > 1
                    ? slots[1].slot
                    : slots[0].slot;
        }

        if (
            selectedSlot === null
        ) {
            selectedSlot =
                slots[0].slot;
        }

        await loadSlot(
            selectedSlot
        );

        await (
            setConnectionStatusFromHealth()
        );

    } catch (error) {
        console.error(error);

    } finally {
        refreshInProgress = false;
    }
}


async function goToSlot() {
    const slot =
        Number(
            goSlotInput.value
        );

    if (
        !Number.isInteger(slot)
        || slot < 0
    ) {
        return;
    }

    try {
        autoModeSelect.value =
            "off";

        ensureSlotOption(
            slot
        );

        await loadSlot(
            slot
        );

        await (
            setConnectionStatusFromHealth()
        );

    } catch (error) {
        console.error(error);

        alert(
            `Slot ${slot} was not found in retained history.`
        );
    }
}


slotSelect.addEventListener(
    "change",
    async () => {
        autoModeSelect.value =
            "off";

        selectedSlot =
            Number(
                slotSelect.value
            );

        await loadSlot(
            selectedSlot
        );
    }
);


autoModeSelect.addEventListener(
    "change",
    async () => {
        await refresh();
    }
);


refreshButton.addEventListener(
    "click",
    async () => {
        await refresh();
    }
);


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


olderButton.addEventListener(
    "click",
    async () => {
        autoModeSelect.value =
            "off";

        const loaded =
            await loadSlotPage(
                "older"
            );

        if (!loaded) {
            return;
        }

        selectedSlot =
            currentSlotPage[0]
                .slot;

        await loadSlot(
            selectedSlot
        );
    }
);


newerButton.addEventListener(
    "click",
    async () => {
        autoModeSelect.value =
            "off";

        const loaded =
            await loadSlotPage(
                "newer"
            );

        if (!loaded) {
            return;
        }

        selectedSlot =
            currentSlotPage[
                currentSlotPage.length
                - 1
            ].slot;

        await loadSlot(
            selectedSlot
        );
    }
);


goSlotButton.addEventListener(
    "click",
    goToSlot
);


goSlotInput.addEventListener(
    "keydown",
    async event => {
        if (
            event.key
            === "Enter"
        ) {
            await goToSlot();
        }
    }
);


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


loadSlotPage(
    "latest"
).then(
    async () => {
        await refresh();
    }
);