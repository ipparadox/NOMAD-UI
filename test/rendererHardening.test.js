const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {SecurityService} = require("../src/classes/securityService.js");

const root = path.resolve(__dirname, "..");
const preload = fs.readFileSync(path.join(root, "src", "preload.js"), "utf8");
const boot = fs.readFileSync(path.join(root, "src", "_boot.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "_renderer.js"), "utf8");
const secureRenderer = fs.readFileSync(path.join(root, "src", "_renderer_secure.js"), "utf8");
const secureHtml = fs.readFileSync(path.join(root, "src", "ui-secure.html"), "utf8");
const productionRendererSources = [
    "managedApplications.js", "workspaceManager.class.js", "applicationLauncher.class.js",
    "i3WorkspaceClient.class.js", "inputCapture.class.js", "repositoryLauncher.class.js",
    "secureKeyboard.class.js", "secureTerminalClient.class.js", "secureTelemetry.class.js",
    "controlPlaneView.class.js"
].map(filename => [filename, fs.readFileSync(path.join(root, "src", "classes", filename), "utf8")]);

assert(preload.includes("contextBridge.exposeInMainWorld(\"nomad\", api)"));
assert(preload.includes("Object.freeze(api)"));
assert(!preload.includes('require("fs")'));
assert(!preload.includes('require("child_process")'));
assert(!preload.includes("shell.openExternal"));
assert(!preload.includes("ipcRenderer.invoke(channel"), "the bridge must not expose arbitrary invoke channel names");
assert(!preload.includes("ipcRenderer.send(channel"), "the bridge must not expose arbitrary send channel names");
[
    "application-registry-operation", "repository-operation", "security.status", "security.profile.get",
    "nomad.workspace.operate", "terminal-operation", "nomad.runtime.bootstrap.get", "nomad.terminal.connection.get",
    "nomad.control.request", "nomad.control.confirm", "nomad.control.cancel", "nomad.control.context",
    "nomad.assistant.interpret", "nomad.terminal.create", "nomad.system.query"
    , "nomad.system.telemetry.get", "nomad.network.telemetry.get", "nomad.workspace.snapshot.get"
].forEach(channel => assert(preload.includes(`\"${channel}\"`), `missing named preload channel ${channel}`));
assert(!preload.includes('"nomad.runtime.window-bounds"'));
assert(!preload.includes('"security.profile.set"'), "renderer cannot change the selected security profile");
assert(preload.includes('status: "USE NOMAD CONTROL PLANE"'), "persistent repository changes must not bypass control-plane review");
assert(boot.includes('request.operation === "clone"') && boot.includes('request.actionId === "pull"'),
    "the main process must independently refuse direct production CLONE and PULL");
assert(preload.includes('payload[0] !== "New process"'), "production terminal events must not project raw working-directory paths");
assert(preload.includes("callback(payload)"));
assert(!preload.includes("callback(event"), "Electron IPC event objects must not cross the context bridge");
[
    "security.enforce", "security.permissions.repair", "security.helper", "firewall", "umount", "sudo"
].forEach(surface => assert(!preload.includes(`\"${surface}\"`), `renderer bridge must not expose ${surface}`));

assert(boot.includes('preload: path.join(__dirname, "preload.js")'));
assert(boot.includes("preloadBridge: true"));
assert(boot.includes('productionMode ? "ui-secure.html" : "ui.html"'));
assert(boot.includes("nodeIntegration: !productionMode"));
assert(boot.includes("contextIsolation: productionMode"));
assert(boot.includes("enableRemoteModule: !productionMode"));
assert(boot.includes("runtimeVerified = verified === true"));
assert(boot.includes("typeof globalThis.require"));
assert(boot.includes("rendererPreloadIsolated"));
assert(boot.includes("managedApplicationEnvironment"));
assert(boot.includes("if (productionMode) return;"), "production renderer-created windows and arbitrary URLs must remain blocked");
assert(boot.includes("EXTERNAL DOCUMENT EDITOR BLOCKED BY SECURITY POLICY"),
    "fixed settings documents must not become an external-launch bypass in LOCKDOWN");
assert(boot.includes("TMPDIR: runtimePathPolicy.temporaryRoot"));
assert(boot.includes("XDG_CACHE_HOME: runtimePathPolicy.cacheRoot"));
assert(renderer.includes("nomadBridge.security.status(false)"));
assert(renderer.includes("nomadBridge.repositories.action"));
assert(renderer.includes("nomadBridge.applications.request"));
assert(renderer.includes("const nomadWindowManagerIpc = ipc"));
assert(renderer.includes("nomadBridge.terminal.connection"));

assert(secureHtml.includes('src="_renderer_secure.js"'));
assert(!secureHtml.includes('src="_renderer.js"'));
assert(secureHtml.includes("xterm/lib/xterm.js"));
assert(secureHtml.includes("control_plane.css"));
assert(!secureHtml.includes(" file:"), "production CSP must not grant an explicit all-file source");
assert(secureHtml.includes("default-src 'none'"));
assert(secureHtml.includes("object-src 'none'") && secureHtml.includes("frame-src 'none'"));
assert(!secureRenderer.includes("fetch("), "production data assets must come from named main-side projections");
[
    "require(", "ipcRenderer", "@electron/remote", "child_process", "shell:true", "shell: true",
    "executeJavaScript", "sendSync", "process.env", "global.eval"
].forEach(surface => assert(!secureRenderer.includes(surface), `production renderer must not contain ${surface}`));
assert(secureRenderer.includes("window.nomadInputCapture && window.nomadInputCapture.active"),
    "all production terminal refocus must yield to active native input capture");
assert.strictEqual((secureRenderer.match(/\.term\.focus\(\)/g) || []).length, 1,
    "the guarded focus helper must be the sole direct production xterm refocus site");
productionRendererSources.forEach(([filename, source]) => {
    ["require(", "ipcRenderer", "@electron/remote", "child_process", "process.env", "module."].forEach(surface => {
        assert(!source.includes(surface), `${filename} must not contain production renderer capability ${surface}`);
    });
});
assert(secureRenderer.includes("bridge.assistant"));
assert(secureRenderer.includes("bridge.control"));
assert(secureRenderer.includes("new SecureTerminalClient"));
assert(secureRenderer.includes("await bridge.runtime.bootstrap()"));
assert(secureRenderer.includes("await bridge.terminal.connection"));
assert(!secureRenderer.includes("command:"));
assert(!secureRenderer.includes("executable:"));
assert(!secureHtml.includes("modal.class.js"), "production must not load legacy renderer classes that require Node");
assert(!secureHtml.includes("terminal.class.js"), "production must use the bridge-backed terminal client");

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
    preloadBridge: true,
    runtimeVerified: true
});
assert.strictEqual(isolated.state, "SECURE");
assert.strictEqual(isolated.actual, "ISOLATED");

const configuredButUnverified = rendererCheck({
    devTools: false,
    nodeIntegration: false,
    enableRemoteModule: false,
    contextIsolation: true,
    preloadBridge: true,
    runtimeVerified: false
});
assert.strictEqual(configuredButUnverified.state, "PARTIAL");
assert.strictEqual(configuredButUnverified.actual, "VERIFICATION_PENDING");

console.log("Production-isolated renderer entrypoint, named preload API, fixed runtime probe, and truthful development compatibility status passed");
