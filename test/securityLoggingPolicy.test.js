const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {createNomadLog, defaultNomadLogPath, sanitizeLogMessage} = require("../src/cli/nomadLog.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-security-log-"));
try {
    const home = path.join(temporaryRoot, "home");
    const runtime = path.join(temporaryRoot, "runtime");
    fs.mkdirSync(home, {recursive: true, mode: 0o700});
    fs.mkdirSync(runtime, {recursive: true, mode: 0o700});
    const normal = defaultNomadLogPath({home, env: {HOME: home}});
    assert.strictEqual(normal, path.join(home, ".local", "state", "nomad", "session.log"));
    const restrictedEnvironment = {
        HOME: home,
        XDG_RUNTIME_DIR: runtime,
        NOMAD_SESSION_PROFILE: "PUBLIC",
        NOMAD_EPHEMERAL_ACTIVE: "1",
        NOMAD_LOG_ROOT: path.join(runtime, "nomad", "log")
    };
    const volatile = defaultNomadLogPath({home, env: restrictedEnvironment});
    assert.strictEqual(volatile, path.join(runtime, "nomad", "log", "session.log"));
    assert.strictEqual(defaultNomadLogPath({home, env: Object.assign({}, restrictedEnvironment, {
        NOMAD_LOG_ROOT: path.join(home, "attacker-selected")
    })}), normal, "an arbitrary NOMAD_LOG_ROOT must not be honored");

    const privateRoot = path.join(temporaryRoot, "private-log");
    fs.mkdirSync(privateRoot, {mode: 0o700});
    const logPath = path.join(privateRoot, "session.log");
    const write = createNomadLog({logPath});
    write("info", "safe diagnostic");
    assert(fs.readFileSync(logPath, "utf8").includes("safe diagnostic"));
    assert.strictEqual(fs.statSync(logPath).mode & 0o777, 0o600);
    const redacted = sanitizeLogMessage("token=do-not-log Bearer credential password:also-secret https://user:pass@example.invalid/");
    assert(!redacted.includes("do-not-log"));
    assert(!redacted.includes("credential"));
    assert(!redacted.includes("also-secret"));
    assert(!redacted.includes("user:pass"));
    const linked = path.join(privateRoot, "linked.log");
    fs.linkSync(logPath, linked);
    const before = fs.readFileSync(logPath, "utf8");
    write("info", "must be refused");
    assert.strictEqual(fs.readFileSync(logPath, "utf8"), before, "hard-linked logs must be refused");

    console.log("NORMAL persistent logging, restricted volatile routing, arbitrary path refusal, private modes, and hardlink refusal passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
