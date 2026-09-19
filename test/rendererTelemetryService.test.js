"use strict";

const assert = require("assert");
const {RendererTelemetryService, TELEMETRY_INTERVALS} = require("../src/classes/rendererTelemetryService.js");

let systemSamples = 0;
let networkSamples = 0;
const systemInformation = {
    system: async () => ({manufacturer: "ACME\nCORP", model: "NOMAD", virtual: false, serial: "SECRET"}),
    chassis: async () => ({type: "Desktop", serial: "SECRET"}),
    cpu: async () => ({manufacturer: "CPU CO", brand: "FAST", cores: 4, physicalCores: 2, speed: 3.1, speedMin: 1.2, speedMax: 4.2}),
    currentLoad: async () => {
        systemSamples++;
        return {currentLoad: 10 + systemSamples, cpus: [{load: 10}, {load: 20}, {load: 30}, {load: 40}]};
    },
    cpuTemperature: async () => ({max: 54}),
    mem: async () => ({total: 16000, free: 4000, used: 12000, active: 10000, available: 6000, swaptotal: 2000, swapused: 200}),
    processes: async () => ({
        all: 10,
        running: 2,
        list: [{pid: 42, name: "node\u0000worker", user: "nomad", cpu: 5.5, mem: 1.2, state: "running", started: "10:00", command: "--secret", path: "/secret"}]
    }),
    battery: async () => ({hasBattery: true, percent: 72, isCharging: false, acConnected: false}),
    networkInterfaces: async () => [{iface: "eth0", ip4: "10.0.0.2", operstate: "up", internal: false, mac: "SECRET"}],
    networkStats: async () => {
        networkSamples++;
        return [{rx_bytes: 1000 + networkSamples, tx_bytes: 2000 + networkSamples, rx_sec: 25, tx_sec: 50, iface: "eth0"}];
    },
    networkConnections: async () => [
        {state: "ESTABLISHED", peeraddress: "203.0.113.7", peerport: 443, pid: 999, process: "SECRET"}
    ]
};

class FakeSocket {
    constructor() { this.handlers = {}; }
    setTimeout() {}
    once(event, callback) { this.handlers[event] = callback; return this; }
    connect() { setImmediate(() => this.handlers.connect()); }
    destroy() {}
}

const fakeNet = {
    Socket: FakeSocket,
    isIP: value => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value || "") ? 4 : 0
};
const fakeGeoLookup = {
    get: address => ({
        location: address === "198.51.100.9"
            ? {latitude: 40.4168, longitude: -3.7038}
            : {latitude: 48.8566, longitude: 2.3522},
        city: {names: {en: address === "198.51.100.9" ? "Madrid" : "Paris"}},
        country: {iso_code: address === "198.51.100.9" ? "ES" : "FR"}
    }),
    close: () => {}
};

async function run() {
    assert.deepStrictEqual(TELEMETRY_INTERVALS, {system: 1000, network: 1000});
    const logs = [];
    const service = new RendererTelemetryService({
        systemInformation,
        net: fakeNet,
        os: {platform: () => "linux", type: () => "Linux", uptime: () => 12345},
        endpointProvider: async () => "198.51.100.9",
        geoLookup: fakeGeoLookup,
        log: (level, message) => logs.push({level, message})
    });

    const system = await service.getSystemTelemetry();
    assert.strictEqual(system.ok, true);
    assert.strictEqual(system.status, "AVAILABLE");
    assert.deepStrictEqual(system.cpu.coreLoads, [10, 20, 30, 40]);
    assert.strictEqual(system.cpu.tasks, 10);
    assert.strictEqual(system.memory.available, 6000);
    assert.deepStrictEqual(system.processes, [{
        pid: 42, name: "node worker", user: "nomad", cpu: 5.5, memory: 1.2,
        state: "running", started: "10:00"
    }]);
    assert(!JSON.stringify(system).includes("--secret"));
    assert(!JSON.stringify(system).includes("/secret"));
    assert(!JSON.stringify(system).includes("serial"));

    await service.getNetworkTelemetry();
    if (service._endpointInFlight) await service._endpointInFlight;
    const network = await service._collectNetworkTelemetry();
    assert.strictEqual(network.ok, true);
    assert.strictEqual(network.status, "ONLINE");
    assert(/^iface_[a-f0-9]{24}$/.test(network.interface.id));
    assert.strictEqual(network.interface.displayName, "eth0");
    assert.strictEqual(network.endpoint.address, "198.51.100.9");
    assert.strictEqual(network.endpoint.latitude, 40.4168);
    assert.deepStrictEqual(network.connectionLocations, [{latitude: 48.8566, longitude: 2.3522, city: "Paris", country: "FR"}]);
    assert(!JSON.stringify(network.connectionLocations).includes("203.0.113.7"));
    assert(!JSON.stringify(network).includes("peerport"));
    assert(!JSON.stringify(network).includes("pid"));

    const systemEvents = [];
    const networkEvents = [];
    assert.strictEqual(service.start({
        systemInterval: 500,
        networkInterval: 500,
        onSystemTelemetry: value => systemEvents.push(value),
        onNetworkTelemetry: value => networkEvents.push(value)
    }), true);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert(systemEvents.length >= 2, "system telemetry subscription must continue after initial render");
    assert(networkEvents.length >= 2, "network telemetry subscription must continue after initial render");
    assert(systemEvents[systemEvents.length - 1].sequence > systemEvents[0].sequence);
    assert(networkEvents[networkEvents.length - 1].sequence > networkEvents[0].sequence);
    assert(systemSamples >= 3);
    assert(networkSamples >= 3);
    assert.strictEqual(service.stop(), true);
    assert.strictEqual(service._timers.length, 0);
    assert.strictEqual(logs.length, 0);

    const unavailableLogs = [];
    const unavailableMethods = {};
    ["system", "chassis", "cpu", "currentLoad", "cpuTemperature", "mem", "processes", "battery", "networkInterfaces"]
        .forEach(name => { unavailableMethods[name] = async () => { throw new Error("sensor path /private must stay main-side"); }; });
    const unavailable = new RendererTelemetryService({
        systemInformation: unavailableMethods,
        net: fakeNet,
        os: {platform: () => "linux", type: () => "Linux", uptime: () => 1},
        log: (level, message) => unavailableLogs.push({level, message})
    });
    const unavailableSystem = await unavailable.getSystemTelemetry();
    const unavailableNetwork = await unavailable.getNetworkTelemetry();
    assert.strictEqual(unavailableSystem.ok, false);
    assert.strictEqual(unavailableSystem.status, "SYSTEM TELEMETRY UNAVAILABLE");
    assert.strictEqual(unavailableNetwork.ok, false);
    assert.strictEqual(unavailableNetwork.status, "NETWORK TELEMETRY UNAVAILABLE");
    assert(unavailableLogs.some(entry => entry.message.includes("module=system.cpu") && entry.message.includes("status=unavailable")));
    assert(unavailableLogs.some(entry => entry.message.includes("module=network.interfaces") && entry.message.includes("status=unavailable")));

    let hungCalls = 0;
    let recover;
    const stalled = new RendererTelemetryService({
        systemInformation: Object.assign({}, systemInformation, {mem: () => {
            hungCalls++;
            return new Promise(resolve => { recover = resolve; });
        }}), callTimeout: 20, net: fakeNet
    });
    const partial = await stalled.getSystemTelemetry();
    assert.strictEqual(partial.status, "PARTIAL");
    assert.strictEqual(partial.memory, null);
    assert(partial.unavailable.includes("mem"));
    await stalled._collectSystemTelemetry();
    assert.strictEqual(hungCalls, 1, "a stuck OS probe must not be started again on every interval");
    recover({total: 1000});
    await new Promise(resolve => setImmediate(resolve));
    stalled.systemInformation.mem = async () => ({total: 2000});
    assert.strictEqual((await stalled._collectSystemTelemetry()).memory.total, 2000);
    assert.strictEqual(stalled._networkStats([{rx_sec: -1, tx_sec: -1}])[0].rx_sec, null);
    stalled.stop();

    console.log("Trusted system/network telemetry projections, sanitization, geography redaction, and bounded live subscriptions passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
