const assert = require("assert");
const {runCli} = require("../src/cli/nomadCli.js");

function capture() {
    let value = "";
    return {stream: {write: chunk => { value += String(chunk); }}, value: () => value};
}

async function invoke(args, service, opts = {}) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(args, Object.assign({
        stdout: stdout.stream,
        stderr: stderr.stream,
        securityCliService: service
    }, opts));
    return {code, stdout: stdout.value(), stderr: stderr.value()};
}

async function run() {
    const calls = {plan: 0, enforce: 0, restore: 0, repairs: 0, systemVerify: 0};
    const plan = {
        selectedProfile: "NORMAL",
        targetProfile: "PUBLIC",
        status: "PLAN READY",
        safeToApply: true,
        dryRun: true,
        privilegedPending: true,
        sessionRestartRequired: true,
        firewall: {rules: "table inet nomad_security { comment \"PUBLIC\" }"},
        categories: [{
            id: "network", label: "FIREWALL / NETWORK", current: "NOT_APPLIED",
            desired: "PUBLIC", action: "APPLY_PUBLIC", privileged: true, available: false
        }]
    };
    const service = {
        plan: target => {
            calls.plan++;
            return Object.assign({}, plan, {targetProfile: target ? String(target).toUpperCase() : "PUBLIC"});
        },
        enforce: target => {
            calls.enforce++;
            return {
                ok: true,
                status: "PARTIAL - SYSTEM ENFORCEMENT PENDING",
                profile: target ? String(target).toUpperCase() : "PUBLIC",
                systemEnforcementPending: true,
                sessionRestartRequired: true
            };
        },
        verify: system => {
            if (system) calls.systemVerify++;
            return ({
            selectedProfile: "PUBLIC", desiredProfile: "PUBLIC", enforcedProfile: "PUBLIC",
            profileGates: true, firewallVerified: false, automount: "DISABLED",
            ephemeral: "PERSISTENT_SESSION", storage: {state: "VERIFIED"},
            firewall: {verificationResult: "NOT_APPLIED"}, sessionRestartRequired: true,
            systemEnforcementPending: true,
            systemVerification: system ? {
                ok: true, status: "NOMAD SYSTEM POLICY VERIFIED PARTIALLY", profile: "PUBLIC",
                firewall: "VERIFIED", storage: "PARTIAL"
            } : null
        });
        },
        restore: apply => {
            calls.restore++;
            return apply ? {ok: true, status: "NOMAD-OWNED CHANGES RESTORED", profile: "NORMAL", sessionRestartRequired: true}
                : {ok: true, applied: false, status: "PLAN_ONLY", actions: ["RESTORE NOMAD FIREWALL", "SELECT NORMAL"]};
        },
        permissions: () => ({
            findingCount: 1,
            resources: [{label: "SESSION ENV", actualMode: "0644", desiredMode: "0600", status: "MODE_CHANGE_REQUIRED"}]
        }),
        repairPermissions: apply => {
            calls.repairs++;
            return apply ? {ok: true, status: "PERMISSIONS VERIFIED", repaired: ["session_env"]}
                : {ok: true, status: "PLAN_ONLY", actions: [{label: "SESSION ENV", currentMode: "0644", desiredMode: "0600"}]};
        }
    };

    const planned = await invoke(["security", "plan", "public"], service);
    assert.strictEqual(planned.code, 0);
    assert(planned.stdout.includes("NOMAD SECURITY ENFORCEMENT PLAN"));
    assert(planned.stdout.includes("TRUSTED NFTABLES DRY RUN"));
    assert(planned.stdout.includes("PLAN ONLY"));
    assert.strictEqual(calls.enforce, 0);

    const dryEnforce = await invoke(["security", "enforce", "public"], service);
    assert.strictEqual(dryEnforce.code, 0);
    assert(dryEnforce.stdout.includes("RUN WITH --apply"));
    assert.strictEqual(calls.enforce, 0);

    const cancelled = await invoke(["security", "enforce", "public", "--apply"], service, {
        confirm: async () => false
    });
    assert.strictEqual(cancelled.code, 0);
    assert(cancelled.stdout.includes("ENFORCEMENT CANCELLED"));
    assert.strictEqual(calls.enforce, 0);

    const applied = await invoke(["security", "enforce", "public", "--apply"], service, {
        confirm: async () => true
    });
    assert.strictEqual(applied.code, 1, "partial system enforcement must have a non-zero result");
    assert(applied.stdout.includes("SYSTEM ENFORCEMENT PENDING"));
    assert(applied.stdout.includes("SESSION RESTART REQUIRED"));
    assert.strictEqual(calls.enforce, 1);

    const invalid = await invoke(["security", "enforce", "public;id"], service);
    assert.strictEqual(invalid.code, 2);
    assert(invalid.stderr.includes("USAGE: nomad security enforce"));

    const verified = await invoke(["security", "verify"], service);
    assert.strictEqual(verified.code, 1);
    assert(verified.stdout.includes("ENFORCED PROFILE"));
    assert(verified.stdout.includes("SYSTEM ENFORCEMENT PENDING"));
    assert.strictEqual(calls.systemVerify, 0, "default verification must never request privilege");

    const cancelledSystemVerify = await invoke(["security", "verify", "--system"], service, {
        confirm: async () => false
    });
    assert.strictEqual(cancelledSystemVerify.code, 0);
    assert(cancelledSystemVerify.stdout.includes("SYSTEM VERIFICATION CANCELLED"));
    assert.strictEqual(calls.systemVerify, 0);

    const systemVerified = await invoke(["security", "verify", "--system"], service, {
        confirm: async () => true
    });
    assert.strictEqual(systemVerified.code, 1, "partial storage enforcement must remain non-zero");
    assert(systemVerified.stdout.includes("NOMAD SYSTEM POLICY VERIFIED PARTIALLY"));
    assert.strictEqual(calls.systemVerify, 1);

    const restorePlan = await invoke(["security", "restore"], service);
    assert.strictEqual(restorePlan.code, 0);
    assert(restorePlan.stdout.includes("PLAN ONLY"));
    const restoreApply = await invoke(["security", "restore", "--apply"], service, {confirm: async () => true});
    assert.strictEqual(restoreApply.code, 0);
    assert(restoreApply.stdout.includes("NOMAD-OWNED CHANGES RESTORED"));

    const permissions = await invoke(["security", "permissions", "--verbose"], service);
    assert.strictEqual(permissions.code, 1);
    assert(permissions.stdout.includes("MODE_CHANGE_REQUIRED"));
    const repairPlan = await invoke(["security", "permissions", "repair"], service);
    assert.strictEqual(repairPlan.code, 0);
    assert(repairPlan.stdout.includes("PLAN ONLY"));
    const repairApply = await invoke(["security", "permissions", "repair", "--apply"], service, {confirm: async () => true});
    assert.strictEqual(repairApply.code, 0);
    assert(repairApply.stdout.includes("PERMISSIONS VERIFIED"));

    console.log("Security plan/enforce/verify/restore and permission plan/apply CLI confirmation and exit semantics passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
