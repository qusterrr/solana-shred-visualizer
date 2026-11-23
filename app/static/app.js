const slotSelect =
    document.getElementById("slot-select");

const autoModeSelect =
    document.getElementById("auto-mode");

const refreshButton =
    document.getElementById("refresh-button");

const timelineButton =
    document.getElementById("timeline-button");

const densityButton =
    document.getElementById("density-button");

const connectionStatus =
    document.getElementById("connection-status");

const slotTitle =
    document.getElementById("slot-title");

const slotSummary =
    document.getElementById("slot-summary");


const POLL_INTERVAL_MS = 2000;

const DENSITY_BUCKET_MS = 10;

const SLOT_REFERENCE_MS = 400;


let selectedSlot = null;

let currentView = "timeline";

let currentData = null;

let refreshInProgress = false;


async function fetchJson(url) {
    const response = await fetch(url);

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
    connectionStatus.textContent = text;

    connectionStatus.className =
        `connection-status ${state}`;
}


function setView(view) {
    currentView = view;

    timelineButton.classList.toggle(
        "active",
        view === "timeline"
    );

    densityButton.classList.toggle(
        "active",
        view === "density"
    );

    if (currentData !== null) {
        renderCurrentView();
    }
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
            document.createElement("option");

        option.value =
            String(item.slot);

        option.textContent =
            `Slot ${item.slot}`;

        slotSelect.appendChild(option);
    }

    if (
        selectedSlot !== null
        && available.has(selectedSlot)
    ) {
        slotSelect.value =
            String(selectedSlot);
    }
}


function chooseAutomaticSlot(slots) {
    if (slots.length === 0) {
        return null;
    }

    const mode =
        autoModeSelect.value;

    if (mode === "live") {
        return slots[0].slot;
    }

    if (mode === "completed") {
        if (slots.length > 1) {
            return slots[1].slot;
        }

        return slots[0].slot;
    }

    return selectedSlot;
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
            `${data.duration_ms.toFixed(1)} ms`,
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
            data.duration_ms
        );

    return [
        0,
        Math.ceil(
            maximum / 50
        ) * 50 + 20,
    ];
}


function createTimeline(data) {
    const events =
        data.events;

    const fecSets =
        getFecSets(events);

    const dataEvents =
        events.filter(
            event =>
                event.shred_type === "data"
        );

    const codeEvents =
        events.filter(
            event =>
                event.shred_type === "code"
        );


    const dataTrace = {
        type: "scattergl",
        mode: "markers",

        name: "Data",

        x: dataEvents.map(
            event =>
                event.arrival_ms
        ),

        y: dataEvents.map(
            event =>
                String(
                    event.fec_set_index
                )
        ),

        customdata: dataEvents.map(
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
            "<br>FEC: %{y}" +
            "<br>Index: %{customdata[0]}" +
            "<br>Sender: %{customdata[1]}:%{customdata[2]}" +
            "<br>Version: %{customdata[3]}" +
            "<extra></extra>",
    };


    const codeTrace = {
        type: "scattergl",
        mode: "markers",

        name: "Coding",

        x: codeEvents.map(
            event =>
                event.arrival_ms
        ),

        y: codeEvents.map(
            event =>
                String(
                    event.fec_set_index
                )
        ),

        customdata: codeEvents.map(
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
            "<br>FEC: %{y}" +
            "<br>Index: %{customdata[0]}" +
            "<br>Sender: %{customdata[1]}:%{customdata[2]}" +
            "<br>Version: %{customdata[3]}" +
            "<extra></extra>",
    };


    const layout = {
        paper_bgcolor: "#0b0e11",
        plot_bgcolor: "#0b0e11",

        font: {
            color: "#c9d1d9",
            size: 12,
        },

        margin: {
            l: 80,
            r: 30,
            t: 25,
            b: 65,
        },

        showlegend: false,

        hovermode: "closest",

        xaxis: {
            title: "Time since first shred (ms)",

            range:
                getTimelineRange(data),

            fixedrange: false,

            gridcolor: "#1f252c",
            zeroline: false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        yaxis: {
            title: "FEC set",

            type: "category",

            categoryorder: "array",

            categoryarray:
                fecSets.map(String),

            gridcolor: "#1f252c",
            zeroline: false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        shapes: [
            {
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
            },
        ],

        annotations: [
            {
                x: SLOT_REFERENCE_MS,
                y: 1,

                xref: "x",
                yref: "paper",

                text: "400 ms",

                showarrow: false,

                xanchor: "left",
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
        [
            dataTrace,
            codeTrace,
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


function percentile(values, percentileValue) {
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
            data.duration_ms
        );

    const chartEnd =
        Math.ceil(
            maximum /
            DENSITY_BUCKET_MS
        ) * DENSITY_BUCKET_MS;

    const bucketCount =
        Math.floor(
            chartEnd /
            DENSITY_BUCKET_MS
        ) + 1;


    const x =
        Array.from(
            {
                length: bucketCount,
            },
            (_, index) =>
                index *
                DENSITY_BUCKET_MS
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
            fecSets.map(String),

        z: z,

        zmin: 1,
        zmax: zMax,

        hoverongaps: false,

        colorscale: [
            [0.0, "#182432"],
            [0.35, "#284e70"],
            [0.7, "#3f78a8"],
            [1.0, "#8cb8d8"],
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
            "FEC %{y}" +
            "<br>Time %{x} ms" +
            "<br>Arrivals %{z}" +
            "<extra></extra>",
    };


    const layout = {
        paper_bgcolor: "#0b0e11",
        plot_bgcolor: "#0b0e11",

        font: {
            color: "#c9d1d9",
        },

        margin: {
            l: 80,
            r: 70,
            t: 25,
            b: 65,
        },

        xaxis: {
            title:
                "Time since first shred (ms)",

            gridcolor: "#1f252c",
            zeroline: false,

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        yaxis: {
            title: "FEC set",

            type: "category",

            categoryorder: "array",

            categoryarray:
                fecSets.map(String),

            gridcolor: "#1f252c",

            tickfont: {
                color: "#8b949e",
            },

            titlefont: {
                color: "#8b949e",
            },
        },

        shapes: [
            {
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
            },
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

    if (currentView === "density") {
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

    slotSelect.value =
        String(data.slot);

    updateSummary(data);

    renderCurrentView();
}


async function refresh() {
    if (refreshInProgress) {
        return;
    }

    refreshInProgress = true;

    try {
        const result =
            await fetchJson(
                "/api/slots?limit=100"
            );

        const slots =
            result.slots;

        if (slots.length === 0) {
            throw new Error(
                "No slots available"
            );
        }

        updateSlotOptions(slots);

        const automaticSlot =
            chooseAutomaticSlot(
                slots
            );

        if (automaticSlot !== null) {
            selectedSlot =
                automaticSlot;
        }

        if (selectedSlot === null) {
            selectedSlot =
                slots[0].slot;
        }

        await loadSlot(
            selectedSlot
        );

        setConnectionStatus(
            "LIVE",
            "ok"
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


refresh();