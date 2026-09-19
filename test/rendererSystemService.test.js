const assert = require("assert");
const {RendererSystemService} = require("../src/classes/rendererSystemService.js");

const systemInformation = {
    system: async () => ({manufacturer: "ACME", model: "NOMAD", virtual: true, serial: "SECRET-SERIAL"}),
    chassis: async () => ({type: "Virtual Machine", serial: "SECRET-CHASSIS"}),
    cpu: async () => ({manufacturer: "CPU CO", brand: "FAST", cores: 8, physicalCores: 4, socket: "SECRET"}),
    currentLoad: async () => ({currentLoad: 12.5, cpus: [{load: 99}]}),
    cpuTemperature: async () => ({max: 51, socket: [50]}),
    mem: async () => ({total: 1000, used: 500, active: 450, swaptotal: 200, swapused: 10, available: 500}),
    battery: async () => ({hasBattery: true, percent: 80, isCharging: false, manufacturer: "SECRET"}),
    processes: async () => ({
        all: 2, running: 1,
        list: [{name: "node", cpu: 4.2, pid: 1234, command: "node --secret", path: "/private/path"}]
    }),
    networkInterfaces: async () => [{
        iface: "eth0", ip4: "10.0.0.5", ip6: "::1", operstate: "up", internal: false,
        virtual: false, mac: "00:11:22:33:44:55", driver: "secret-driver"
    }],
    networkStats: async iface => [{iface, rx_bytes: 100, tx_bytes: 200, rx_sec: 3, tx_sec: 4, ms: 10}]
};

async function run() {
    const service = new RendererSystemService({systemInformation});
    const system = await service.query({method: "system"});
    assert.deepStrictEqual(system.value, {manufacturer: "ACME", model: "NOMAD", virtual: true});
    assert(!JSON.stringify(system).includes("SECRET-SERIAL"));

    const processes = await service.query({method: "processes"});
    assert.deepStrictEqual(processes.value.list, [{name: "node", cpu: 4.2}]);
    assert(!JSON.stringify(processes).includes("1234"));
    assert(!JSON.stringify(processes).includes("/private/path"));

    const interfaces = await service.query({method: "networkInterfaces"});
    assert.strictEqual(interfaces.value[0].iface.startsWith("iface_"), true);
    assert.strictEqual(interfaces.value[0].displayName, "eth0");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(interfaces.value[0], "mac"), false);
    const interfaceId = interfaces.value[0].iface;

    const stats = await service.query({method: "networkStats", targetId: interfaceId});
    assert.deepStrictEqual(stats.value, [{rx_bytes: 100, tx_bytes: 200, rx_sec: 3, tx_sec: 4}]);
    assert.strictEqual((await service.query({method: "networkStats", targetId: "eth0"})).ok, false);

    assert.strictEqual((await service.query({method: "fsSize"})).ok, false,
        "unused storage inventory must not be exposed to the renderer");
    assert.strictEqual((await service.query({method: "networkConnections"})).ok, false,
        "raw connection inventory must not be exposed to the renderer");
    assert.strictEqual((await service.query({method: "exec", targetId: "id"})).ok, false);

    console.log("Renderer system projections expose fixed summaries, opaque interfaces, and no raw process, storage, or connection identities");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
