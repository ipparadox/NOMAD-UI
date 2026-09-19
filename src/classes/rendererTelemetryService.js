"use strict";

const crypto = require("crypto");
const https = require("https");
const net = require("net");
const os = require("os");

const TELEMETRY_INTERVALS = Object.freeze({system: 1000, network: 1000});

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function integerOrNull(value, minimum = 0) {
    return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

function text(value, maximum = 128) {
    return typeof value === "string"
        ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function boundedInterval(value, fallback) {
    return Number.isSafeInteger(value) && value >= 500 && value <= 60000 ? value : fallback;
}

function statusError(error) {
    if (!error) return "UNKNOWN";
    const name = text(error.name || error.code || "Error", 64) || "Error";
    const message = text(error.message || "telemetry request failed", 192) || "telemetry request failed";
    return `${name}: ${message}`;
}

class RendererTelemetryService {
    constructor(opts = {}) {
        this.systemInformation = opts.systemInformation || require("systeminformation");
        this.net = opts.net || net;
        this.os = opts.os || os;
        this.https = opts.https || https;
        this.log = typeof opts.log === "function" ? opts.log : (() => {});
        this.pingTarget = typeof opts.pingTarget === "string" ? opts.pingTarget : "1.1.1.1";
        this.preferredInterface = typeof opts.preferredInterface === "string" ? opts.preferredInterface : null;
        this.endpointHost = typeof opts.endpointHost === "string" ? opts.endpointHost : "myexternalip.com";
        this.endpointPath = typeof opts.endpointPath === "string" ? opts.endpointPath : "/json";
        this.endpointProvider = typeof opts.endpointProvider === "function" ? opts.endpointProvider : null;
        this.geolite2 = opts.geolite2 || null;
        this.maxmind = opts.maxmind || null;
        this.geoLookup = opts.geoLookup || null;
        this._systemSequence = 0;
        this._networkSequence = 0;
        this._systemTelemetry = null;
        this._networkTelemetry = null;
        this._systemInFlight = null;
        this._networkInFlight = null;
        this._endpointInFlight = null;
        this._endpoint = null;
        this._endpointCheckedAt = 0;
        this._interfaceObservation = null;
        this._interfaceCheckedAt = 0;
        this._pingObservation = null;
        this._pingCheckedAt = 0;
        this._connectionLocations = [];
        this._connectionLocationsAvailable = false;
        this._selectedInterfaceKey = null;
        this._connectionsCheckedAt = 0;
        this._timers = [];
        this._failureLogTimes = new Map();
        this._onSystemTelemetry = () => {};
        this._onNetworkTelemetry = () => {};
        this._locationInitialization = null;
        this._calls = new Map();
        this._cache = new Map();
        this.callTimeout = Number.isSafeInteger(opts.callTimeout) && opts.callTimeout > 0
            ? Math.min(opts.callTimeout, 5000) : 2500;
    }

    start(opts = {}) {
        if (this._timers.length) return false;
        this._onSystemTelemetry = typeof opts.onSystemTelemetry === "function" ? opts.onSystemTelemetry : (() => {});
        this._onNetworkTelemetry = typeof opts.onNetworkTelemetry === "function" ? opts.onNetworkTelemetry : (() => {});
        const systemInterval = boundedInterval(opts.systemInterval, TELEMETRY_INTERVALS.system);
        const networkInterval = boundedInterval(opts.networkInterval, TELEMETRY_INTERVALS.network);
        // A slow sensor must not accumulate a publisher per interval.
        let systemPending = false;
        let networkPending = false;
        const publishSystem = async () => {
            if (systemPending) return;
            systemPending = true;
            try { this._onSystemTelemetry(await this._collectSystemTelemetry()); }
            catch (error) { this._logFailure("system.publish", error); }
            finally { systemPending = false; }
        };
        const publishNetwork = async () => {
            if (networkPending) return;
            networkPending = true;
            try { this._onNetworkTelemetry(await this._collectNetworkTelemetry()); }
            catch (error) { this._logFailure("network.publish", error); }
            finally { networkPending = false; }
        };
        publishSystem();
        publishNetwork();
        this._timers.push(setInterval(publishSystem, systemInterval), setInterval(publishNetwork, networkInterval));
        this._timers.forEach(timer => { if (timer && typeof timer.unref === "function") timer.unref(); });
        if (typeof opts.locationCachePath === "string" && opts.locationCachePath) {
            this.initializeLocation(opts.locationCachePath).catch(() => false);
        }
        return true;
    }

    stop() {
        this._timers.forEach(timer => clearInterval(timer));
        this._timers = [];
        if (this.geoLookup && typeof this.geoLookup.close === "function") {
            try { this.geoLookup.close(); } catch (error) {}
        }
        this.geoLookup = null;
        return true;
    }

    getSystemTelemetry() {
        if (this._systemTelemetry && Date.now() - this._systemTelemetry.timestamp < 2000) {
            return Promise.resolve(this._systemTelemetry);
        }
        return this._collectSystemTelemetry();
    }

    getNetworkTelemetry() {
        if (this._networkTelemetry && Date.now() - this._networkTelemetry.timestamp < 2000) {
            return Promise.resolve(this._networkTelemetry);
        }
        return this._collectNetworkTelemetry();
    }

    async initializeLocation(cachePath) {
        if (this.geoLookup) return true;
        if (this._locationInitialization) return this._locationInitialization;
        this._locationInitialization = (async () => {
            try {
                const geolite2 = this.geolite2 || require("geolite2-redist");
                const maxmind = this.maxmind || require("maxmind");
                await geolite2.downloadDbs(cachePath);
                this.geoLookup = await geolite2.open("GeoLite2-City", filename => maxmind.open(filename));
                this._endpoint = null;
                this._endpointCheckedAt = 0;
                this.log("info", "Renderer network telemetry GeoIP database initialized");
                return true;
            } catch (error) {
                this._logFailure("network.location", error, true);
                return false;
            }
        })().finally(() => { this._locationInitialization = null; });
        return this._locationInitialization;
    }

    ping() {
        const target = this.pingTarget;
        if (typeof target !== "string" || target.length > 255 || /[^A-Za-z0-9.:-]/.test(target)) {
            return Promise.resolve({ok: false, status: "PING TARGET INVALID"});
        }
        return new Promise(resolve => {
            const socket = new this.net.Socket();
            const start = process.hrtime.bigint();
            let complete = false;
            const finish = result => {
                if (complete) return;
                complete = true;
                try { socket.destroy(); } catch (error) {}
                resolve(result);
            };
            socket.setTimeout(1900);
            socket.once("connect", () => {
                const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
                finish({ok: true, milliseconds: Math.max(0, Math.min(60000, elapsed))});
            });
            socket.once("timeout", () => finish({ok: false, status: "OFFLINE"}));
            socket.once("error", () => finish({ok: false, status: "OFFLINE"}));
            try { socket.connect({port: 80, host: target, family: 4}); } catch (error) { finish({ok: false, status: "OFFLINE"}); }
        });
    }

    _collectSystemTelemetry() {
        if (this._systemInFlight) return this._systemInFlight;
        this._systemInFlight = (async () => {
            const names = ["system", "chassis", "cpu", "currentLoad", "cpuTemperature", "mem", "processes", "battery"];
            const results = await Promise.all(names.map(name => this._safeSystemCall(name)));
            const values = Object.fromEntries(names.map((name, index) => [name, results[index].value]));
            const available = results.filter(result => result.ok).length;
            const runtime = this._runtime();
            const processData = values.processes;
            const snapshot = {
                ok: available > 0,
                status: available === names.length ? "AVAILABLE" : (available > 0 ? "PARTIAL" : "SYSTEM TELEMETRY UNAVAILABLE"),
                unavailable: names.filter((name, index) => !results[index].ok),
                sequence: ++this._systemSequence,
                timestamp: Date.now(),
                runtime,
                identity: values.system ? {
                    manufacturer: text(values.system.manufacturer, 64),
                    model: text(values.system.model, 96),
                    virtual: values.system.virtual === true,
                    chassis: values.chassis ? text(values.chassis.type, 64) : ""
                } : null,
                power: values.battery ? {
                    hasBattery: values.battery.hasBattery === true,
                    percent: Number.isFinite(values.battery.percent)
                        ? Math.max(0, Math.min(100, values.battery.percent)) : null,
                    isCharging: values.battery.isCharging === true,
                    acConnected: values.battery.acConnected === true
                } : null,
                cpu: values.cpu ? {
                    manufacturer: text(values.cpu.manufacturer, 64),
                    brand: text(values.cpu.brand, 96),
                    cores: integerOrNull(values.cpu.cores),
                    physicalCores: integerOrNull(values.cpu.physicalCores),
                    speed: finiteOrNull(values.cpu.speed),
                    speedMin: finiteOrNull(values.cpu.speedMin),
                    speedMax: finiteOrNull(values.cpu.speedMax),
                    load: values.currentLoad ? finiteOrNull(values.currentLoad.currentLoad) : null,
                    coreLoads: values.currentLoad && Array.isArray(values.currentLoad.cpus)
                        ? values.currentLoad.cpus.slice(0, 256).map(entry => finiteOrNull(entry && entry.load)) : [],
                    temperature: values.cpuTemperature ? finiteOrNull(values.cpuTemperature.max) : null,
                    tasks: processData ? integerOrNull(processData.all) : null,
                    runningTasks: processData ? integerOrNull(processData.running) : null
                } : null,
                memory: values.mem ? {
                    total: finiteOrNull(values.mem.total),
                    free: finiteOrNull(values.mem.free),
                    used: finiteOrNull(values.mem.used),
                    active: finiteOrNull(values.mem.active),
                    available: finiteOrNull(values.mem.available),
                    swapTotal: finiteOrNull(values.mem.swaptotal),
                    swapUsed: finiteOrNull(values.mem.swapused)
                } : null,
                processes: processData && Array.isArray(processData.list)
                    ? processData.list.slice().sort((a, b) => ((Number(b && b.cpu) || 0) - (Number(a && a.cpu) || 0)) * 100
                        + (Number(b && b.mem) || 0) - (Number(a && a.mem) || 0)).slice(0, 512).map(entry => ({
                        pid: integerOrNull(entry && entry.pid),
                        name: text(entry && entry.name, 64) || "PROCESS",
                        user: text(entry && entry.user, 64),
                        cpu: finiteOrNull(entry && entry.cpu),
                        memory: finiteOrNull(entry && entry.mem),
                        state: text(entry && entry.state, 32),
                        started: text(entry && entry.started, 64)
                    })) : []
            };
            this._systemTelemetry = snapshot;
            return snapshot;
        })().finally(() => { this._systemInFlight = null; });
        return this._systemInFlight;
    }

    _collectNetworkTelemetry() {
        if (this._networkInFlight) return this._networkInFlight;
        this._networkInFlight = (async () => {
            const now = Date.now();
            if (!this._interfaceObservation || now - this._interfaceCheckedAt >= 5000) {
                this._interfaceObservation = await this._selectInterface();
                this._interfaceCheckedAt = now;
            }
            const observation = this._interfaceObservation;
            const selected = observation && observation.selected;
            const interfaceKey = selected ? `${selected.id}:${selected.ip4}` : null;
            if (interfaceKey !== this._selectedInterfaceKey) {
                this._selectedInterfaceKey = interfaceKey;
                this._endpoint = null;
                this._endpointCheckedAt = 0;
                this._pingObservation = null;
                this._connectionLocations = [];
                this._connectionLocationsAvailable = false;
                this._connectionsCheckedAt = 0;
            }
            let traffic = null;
            if (selected) {
                try {
                    const rawStats = await this._boundedCall(`networkStats:${selected.id}`, () => this.systemInformation.networkStats(selected.name));
                    traffic = this._networkStats(rawStats)[0] || null;
                } catch (error) {
                    this._logFailure("network.stats", error);
                }
            }
            if (selected && (!this._pingObservation || now - this._pingCheckedAt >= 5000)) {
                this._pingObservation = await this.ping();
                this._pingCheckedAt = now;
            }
            if (!selected) this._pingObservation = null;
            if (selected && (!this._endpoint || now - this._endpointCheckedAt >= 60000)) {
                this._refreshEndpoint(selected.ip4);
            }
            if (selected && this.geoLookup && now - this._connectionsCheckedAt >= 3000) {
                await this._refreshConnectionLocations();
                this._connectionsCheckedAt = now;
            } else if (!selected) {
                this._connectionLocations = [];
                this._connectionLocationsAvailable = false;
            }
            const online = Boolean(selected);
            const endpoint = selected && this._endpoint ? Object.assign({}, this._endpoint) : {
                status: this._endpointInFlight || this._locationInitialization ? "PENDING" : "UNAVAILABLE",
                address: null,
                latitude: null,
                longitude: null,
                city: "",
                country: ""
            };
            const snapshot = {
                ok: Boolean(observation && observation.ok),
                status: observation && observation.ok ? (online ? "ONLINE" : "OFFLINE") : "NETWORK TELEMETRY UNAVAILABLE",
                sequence: ++this._networkSequence,
                timestamp: Date.now(),
                interface: selected ? {
                    id: selected.id,
                    displayName: selected.displayName,
                    state: selected.operstate,
                    ip4: selected.ip4
                } : null,
                latencyMs: this._pingObservation && this._pingObservation.ok
                    ? finiteOrNull(this._pingObservation.milliseconds) : null,
                traffic,
                endpoint,
                connectionLocationsAvailable: this._connectionLocationsAvailable,
                connectionLocations: this._connectionLocations.map(location => Object.assign({}, location))
            };
            this._networkTelemetry = snapshot;
            return snapshot;
        })().catch(error => {
            this._logFailure("network.telemetry", error);
            const snapshot = {
                ok: false,
                status: "NETWORK TELEMETRY UNAVAILABLE",
                sequence: ++this._networkSequence,
                timestamp: Date.now(),
                interface: null,
                latencyMs: null,
                traffic: null,
                endpoint: {status: "UNAVAILABLE", address: null, latitude: null, longitude: null, city: "", country: ""},
                connectionLocationsAvailable: false,
                connectionLocations: []
            };
            this._networkTelemetry = snapshot;
            return snapshot;
        }).finally(() => { this._networkInFlight = null; });
        return this._networkInFlight;
    }

    async _safeSystemCall(name) {
        try {
            const cadence = {system: 20000, chassis: 20000, processes: 5000, battery: 3000, cpuTemperature: 2000};
            const cached = this._cache.get(name);
            if (cached && Date.now() - cached.timestamp < (cadence[name] || 0)) return {ok: true, value: cached.value};
            const method = this.systemInformation[name];
            if (typeof method !== "function") throw new Error("method unavailable");
            const value = await this._boundedCall(name, () => method.call(this.systemInformation));
            if (!value || typeof value !== "object") throw new Error("sensor result unavailable");
            this._cache.set(name, {timestamp: Date.now(), value});
            return {ok: true, value};
        } catch (error) {
            this._logFailure(`system.${name}`, error);
            return {ok: false, value: null};
        }
    }

    async _boundedCall(name, read) {
        // Retain the underlying call until it settles: timing out must not spawn
        // an unbounded number of OS probes when a sensor never responds.
        if (!this._calls.has(name)) {
            const call = Promise.resolve().then(read);
            this._calls.set(name, call);
            call.then(() => this._calls.delete(name), () => this._calls.delete(name));
        }
        const pending = this._calls.get(name);
        if (pending.timedOut) throw new Error("sensor still unavailable");
        let timer;
        try {
            return await Promise.race([pending, new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    pending.timedOut = true;
                    reject(new Error("sensor timeout"));
                }, this.callTimeout);
            })]);
        } finally { clearTimeout(timer); }
    }

    _runtime() {
        let platform = "unknown";
        let type = "unknown";
        let uptime = null;
        try { platform = text(this.os.platform(), 32) || "unknown"; } catch (error) {}
        try { type = text(this.os.type(), 64) || "unknown"; } catch (error) {}
        try { uptime = Math.max(0, Math.floor(this.os.uptime())); } catch (error) {}
        return {platform, type, uptime};
    }

    async _selectInterface() {
        try {
            const interfaces = await this._boundedCall("networkInterfaces", () => this.systemInformation.networkInterfaces());
            const values = Array.isArray(interfaces) ? interfaces : [];
            let selected = null;
            if (this.preferredInterface) {
                selected = values.find(entry => entry && entry.iface === this.preferredInterface
                    && entry.operstate === "up" && entry.internal !== true && text(entry.ip4, 64));
            }
            if (!selected) {
                selected = values.find(entry => entry && entry.operstate === "up"
                    && entry.internal !== true && text(entry.ip4, 64));
            }
            if (!selected) return {ok: true, selected: null};
            const name = text(selected.iface, 128);
            return {ok: true, selected: {
                id: `iface_${crypto.createHash("sha256").update(name).digest("hex").slice(0, 24)}`,
                name,
                displayName: name,
                operstate: selected.operstate === "up" ? "up" : "unknown",
                ip4: text(selected.ip4, 64)
            }};
        } catch (error) {
            this._logFailure("network.interfaces", error);
            return {ok: false, selected: null};
        }
    }

    _refreshEndpoint(localAddress) {
        if (this._endpointInFlight) return this._endpointInFlight;
        const owner = this._selectedInterfaceKey;
        this._endpointCheckedAt = Date.now();
        const provider = this.endpointProvider
            ? () => this.endpointProvider(localAddress)
            : () => this._fetchExternalAddress(localAddress);
        this._endpointInFlight = Promise.resolve().then(provider).then(address => {
            if (owner !== this._selectedInterfaceKey) return null;
            const safeAddress = text(address, 64);
            if (!safeAddress || !this.net.isIP || this.net.isIP(safeAddress) === 0) throw new Error("external address invalid");
            const location = this._lookupLocation(safeAddress);
            this._endpoint = {
                status: location ? "AVAILABLE" : "LOCATION UNAVAILABLE",
                address: safeAddress,
                latitude: location ? location.latitude : null,
                longitude: location ? location.longitude : null,
                city: location ? location.city : "",
                country: location ? location.country : ""
            };
            return this._endpoint;
        }).catch(error => {
            if (owner !== this._selectedInterfaceKey) return null;
            this._endpoint = {
                status: "UNAVAILABLE", address: null, latitude: null, longitude: null, city: "", country: ""
            };
            this._logFailure("network.endpoint", error);
            return this._endpoint;
        }).finally(() => { this._endpointInFlight = null; });
        return this._endpointInFlight;
    }

    _fetchExternalAddress(localAddress) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve(value);
            };
            const options = {
                protocol: "https:",
                host: this.endpointHost,
                port: 443,
                path: this.endpointPath,
                method: "GET",
                agent: false,
                headers: {"User-Agent": "NOMAD-UI Network Telemetry"}
            };
            if (this.net.isIP && this.net.isIP(localAddress) === 4) options.localAddress = localAddress;
            let request;
            try {
                request = this.https.get(options, response => {
                    if (!response || response.statusCode !== 200) {
                        if (response && typeof response.resume === "function") response.resume();
                        finish(new Error("endpoint response unavailable"));
                        return;
                    }
                    let raw = "";
                    response.setEncoding("utf8");
                    response.on("data", chunk => {
                        raw += chunk;
                        if (raw.length > 16384) {
                            try { request.destroy(); } catch (error) {}
                            finish(new Error("endpoint response too large"));
                        }
                    });
                    response.on("end", () => {
                        try {
                            const value = JSON.parse(raw);
                            finish(null, value && value.ip);
                        } catch (error) { finish(error); }
                    });
                    response.on("error", error => finish(error));
                });
                request.setTimeout(4000, () => {
                    try { request.destroy(); } catch (error) {}
                    finish(new Error("endpoint request timeout"));
                });
                request.on("error", error => finish(error));
            } catch (error) { finish(error); }
        });
    }

    async _refreshConnectionLocations() {
        try {
            if (!this.geoLookup || typeof this.systemInformation.networkConnections !== "function") return;
            const connections = await this._boundedCall("networkConnections", () => this.systemInformation.networkConnections());
            const peers = Array.from(new Set((Array.isArray(connections) ? connections : [])
                .filter(entry => entry && entry.state === "ESTABLISHED" && typeof entry.peeraddress === "string")
                .map(entry => entry.peeraddress)
                .filter(address => this.net.isIP && this.net.isIP(address) !== 0))).slice(0, 64);
            const locations = [];
            const seen = new Set();
            peers.forEach(address => {
                const location = this._lookupLocation(address);
                if (!location) return;
                const key = `${location.latitude}:${location.longitude}`;
                if (seen.has(key) || locations.length >= 24) return;
                seen.add(key);
                locations.push(location);
            });
            this._connectionLocations = locations;
            this._connectionLocationsAvailable = true;
        } catch (error) {
            this._connectionLocations = [];
            this._connectionLocationsAvailable = false;
            this._logFailure("network.connections", error);
        }
    }

    _lookupLocation(address) {
        if (!this.geoLookup || typeof this.geoLookup.get !== "function") return null;
        try {
            const record = this.geoLookup.get(address);
            const latitude = record && record.location ? finiteOrNull(record.location.latitude) : null;
            const longitude = record && record.location ? finiteOrNull(record.location.longitude) : null;
            if (latitude === null || longitude === null || latitude < -90 || latitude > 90
                || longitude < -180 || longitude > 180) return null;
            const city = record.city && record.city.names ? text(record.city.names.en, 96) : "";
            const country = record.country ? text(record.country.iso_code, 8) : "";
            return {latitude, longitude, city, country};
        } catch (error) {
            return null;
        }
    }

    _networkStats(value) {
        const counter = value => Number.isFinite(value) && value >= 0 ? value : null;
        return (Array.isArray(value) ? value : []).slice(0, 1).map(entry => ({
            rx_bytes: counter(entry && entry.rx_bytes),
            tx_bytes: counter(entry && entry.tx_bytes),
            rx_sec: counter(entry && entry.rx_sec),
            tx_sec: counter(entry && entry.tx_sec)
        }));
    }

    _logFailure(moduleName, error, immediate = false) {
        const now = Date.now();
        const previous = this._failureLogTimes.get(moduleName) || 0;
        if (!immediate && now - previous < 60000) return;
        this._failureLogTimes.set(moduleName, now);
        this.log("warn", `Renderer telemetry module=${text(moduleName, 64)} status=unavailable detail=${statusError(error)}`);
    }
}

module.exports = {RendererTelemetryService, TELEMETRY_INTERVALS};
