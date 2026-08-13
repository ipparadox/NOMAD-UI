const assert = require("assert");
const {runCli} = require("../src/cli/nomadCli.js");

function capture() {
    let value = "";
    return {
        stream: {write: chunk => { value += String(chunk); }},
        value: () => value
    };
}

async function invoke(args, securityCliService) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(args, {stdout: stdout.stream, stderr: stderr.stream, securityCliService});
    return {code, stdout: stdout.value(), stderr: stderr.value()};
}

async function run() {
    const profileChanges = [];
    const checks = [
        {id: "repository_execution", label: "REPOSITORY EXECUTION", actual: "CONTROLLED", state: "PARTIAL", detail: "EXACT AUTHORIZATION REQUIRED"},
        {id: "repository_isolation", label: "REPOSITORY ISOLATION", actual: "NONE", state: "INSECURE", detail: "DIRECT EXECUTION FALLBACK"},
        {id: "firewall", label: "FIREWALL", actual: "NOT_CONFIGURED", state: "INSECURE", detail: "NO ACTIVE POLICY"},
        {id: "host_storage", label: "HOST STORAGE", actual: "ACCESSIBLE", state: "INSECURE", detail: "INTERNAL STORAGE DETECTED"},
        {id: "automount", label: "AUTOMOUNT", actual: "ENABLED", state: "INSECURE", detail: "GNOME AUTOMOUNT ENABLED"},
        {id: "disk_encryption", label: "DISK ENCRYPTION", actual: "NOT_VERIFIED", state: "INSECURE", detail: "ROOT ENCRYPTION NOT VERIFIED"},
        {id: "swap", label: "SWAP", actual: "ACTIVE", state: "INSECURE", detail: "PERSISTENCE POSSIBLE"},
        {id: "secure_boot", label: "SECURE BOOT", actual: "UNKNOWN", state: "UNKNOWN", detail: "NOT VERIFIED"},
        {id: "session_type", label: "SESSION TYPE", actual: "NOMAD_X11", state: "SECURE", detail: "DEDICATED SESSION"},
        {id: "debug_devtools", label: "DEBUG / DEVTOOLS", actual: "RESTRICTED", state: "SECURE", detail: "PRODUCTION MODE"}
    ];
    const securityCliService = {
        status: verbose => Object.assign({
            version: 1,
            generatedAt: "2026-08-13T12:00:00.000Z",
            profile: {id: "PUBLIC", source: "CONFIG", compliance: "NON_COMPLIANT", systemEnforcementPending: true},
            checks
        }, verbose ? {
            policy: [{
                id: "host_storage", label: "HOST STORAGE", desired: "BLOCKED", actual: "ACCESSIBLE",
                compliant: false, enforceable: "NO", reason: "SYSTEM ENFORCEMENT PENDING"
            }],
            findings: [],
            capabilities: {maximumLevel: "NONE", preferredBackend: "DIRECT", backends: []}
        } : {}),
        audit: () => ({
            version: 1,
            profile: {id: "PUBLIC"},
            findings: [{
                severity: "HIGH", id: "host_storage", label: "HOST STORAGE",
                detail: "INTERNAL FILESYSTEM ACCESSIBLE", remediation: "SYSTEM ENFORCEMENT PENDING"
            }]
        }),
        profile: () => ({
            profile: "PUBLIC", source: "CONFIG", compliance: "NON_COMPLIANT", systemEnforcementPending: true
        }),
        listProfiles: () => [
            {id: "NORMAL", repositoryExecution: "CONTROLLED", minimumRepositoryIsolation: "NONE", hostStorageAccess: "OS_POLICY", networkPolicy: "OS_POLICY"},
            {id: "PUBLIC", repositoryExecution: "CONTROLLED", minimumRepositoryIsolation: "PARTIAL", hostStorageAccess: "BLOCKED", networkPolicy: "OS_POLICY"},
            {id: "LOCKDOWN", repositoryExecution: "DISABLED", minimumRepositoryIsolation: "STRONG", hostStorageAccess: "BLOCKED", networkPolicy: "RESTRICTED"}
        ],
        setProfile: profile => {
            profileChanges.push(profile);
            return {profile: profile.toUpperCase(), compliance: "NON_COMPLIANT", systemEnforcementPending: true};
        }
    };

    const status = await invoke(["security", "status"], securityCliService);
    assert.strictEqual(status.code, 0);
    assert(status.stdout.includes("NOMAD SECURITY STATUS"));
    assert(status.stdout.includes("PROFILE"));
    assert(status.stdout.includes("PUBLIC"));
    assert(status.stdout.includes("REPOSITORY ISOLATION"));
    assert(status.stdout.includes("NONE"));
    assert(status.stdout.includes("HOST STORAGE"));
    assert(status.stdout.includes("ACCESSIBLE"));
    assert(status.stdout.includes("SYSTEM ENFORCEMENT PENDING"));

    const verbose = await invoke(["security", "status", "--verbose"], securityCliService);
    assert.strictEqual(verbose.code, 0);
    assert(verbose.stdout.includes("OBSERVED CHECKS"));
    assert(verbose.stdout.includes("PROFILE POLICY"));
    assert(verbose.stdout.includes("ISOLATION BACKEND: DIRECT"));

    const audit = await invoke(["security", "audit"], securityCliService);
    assert.strictEqual(audit.code, 0);
    assert(audit.stdout.includes("NOMAD SECURITY AUDIT"));
    assert(audit.stdout.includes("HIGH"));
    assert(audit.stdout.includes("INTERNAL FILESYSTEM ACCESSIBLE"));

    const profile = await invoke(["security", "profile"], securityCliService);
    assert.strictEqual(profile.code, 0);
    assert(profile.stdout.includes("PROFILE: PUBLIC"));
    assert(profile.stdout.includes("COMPLIANCE: NON_COMPLIANT"));

    const listed = await invoke(["security", "profile", "list"], securityCliService);
    assert.strictEqual(listed.code, 0);
    assert(listed.stdout.includes("NORMAL"));
    assert(listed.stdout.includes("PUBLIC"));
    assert(listed.stdout.includes("LOCKDOWN"));
    assert(listed.stdout.includes("DISABLED"));

    const changed = await invoke(["security", "profile", "set", "lockdown"], securityCliService);
    assert.strictEqual(changed.code, 0);
    assert(changed.stdout.includes("PROFILE CHANGED"));
    assert(changed.stdout.includes("PROFILE: LOCKDOWN"));
    assert(changed.stdout.includes("SYSTEM ENFORCEMENT PENDING"));
    assert.deepStrictEqual(profileChanges, ["lockdown"]);

    const invalid = await invoke(["security", "status", "--json"], securityCliService);
    assert.strictEqual(invalid.code, 2);
    assert(invalid.stderr.includes("USAGE: nomad security status"));

    console.log("NOMAD security status, audit, profile display/list/set, and pending-enforcement CLI output passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
