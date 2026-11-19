const slotSelect =
    document.getElementById("slot-select");

const refreshButton =
    document.getElementById("refresh-button");

const followLatest =
    document.getElementById("follow-latest");

const connectionStatus =
    document.getElementById("connection-status");

const metricArrivals =
    document.getElementById("metric-arrivals");

const metricFec =
    document.getElementById("metric-fec");

const metricTypes =
    document.getElementById("metric-types");

const metricDuration =
    document.getElementById("metric-duration");

const chartTitle =
    document.getElementById("chart-title");


const POLL_INTERVAL_MS = 2000;
const TIME_BUCKET_MS = 10;

let selectedSlot = null;
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
        `status ${state}`;
}


async function loadSlots(
    forceLatest = false
) {
    const result =
        await fetchJson(
            "/api/slots?limit=100"
        );

    const slots = result.slots;

    if (slots.length === 0) {
        slotSelect.innerHTML =
            "<option>No data</option>";

        return;
    }

    const previous =
        selectedSlot;

    slotSelect.innerHTML = "";

    for (const slot of slots) {
        const option =
            document.createElement("option");

        option.value =
            String(slot.slot);

        option.textContent =
            `${slot.slot} · ` +
            `${slot.arrivals} arrivals · ` +
            `${slot.fec_sets} FEC`;

        slotSelect.appendChild(option);
    }

    if (
        forceLatest
        || previous === null
        || !slots.some(
            slot =>
                slot.slot === previous
        )
    ) {
        selectedSlot =
            slots[0].slot;
    } else {
        selectedSlot =
            previous;
    }

    slotSelect.value =
        String(selectedSlot);
}


function createHeatmap(data) {
    const events =
        data.events;

    const fecSets =
        [...new Set(
            events.map(
                event =>
                    event.fec_set_index
            )
        )].sort(
            (a, b) => a - b
        );

    const maxArrival =
        Math.max(
            0,
            ...events.map(
                event =>
                    event.arrival_ms
            )
        );

    const chartEnd =
        Math.max(
            400,
            Math.ceil(
                maxArrival
                / TIME_BUCKET_MS
            ) * TIME_BUCKET_MS
        );

    const bucketCount =
        Math.floor(
            chartEnd
            / TIME_BUCKET_MS
        ) + 1;

    const x = Array.from(
        {
            length: bucketCount,
        },
        (_, index) =>
            index * TIME_BUCKET_MS
    );

    const fecIndex =
        new Map();

    fecSets.forEach(
        (fec, index) => {
            fecIndex.set(
                fec,
                index
            );
        }
    );

    const z = fecSets.map(
        () =>
            Array(bucketCount).fill(0)
    );

    for (const event of events) {
        const row =
            fecIndex.get(
                event.fec_set_index
            );

        const column =
            Math.min(
                Math.floor(
                    event.arrival_ms
                    / TIME_BUCKET_MS
                ),
                bucketCount - 1
            );

        z[row][column] += 1;
    }

    const trace = {
        type: "heatmap",

        x: x,

        y: fecSets.map(
            fec => String(fec)
        ),

        z: z,

        colorscale: "Viridis",

        colorbar: {
            title: "Arrivals",
        },

        hovertemplate:
            "FEC %{y}" +
            "<br>Time %{x} ms" +
            "<br>Shreds %{z}" +
            "<extra></extra>",
    };

    const layout = {
        paper_bgcolor:
            "#161b22",

        plot_bgcolor:
            "#161b22",

        font: {
            color: "#e6edf3",
        },

        margin: {
            l: 80,
            r: 40,
            t: 30,
            b: 70,
        },

        xaxis: {
            title:
                "Time since first shred (ms)",

            gridcolor:
                "#30363d",

            zerolinecolor:
                "#30363d",
        },

        yaxis: {
            title:
                "FEC set",

            type:
                "category",

            gridcolor:
                "#30363d",
        },

        hovermode:
            "closest",
    };

    Plotly.react(
        "heatmap",
        [trace],
        layout,
        {
            responsive: true,
            displaylogo: false,
        }
    );
}


async function loadSlot(slot) {
    const data =
        await fetchJson(
            `/api/slots/${slot}`
        );

    selectedSlot =
        data.slot;

    chartTitle.textContent =
        `Slot ${data.slot}`;

    metricArrivals.textContent =
        data.arrivals.toLocaleString();

    metricFec.textContent =
        data.fec_count;

    metricTypes.textContent =
        `${data.data_shreds} / ${data.code_shreds}`;

    metricDuration.textContent =
        `${data.duration_ms.toFixed(1)} ms`;

    createHeatmap(data);
}


async function refresh(
    forceLatest = false
) {
    if (refreshInProgress) {
        return;
    }

    refreshInProgress = true;

    try {
        await loadSlots(
            forceLatest
        );

        if (selectedSlot !== null) {
            await loadSlot(
                selectedSlot
            );
        }

        setConnectionStatus(
            "Live",
            "ok"
        );

    } catch (error) {
        console.error(error);

        setConnectionStatus(
            "Connection error",
            "error"
        );

    } finally {
        refreshInProgress = false;
    }
}


slotSelect.addEventListener(
    "change",
    async () => {
        followLatest.checked = false;

        selectedSlot =
            Number(
                slotSelect.value
            );

        await refresh(false);
    }
);


refreshButton.addEventListener(
    "click",
    async () => {
        await refresh(
            followLatest.checked
        );
    }
);


setInterval(
    async () => {
        await refresh(
            followLatest.checked
        );
    },
    POLL_INTERVAL_MS
);


refresh(true);