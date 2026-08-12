const assert = require("assert");
const {MANAGED_APPLICATIONS} = require("../src/classes/managedApplications.js");
const {WorkspaceManager} = require("../src/classes/workspaceManager.class.js");
const {ApplicationLauncher} = require("../src/classes/applicationLauncher.class.js");

const operations = [];
const resumed = [];
const manager = new WorkspaceManager({
    applications: MANAGED_APPLICATIONS,
    initialApplicationIds: ["terminal"],
    operationHandlers: {
        focus: slot => operations.push(slot.id)
    }
});
const launcher = new ApplicationLauncher({
    manager,
    onResume: id => resumed.push(id)
});

assert.deepStrictEqual(launcher.entries.map(entry => entry.label), ["CODE", "BROWSER", "NOTES", "TERMINAL"]);
assert.deepStrictEqual(launcher.entries.map(entry => entry.state), ["AVAILABLE", "AVAILABLE", "AVAILABLE", "ACTIVE"]);

let triggerPrevented = false;
let triggerStopped = false;
launcher._onTriggerClick({
    preventDefault: () => { triggerPrevented = true; },
    stopPropagation: () => { triggerStopped = true; }
});
assert.strictEqual(triggerPrevented, true);
assert.strictEqual(triggerStopped, true);
assert.strictEqual(manager.activeSlotId, "terminal", "opening the launcher must not switch applications");
assert.deepStrictEqual(operations, []);
launcher._handleKeydown({
    key: "Escape",
    preventDefault: () => {},
    stopPropagation: () => {},
    stopImmediatePropagation: () => {}
});
assert.strictEqual(manager.activeSlotId, "terminal");
assert.deepStrictEqual(resumed, ["terminal"]);

launcher.open();
launcher.activate("code");
assert.strictEqual(manager.activeSlotId, "code");
assert.deepStrictEqual(operations, ["code"]);
assert.strictEqual(launcher.isOpen, false);
assert.strictEqual(manager.getApplicationStates().find(entry => entry.id === "code").state, "ACTIVE");

launcher.open();
launcher.activate("code");
assert.deepStrictEqual(operations, ["code"], "selecting ACTIVE must not issue another manager focus");
assert.deepStrictEqual(resumed, ["terminal", "code"]);

launcher.open();
launcher._handleKeydown({
    key: "ArrowDown",
    preventDefault: () => {},
    stopPropagation: () => {},
    stopImmediatePropagation: () => {}
});
launcher._handleKeydown({
    key: "Enter",
    preventDefault: () => {},
    stopPropagation: () => {},
    stopImmediatePropagation: () => {}
});
assert.strictEqual(manager.activeSlotId, "browser");
assert.deepStrictEqual(operations, ["code", "browser"]);
assert.strictEqual(manager.getSlot("code").running, true);
assert.strictEqual(manager.getSlot("code").state, "HIDDEN");

const originalCodeSlot = manager.getSlot("code");
launcher.open();
launcher.activate("code");
assert.strictEqual(manager.getSlot("code"), originalCodeSlot, "restoring CODE must reuse its managed slot");
assert.strictEqual(manager.activeSlotId, "code");
assert.deepStrictEqual(manager.getState().slots.map(slot => slot.id), ["code", "browser", "terminal"]);
assert.deepStrictEqual(operations, ["code", "browser", "code"]);

launcher.open();
const operationsBeforeEscape = operations.slice();
launcher._handleKeydown({
    key: "Escape",
    preventDefault: () => {},
    stopPropagation: () => {},
    stopImmediatePropagation: () => {}
});
assert.strictEqual(manager.activeSlotId, "code");
assert.deepStrictEqual(operations, operationsBeforeEscape, "Escape must not run a workspace operation");
assert.strictEqual(resumed[resumed.length - 1], "code");

launcher.open();
launcher.activate("notes");
assert.strictEqual(manager.activeSlotId, "notes");
assert.strictEqual(manager.getSlot("notes").placeholder, true);

launcher.open();
launcher.activate("terminal");
assert.strictEqual(manager.activeSlotId, "terminal");

manager.close("browser", {skipOperation: true});
assert.strictEqual(launcher.entries.find(entry => entry.id === "browser").state, "AVAILABLE");

launcher.open();
const operationsBeforeUnknown = operations.slice();
assert.strictEqual(launcher.activate("not-registered"), false);
assert.deepStrictEqual(operations, operationsBeforeUnknown, "unknown IDs must never reach an operation handler");
assert.strictEqual(manager.getSlot("not-registered"), null);

launcher.destroy();

const futureManager = new WorkspaceManager({
    applications: MANAGED_APPLICATIONS.concat({
        id: "spotify",
        displayName: "SPOTIFY",
        type: "external"
    }),
    initialApplicationIds: ["terminal"]
});
const futureLauncher = new ApplicationLauncher({manager: futureManager});
assert.ok(futureLauncher.entries.some(entry => entry.id === "spotify"), "new registry entries must appear without launcher changes");
futureLauncher.destroy();

console.log("ApplicationLauncher registry, state, keyboard, and activation behavior passed");
