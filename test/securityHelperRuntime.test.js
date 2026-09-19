const assert = require("assert");
const path = require("path");
const {
    HELPER_RUNTIME_PATH,
    SecurityHelperClient
} = require("../src/classes/securityEnforcementService.js");

const helperPath = "/usr/local/libexec/nomad-security-helper";
const directoryStats = {
    uid: 0, mode: 0o40755,
    isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false
};
const fileStats = uid => ({
    uid, mode: 0o100755, nlink: 1,
    isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false
});

function filesystem(runtimeUid) {
    return {
        lstatSync(filename) {
            if (filename === helperPath) return fileStats(0);
            if (["/", "/usr", "/usr/local", "/usr/local/libexec", "/usr/bin"].includes(filename)) return directoryStats;
            if (filename === HELPER_RUNTIME_PATH) return fileStats(runtimeUid);
            const error = new Error("missing"); error.code = "ENOENT"; throw error;
        },
        statSync(filename) {
            if (filename === HELPER_RUNTIME_PATH) return fileStats(runtimeUid);
            throw new Error("missing");
        },
        realpathSync: filename => filename
    };
}

assert.strictEqual(HELPER_RUNTIME_PATH, "/usr/bin/node");
const trusted = new SecurityHelperClient({
    fs: filesystem(0), path, helperPath, uid: 1000,
    resolveExecutable: command => command === "pkexec" ? "/usr/bin/pkexec" : null
}).capability();
assert.strictEqual(trusted.runtime, "/usr/bin/node");
assert.strictEqual(trusted.runtimeTrusted, true);
assert.strictEqual(trusted.available, true);

let invocation = null;
const invokingClient = new SecurityHelperClient({
    fs: filesystem(0), path, helperPath, uid: 1000,
    resolveExecutable: command => command === "pkexec" ? "/usr/bin/pkexec" : null,
    runner: (command, args, options) => {
        invocation = {command, args, options};
        return {
            status: 0,
            stdout: JSON.stringify({
                ok: true, status: "READY", profile: "NONE",
                firewall: "NOT_APPLIED", storage: "NOT_APPLIED"
            })
        };
    }
});
assert.strictEqual(invokingClient.invoke("status", {authorized: true}).ok, true);
assert.strictEqual(invocation.command, "/usr/bin/pkexec");
assert.deepStrictEqual(invocation.args, [helperPath, "status"]);
assert.deepStrictEqual(invocation.options.env, {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C"
});
assert.strictEqual(invocation.options.shell, false);

const userWritableRuntime = new SecurityHelperClient({
    fs: filesystem(1000), path, helperPath, uid: 1000,
    resolveExecutable: command => command === "pkexec" ? "/usr/bin/pkexec" : null
}).capability();
assert.strictEqual(userWritableRuntime.runtimeTrusted, false);
assert.strictEqual(userWritableRuntime.trusted, false);
assert.strictEqual(userWritableRuntime.available, false);
assert.strictEqual(userWritableRuntime.status, "TRUSTED /usr/bin/node RUNTIME UNAVAILABLE");
assert(!JSON.stringify(userWritableRuntime).includes(".nvm"));

console.log("Privileged helper runtime is pinned to trusted root-owned /usr/bin/node and fails closed for user-owned runtimes");
