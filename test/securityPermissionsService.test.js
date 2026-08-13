const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {SecurityPermissionsService} = require("../src/classes/securityPermissionsService.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-permissions-"));
try {
    const configRoot = path.join(temporaryRoot, "config", "nomad");
    const stateRoot = path.join(temporaryRoot, "state", "nomad");
    const repositoryRoot = path.join(temporaryRoot, "Repositories");
    fs.mkdirSync(configRoot, {recursive: true, mode: 0o700});
    fs.mkdirSync(stateRoot, {recursive: true, mode: 0o700});
    fs.mkdirSync(repositoryRoot, {recursive: true, mode: 0o777});
    fs.chmodSync(configRoot, 0o700);
    fs.chmodSync(stateRoot, 0o700);
    fs.chmodSync(repositoryRoot, 0o777);
    const sessionEnv = path.join(configRoot, "session.env");
    const securityProfile = path.join(configRoot, "security.json");
    fs.writeFileSync(sessionEnv, "# paths only\n", {mode: 0o644});
    fs.writeFileSync(securityProfile, "{}\n", {mode: 0o600});
    const repositoryFile = path.join(repositoryRoot, "do-not-chmod.txt");
    fs.writeFileSync(repositoryFile, "preserve", {mode: 0o666});
    fs.chmodSync(repositoryFile, 0o666);

    const service = new SecurityPermissionsService({
        roots: {configRoot, stateRoot},
        home: temporaryRoot
    });
    const inspection = service.inspect(true);
    const envFinding = inspection.resources.find(resource => resource.id === "session_env");
    assert.strictEqual(envFinding.status, "MODE_CHANGE_REQUIRED");
    assert.strictEqual(envFinding.actualMode, "0644");
    assert.strictEqual(envFinding.desiredMode, "0600");
    assert.strictEqual(envFinding.repairable, true);

    const plan = service.repair({apply: false, verbose: true});
    assert.strictEqual(plan.applied, false);
    assert.strictEqual(plan.status, "PLAN_ONLY");
    assert(plan.actions.some(action => action.id === "session_env"));
    assert.strictEqual(fs.statSync(sessionEnv).mode & 0o777, 0o644, "planning must be read-only");
    assert.strictEqual(service.repair({apply: true, authorized: false}).status, "EXPLICIT AUTHORIZATION REQUIRED");
    assert.strictEqual(fs.statSync(sessionEnv).mode & 0o777, 0o644, "--apply authority must be explicit");

    const applied = service.repair({apply: true, authorized: true, verbose: true});
    assert.strictEqual(applied.ok, true);
    assert(applied.repaired.includes("session_env"));
    assert.strictEqual(fs.statSync(sessionEnv).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(repositoryRoot).mode & 0o777, 0o777, "repository directory must not be chmodded");
    assert.strictEqual(fs.statSync(repositoryFile).mode & 0o777, 0o666, "repository contents must not be chmodded");

    fs.unlinkSync(sessionEnv);
    const symlinkVictim = path.join(temporaryRoot, "symlink-victim");
    fs.writeFileSync(symlinkVictim, "preserve", {mode: 0o644});
    fs.symlinkSync(symlinkVictim, sessionEnv);
    const symlink = service.inspect(true).resources.find(resource => resource.id === "session_env");
    assert.strictEqual(symlink.status, "SYMLINK_REJECTED");
    assert.strictEqual(symlink.repairable, false);
    const refusedSymlinkRepair = service.repair({apply: true, authorized: true});
    assert.strictEqual(refusedSymlinkRepair.ok, false,
        "non-repairable findings must prevent a false PERMISSIONS VERIFIED result");
    assert.strictEqual(fs.statSync(symlinkVictim).mode & 0o777, 0o644, "symlink target must never be chmodded");
    fs.unlinkSync(sessionEnv);

    const appsPath = path.join(configRoot, "apps.json");
    const appsLink = path.join(temporaryRoot, "apps-hardlink.json");
    fs.writeFileSync(appsPath, "[]\n", {mode: 0o644});
    fs.linkSync(appsPath, appsLink);
    const hardlink = service.inspect(true).resources.find(resource => resource.id === "application_registry");
    assert.strictEqual(hardlink.status, "HARDLINK_REJECTED");
    assert.strictEqual(hardlink.repairable, false);

    const singleSpec = [{
        id: "owner_test", label: "OWNER TEST", path: securityProfile,
        root: configRoot, type: "file", mode: 0o600
    }];
    const wrongOwner = new SecurityPermissionsService({
        specs: singleSpec,
        uid: (typeof process.getuid === "function" ? process.getuid() : 1000) + 1
    }).inspect(true).resources[0];
    assert.strictEqual(wrongOwner.status, "OWNER_REJECTED");
    assert.strictEqual(wrongOwner.repairable, false);

    console.log("Known-path permission planning/apply, symlink/owner/hardlink refusal, exact modes, and repository exclusion passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
