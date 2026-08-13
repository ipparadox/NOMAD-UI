const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {SecurityService} = require("../src/classes/securityService.js");

const root = path.resolve(__dirname, "..");
const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
const boot = fs.readFileSync(path.join(root, "src", "_boot.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "_renderer.js"), "utf8");

assert(preload.includes("contextBridge.exposeInMainWorld(\"nomad\", api)"));
assert(preload.includes("Object.freeze(api)"));
assert(!preload.includes('require("fs")'));
assert(!preload.includes('require("child_process")'));
assert(!preload.includes("shell.openExternal"));
assert(!preload.includes("ipcRenderer.invoke(channel"), "the bridge must not expose arbitrary invoke channel names");
assert(!preload.includes("ipcRenderer.send(channel"), "the bridge must not expose arbitrary send channel names");
[
    "application-registry-operation", "repository-operation", "security.status", "security.profile.get",
    "window-manager-operation", "terminal-operation", "nomad.runtime.window-bounds", "nomad.terminal.connection"
].forEach(channel => assert(preload.includes(`\"${channel}\"`), `missing named preload channel ${channel}`));
assert(!preload.includes('"security.profile.set"'), "renderer cannot change the selected security profile");
assert(preload.includes("callback(payload)"));
assert(!preload.includes("callback(event"), "Electron IPC event objects must not cross the context bridge");
[
    "security.enforce", "security.permissions.repair", "security.helper", "firewall", "umount", "sudo"
].forEach(surface => assert(!preload.includes(`\"${surface}\"`), `renderer bridge must not expose ${surface}`));

assert(boot.includes('preload: path.join(__dirname, "preload.js")'));
assert(boot.includes("preloadBridge: true"));
assert(boot.includes("managedApplicationEnvironment"));
assert(boot.includes("TMPDIR: runtimePathPolicy.temporaryRoot"));
assert(boot.includes("XDG_CACHE_HOME: runtimePathPolicy.cacheRoot"));
assert(renderer.includes("nomadBridge.security.status(false)"));
assert(renderer.includes("nomadBridge.repositories.action"));
assert(renderer.includes("nomadBridge.applications.request"));
assert(renderer.includes("nomadBridge.windowManager.send"));
assert(renderer.includes("nomadBridge.terminal.connection"));

function rendererCheck(configuration, productionMode = true) {
    return new SecurityService({
        productionMode,
        debugConfiguration: configuration,
        profileService: {get: () => ({profile: "NORMAL", source: "DEFAULT"}), list: () => []},
        isolationService: {capabilities: () => ({maximumLevel: "NONE", preferredBackend: "DIRECT", backends: []})}
    })._rendererPrivilegeCheck();
}

const compatibility = rendererCheck({
    devTools: false,
    nodeIntegration: true,
    enableRemoteModule: true,
    contextIsolation: false,
    preloadBridge: true
});
assert.strictEqual(compatibility.state, "INSECURE");
assert.strictEqual(compatibility.actual, "LEGACY_COMPATIBILITY");
assert(compatibility.detail.includes("LEGACY EDEX MODULES"));

const productionFlagOnly = rendererCheck({devTools: false}, true);
assert.strictEqual(productionFlagOnly.state, "INSECURE", "production mode alone must never imply renderer security");

const missingIsolation = rendererCheck({
    devTools: false,
    nodeIntegration: false,
    enableRemoteModule: false,
    contextIsolation: false,
    preloadBridge: true
});
assert.strictEqual(missingIsolation.state, "INSECURE");

const isolated = rendererCheck({
    devTools: false,
    nodeIntegration: false,
    enableRemoteModule: false,
    contextIsolation: true,
    preloadBridge: true
});
assert.strictEqual(isolated.state, "SECURE");
assert.strictEqual(isolated.actual, "ISOLATED");

console.log("Named preload API, no arbitrary IPC/Node primitives, migrated NOMAD paths, and truthful legacy renderer status passed");
