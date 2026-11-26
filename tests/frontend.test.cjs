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
    const page = rows => ({ slots: rows.map(slot => ({ slot })) });
    const context = vm.createContext({
        console,
        setInterval() {},
        Plotly: { react(_chart, traces) { plots.push(traces); } },
        fetch(url) {
            return new Promise(resolve => {
                requests.push({
                    url,
                    reply(data) { resolve({ ok: true, json: async () => data }); },
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
        page,
        state(expression) { return vm.runInContext(expression, context); },
        async reply(url, data) {
            const index = requests.findIndex(request => request.url === url);
            assert.ok(index >= 0, `Expected pending request for ${url}`);
            requests.splice(index, 1)[0].reply(data);
            await new Promise(resolve => setImmediate(resolve));
        },
    };
}

function slotData(slot) {
    return {
        slot,
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
    assert.equal(browser.state("currentSlotPage[0].slot"), 40);

    const select = browser.elements.get("slot-select");
    select.value = "20";
    const selection = select.change();
    await browser.reply("/api/slots/20", slotData(20));
    await browser.reply("/api/slots/40", slotData(40));
    await Promise.all([newPage, selection]);
    assert.equal(browser.state("currentData.slot"), 20);
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
    assert.equal(browser.plots[0][0].x.join(","), "7");
    assert.equal(browser.plots[0][0].y.join(","), "32");
    assert.equal(browser.plots[0][0].customdata[0].join(","), "64,5,data");
    assert.equal(browser.plots[0][1].x.join(","), "7");

    browser.elements.get("timeline-button").click();
    const timeline = browser.plots[1];
    assert.equal(timeline[0].x.join(","), "1,2");
    assert.equal(timeline[2].x.join(","), "7");
    assert.equal(timeline[2].y.join(","), "64");
});
