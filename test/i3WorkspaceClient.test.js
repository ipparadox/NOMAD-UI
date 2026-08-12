const assert = require("assert");
const {MANAGED_APPLICATIONS} = require("../src/classes/managedApplications.js");
const {WorkspaceManager} = require("../src/classes/workspaceManager.class.js");
const {I3WorkspaceClient} = require("../src/classes/i3WorkspaceClient.class.js");

const listeners = {};
const sent = [];
const ipc = {
    on: (event, listener) => { listeners[event] = listener; },
    send: (event, request) => sent.push([event, request])
};
const manager = new WorkspaceManager({applications: MANAGED_APPLICATIONS, initialApplicationIds: ["terminal"]});
const client = new I3WorkspaceClient({ipc, manager, viewport: {}});
client.geometry = () => ({x: 10, y: 20, width: 800, height: 600});

global.window = {addEventListener: () => {}, ResizeObserver: null};
client.initialize();
sent.length = 0;

const observe = (appId, state, opts = {}) => client._apply({
    ok: true,
    appId,
    status: state === "HIDDEN" ? "HIDDEN" : "RUNNING",
    state,
    running: true,
    minimized: state === "HIDDEN",
    fullscreen: false,
    visible: state !== "HIDDEN",
    focused: state === "ACTIVE",
    discovered: opts.discovered === true,
    observed: true,
    containerId: appId === "code" ? 303 : 404
});
const operations = operation => sent
    .filter(([event, request]) => event === "window-manager-operation" && request.operation === operation)
    .map(([, request]) => request);

// A focused first discovery is the only observation that may take logical
// ACTIVE ownership from TERMINAL.
observe("code", "ACTIVE", {discovered: true});
assert.strictEqual(manager.activeSlotId, "code");
assert.deepStrictEqual(manager.getState().slots.map(slot => slot.id), ["code", "terminal"]);
assert.strictEqual(manager.getSlot("terminal").active, false);
assert.strictEqual(operations("geometry").length, 1);
assert.strictEqual(operations("geometry")[0].appId, "code");

// Repeated polling and passive focus loss to the NOMAD host must not turn the
// physical eDEX X11 focus into logical TERMINAL ownership.
sent.length = 0;
observe("code", "RUNNING");
observe("code", "RUNNING");
observe("code", "RUNNING");
assert.strictEqual(manager.activeSlotId, "code");
assert.strictEqual(manager.getSlot("code").state, "ACTIVE");
assert.strictEqual(operations("focusNomad").length, 0);
assert.strictEqual(operations("geometry").length, 0);

// A geometry response is operational acknowledgement, not a focus event.
client._apply({ok: true, appId: "code", status: "RUNNING", state: "RUNNING"});
assert.strictEqual(manager.activeSlotId, "code");
assert.strictEqual(manager.getSlot("code").state, "ACTIVE");

// Only the explicit selection below is allowed to activate TERMINAL and focus
// the NOMAD host.
manager.focus("terminal");
assert.strictEqual(manager.activeSlotId, "terminal");
assert.strictEqual(operations("focusNomad").length, 1);
assert.strictEqual(operations("focusNomad")[0].appId, "terminal");

sent.length = 0;
observe("browser", "ACTIVE", {discovered: true});
assert.strictEqual(manager.activeSlotId, "browser");
assert.deepStrictEqual(manager.getState().slots.map(slot => slot.id), ["browser", "terminal", "code"]);
assert.strictEqual(operations("geometry").length, 1);
assert.strictEqual(operations("geometry")[0].appId, "browser");

sent.length = 0;
observe("browser", "RUNNING");
observe("browser", "RUNNING");
observe("browser", "RUNNING");
assert.strictEqual(manager.activeSlotId, "browser");
assert.strictEqual(manager.getSlot("browser").state, "ACTIVE");
assert.strictEqual(operations("focusNomad").length, 0);

// A non-focused discovery/update is background runtime information and cannot
// steal ACTIVE from the current logical workspace.
observe("code", "RUNNING");
assert.strictEqual(manager.activeSlotId, "browser");
assert.deepStrictEqual(manager.getState().slots.map(slot => slot.id), ["browser", "terminal", "code"]);

// Passive scratchpad observations do not select TERMINAL. An explicit
// minimize may leave no active workspace, but still may not select TERMINAL.
observe("browser", "HIDDEN");
assert.strictEqual(manager.activeSlotId, "browser");
assert.strictEqual(operations("focusNomad").length, 0);

sent.length = 0;
manager.minimize("browser");
client._apply({
    ok: true,
    appId: "browser",
    status: "HIDDEN",
    state: "HIDDEN",
    running: true,
    minimized: true,
    observed: false
});
assert.strictEqual(manager.activeSlotId, null);
assert.strictEqual(manager.getSlot("terminal").active, false);
assert.strictEqual(operations("minimize").length, 1);
assert.strictEqual(operations("focusNomad").length, 0);

manager.focus("terminal");
assert.strictEqual(manager.activeSlotId, "terminal");
assert.strictEqual(manager.getSlot("terminal").active, true);
assert.strictEqual(operations("focusNomad").length, 1);

// Closing the launcher after an external app had logical ownership can return
// physical i3 focus without running another WorkspaceManager transition.
const launcherSent = [];
const launcherErrors = [];
const launcherIpc = {
    on: () => {},
    send: (event, request) => launcherSent.push([event, request])
};
const launcherManager = new WorkspaceManager({applications: MANAGED_APPLICATIONS, initialApplicationIds: ["terminal"]});
const launcherClient = new I3WorkspaceClient({
    ipc: launcherIpc,
    manager: launcherManager,
    viewport: {},
    onApplicationError: (message, appId) => launcherErrors.push([message, appId])
});
launcherClient.geometry = () => ({x: 10, y: 20, width: 800, height: 600});
launcherClient.initialize();
launcherManager.synchronize("code", {state: "ACTIVE", running: true});
launcherSent.length = 0;
assert.strictEqual(launcherClient.refocus("code"), true);
assert.strictEqual(launcherManager.activeSlotId, "code");
assert.strictEqual(launcherSent[0][1].operation, "focus");

// A failed registry-backed activation falls back safely to TERMINAL and emits
// only the fixed launcher error vocabulary.
launcherManager.close("code", {skipOperation: true});
launcherManager.focus("terminal");
launcherSent.length = 0;
launcherManager.focus("code");
const failedLaunch = launcherSent.find(([, request]) => request.operation === "launch")[1];
launcherClient._apply({
    requestId: failedLaunch.requestId,
    ok: false,
    appId: "code",
    status: "APPLICATION NOT FOUND"
});
assert.strictEqual(launcherManager.activeSlotId, "terminal");
assert.strictEqual(launcherManager.getSlot("code"), null);
assert.deepStrictEqual(launcherErrors, [["APPLICATION NOT FOUND", "code"]]);

delete global.window;
console.log("I3 workspace logical focus ownership regressions passed");
