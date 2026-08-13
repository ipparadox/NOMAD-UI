const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    SecurityEnforcementService,
    SecurityTransactionStore,
    parseEnforcementState
} = require("../src/classes/securityEnforcementService.js");
const {SECURITY_PROFILES} = require("../src/classes/securityProfileService.js");

function harness(opts = {}) {
    let profile = opts.profile || "NORMAL";
    let automount = opts.automount || "true";
    let firewallProfile = opts.firewallProfile || "NONE";
    let document = opts.document || null;
    const calls = {profiles: [], automount: [], helper: [], writes: 0, clears: 0};
    const profileService = {
        get: () => ({profile, source: "CONFIG", policy: SECURITY_PROFILES[profile]}),
        set: value => {
            const normalized = String(value).toUpperCase();
            if (!SECURITY_PROFILES[normalized]) throw new Error("invalid profile");
            profile = normalized;
            calls.profiles.push(normalized);
            return {profile, source: "CONFIG", policy: SECURITY_PROFILES[profile]};
        }
    };
    const firewallService = {
        plan: target => ({
            profile: target,
            operation: target === "NORMAL" ? "RESTORE_NOMAD_POLICY" : `APPLY_${target}`,
            backend: "NFTABLES_DEDICATED_TABLE",
            available: opts.firewallAvailable !== false,
            privileged: true,
            rules: target === "NORMAL" ? null : `table inet nomad_security { comment "${target}" }`,
            preservesUnrelatedPolicy: true
        }),
        inspect: target => ({
            backend: "NFTABLES",
            available: opts.firewallAvailable !== false,
            currentState: firewallProfile === "NONE" ? "INACTIVE" : "ACTIVE",
            nomadPolicyState: firewallProfile === "NONE" ? "NOT_APPLIED" : firewallProfile,
            verificationResult: firewallProfile === target ? "VERIFIED" : "NOT_APPLIED",
            enforcementBackend: opts.firewallAvailable === false ? "UNAVAILABLE" : "NFTABLES_DEDICATED_TABLE",
            ipv4: firewallProfile === target,
            ipv6: firewallProfile === target,
            compliant: target === "NORMAL" || firewallProfile === target
        })
    };
    const storageService = {
        inspect: verbose => Object.assign({
            state: opts.storageAmbiguous ? "AMBIGUOUS" : "VERIFIED",
            ambiguous: opts.storageAmbiguous === true,
            eligibleCount: opts.eligibleCount || 0,
            protectedCount: opts.protectedCount || 0,
            refusedCount: opts.refusedCount || 0,
            removableCount: 0,
            inventory: {}
        }, verbose ? {eligibleMounts: opts.eligibleCount ? ["/mnt/host"] : []} : {})
    };
    const pathPolicyService = {
        resolve: target => ({
            profile: target,
            ephemeral: target !== "NORMAL",
            volatileRuntimeVerified: opts.runtimeAvailable !== false,
            sessionRestartRequired: target !== "NORMAL",
            configRoot: "/config/nomad",
            persistentStateRoot: "/state/nomad"
        }),
        observe: target => ({
            actual: target === "NORMAL" ? "PERSISTENT_ALLOWED" : "PERSISTENT_SESSION",
            sessionRestartRequired: target !== "NORMAL"
        })
    };
    const automountController = {
        observe: () => ({available: true, value: automount, state: automount === "false" ? "DISABLED" : "ENABLED"}),
        disable: () => {
            calls.automount.push("disable");
            if (opts.automountFailure) return {ok: false, changed: false, previous: automount, status: "VERIFICATION_FAILED"};
            if (automount === "false") return {ok: true, changed: false, previous: "false", status: "ALREADY_DISABLED"};
            automount = "false";
            return {ok: true, changed: true, previous: "true", status: "DISABLED"};
        },
        restore: record => {
            calls.automount.push("restore");
            if (!record || !["true", "false"].includes(record.previous)) return {ok: false, status: "INVALID"};
            if (automount !== "false") return {ok: false, status: "STATE_CHANGED_EXTERNALLY"};
            automount = record.previous;
            return {ok: true, changed: true, status: "RESTORED"};
        }
    };
    const helperClient = {
        capability: () => ({
            installed: opts.helperAvailable === true,
            trusted: opts.helperAvailable === true,
            available: opts.helperAvailable === true,
            status: opts.helperAvailable === true ? "AVAILABLE" : "HELPER NOT INSTALLED"
        }),
        invoke: operation => {
            calls.helper.push(operation);
            if (opts.helperFailure && operation.startsWith("apply-")) return {ok: false, status: "MOCK APPLY FAILURE"};
            if (operation === "apply-public") firewallProfile = "PUBLIC";
            else if (operation === "apply-lockdown") firewallProfile = "LOCKDOWN";
            else if (operation === "restore") firewallProfile = "NONE";
            return {ok: true, status: "MOCK OK", profile: firewallProfile, firewall: "VERIFIED", storage: "PARTIAL"};
        }
    };
    const store = {
        read: () => document && JSON.parse(JSON.stringify(document)),
        write: value => {
            calls.writes++;
            if (opts.storeFailure || calls.writes === opts.storeFailureAt) throw new Error("mock store failure");
            document = JSON.parse(JSON.stringify(value));
            return document;
        },
        clear: () => {
            calls.clears++;
            document = null;
            return true;
        }
    };
    const service = new SecurityEnforcementService({
        profileService,
        firewallService,
        storageService,
        pathPolicyService,
        automountController,
        helperClient,
        store,
        now: () => new Date("2026-08-13T18:00:00.000Z")
    });
    return {
        service,
        calls,
        state: () => ({profile, automount, firewallProfile, document})
    };
}

const planned = harness({helperAvailable: false});
const planBefore = planned.state();
const publicPlan = planned.service.plan("PUBLIC", {verbose: true});
assert.strictEqual(publicPlan.dryRun, true);
assert.strictEqual(publicPlan.safeToApply, true);
assert.strictEqual(publicPlan.targetProfile, "PUBLIC");
assert.strictEqual(publicPlan.sessionRestartRequired, true);
assert.strictEqual(publicPlan.privilegedPending, true);
assert(publicPlan.firewall.rules.includes("nomad_security"));
assert.deepStrictEqual(planned.state(), planBefore, "security plan must be read-only");
assert.deepStrictEqual(planned.calls, {profiles: [], automount: [], helper: [], writes: 0, clears: 0});

assert.strictEqual(planned.service.apply("PUBLIC", {authorized: false}).status, "EXPLICIT AUTHORIZATION REQUIRED");
assert.deepStrictEqual(planned.state(), planBefore);

const partial = harness({helperAvailable: false});
const partialResult = partial.service.apply("PUBLIC", {authorized: true});
assert.strictEqual(partialResult.ok, true);
assert.strictEqual(partialResult.systemEnforcementPending, true);
assert.strictEqual(partialResult.sessionRestartRequired, true);
assert.strictEqual(partial.state().profile, "PUBLIC");
assert.strictEqual(partial.state().automount, "false");
assert.strictEqual(partial.state().document.originalProfile, "NORMAL");
assert.strictEqual(partial.state().document.enforcedProfile, "PUBLIC");
assert.strictEqual(partial.state().document.automount.owned, true);
const restored = partial.service.restore({apply: true, authorized: true, targetProfile: "NORMAL"});
assert.strictEqual(restored.ok, true);
assert.strictEqual(partial.state().profile, "NORMAL");
assert.strictEqual(partial.state().automount, "true");
assert.strictEqual(partial.state().document, null);

const unjournaledFirewall = harness({firewallProfile: "PUBLIC"});
const unjournaledRestore = unjournaledFirewall.service.restore({apply: true, authorized: true, targetProfile: "NORMAL"});
assert.strictEqual(unjournaledRestore.ok, false);
assert.strictEqual(unjournaledRestore.status, "RESTORE PARTIAL - UNJOURNALED NOMAD FIREWALL REMAINS");
assert.strictEqual(unjournaledRestore.systemEnforcementPending, true);

const ambiguous = harness({helperAvailable: true, storageAmbiguous: true});
const ambiguousPlan = ambiguous.service.plan("LOCKDOWN");
assert.strictEqual(ambiguousPlan.safeToApply, false);
const ambiguousApply = ambiguous.service.apply("LOCKDOWN", {authorized: true});
assert.strictEqual(ambiguousApply.applied, false);
assert.strictEqual(ambiguous.state().profile, "NORMAL");
assert.strictEqual(ambiguous.calls.helper.length, 0);

const helperFailure = harness({helperAvailable: true, helperFailure: true});
const failed = helperFailure.service.apply("LOCKDOWN", {authorized: true});
assert.strictEqual(failed.ok, false);
assert.strictEqual(failed.status, "APPLY FAILED - NOMAD CHANGES ROLLED BACK");
assert.strictEqual(helperFailure.state().profile, "NORMAL");
assert.strictEqual(helperFailure.state().automount, "true");
assert.strictEqual(helperFailure.state().document, null);
assert.deepStrictEqual(helperFailure.calls.profiles, ["LOCKDOWN", "NORMAL"]);

const externalAutomountChange = harness({
    helperAvailable: true,
    profile: "PUBLIC",
    automount: "true",
    document: {
        version: 1,
        phase: "APPLIED",
        originalProfile: "NORMAL",
        enforcedProfile: "PUBLIC",
        updatedAt: "2026-08-13T18:00:00.000Z",
        automount: {owned: true, pending: false, previous: "true"},
        helper: {owned: true, pending: false, profile: "PUBLIC"},
        sessionRestartRequired: true
    }
});
const externalAutomountResult = externalAutomountChange.service.apply("LOCKDOWN", {authorized: true});
assert.strictEqual(externalAutomountResult.ok, false);
assert(externalAutomountResult.failure.includes("AUTOMOUNT STATE CHANGED EXTERNALLY"));
assert.strictEqual(externalAutomountChange.state().profile, "PUBLIC");
assert.strictEqual(externalAutomountChange.calls.helper.length, 0,
    "an externally changed owned setting must fail before privileged transition");

const storeFailure = harness({helperAvailable: true, storeFailure: true});
const storeFailed = storeFailure.service.apply("PUBLIC", {authorized: true});
assert.strictEqual(storeFailed.ok, false);
assert.strictEqual(storeFailure.calls.helper.length, 0,
    "a transaction journal failure before mutation must prevent helper execution");
assert.strictEqual(storeFailure.state().profile, "NORMAL");
assert.strictEqual(storeFailure.state().automount, "true");

const lateStoreFailure = harness({helperAvailable: true, storeFailureAt: 5});
const lateStoreFailed = lateStoreFailure.service.apply("PUBLIC", {authorized: true});
assert.strictEqual(lateStoreFailed.ok, false);
assert(lateStoreFailure.calls.helper.includes("apply-public"));
assert(lateStoreFailure.calls.helper.includes("restore"),
    "successful helper changes must be rolled back after a later journal failure");
assert.strictEqual(lateStoreFailure.state().profile, "NORMAL");
assert.strictEqual(lateStoreFailure.state().automount, "true");

const complete = harness({helperAvailable: true});
const completeResult = complete.service.apply("PUBLIC", {authorized: true});
assert.strictEqual(completeResult.ok, true);
assert.strictEqual(completeResult.verification.firewallVerified, true);
assert.strictEqual(completeResult.verification.helperOwned, true);
assert.strictEqual(completeResult.verification.sessionRestartRequired, true);
assert.strictEqual(completeResult.verification.systemEnforcementPending, true,
    "mount removal alone cannot verify prevention of manual remounts");
assert.strictEqual(completeResult.verification.systemVerification.firewall, "VERIFIED",
    "apply must retain the helper's immediate privileged verification result");
const privilegedVerification = complete.service.verify({systemAuthorized: true});
assert.strictEqual(privilegedVerification.systemVerification.firewall, "VERIFIED");
assert(complete.calls.helper.includes("status"), "explicit system verification must use only the named status operation");
const lockdownTransition = complete.service.apply("LOCKDOWN", {authorized: true});
assert.strictEqual(lockdownTransition.ok, true);
assert.strictEqual(complete.state().document.originalProfile, "NORMAL", "transition must preserve the original rollback profile");
assert.strictEqual(complete.state().document.enforcedProfile, "LOCKDOWN");
assert.strictEqual(complete.calls.automount.filter(call => call === "disable").length, 1,
    "an already NOMAD-owned setting must not be captured again");

assert.throws(() => complete.service.plan("public; rm -rf /"), /SECURITY PROFILE INVALID/);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-enforcement-store-"));
try {
    const configBase = path.join(temporaryRoot, "config");
    const configRoot = path.join(configBase, "nomad");
    const storePath = path.join(configRoot, "enforcement-state.json");
    fs.mkdirSync(configBase, {recursive: true, mode: 0o700});
    fs.chmodSync(configBase, 0o700);
    const store = new SecurityTransactionStore({storePath});
    assert.strictEqual(store.inspect().safe, true);
    const document = {
        version: 1,
        phase: "APPLIED",
        originalProfile: "NORMAL",
        enforcedProfile: "PUBLIC",
        updatedAt: "2026-08-13T18:00:00.000Z",
        automount: {owned: true, pending: false, previous: "true"},
        helper: {owned: true, pending: false, profile: "PUBLIC"},
        sessionRestartRequired: true
    };
    store.write(document);
    assert.deepStrictEqual(store.read(), document);
    assert.strictEqual(fs.statSync(storePath).mode & 0o777, 0o600);
    store.write(Object.assign({}, document, {phase: "APPLYING"}));
    assert.strictEqual(store.inspect().safe, false);
    assert(store.inspect().status.includes("INCOMPLETE"));
    store.clear();

    const victim = path.join(temporaryRoot, "victim.json");
    fs.writeFileSync(victim, "{}\n", {mode: 0o600});
    fs.symlinkSync(victim, storePath);
    assert.throws(() => store.read(), /STATE REFUSED/);
    fs.unlinkSync(storePath);
    fs.writeFileSync(storePath, `${JSON.stringify(document)}\n`, {mode: 0o600});
    fs.linkSync(storePath, path.join(configRoot, "unexpected-hardlink.json"));
    assert.throws(() => store.read(), /STATE REFUSED/);

    const legacy = Object.assign({}, document);
    delete legacy.phase;
    delete legacy.automount.pending;
    delete legacy.helper.pending;
    assert.strictEqual(parseEnforcementState(JSON.stringify(legacy)).phase, "APPLIED",
        "existing V0.6 state remains readable without weakening pending-state semantics");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}

console.log("Read-only plans, explicit apply authority, enum validation, partial enforcement, ambiguity refusal, rollback, transitions, and restart truthfulness passed");
