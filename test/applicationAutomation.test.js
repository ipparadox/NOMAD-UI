"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {ApplicationAutomationService} = require("../src/classes/applicationAutomationService.js");
const {ApplicationService} = require("../src/cli/applicationService.js");
const {ApplicationRegistry} = require("../src/classes/applicationRegistry.js");
const {DesktopEntryDiscovery} = require("../src/classes/desktopEntryDiscovery.js");
const {ControlPlaneService} = require("../src/classes/controlPlaneService.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-app-automation-"));
const directory = path.join(root, "applications");
fs.mkdirSync(directory);
const registryPath = path.join(root, "config", "applications.json");
const discovery = new DesktopEntryDiscovery({directories: [directory]});
function desktop(id, wm = "ExampleWindow") {
    fs.writeFileSync(path.join(directory, `${id}.desktop`), `[Desktop Entry]\nType=Application\nName=${id}\nExec=/usr/bin/true\n${wm ? `StartupWMClass=${wm}\n` : ""}`, {mode: 0o644});
}
const service = new ApplicationService({registryPath, discovery, executableExists: () => true});
const registry = new ApplicationRegistry({registryPath, discovery, executableExists: () => true});
registry.reload();
let profile = "NORMAL";
let reloads = 0;
let learning = 0;
const automation = new ApplicationAutomationService({applicationService: service, applicationRegistry: registry, getSecurityProfile: () => profile, onChanged: () => reloads++, learner: {learn: async () => { learning++; throw new Error("AMBIGUOUS"); }}});
let count = 0;
async function main() {
    desktop("example");
    assert(automation.scan().applications.some(a => a.id === "example"));
    assert(!registry.get("example")); count++;
    const plan = automation.plan("example");
    assert(plan.confirmation); assert(plan.confirmation.effects.includes("USE VERIFIED STARTUP WM CLASS"));
    assert(!JSON.stringify(plan.confirmation).includes("/usr/bin")); count++;
    const registered = await automation.register("example", plan.stored);
    assert(registered.ok); assert.strictEqual(learning, 0); assert(registry.get("example").available);
    assert(reloads > 0); assert.strictEqual(fs.statSync(registryPath).mode & 0o777, 0o600); count++;
    assert(!automation.scan().applications.some(a => a.id === "example")); count++;
    desktop("changed"); const changed = automation.plan("changed"); desktop("changed", "Different");
    assert.strictEqual((await automation.register("changed", changed.stored)).ok, false); assert(!registry.get("changed")); count++;
    desktop("profile-change"); const normal = automation.plan("profile-change"); profile = "PUBLIC";
    assert.strictEqual((await automation.register("profile-change", normal.stored)).ok, false); count++;
    profile = "LOCKDOWN"; assert.strictEqual(automation.plan("example").ok, false);
    assert.strictEqual((await automation.complete(registered)).ok, false); count++;
    profile = "NORMAL"; desktop("unidentified", ""); const needs = automation.plan("unidentified");
    assert(needs.confirmation.effects.some(e => e.includes("LEARN")));
    const ambiguous = await automation.register("unidentified", needs.stored);
    assert.strictEqual(ambiguous.ok, false); assert.strictEqual(learning, 1);
    assert.strictEqual(registry.get("unidentified").available, false); assert(ambiguous.status.includes("INCOMPLETE")); count++;
    // Retry automatically uses the existing safe learner target and persists exact matchers.
    automation.learner = {learn: async id => {
        learning++;
        const target = service.prepareWindowClassLearning(id);
        return service.storeLearnedWindowMatcher(target, {className: "ExactClass", instance: "exact-instance"});
    }};
    const retry = automation.plan("unidentified"); const learned = await automation.register("unidentified", retry.stored);
    assert(learned.ok); assert(registry.get("unidentified").available); count++;
    desktop("ignored"); automation.ignore("ignored"); assert(!automation.scan().applications.some(a => a.id === "ignored")); count++;
    assert.strictEqual(automation.trustedInstalledCandidate(service.findCandidate("example")), false, "user desktop entries must not auto-register as trusted catalog installs"); count++;
    let reconciled = 0;
    const installer = {definition: () => ({id: "example"}), registerInstalled: () => { reconciled++; return registered; }};
    service.findInstalledCandidate = () => service.findCandidate("example");
    assert.strictEqual((await automation.installed("example", installer)).ok, false); assert.strictEqual(reconciled, 0); count++;
    automation.trustedInstalledCandidate = () => "/usr/bin/true";
    const reconcile = service.reconcileInstalledCandidate.bind(service);
    service.reconcileInstalledCandidate = (...args) => { reconciled++; return reconcile(...args); };
    assert((await automation.installed("example", installer)).ok); assert.strictEqual(reconciled, 1); count++;
    // Registry modifications made outside the process are picked up without a restart.
    const before = reloads; automation.start(); desktop("external"); service.add("external");
    await new Promise(resolve => setTimeout(resolve, 650));
    assert(reloads > before); assert(registry.get("external")); automation.stop(); count++;
    const outside = path.join(root, "outside.desktop"); fs.writeFileSync(outside, "[Desktop Entry]\nType=Application\nName=Escape\nExec=/usr/bin/true\n");
    fs.symlinkSync(outside, path.join(directory, "escape.desktop")); assert.strictEqual(discovery.findById("escape.desktop"), null); count++;
    desktop("writable"); fs.chmodSync(path.join(directory, "writable.desktop"), 0o666);
    assert.strictEqual(discovery.findById("writable.desktop"), null); count++;
    const control = new ControlPlaneService({profileService: {get: () => ({profile})}, applicationAutomation: automation,
        installService: {plan: () => ({displayName: "Example", package: "example", source: "APT"}), apply: async () => {}, registerInstalled: () => null},
        applicationRegistry: registry});
    const install = await control.request({actionId: "APPLICATION_INSTALL", targetId: "example"});
    assert(install.confirmationRequired);
    profile = "LOCKDOWN"; assert.strictEqual((await control.confirm({challengeId: install.challengeId})).ok, false);
    assert.strictEqual((await control.request({actionId: "APPLICATION_INSTALL", targetId: "example"})).ok, false); count++;
    profile = "NORMAL";
    control.applicationAutomation = null;
    const incomplete = await control.request({actionId: "APPLICATION_INSTALL", targetId: "example"});
    const result = await control.confirm({challengeId: incomplete.challengeId});
    assert.strictEqual(result.ok, false); assert.strictEqual(result.status, "INSTALLATION SUCCESS / NOMAD REGISTRATION INCOMPLETE"); count++;
    console.log(`${count} application automation, identity, discovery, live reload and profile checks passed`);
}
main().finally(() => { automation.stop(); fs.rmSync(root, {recursive: true, force: true}); }).catch(error => {console.error(error); process.exitCode = 1;});
