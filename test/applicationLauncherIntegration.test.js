const assert = require("assert");
const {MANAGED_APPLICATIONS} = require("../src/classes/managedApplications.js");
const {WorkspaceManager} = require("../src/classes/workspaceManager.class.js");
const {ApplicationLauncher} = require("../src/classes/applicationLauncher.class.js");
const {I3WorkspaceClient} = require("../src/classes/i3WorkspaceClient.class.js");

global.window = {addEventListener: () => {}, ResizeObserver: null};

const sent = [];
const ipc = {
    on: () => {},
    send: (event, request) => sent.push([event, request])
};
const manager = new WorkspaceManager({applications: MANAGED_APPLICATIONS, initialApplicationIds: ["terminal"]});
const client = new I3WorkspaceClient({ipc, manager, viewport: {}});
client.geometry = () => ({x: 20, y: 30, width: 900, height: 650});
client.initialize();
sent.length = 0;

const launcher = new ApplicationLauncher({manager, onResume: id => client.refocus(id)});
const requests = () => sent
    .filter(([event]) => event === "window-manager-operation")
    .map(([, request]) => request);

launcher.open();
launcher.activate("code");
let codeLaunch = requests().find(request => request.operation === "launch" && request.appId === "code");
assert.ok(codeLaunch, "CODE must use the existing trusted launch operation");
assert.deepStrictEqual(codeLaunch.geometry, {x: 20, y: 30, width: 900, height: 650});
client._apply({
    requestId: codeLaunch.requestId,
    ok: true,
    appId: "code",
    status: "RUNNING",
    state: "RUNNING",
    running: true,
    minimized: false,
    fullscreen: false
});
assert.strictEqual(manager.activeSlotId, "code");
assert.deepStrictEqual(manager.getState().slots.map(slot => slot.id), ["code", "terminal"]);

sent.length = 0;
launcher.open();
launcher.activate("browser");
assert.deepStrictEqual(
    requests().map(request => [request.operation, request.appId]),
    [["minimize", "code"], ["launch", "browser"]]
);
const codeMinimize = requests()[0];
const browserLaunch = requests()[1];
assert.deepStrictEqual(browserLaunch.geometry, {x: 20, y: 30, width: 900, height: 650});
client._apply({
    requestId: codeMinimize.requestId,
    ok: true,
    appId: "code",
    status: "HIDDEN",
    state: "HIDDEN",
    running: true,
    minimized: true,
    fullscreen: false
});
client._apply({
    requestId: browserLaunch.requestId,
    ok: true,
    appId: "browser",
    status: "RUNNING",
    state: "RUNNING",
    running: true,
    minimized: false,
    fullscreen: false
});
assert.deepStrictEqual(manager.getState().slots.map(slot => slot.id), ["browser", "code", "terminal"]);
assert.strictEqual(manager.getSlot("code").state, "HIDDEN");

sent.length = 0;
launcher.open();
launcher.activate("code");
assert.deepStrictEqual(
    requests().map(request => [request.operation, request.appId]),
    [["minimize", "browser"], ["focus", "code"]]
);
assert.strictEqual(requests().filter(request => request.operation === "launch" && request.appId === "code").length, 0);
assert.strictEqual(manager.activeSlotId, "code");
assert.deepStrictEqual(manager.getState().slots.map(slot => slot.id), ["code", "browser", "terminal"]);

sent.length = 0;
launcher.open();
launcher.activate("terminal");
assert.deepStrictEqual(requests().map(request => [request.operation, request.appId]), [["focusNomad", "terminal"]]);
assert.strictEqual(manager.activeSlotId, "terminal");

sent.length = 0;
launcher.open();
launcher.activate("notes");
assert.deepStrictEqual(requests().map(request => [request.operation, request.appId]), [["focusNomad", "notes"]]);
assert.strictEqual(manager.activeSlotId, "notes");
assert.strictEqual(manager.getSlot("notes").placeholder, true);

launcher.destroy();
delete global.window;
console.log("ApplicationLauncher and i3 managed-application integration passed");
