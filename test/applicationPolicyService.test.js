const assert = require("assert");
const {ApplicationPolicyService} = require("../src/classes/applicationPolicyService.js");
const {ApplicationRegistry, handleApplicationRegistryRequest} = require("../src/classes/applicationRegistry.js");
const {I3WindowManager} = require("../src/classes/i3WindowManager.class.js");
const {MANAGED_APPLICATIONS} = require("../src/classes/managedApplications.js");

let profile = "NORMAL";
let externalCount = 0;
const policy = new ApplicationPolicyService({
    getSecurityProfile: () => profile,
    getRunningExternalCount: () => externalCount
});
const terminal = MANAGED_APPLICATIONS.find(application => application.id === "terminal");
const browser = MANAGED_APPLICATIONS.find(application => application.id === "browser");

assert.strictEqual(policy.evaluate(browser, "NORMAL").allowed, true);
assert.strictEqual(policy.status("NORMAL").actual, "CONTROLLED_REGISTRY");
assert.strictEqual(policy.status("NORMAL").compliant, true);

const publicBrowser = policy.evaluate(browser, "PUBLIC");
assert.strictEqual(publicBrowser.allowed, true);
assert.strictEqual(publicBrowser.isolation, "CONTROLLED_NO_STRONG_SANDBOX");
assert.strictEqual(policy.status("PUBLIC").state, "PARTIAL");
assert(policy.status("PUBLIC").detail.includes("X11/DBUS/HOME"));

assert.strictEqual(policy.evaluate(terminal, "LOCKDOWN").allowed, true);
assert.strictEqual(policy.evaluate(browser, "LOCKDOWN").allowed, false);
assert.strictEqual(policy.evaluate({id: "vlc", type: "external"}, "LOCKDOWN").allowed, false);
assert.strictEqual(policy.evaluate({id: "terminal", type: "external"}, "LOCKDOWN").allowed, false,
    "a renderer-provided ID cannot spoof built-in type");
externalCount = 1;
assert.strictEqual(policy.status("LOCKDOWN").actual, "EXTERNAL_PROCESS_ACTIVE");
assert.strictEqual(policy.status("LOCKDOWN").compliant, false);
externalCount = 0;
assert.strictEqual(policy.status("LOCKDOWN").actual, "BUILTIN_ONLY");
assert.strictEqual(policy.status("LOCKDOWN").compliant, true);

profile = "LOCKDOWN";
const registry = new ApplicationRegistry({
    builtIns: MANAGED_APPLICATIONS,
    protectedIds: MANAGED_APPLICATIONS.map(application => application.id),
    executableExists: () => true,
    registryPath: "/definitely/not/present/apps.json"
});
registry.reload();
const projected = handleApplicationRegistryRequest(registry, null, {operation: "get"}, policy);
assert.strictEqual(projected.ok, true);
assert.strictEqual(projected.applications.find(application => application.id === "terminal").available, true);
assert.strictEqual(projected.applications.find(application => application.id === "browser").available, false);
assert.strictEqual(projected.applications.find(application => application.id === "browser").status, "BLOCKED BY LOCKDOWN");

const spawnCalls = [];
const manager = new I3WindowManager({
    applications: MANAGED_APPLICATIONS,
    applicationPolicy: policy,
    spawn: (executable, args, options) => {
        spawnCalls.push({executable, args, options});
        throw new Error("must not spawn in lockdown");
    }
});
manager.available = true;

(async () => {
    const blocked = await manager.operate("launch", "browser", {x: 0, y: 0, width: 800, height: 600});
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.status, "BLOCKED BY LOCKDOWN");
    assert.strictEqual(spawnCalls.length, 0);
    assert.strictEqual(manager.getRunningExternalCount(), 0);
    manager.processes.browser = {};
    assert.strictEqual(manager.getRunningExternalCount(), 1);
    assert.strictEqual(policy.status("LOCKDOWN").existingExternalCount, 0,
        "policy reports only the authoritative callback it was configured with");

    profile = "NORMAL";
    assert.strictEqual(policy.evaluate(browser).allowed, true);
    const normalProjection = policy.projectAll(registry.getApplications());
    assert.strictEqual(normalProjection.find(application => application.id === "browser").available, true);

    console.log("NORMAL/PUBLIC application truthfulness, LOCKDOWN main-side built-in gate, spoof refusal, and existing-process reporting passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
