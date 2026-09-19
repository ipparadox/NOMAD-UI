"use strict";

const crypto = require("crypto");
const net = require("net");
const os = require("os");

const SYSTEM_METHODS = Object.freeze([
    "battery", "chassis", "cpu", "cpuTemperature", "currentLoad", "mem",
    "networkInterfaces", "networkStats", "processes", "system"
]);
const SYSTEM_METHOD_SET = new Set(SYSTEM_METHODS);
const INTERFACE_ID_PATTERN = /^iface_[a-f0-9]{24}$/;

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function text(value, maximum = 128) {
    return typeof value === "string"
        ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

class RendererSystemService {
    constructor(opts = {}) {
        this.systemInformation = opts.systemInformation || require("systeminformation");
        this.net = opts.net || net;
        this.os = opts.os || os;
        this.pingTarget = typeof opts.pingTarget === "string" ? opts.pingTarget : "1.1.1.1";
        this.interfaceNames = new Map();
    }

    async query(request) {
        if (!isPlainObject(request) || Object.keys(request).some(key => !["method", "targetId"].includes(key))
            || !SYSTEM_METHOD_SET.has(request.method)
            || (request.method !== "networkStats" && Object.prototype.hasOwnProperty.call(request, "targetId"))) {
            return {ok: false, status: "INVALID SYSTEM INFORMATION REQUEST"};
        }
        try {
            if (request.method === "networkInterfaces") return {ok: true, value: await this._networkInterfaces()};
            if (request.method === "networkStats") {
                if (!INTERFACE_ID_PATTERN.test(request.targetId || "") || !this.interfaceNames.has(request.targetId)) {
                    return {ok: false, status: "NETWORK INTERFACE CONTEXT INVALID"};
                }
                return {ok: true, value: this._networkStats(
                    await this.systemInformation.networkStats(this.interfaceNames.get(request.targetId))
                )};
            }
            const method = this.systemInformation[request.method];
            if (typeof method !== "function") return {ok: false, status: "SYSTEM INFORMATION UNAVAILABLE"};
            return {ok: true, value: this._project(request.method, await method.call(this.systemInformation))};
        } catch (error) {
            return {ok: false, status: "SYSTEM INFORMATION UNAVAILABLE"};
        }
    }

    runtime() {
        return {
            platform: this.os.platform(),
            type: this.os.type(),
            uptime: Math.max(0, Math.floor(this.os.uptime()))
        };
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

    async _networkInterfaces() {
        const interfaces = await this.systemInformation.networkInterfaces();
        if (!Array.isArray(interfaces)) return [];
        this.interfaceNames.clear();
        return interfaces.slice(0, 128).map(entry => {
            const name = typeof entry.iface === "string" ? entry.iface : "";
            const id = `iface_${crypto.createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
            this.interfaceNames.set(id, name);
            return {
                iface: id,
                displayName: text(name),
                ip4: text(entry.ip4, 64),
                ip6: text(entry.ip6, 128),
                operstate: ["up", "down", "unknown", "dormant"].includes(entry.operstate) ? entry.operstate : "unknown",
                internal: entry.internal === true,
                virtual: entry.virtual === true
            };
        });
    }

    _networkStats(value) {
        return (Array.isArray(value) ? value : []).slice(0, 1).map(entry => ({
            rx_bytes: finiteNumber(entry && entry.rx_bytes),
            tx_bytes: finiteNumber(entry && entry.tx_bytes),
            rx_sec: finiteNumber(entry && entry.rx_sec),
            tx_sec: finiteNumber(entry && entry.tx_sec)
        }));
    }

    _project(method, value) {
        if (method === "system") return {
            manufacturer: text(value && value.manufacturer, 64),
            model: text(value && value.model, 96),
            virtual: value && value.virtual === true
        };
        if (method === "chassis") return {type: text(value && value.type, 64)};
        if (method === "cpu") return {
            manufacturer: text(value && value.manufacturer, 64),
            brand: text(value && value.brand, 96),
            cores: Math.max(0, Math.floor(finiteNumber(value && value.cores))),
            physicalCores: Math.max(0, Math.floor(finiteNumber(value && value.physicalCores)))
        };
        if (method === "currentLoad") return {currentLoad: finiteNumber(value && value.currentLoad)};
        if (method === "cpuTemperature") return {max: finiteNumber(value && value.max, NaN)};
        if (method === "mem") return {
            total: finiteNumber(value && value.total), used: finiteNumber(value && value.used),
            active: finiteNumber(value && value.active), swaptotal: finiteNumber(value && value.swaptotal),
            swapused: finiteNumber(value && value.swapused)
        };
        if (method === "processes") return {
            all: Math.max(0, Math.floor(finiteNumber(value && value.all))),
            running: Math.max(0, Math.floor(finiteNumber(value && value.running))),
            list: (Array.isArray(value && value.list) ? value.list : []).slice(0, 512).map(entry => ({
                name: text(entry && entry.name, 64), cpu: finiteNumber(entry && entry.cpu)
            }))
        };
        if (method === "battery") return {
            hasBattery: value && value.hasBattery === true,
            percent: Math.max(0, Math.min(100, finiteNumber(value && value.percent))),
            isCharging: value && value.isCharging === true
        };
        return null;
    }
}

module.exports = {INTERFACE_ID_PATTERN, RendererSystemService, SYSTEM_METHODS};
