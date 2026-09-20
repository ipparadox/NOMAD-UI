"use strict";

const EXPECTED_BRIDGE_KEYS = Object.freeze([
    "applications",
    "assistant",
    "auth",
    "automation",
    "control",
    "log",
    "network",
    "repositories",
    "runtime",
    "security",
    "settings",
    "system",
    "terminal",
    "windowManager"
]);

function safeRendererText(value, fallback = "UNAVAILABLE") {
    const text = String(value === null || typeof value === "undefined" ? fallback : value)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/ig, "$1[REDACTED]")
        .replace(/((?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[=:]\s*)[^\s,;]+/ig, "$1[REDACTED]")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/ig, "$1[REDACTED]@")
        .slice(0, 512);
    return text || fallback;
}

function safeRendererLocation(value) {
    if (typeof value !== "string" || !value) return "UNAVAILABLE";
    let location = value.split(/[?#]/, 1)[0];
    try {
        location = new URL(value).pathname || location;
    } catch (error) {}
    try { location = decodeURIComponent(location); } catch (error) {}
    const basename = location.split(/[\\/]/).filter(Boolean).pop();
    return safeRendererText(basename || "UNAVAILABLE", "UNAVAILABLE").slice(0, 128);
}

function safeRendererCode(value) {
    if (Number.isFinite(value)) return String(Math.trunc(value));
    if (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)) return value;
    return "UNAVAILABLE";
}

function rendererVerificationReport({rendererPreloadIsolated, currentUrl, expectedUrl, probe}) {
    const bridgeKeys = probe && Array.isArray(probe.bridgeKeys) ? probe.bridgeKeys : null;
    const checks = Object.freeze({
        rendererPreloadIsolated: rendererPreloadIsolated === true,
        urlMatch: currentUrl === expectedUrl,
        probeAvailable: Boolean(probe),
        requireUndefined: Boolean(probe) && probe.requireType === "undefined",
        processUndefined: Boolean(probe) && probe.processType === "undefined",
        moduleUndefined: Boolean(probe) && probe.moduleType === "undefined",
        bridgeObject: Boolean(probe) && probe.bridgeType === "object",
        bridgeKeyCount: Boolean(bridgeKeys) && bridgeKeys.length === EXPECTED_BRIDGE_KEYS.length,
        bridgeExactKeys: Boolean(bridgeKeys)
            && EXPECTED_BRIDGE_KEYS.every((key, index) => bridgeKeys[index] === key)
    });
    const failed = Object.keys(checks).filter(name => checks[name] !== true);
    return Object.freeze({verified: failed.length === 0, checks, failed: Object.freeze(failed)});
}

function attachRendererLifecycleDiagnostics(win, options = {}) {
    if (!win || !win.webContents || typeof options.log !== "function") return false;
    const log = options.log;
    const emit = (level, eventType, details = {}) => {
        const fields = [`event=${safeRendererText(eventType, "unknown").slice(0, 64)}`];
        if (Object.prototype.hasOwnProperty.call(details, "code")) fields.push(`code=${safeRendererCode(details.code)}`);
        if (Object.prototype.hasOwnProperty.call(details, "description")) {
            fields.push(`description=${safeRendererText(details.description)}`);
        }
        if (Object.prototype.hasOwnProperty.call(details, "source")) {
            fields.push(`source=${safeRendererLocation(details.source)}`);
        }
        if (Number.isSafeInteger(details.line) && details.line >= 0) fields.push(`line=${details.line}`);
        if (typeof details.mainFrame === "boolean") fields.push(`mainFrame=${details.mainFrame}`);
        log(level, `Renderer diagnostic: ${fields.join(" ")}`);
    };
    const contents = win.webContents;
    contents.on("did-start-loading", () => emit("info", "did-start-loading"));
    contents.on("dom-ready", () => emit("info", "dom-ready"));
    contents.on("did-finish-load", () => emit("info", "did-finish-load"));
    contents.on("did-fail-load", (event, code, description, validatedUrl, isMainFrame) => {
        emit("error", "did-fail-load", {code, description, source: validatedUrl, mainFrame: isMainFrame});
    });
    contents.on("console-message", (event, level, message, line, sourceId) => {
        const levels = ["debug", "info", "warn", "error"];
        emit(levels[level] || "info", "console-message", {code: level, description: message, source: sourceId, line});
    });
    contents.on("preload-error", (event, preloadPath, error) => {
        emit("error", "preload-error", {
            description: error && error.message ? error.message : error,
            source: preloadPath
        });
    });
    contents.on("render-process-gone", (event, details = {}) => {
        emit("error", "render-process-gone", {code: details.exitCode, description: details.reason});
    });
    contents.on("crashed", (event, killed) => {
        emit("error", "crashed", {code: killed === true ? "killed" : "not-killed"});
    });
    win.on("unresponsive", () => emit("warn", "unresponsive"));
    win.on("responsive", () => emit("info", "responsive"));
    return true;
}

// Fixed read-only probe. No renderer-provided script, target, data or IPC API.
function attachSecureProgressDiagnostics(win, log) {
    let baseline = null;
    let reading = false;
    const probe = `(() => {
        const d = document.body.dataset;
        const dashboard = window.nomadTelemetry;
        const system = dashboard && dashboard.system;
        const network = dashboard && dashboard.network;
        const terminal = window.term && window.term[window.currentTerm];
        return {
            ready: d.nomadRendererReady === 'true',
            clock: Number(d.nomadClockTimestamp) || 0,
            system: Number(system && system.lastSequence) || 0,
            network: Number(network && network.lastSequence) || 0,
            cpu: Number(d.nomadCpuGraphTimestamp) || 0,
            memory: Number(d.nomadMemoryTimestamp) || 0,
            traffic: Number(d.nomadNetworkGraphTimestamp) || 0,
            globe: Number(d.nomadGlobeTick) || 0,
            repositories: window.repositoryLauncher ? window.repositoryLauncher.repositories.length : 0,
            workspace: document.querySelectorAll('[data-workspace-slot]').length,
            keyboard: Boolean(window.keyboard),
            control: Boolean(window.nomadControlPlane),
            terminal: Boolean(terminal && terminal.socket && terminal.socket.readyState === 1)
        };
    })()`;
    const timer = setInterval(async () => {
        if (reading || win.isDestroyed()) return;
        reading = true;
        try {
            const current = await win.webContents.executeJavaScript(probe);
            if (!current || !current.ready) return;
            if (!baseline) { baseline = {time: Date.now(), value: current}; return; }
            if (Date.now() - baseline.time < 30000) return;
            const progress = ["clock", "system", "network", "cpu", "memory", "traffic", "globe"]
                .map(name => `${name}=${Number(current[name]) > Number(baseline.value[name]) ? "ADVANCING" : "UNAVAILABLE_OR_IDLE"}`);
            ["repositories", "workspace"].forEach(name => progress.push(`${name}=${Number.isSafeInteger(current[name]) ? current[name] : 0}`));
            ["terminal", "keyboard", "control"].forEach(name => progress.push(`${name}=${current[name] === true ? "READY" : "UNAVAILABLE"}`));
            log("info", `Secure renderer live verification (30s): ${progress.join(" ")}`);
            baseline = {time: Date.now(), value: current};
        } catch (error) {
            log("warn", "Secure renderer live verification unavailable");
        } finally { reading = false; }
    }, 5000);
    win.on("closed", () => clearInterval(timer));
    win.webContents.on("did-start-loading", () => { baseline = null; });
    return () => clearInterval(timer);
}

module.exports = {
    EXPECTED_BRIDGE_KEYS,
    attachSecureProgressDiagnostics,
    attachRendererLifecycleDiagnostics,
    rendererVerificationReport,
    safeRendererCode,
    safeRendererLocation,
    safeRendererText
};
