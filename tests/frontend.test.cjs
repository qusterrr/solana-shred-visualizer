const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(join(__dirname, "../app/static/app.js"), "utf8");

function startBrowser() {
    const requests = [];
    const plots = [];
    const elements = new Map();
    const timers = [];
    const page = (rows, { hasOlder = false, hasNewer = false } = {}) => ({
        slots: rows.map(slot => ({ slot, first_arrival_us: 10_000_000 })),
        oldest_slot: rows.at(-1) ?? null,
        newest_slot: rows[0] ?? null,
        has_older: hasOlder,
        has_newer: hasNewer,
    });
    const context = vm.createContext({
        console: { error() {} },
        setInterval(callback) { timers.push(callback); },
        Plotly: {
            react(_chart, traces) { plots.push(traces); },
            purge() { plots.push([]); },
        },
        fetch(url) {
            return new Promise(resolve => {
                requests.push({
                    url,
                    reply(data, status) {
                        resolve({ ok: status < 400, status, json: async () => data });
                    },
                });
            });
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        value: id === "auto-mode" ? "live" : "",
                        options: [],
                        set innerHTML(value) { this.options = []; },
                        appendChild(option) { this.options.push(option); },
                        prepend(option) { this.options.unshift(option); },
                        classList: { toggle() {} },
                        addEventListener(event, handler) { this[event] = handler; },
                    });
                }
                return elements.get(id);
            },
            createElement() { return {}; },
        },
    });
    vm.runInContext(source, context);

    return {
        elements,
        plots,
        timers,
        page,
        state(expression) { return vm.runInContext(expression, context); },
        async reply(url, data, status = 200) {
            const index = requests.findIndex(request => request.url === url);
            assert.ok(index >= 0, `Expected pending request for ${url}`);
            requests.splice(index, 1)[0].reply(data, status);
            await new Promise(resolve => setImmediate(resolve));
        },
    };
}

function slotData(slot) {
    return {
        slot,
        first_arrival_us: 10_000_000,
        arrivals: 0,
        fec_count: 0,
        observed_span_ms: 0,
        events: [],
        decode_threshold: 32,
        fec_analysis: [],
    };
}

test("late live response cannot replace a manual historical slot", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30, 20]));
    const select = browser.elements.get("slot-select");
    select.value = "20";
    const selection = select.change();
    await browser.reply("/api/slots/20", slotData(20));
    await selection;
    await browser.reply("/api/live", slotData(30));

    assert.equal(browser.state("selectedSlot"), 20);
    assert.equal(browser.state("currentData.slot"), 20);
    assert.equal(select.value, "20");
    assert.equal(browser.plots.length, 1);
});

test("newer history action owns the page and its slot response", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30, 20]));
    const older = browser.elements.get("older-button");
    const newer = browser.elements.get("newer-button");

    const oldPage = older.click();
    const newPage = newer.click();
    await browser.reply("/api/slots?limit=100&after=30", browser.page([40]));
    await browser.reply("/api/slots?limit=100&before=20", browser.page([10]));
    await oldPage;
    assert.equal(browser.state("historyPage.newest_slot"), 30);

    const select = browser.elements.get("slot-select");
    select.value = "20";
    const selection = select.change();
    await browser.reply("/api/slots/20", slotData(20));
    await browser.reply("/api/slots/40", slotData(40));
    await Promise.all([newPage, selection]);
    assert.equal(browser.state("currentData.slot"), 20);
    assert.equal(browser.state("historyPage.newest_slot"), 30);
    assert.equal(browser.plots.length, 1);
});

test("CDF and Timeline render the API analysis and Timeline retains duplicate events", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30]));
    const event = { fec_set_index: 64, shred_type: "data", shred_index: 5, arrival_ms: 1 };
    const data = {
        ...slotData(30),
        arrivals: 2,
        fec_count: 1,
        events: [event, { ...event, arrival_ms: 2 }],
        fec_analysis: [{
            fec_set_index: 64,
            unique_recognized_shred_count: 32,
            cumulative_unique_points: [{ ...event, arrival_ms: 7, count: 32 }],
            decode_time_ms: 7,
        }],
    };
    await browser.reply("/api/live", data);
    assert.equal(browser.plots[0][0].x.join(","), "7,220");
    assert.equal(browser.plots[0][0].y.join(","), "32,32");
    assert.deepEqual([...browser.plots[0][0].customdata[0]], [64, 5, "data"]);
    assert.equal(browser.plots[0][1].x.join(","), "7");

    browser.elements.get("timeline-button").click();
    const timeline = browser.plots[1];
    assert.equal(timeline[0].x.join(","), "1,2");
    assert.equal(timeline[2].x.join(","), "7");
    assert.equal(timeline[2].y.join(","), "64");
});

test("an empty live store displays NO DATA", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([]));
    await browser.reply("/api/live", { slot: null });
    await browser.reply("/api/health", { state: "no_data" });
    assert.equal(browser.elements.get("connection-status").textContent, "NO DATA");
    assert.equal(browser.state("currentData"), null);
    assert.equal(browser.plots.length, 0);
});

test("the first live data after an empty startup initializes history", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([]));
    await browser.reply("/api/live", { slot: null });
    const tick = browser.timers.find(callback => callback.name !== "refreshHealth")();
    await browser.reply("/api/live", slotData(20));
    await browser.reply("/api/slots?limit=100", browser.page([20]));
    await tick;
    assert.equal(browser.state("historyPage.newest_slot"), 20);
    assert.equal(browser.state("selectedSlot"), 20);
});

test("health polling continues in history and labels the actual live slot", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30, 20]));
    await browser.reply("/api/live", slotData(30));
    await browser.reply("/api/health", { state: "live", latest_slot: 30 });
    assert.equal(browser.elements.get("connection-status").textContent, "LIVE");

    const select = browser.elements.get("slot-select");
    select.value = "20";
    const selection = select.change();
    await browser.reply("/api/slots/20", slotData(20));
    await selection;
    assert.equal(browser.elements.get("connection-status").textContent, "LIVE · Slot 30");

    const poll = browser.timers.find(callback => callback.name === "refreshHealth")();
    await browser.reply("/api/health", { state: "lagging", latest_slot: 30 });
    await poll;
    assert.equal(browser.elements.get("connection-status").textContent, "INGEST LAG");
    assert.equal(browser.state("selectedSlot"), 20);
});

test("direct lookup and live updates keep navigation anchored to the history page", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30, 20], { hasOlder: true }));
    await browser.reply("/api/live", slotData(50));
    const input = browser.elements.get("go-slot-input");
    input.value = "7";
    const lookup = browser.elements.get("go-slot-button").click();
    await browser.reply("/api/slots/7", slotData(7));
    await lookup;
    assert.equal(browser.state("historyPage.oldest_slot"), 20);
    const older = browser.elements.get("older-button").click();
    await browser.reply("/api/slots?limit=100&before=20", browser.page([10, 7], { hasNewer: true }));
    await browser.reply("/api/slots/10", slotData(10));
    await older;
    const newer = browser.elements.get("newer-button").click();
    await browser.reply("/api/slots?limit=100&after=10", browser.page([30, 20], { hasOlder: true }));
    await browser.reply("/api/slots/20", slotData(20));
    await newer;
    assert.equal(browser.state("historyPage.oldest_slot"), 20);
    assert.equal(browser.state("historyPage.newest_slot"), 30);
});

test("invalid and missing slot inputs get inline feedback without fake options", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30]));
    await browser.reply("/api/live", slotData(30));
    const input = browser.elements.get("go-slot-input");
    const button = browser.elements.get("go-slot-button");
    const status = browser.elements.get("navigation-status");
    for (const value of ["", "-1", "5.5", "9007199254740993"]) {
        input.value = value;
        await button.click();
        assert.match(status.textContent, /valid whole slot/);
    }
    input.value = "20";
    const lookup = button.click();
    const select = browser.elements.get("slot-select");
    assert.deepEqual(select.options.map(option => option.value), ["30"]);
    await browser.reply("/api/slots/20", {}, 404);
    await lookup;
    assert.match(status.textContent, /Slot 20 was not found/);
    assert.deepEqual(select.options.map(option => option.value), ["30"]);
    assert.equal(browser.state("selectedSlot"), 30);
});

test("an expired selected slot is cleared and the page is revalidated", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30, 20]));
    await browser.reply("/api/live", slotData(30));
    const select = browser.elements.get("slot-select");
    select.value = "20";
    const lookup = select.change();
    await browser.reply("/api/slots/20", slotData(20));
    await lookup;

    const refresh = browser.elements.get("refresh-button").click();
    await browser.reply("/api/slots/20", {}, 404);
    await browser.reply("/api/slots?limit=100&at=30", browser.page([30]));
    await refresh;
    assert.equal(browser.state("currentData"), null);
    assert.match(browser.elements.get("navigation-status").textContent, /no longer retained/);
    assert.deepEqual(select.options.map(option => option.value), ["30"]);
});

test("an empty directional page gives boundary feedback and recovers after pruning", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30]));
    await browser.reply("/api/live", slotData(30));

    const newer = browser.elements.get("newer-button").click();
    await browser.reply("/api/slots?limit=100&after=30", browser.page([]));
    await browser.reply("/api/slots?limit=100&at=30", browser.page([30]));
    await newer;
    const status = browser.elements.get("navigation-status");
    assert.equal(status.textContent, "No newer retained slots.");
    assert.equal(browser.state("selectedSlot"), 30);

    const older = browser.elements.get("older-button").click();
    await browser.reply("/api/slots?limit=100&before=30", browser.page([]));
    await browser.reply("/api/slots?limit=100&at=30", browser.page([]));
    await browser.reply("/api/slots?limit=100", browser.page([]));
    await older;
    assert.match(status.textContent, /No retained slots/);
    assert.equal(browser.state("historyPage.newest_slot"), null);
    assert.equal(browser.state("currentData"), null);
});

test("time picker sends UTC, shows the nearest observation and explains range boundaries", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30]));
    await browser.reply("/api/live", slotData(30));
    browser.elements.get("observed-time-input").value = "1970-01-01T00:00:05";
    const button = browser.elements.get("go-time-button");
    const url = "/api/slots/nearest?observed_at=1970-01-01T00%3A00%3A05.000Z";
    const search = button.click();
    await browser.reply(url, { match: { slot: 20, range: "before", difference_us: 5_000_000 } });
    await browser.reply("/api/slots/20", slotData(20));
    await browser.reply("/api/slots?limit=100&at=20", browser.page([20], { hasNewer: true }));
    await search;
    assert.equal(browser.state("historyPage.newest_slot"), 20);
    assert.match(browser.elements.get("slot-observed-time").textContent, /00:00:10\.000 UTC/);
    const status = browser.elements.get("navigation-status");
    assert.match(status.textContent, /outside retained history/);
    const emptySearch = button.click();
    await browser.reply(url, { match: null });
    await emptySearch;
    assert.match(status.textContent, /No retained data for this time/);
});

test("history remains usable when stale and API failures appear inline", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30, 20]));
    await browser.reply("/api/live", { slot: null });
    await browser.reply("/api/health", { state: "stale", last_arrival_age_ms: 5000 });
    const select = browser.elements.get("slot-select");
    select.value = "20";
    const historical = select.change();
    await browser.reply("/api/slots/20", slotData(20));
    await historical;
    assert.match(browser.elements.get("connection-status").textContent, /^STALE/);
    assert.equal(browser.state("selectedSlot"), 20);

    const poll = browser.timers.find(callback => callback.name === "refreshHealth")();
    await browser.reply("/api/health", {}, 503);
    await poll;
    assert.equal(browser.elements.get("connection-status").textContent, "OFFLINE");
    const refresh = browser.elements.get("refresh-button").click();
    await browser.reply("/api/slots/20", {}, 503);
    await refresh;
    assert.equal(browser.state("selectedSlot"), 20);
    assert.match(browser.elements.get("navigation-status").textContent, /Unable to load data/);
});

test("Previous uses the current API result independently of the history page", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30, 20]));
    await browser.reply("/api/live", slotData(40));
    const mode = browser.elements.get("auto-mode");
    mode.value = "previous";
    const previous = mode.change();
    await browser.reply("/api/previous", slotData(35));
    await previous;
    assert.equal(browser.state("selectedSlot"), 35);
    assert.equal(browser.state("historyPage.newest_slot"), 30);
});

test("one-point CDF stays visible without a decode marker and extreme Density stays bounded", async () => {
    const browser = startBrowser();
    await browser.reply("/api/slots?limit=100", browser.page([30]));
    const event = { fec_set_index: 64, shred_type: "data", shred_index: 5, arrival_ms: 0 };
    const late = 100_000_000_000;
    await browser.reply("/api/live", {
        ...slotData(30),
        observed_span_ms: late,
        events: [event, { ...event, arrival_ms: late }],
        fec_analysis: [{
            fec_set_index: 64,
            unique_recognized_shred_count: 1,
            cumulative_unique_points: [{ ...event, count: 1 }],
            decode_time_ms: null,
        }],
    });
    assert.equal(browser.plots[0].length, 1);
    assert.equal(browser.plots[0][0].x[0], 0);
    assert.ok(browser.plots[0][0].x[1] >= late);
    assert.equal(browser.plots[0][0].y.join(","), "1,1");

    browser.elements.get("timeline-button").click();
    assert.equal(browser.plots[1][2].x.length, 0);
    browser.elements.get("density-button").click();
    const density = browser.plots[2][0];
    assert.ok(density.x.length <= 1024);
    assert.equal(density.z[0].reduce((sum, count) => sum + count, 0), 2);
});
