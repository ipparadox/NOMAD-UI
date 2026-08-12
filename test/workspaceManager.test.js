const assert = require("assert");
const {MANAGED_APPLICATIONS} = require("../src/classes/managedApplications.js");
const {WorkspaceManager} = require("../src/classes/workspaceManager.class.js");

const operations = [];
const manager = new WorkspaceManager({
    applications: MANAGED_APPLICATIONS,
    initialApplicationIds: ["terminal"],
    operationHandlers: {
        focus: slot => operations.push(["focus", slot.id]),
        close: slot => operations.push(["close", slot.id]),
        minimize: slot => operations.push(["minimize", slot.id])
    }
});

const order = () => manager.getState().slots.map(slot => slot.label);

assert.deepStrictEqual(order(), ["TERMINAL"]);
assert.strictEqual(manager.getSlot("terminal").state, "ACTIVE");

manager.focus("code");
assert.deepStrictEqual(order(), ["CODE", "TERMINAL"]);
manager.update("code", {state: "RUNNING", running: true});

manager.focus("browser");
assert.deepStrictEqual(order(), ["BROWSER", "CODE", "TERMINAL"]);
manager.update("browser", {state: "RUNNING", running: true});

manager.focus("code");
assert.deepStrictEqual(order(), ["CODE", "BROWSER", "TERMINAL"]);
assert.strictEqual(operations.filter(item => item[0] === "focus" && item[1] === "code").length, 2);

manager.focus("terminal");
assert.deepStrictEqual(order(), ["TERMINAL", "CODE", "BROWSER"]);
manager.focus("code");
assert.deepStrictEqual(order(), ["CODE", "TERMINAL", "BROWSER"]);
assert.strictEqual(manager.getSlot("code").running, true);

manager.minimize("code");
assert.ok(manager.getSlot("code"));
assert.strictEqual(manager.getSlot("code").state, "HIDDEN");

manager.close("code");
assert.deepStrictEqual(order(), ["TERMINAL", "BROWSER"]);
assert.strictEqual(manager.getSlot("code"), null);

manager.close("browser", {skipOperation: true});
assert.deepStrictEqual(order(), ["TERMINAL"]);

manager.focus("notes");
assert.deepStrictEqual(order(), ["NOTES", "TERMINAL"]);
assert.strictEqual(manager.getSlot("notes").state, "ACTIVE");

manager.synchronize("browser", {state: "ACTIVE", running: true});
assert.deepStrictEqual(order(), ["BROWSER", "NOTES", "TERMINAL"]);
assert.strictEqual(manager.getSlot("browser").state, "ACTIVE");

console.log("WorkspaceManager dynamic application transitions passed");
