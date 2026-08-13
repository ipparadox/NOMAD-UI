const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {SecurityPathPolicyService} = require("../src/classes/securityPathPolicyService.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-path-policy-"));
try {
    const home = path.join(temporaryRoot, "home");
    const runtime = path.join(temporaryRoot, "runtime");
    const configRoot = path.join(home, ".config", "nomad");
    const stateRoot = path.join(home, ".local", "state", "nomad");
    fs.mkdirSync(home, {recursive: true, mode: 0o700});
    fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
    fs.chmodSync(runtime, 0o700);
    const mountInfo = [
        "24 1 8:2 / / rw,relatime - ext4 /dev/sda2 rw",
        `25 24 0:44 / ${runtime.replace(/ /g, "\\040")} rw,nosuid,nodev - tmpfs tmpfs rw`
    ].join("\n");

    const normal = new SecurityPathPolicyService({
        home,
        env: {HOME: home, XDG_RUNTIME_DIR: runtime},
        sources: {mountInfo},
        roots: {configRoot, stateRoot, cacheRoot: path.join(home, ".cache", "nomad")}
    }).resolve("NORMAL");
    assert.strictEqual(normal.ephemeral, false);
    assert.strictEqual(normal.runtimeStateRoot, stateRoot);
    assert.strictEqual(normal.logRoot, stateRoot);
    assert.strictEqual(normal.sessionRestartRequired, false);

    const runtimeRoot = path.join(runtime, "nomad");
    const publicEnvironment = {
        HOME: home,
        XDG_RUNTIME_DIR: runtime,
        NOMAD_SESSION_PROFILE: "PUBLIC",
        NOMAD_EPHEMERAL_ACTIVE: "1",
        NOMAD_RUNTIME_STATE_DIR: path.join(runtimeRoot, "state"),
        NOMAD_LOG_ROOT: path.join(runtimeRoot, "log")
    };
    const publicService = new SecurityPathPolicyService({
        home,
        env: publicEnvironment,
        sources: {mountInfo},
        roots: {configRoot, stateRoot, cacheRoot: path.join(home, ".cache", "nomad")}
    });
    const publicPolicy = publicService.activate("PUBLIC");
    assert.strictEqual(publicPolicy.ephemeral, true);
    assert.strictEqual(publicPolicy.volatileRuntimeVerified, true);
    assert.strictEqual(publicPolicy.sessionRestartRequired, false);
    assert.strictEqual(publicPolicy.runtimeStateRoot, path.join(runtimeRoot, "state"));
    assert.strictEqual(publicPolicy.logRoot, path.join(runtimeRoot, "log"));
    assert.strictEqual(publicPolicy.repositoryStateRoot, path.join(runtimeRoot, "state", "repositories"));
    assert.strictEqual(publicPolicy.temporaryRoot, path.join(runtimeRoot, "tmp"));
    assert.strictEqual(publicPolicy.configRoot, configRoot, "essential config must remain persistent");
    assert(publicPolicy.essentialPersistent.includes("SECURITY PROFILE"));
    assert(publicPolicy.essentialPersistent.includes("REPOSITORY TRUST FINGERPRINTS"));
    [publicPolicy.runtimeRoot, publicPolicy.runtimeStateRoot, publicPolicy.logRoot,
        publicPolicy.cacheRoot, publicPolicy.temporaryRoot]
        .forEach(directory => assert.strictEqual(fs.statSync(directory).mode & 0o777, 0o700));
    const publicObservation = publicService.observe("PUBLIC");
    assert.strictEqual(publicObservation.actual, "VOLATILE");
    assert.strictEqual(publicObservation.state, "SECURE");

    const mismatch = new SecurityPathPolicyService({
        home,
        env: Object.assign({}, publicEnvironment, {NOMAD_SESSION_PROFILE: "NORMAL", NOMAD_EPHEMERAL_ACTIVE: "0"}),
        sources: {mountInfo}, roots: {configRoot, stateRoot}
    }).observe("PUBLIC");
    assert.strictEqual(mismatch.sessionRestartRequired, true);
    assert.strictEqual(mismatch.actual, "PERSISTENT_SESSION");
    assert(mismatch.detail.includes("SESSION RESTART REQUIRED"));

    const unavailable = new SecurityPathPolicyService({
        home,
        env: {HOME: home, XDG_RUNTIME_DIR: path.join(temporaryRoot, "missing")},
        sources: {mountInfo: "24 1 8:2 / / rw - ext4 /dev/sda2 rw"},
        roots: {configRoot, stateRoot}
    }).observe("LOCKDOWN");
    assert.strictEqual(unavailable.state, "UNAVAILABLE");
    assert.strictEqual(unavailable.actual, "PERSISTENT_SESSION");
    assert.strictEqual(unavailable.sessionRestartRequired, true);

    console.log("NORMAL persistence, PUBLIC verified volatile routing, LOCKDOWN fail-closed routing, essential persistence, and restart truthfulness passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
