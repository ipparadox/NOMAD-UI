const assert = require("assert");
const {
    HelperRuntime,
    MARKER,
    OPERATIONS,
    classifyMounts,
    main,
    renderRules,
    verifyRules
} = require("../src/security-helper/nomad-security-helper.js");
const {renderNftRules} = require("../src/classes/securityFirewallService.js");

assert.deepStrictEqual(Array.from(OPERATIONS).sort(), [
    "apply-lockdown", "apply-public", "restore", "status", "verify-firewall", "verify-storage"
]);
let executed = 0;
const fakeRuntime = {
    execute: operation => {
        executed++;
        return {ok: true, status: operation, profile: "NONE", firewall: "NOT_APPLIED", storage: "NOT_APPLIED"};
    }
};
assert.strictEqual(main(["exec", "id"], fakeRuntime).exitCode, 2);
assert.strictEqual(main(["apply-public", "extra"], fakeRuntime).exitCode, 2);
assert.strictEqual(main(["apply-PUBLIC"], fakeRuntime).exitCode, 2);
assert.strictEqual(executed, 0, "invalid argument shapes must never reach the helper runtime");
assert.strictEqual(main(["apply-public"], fakeRuntime).exitCode, 0);
assert.strictEqual(executed, 1);

const publicRules = renderRules("PUBLIC");
const lockdownRules = renderRules("LOCKDOWN");
assert.strictEqual(verifyRules(publicRules, "PUBLIC"), true);
assert.strictEqual(verifyRules(lockdownRules, "LOCKDOWN"), true);
assert.strictEqual(verifyRules(lockdownRules.replace(
    "oifname \"lo\" accept", "oifname \"lo\" accept\n            accept"
), "LOCKDOWN"), false);
assert.strictEqual(publicRules, renderNftRules("PUBLIC"), "CLI and helper PUBLIC templates must remain identical");
assert.strictEqual(lockdownRules, renderNftRules("LOCKDOWN"), "CLI and helper LOCKDOWN templates must remain identical");
assert.strictEqual(renderRules("PUBLIC; arbitrary"), null);
assert(!publicRules.includes("flush ruleset"));
assert(!lockdownRules.includes("flush ruleset"));
assert(publicRules.includes("table inet nomad_security"));
assert(lockdownRules.includes("policy drop"));

class FirewallObservationRuntime extends HelperRuntime {
    constructor(content) {
        super({uid: 0});
        this.content = content;
    }
    _tool(name) { return name === "nft" ? "/usr/sbin/nft" : null; }
    _run(executable, args) {
        if (args.join(" ") === "list tables") return {status: 0, stdout: "table inet nomad_security\n"};
        if (args.join(" ") === "list table inet nomad_security") return {status: 0, stdout: this.content};
        return {status: 1, stdout: ""};
    }
}
assert.strictEqual(new FirewallObservationRuntime(publicRules)._currentFirewall().owned, true);
assert.strictEqual(new FirewallObservationRuntime(
    `table inet nomad_security { comment "${MARKER}; NOMAD-UI PROFILE PUBLIC" }`
)._currentFirewall().owned, false, "a marker alone must never authorize replacement of a corrupted or unrelated table");

let spawnCount = 0;
const unprivileged = new HelperRuntime({
    uid: 1000,
    spawnSync: () => { spawnCount++; return {status: 0}; }
});
const refused = unprivileged.execute("apply-public");
assert.strictEqual(refused.ok, false);
assert.strictEqual(refused.status, "ROOT EXECUTION REQUIRED");
assert.strictEqual(spawnCount, 0);
assert.strictEqual(unprivileged.execute("exec").status, "INVALID OPERATION");

const mounts = [
    {majorMinor: "8:2", mountPoint: "/", source: "/dev/sda2", fsType: "ext4"},
    {majorMinor: "8:17", mountPoint: "/mnt/host", source: "/dev/sdb1", fsType: "ext4"},
    {majorMinor: "8:33", mountPoint: "/mnt/nomad", source: "/dev/sdc1", fsType: "ext4"},
    {majorMinor: "8:49", mountPoint: "/mnt/repositories", source: "/dev/sdd1", fsType: "ext4"}
];
const devices = [
    {majorMinor: "8:2", devicePath: "/dev/sda2", rootRemovable: false},
    {majorMinor: "8:17", devicePath: "/dev/sdb1", rootRemovable: false},
    {majorMinor: "8:33", devicePath: "/dev/sdc1", rootRemovable: false},
    {majorMinor: "8:49", devicePath: "/dev/sdd1", rootRemovable: false}
];
const storage = classifyMounts(mounts, devices, {
    nomadRoot: "/mnt/nomad/NOMAD-UI",
    repositoryRoots: ["/mnt/repositories"],
    persistentPaths: ["/mnt/nomad/config"],
    allowedUnmountRoots: ["/media", "/mnt", "/run/media"]
});
assert.strictEqual(storage.ambiguous, false);
assert.deepStrictEqual(storage.eligible.map(item => item.mountPoint), ["/mnt/host"]);
assert(storage.protected.some(item => item.mountPoint === "/"));
assert(storage.protected.some(item => item.mountPoint === "/mnt/nomad"));
assert(storage.protected.some(item => item.mountPoint === "/mnt/repositories"));

const source = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "security-helper", "nomad-security-helper.js"), "utf8");
assert(!source.includes("shell: true"));
assert(!source.includes("execSync("));
assert(!source.includes("execFileSync("));
assert(!source.includes("process.argv.slice(3)"));

class MockApplyRuntime extends HelperRuntime {
    constructor(options = {}) {
        super({uid: 0, spawnSync: () => { throw new Error("unexpected external command"); }});
        this.options = options;
        this.journal = [];
        this.restoredFirewall = null;
        this.cleared = false;
    }
    _readConfig() { return {version: 1}; }
    _storageInventory() {
        return {available: true, ambiguous: false, eligible: [], protected: [], refused: []};
    }
    _currentFirewall() {
        return this.options.currentFirewall || {
            available: true, ambiguous: false, present: false, owned: false, profile: null, content: ""
        };
    }
    _readState() {
        if (this.options.corruptState) throw new Error("corrupt state");
        return this.options.state || null;
    }
    _writeState(document) { this.journal.push(JSON.parse(JSON.stringify(document))); }
    _applyFirewall() { return {ok: true, status: "APPLIED"}; }
    _verifyFirewall(profile) {
        return {ok: true, status: "VERIFIED", profile, firewall: "VERIFIED", storage: "NOT_APPLIED"};
    }
    _restoreMounts() { return true; }
    _restoreFirewallProfile(profile) { this.restoredFirewall = profile; return true; }
    _clearState() { this.cleared = true; return true; }
    _clearStateIfPresent() { this.cleared = true; return true; }
}

const journaled = new MockApplyRuntime();
const journaledResult = journaled.execute("apply-public");
assert.strictEqual(journaledResult.ok, true);
assert.strictEqual(journaled.journal[0].phase, "APPLYING", "helper intent must be durable before policy mutation");
assert.strictEqual(journaled.journal[journaled.journal.length - 1].phase, "APPLIED");

const statusRuntime = new MockApplyRuntime({
    state: {
        version: 3,
        profile: "PUBLIC",
        originalFirewallProfile: null,
        previousFirewallProfile: null,
        phase: "APPLIED",
        mounts: [],
        pendingMount: null
    },
    currentFirewall: {available: true, ambiguous: false, present: true, owned: true, profile: "PUBLIC", content: ""}
});
const statusResult = statusRuntime.execute("status");
assert.strictEqual(statusResult.ok, true);
assert.strictEqual(statusResult.firewall, "VERIFIED");
assert.strictEqual(statusResult.storage, "PARTIAL",
    "storage verification must remain partial when manual remount prevention is not guaranteed");

const corrupt = new MockApplyRuntime({corruptState: true});
const corruptResult = corrupt.execute("apply-lockdown");
assert.strictEqual(corruptResult.ok, false);
assert.strictEqual(corruptResult.status, "HELPER STATE OR CONFIGURATION REFUSED");
assert.strictEqual(corrupt.journal.length, 0, "corrupt helper state must fail before any mutation");

const ambiguousFirewall = new MockApplyRuntime({
    currentFirewall: {available: true, ambiguous: true, present: false, owned: false, profile: null, content: ""}
});
assert.strictEqual(ambiguousFirewall.execute("apply-public").ok, false);
assert.strictEqual(ambiguousFirewall.journal.length, 0);

const restoreState = {
    version: 3,
    profile: "LOCKDOWN",
    originalFirewallProfile: "PUBLIC",
    previousFirewallProfile: "PUBLIC",
    phase: "APPLIED",
    mounts: [],
    pendingMount: null
};
const exactRestore = new MockApplyRuntime({
    state: restoreState,
    currentFirewall: {available: true, ambiguous: false, present: true, owned: true, profile: "LOCKDOWN", content: ""}
});
const exactRestoreResult = exactRestore.execute("restore");
assert.strictEqual(exactRestoreResult.ok, true);
assert.strictEqual(exactRestore.restoredFirewall, "PUBLIC", "restore must recover the exact prior NOMAD firewall profile");
assert.strictEqual(exactRestore.cleared, true);

const interruptedTransition = new MockApplyRuntime({
    state: {
        version: 3,
        profile: "LOCKDOWN",
        originalFirewallProfile: null,
        previousFirewallProfile: "PUBLIC",
        phase: "APPLYING",
        mounts: [],
        pendingMount: null
    },
    currentFirewall: {available: true, ambiguous: false, present: true, owned: true, profile: "PUBLIC", content: ""}
});
const interruptedRestore = interruptedTransition.execute("restore");
assert.strictEqual(interruptedRestore.ok, true,
    "a crash before a PUBLIC to LOCKDOWN firewall mutation must remain restorable");
assert.strictEqual(interruptedTransition.restoredFirewall, null);

console.log("Enum-only helper surface, root requirement, durable fail-closed journals, exact restore, trusted nft templates, protected storage selection, and non-shell execution passed");
