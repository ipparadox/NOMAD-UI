const assert = require("assert");
const {EventEmitter} = require("events");
const {
    EXPECTED_BRIDGE_KEYS,
    attachRendererLifecycleDiagnostics,
    rendererVerificationReport,
    safeRendererLocation
} = require("../src/classes/rendererDiagnostics.js");

const goodProbe = {
    requireType: "undefined",
    processType: "undefined",
    moduleType: "undefined",
    bridgeType: "object",
    bridgeKeys: Array.from(EXPECTED_BRIDGE_KEYS)
};
const verified = rendererVerificationReport({
    rendererPreloadIsolated: true,
    currentUrl: "file:///opt/nomad/ui-secure.html",
    expectedUrl: "file:///opt/nomad/ui-secure.html",
    probe: goodProbe
});
assert.strictEqual(verified.verified, true);
assert.deepStrictEqual(verified.failed, []);
assert.deepStrictEqual(Object.keys(verified.checks), [
    "rendererPreloadIsolated", "urlMatch", "probeAvailable", "requireUndefined",
    "processUndefined", "moduleUndefined", "bridgeObject", "bridgeKeyCount", "bridgeExactKeys"
]);

const noProbe = rendererVerificationReport({
    rendererPreloadIsolated: false,
    currentUrl: "file:///opt/nomad/wrong.html",
    expectedUrl: "file:///opt/nomad/ui-secure.html",
    probe: null
});
assert.deepStrictEqual(noProbe.failed, Object.keys(noProbe.checks));

const wrongGlobals = rendererVerificationReport({
    rendererPreloadIsolated: true,
    currentUrl: "file:///opt/nomad/ui-secure.html",
    expectedUrl: "file:///opt/nomad/ui-secure.html",
    probe: Object.assign({}, goodProbe, {requireType: "function", processType: "object", moduleType: "object"})
});
assert.deepStrictEqual(wrongGlobals.failed, ["requireUndefined", "processUndefined", "moduleUndefined"]);

const wrongBridge = rendererVerificationReport({
    rendererPreloadIsolated: true,
    currentUrl: "file:///opt/nomad/ui-secure.html",
    expectedUrl: "file:///opt/nomad/ui-secure.html",
    probe: Object.assign({}, goodProbe, {
        bridgeType: "undefined",
        bridgeKeys: EXPECTED_BRIDGE_KEYS.slice(0, -1).concat("wrong")
    })
});
assert.deepStrictEqual(wrongBridge.failed, ["bridgeObject", "bridgeExactKeys"]);

assert.strictEqual(safeRendererLocation("file:///home/operator/NOMAD-UI/src/_renderer_secure.js?token=secret"), "_renderer_secure.js");

class FakeWindow extends EventEmitter {
    constructor() {
        super();
        this.webContents = new EventEmitter();
    }
}

const fakeWindow = new FakeWindow();
const logs = [];
assert.strictEqual(attachRendererLifecycleDiagnostics(fakeWindow, {
    log: (level, message) => logs.push({level, message})
}), true);

fakeWindow.webContents.emit("did-start-loading");
fakeWindow.webContents.emit("dom-ready");
fakeWindow.webContents.emit("did-finish-load");
fakeWindow.webContents.emit("did-fail-load", {}, -6, "FILE NOT FOUND", "file:///home/operator/private/ui-secure.html", true);
fakeWindow.webContents.emit("console-message", {}, 3, "token=super-secret", 44, "file:///home/operator/private/_renderer_secure.js");
fakeWindow.webContents.emit("preload-error", {}, "/home/operator/private/preload.js", new Error("preload failed"));
fakeWindow.webContents.emit("render-process-gone", {}, {exitCode: 9, reason: "crashed"});
fakeWindow.webContents.emit("crashed", {}, false);
fakeWindow.emit("unresponsive");
fakeWindow.emit("responsive");

const messages = logs.map(entry => entry.message);
assert(messages.some(message => message.includes("event=did-fail-load") && message.includes("code=-6")
    && message.includes("source=ui-secure.html") && message.includes("mainFrame=true")));
assert(messages.some(message => message.includes("event=console-message") && message.includes("line=44")
    && message.includes("source=_renderer_secure.js") && message.includes("token=[REDACTED]")));
assert(messages.some(message => message.includes("event=preload-error") && message.includes("source=preload.js")));
assert(messages.some(message => message.includes("event=render-process-gone") && message.includes("code=9")
    && message.includes("description=crashed")));
assert(messages.some(message => message.includes("event=crashed") && message.includes("code=not-killed")));
assert(messages.some(message => message.includes("event=unresponsive")));
assert(messages.some(message => message.includes("event=responsive")));
assert(messages.every(message => !message.includes("/home/operator/private")));

console.log("Renderer lifecycle diagnostics and predicate-level isolation verification passed");
