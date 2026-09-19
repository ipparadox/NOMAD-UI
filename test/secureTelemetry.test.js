"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

// Small DOM for behavioral tests, including markup mounted by the real views.
class Element {
    constructor(tag, document) {
        this.tagName = tag.toLowerCase(); this.document = document;
        this.children = []; this.dataset = {}; this.style = {}; this.listeners = {};
        this.className = ""; this.textContent = ""; this.offsetWidth = 200; this.offsetHeight = 200;
        this.classList = {
            add: name => { this.className += ` ${name}`; },
            remove: name => { this.className = this.className.split(/\s+/).filter(x => x !== name).join(" "); },
            contains: name => this.className.split(/\s+/).includes(name)
        };
    }
    set id(id) { this._id = id; this.document.ids.set(id, this); }
    get id() { return this._id; }
    get firstChild() { return this.children[0] || (this._text ||= {textContent: ""}); }
    set innerHTML(html) {
        this.children = []; const stack = [this];
        for (const token of html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
            const value = token[0];
            if (value.startsWith("</")) { stack.pop(); continue; }
            if (!value.startsWith("<")) { stack[stack.length - 1].textContent += value.trim(); continue; }
            const tag = value.match(/^<([a-z0-9]+)/i)[1];
            const node = new Element(tag, this.document);
            for (const attr of value.matchAll(/([a-z-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
            stack[stack.length - 1].appendChild(node);
            if (!["br", "input"].includes(tag)) stack.push(node);
        }
    }
    setAttribute(name, value) { if (name === "id") this.id = value; else if (name === "class") this.className = value; else this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    insertBefore(node, before) { const i = this.children.indexOf(before); if (i < 0) return this.appendChild(node); this.children.splice(i, 0, node); node.parentElement = this; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    replaceWith(node) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1, node); node.parentElement = p; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    removeEventListener(type) { delete this.listeners[type]; }
    focus() { this.document.activeElement = this; }
    remove() { this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        if (selector.includes(",")) return selector.split(",").flatMap(s => this.querySelectorAll(s.trim()));
        const tokens = selector.replace(/>/g, " ").trim().split(/\s+/);
        let parents = [this];
        for (const token of tokens) {
            const matches = [];
            const visit = node => node.children.forEach(child => {
                const id = token.match(/#([\w-]+)/); const cls = token.match(/\.([\w-]+)/); const tag = token.match(/^[a-z][a-z0-9]*/);
                const nth = token.match(/:nth-child\((\d)\)/);
                if ((!id || child.id === id[1]) && (!cls || child.classList.contains(cls[1])) && (!tag || child.tagName === tag[0])
                    && (!nth || node.children.indexOf(child) === Number(nth[1]) - 1)
                    && (!token.includes(":first-child") || node.children[0] === child)) matches.push(child);
                visit(child);
            });
            parents.forEach(visit); parents = matches;
        }
        return parents;
    }
}
const document = {
    ids: new Map(), hidden: false, listeners: {},
    createElement(tag) { return new Element(tag, this); },
    createDocumentFragment() { return this.createElement("fragment"); },
    getElementById(id) { return this.ids.get(id) || null; },
    querySelector(s) { return this.body.querySelector(s); },
    querySelectorAll(s) { return this.body.querySelectorAll(s); },
    addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener(type) { delete this.listeners[type]; }
};
document.body = document.createElement("body");
for (const id of ["mod_column_left", "mod_column_right"]) {
    const column = document.createElement("section"); column.id = id; column.className = "mod_column"; document.body.appendChild(column);
}
let now = 100000;
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const intervals = new Map(); const timeouts = new Map(); const frames = new Map(); let timerId = 0;
class Series { constructor() { this.data = []; } append(time, value) { this.data.push([time, value]); } }
class Chart {
    constructor() { this.series = []; } addTimeSeries(series) { this.series.push(series); }
    streamTo(canvas) { assert(canvas); this.canvas = canvas; this.start(); } start() { this.running = true; } stop() { this.running = false; }
}
class Globe {
    constructor(width, height, options) { assert(options.tiles); this.domElement = document.createElement("canvas"); this.ticks = 0; }
    init(background, ready) { ready(); } tick() { this.ticks++; }
    addPin() { return {remove() {}}; } addMarker() { return {remove() {}}; }
}
const theme = {r: 0, g: 200, b: 255, colors: {light_black: "#000000"}, cssvars: {font_main: "Exo 2"}};
const window = {settings: {}, theme, TimeSeries: Series, SmoothieChart: Chart, ENCOM: {Globe},
    audioManager: {scan: {play() {}}, panels: {play() {}}}, addEventListener() {}};
const context = vm.createContext({document, window, console, Date: Clock,
    setInterval: fn => { intervals.set(++timerId, fn); return timerId; }, clearInterval: id => intervals.delete(id),
    setTimeout: fn => { timeouts.set(++timerId, fn); return timerId; }, clearTimeout: id => timeouts.delete(id),
    requestAnimationFrame: fn => { frames.set(++timerId, fn); return timerId; }, cancelAnimationFrame: id => frames.delete(id)});
vm.runInContext(fs.readFileSync(require.resolve("../src/classes/secureTelemetry.class.js"), "utf8"), context);
const system = {ok: true, status: "AVAILABLE", sequence: 1, timestamp: now,
    runtime: {uptime: 123, platform: "linux"}, identity: {manufacturer: "Test", model: "Fixture", chassis: "Desktop"},
    cpu: {cores: 2, coreLoads: [12, 23], speed: 2.4, speedMax: 3, tasks: 2, temperature: 40},
    memory: {total: 1000, active: 500, free: 200, available: 400, swapTotal: 0, swapUsed: 0},
    processes: [{pid: 1, name: "fixture", cpu: 1, memory: 2}]};
const network = {ok: true, status: "ONLINE", sequence: 1, timestamp: now,
    interface: {displayName: "fixture"}, traffic: {tx_sec: 100, rx_sec: 200, tx_bytes: 1000, rx_bytes: 2000}, endpoint: {status: "UNAVAILABLE"}};
let systemUpdate; let networkUpdate; let unsubscribed = 0;
const logs = [];
async function run() {
    const dashboard = new window.SecureTelemetryDashboard({theme, bootstrap: {globeGrid: {tiles: []}}, log: (level, text) => logs.push(text),
        systemBridge: {getTelemetry: async () => system, subscribeTelemetry: fn => { systemUpdate = fn; return () => unsubscribed++; }},
        networkBridge: {getTelemetry: async () => network, subscribeTelemetry: fn => { networkUpdate = fn; return () => unsubscribed++; }}});
    const ready = await dashboard.initialize();
    assert(ready.system.available && ready.network.available && ready.network.globeInitialized, logs.join("; "));
    ["clock", "sysinfo", "hardwareInspector", "cpuinfo", "ramwatcher", "toplist", "netstat", "globe", "conninfo"].forEach(id => assert(document.getElementById(`mod_${id}`)));
    assert.strictEqual(dashboard.system.cpuSeries[0].data[0][1], 12);
    assert.strictEqual(dashboard.network.trafficSeries[0].data[0][1], 100 / 125000);
    now += 1000;
    systemUpdate({...system, sequence: 2, timestamp: now, cpu: {...system.cpu, coreLoads: [70, 80]}});
    networkUpdate({...network, sequence: 2, timestamp: now, traffic: {...network.traffic, tx_sec: 500}});
    assert.strictEqual(dashboard.system.cpuSeries[0].data[1][1], 70);
    assert.strictEqual(dashboard.network.trafficSeries[0].data[1][1], 500 / 125000);
    assert.strictEqual(document.body.dataset.nomadCpuGraphTimestamp, String(now));
    systemUpdate(system); // delayed initial response must not overwrite the subscription
    assert.strictEqual(dashboard.system.lastSequence, 2);
    const before = document.body.dataset.nomadClockTimestamp;
    intervals.get(dashboard.clock.updater)();
    assert.notStrictEqual(document.body.dataset.nomadClockTimestamp, before);
    const [id, tick] = frames.entries().next().value; frames.delete(id); tick(1000);
    assert.strictEqual(dashboard.network.globe.globe.ticks, 1);
    assert.strictEqual(frames.size, 1, "one globe loop only");
    now += 11000; dashboard.checkFreshness();
    assert.strictEqual(dashboard.system.statusElement.textContent, "SYSTEM TELEMETRY UNAVAILABLE");
    assert(dashboard.system.cpuCharts.every(chart => !chart.running));
    systemUpdate({...system, sequence: 3, timestamp: now});
    assert(dashboard.system.statusElement.hidden);
    assert(dashboard.system.cpuCharts.every(chart => chart.running));
    systemUpdate({ok: false, sequence: 4, timestamp: now});
    assert.strictEqual(document.getElementById("mod_ramwatcher_info").textContent, "UNAVAILABLE");
    assert.strictEqual(document.getElementById("mod_cpuinfo_temp").textContent, "UNAVAILABLE");
    const samples = dashboard.network.trafficSeries[0].data.length;
    networkUpdate({ok: false, sequence: 3, timestamp: now});
    assert.strictEqual(dashboard.network.trafficSeries[0].data.length, samples, "failure must not append fake zero traffic");
    assert(dashboard.network.trafficCharts.every(chart => !chart.running));
    dashboard.dispose();
    assert.strictEqual(unsubscribed, 2); assert.strictEqual(intervals.size, 0); assert.strictEqual(frames.size, 0);
    console.log("Secure telemetry DOM, subscriptions, graph samples, globe loop, clock progression, stale/failure recovery and disposal passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
