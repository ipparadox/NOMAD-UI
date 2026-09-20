const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {EXPECTED_BRIDGE_KEYS} = require("../src/classes/rendererDiagnostics.js");

const root = path.resolve(__dirname, "..");
const srcRoot = path.join(root, "src");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const boot = read("src/_boot.js");
const preload = read("src/preload.js");
const secureHtml = read("src/ui-secure.html");
const secureRenderer = read("src/_renderer_secure.js");
const secureTerminal = read("src/classes/secureTerminalClient.class.js");
const secureTelemetry = read("src/classes/secureTelemetry.class.js");
const secureKeyboard = read("src/classes/secureKeyboard.class.js");
const controlPlane = read("src/classes/controlPlaneView.class.js");
const modeExpression = boot.match(/const productionMode = (.*);/)[1];
for (const [env, expected] of [[{}, true], [{NOMAD_PRODUCTION: "1"}, true],
    [{NOMAD_DEVELOPMENT: "1"}, false], [{NOMAD_DEVELOPMENT: "1", NOMAD_PRODUCTION: "1"}, true]]) {
    assert.strictEqual(vm.runInNewContext(modeExpression, {process: {env}}), expected,
        "legacy renderer requires explicit development mode; production always wins");
}
assert(secureHtml.includes("assets/css/mod_processlist.css"));
assert(read("src/assets/css/control_plane.css").includes("#nomad_process_list {"));

const cspMatch = secureHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
assert(cspMatch, "secure HTML must define a CSP");
const csp = Object.fromEntries(cspMatch[1].split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const tokens = part.split(/\s+/);
    return [tokens.shift(), tokens];
}));
assert.deepStrictEqual(csp["default-src"], ["'none'"]);
assert.deepStrictEqual(csp["script-src"], ["'self'"]);
assert.deepStrictEqual(csp["style-src"], ["'self'", "'unsafe-inline'"]);
assert.deepStrictEqual(csp["font-src"], ["'self'"]);
assert.deepStrictEqual(csp["img-src"], ["'self'", "data:"]);
assert.deepStrictEqual(csp["media-src"], ["'self'"]);
assert.deepStrictEqual(csp["connect-src"], ["'self'", "ws://127.0.0.1:*"]);
assert.deepStrictEqual(csp["object-src"], ["'none'"]);
assert.deepStrictEqual(csp["frame-src"], ["'none'"]);
assert(!csp["script-src"].includes("'unsafe-eval'") && !csp["script-src"].includes("'unsafe-inline'"));
assert(!csp["connect-src"].some(source => ["*", "ws:", "wss:", "http:", "https:"].includes(source)));
assert(secureRenderer.includes('document.createElement("style")'), "runtime theme projection requires inline style permission");
assert(read("src/node_modules/howler/dist/howler.min.js").includes("XMLHttpRequest"),
    "local Howler audio loading requires connect-src self");

const resources = Array.from(secureHtml.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="([^"]+)"/g), match => match[1]);
assert(resources.includes("_renderer_secure.js"));
resources.forEach(resource => {
    assert(!/^[a-z]+:/i.test(resource), `secure resource must be local: ${resource}`);
    const resolved = path.resolve(srcRoot, resource);
    assert(resolved.startsWith(`${srcRoot}${path.sep}`), `secure resource escaped src: ${resource}`);
    assert(fs.statSync(resolved).isFile(), `secure resource missing: ${resource}`);
});
[
    "assets/css/main.css", "assets/css/main_shell.css", "assets/css/workspace.css",
    "assets/css/repository.css", "assets/css/keyboard.css", "assets/css/mod_column.css",
    "assets/css/mod_clock.css", "assets/css/mod_sysinfo.css", "assets/css/mod_hardwareInspector.css",
    "assets/css/mod_cpuinfo.css", "assets/css/mod_ramwatcher.css", "assets/css/mod_toplist.css",
    "assets/css/mod_netstat.css", "assets/css/mod_globe.css", "assets/css/mod_conninfo.css",
    "assets/css/boot_screen.css", "assets/css/control_plane.css"
].forEach(resource => assert(resources.includes(resource), `required stylesheet missing: ${resource}`));
[
    "classes/managedApplications.js", "classes/workspaceManager.class.js",
    "classes/applicationLauncher.class.js", "classes/i3WorkspaceClient.class.js",
    "classes/inputCapture.class.js", "classes/repositoryLauncher.class.js",
    "classes/secureKeyboard.class.js", "classes/secureTerminalClient.class.js",
    "classes/secureTelemetry.class.js", "classes/controlPlaneView.class.js"
].forEach(resource => {
    assert(resources.includes(resource), `required renderer class missing: ${resource}`);
    assert(secureHtml.indexOf(resource) < secureHtml.indexOf("_renderer_secure.js"), `${resource} must load before the secure renderer`);
});

assert(secureHtml.includes('id="boot_screen"'));
[
    "mod_column_left", "main_shell", "workspace_slots", "workspace_viewport", "terminal0",
    "mod_column_right", "nomad_security_strip", "repository",
    "repository_container", "keyboard"
].forEach(id => assert(secureRenderer.includes(`id="${id}"`), `required secure DOM missing: ${id}`));
[
    "mod_clock", "mod_sysinfo", "mod_hardwareInspector", "mod_cpuinfo", "mod_ramwatcher",
    "mod_toplist", "mod_netstat", "mod_globe", "mod_conninfo",
    "mod_system_telemetry_status", "mod_network_telemetry_status"
].forEach(id => assert(secureTelemetry.includes(`id = "${id}"`) || secureTelemetry.includes(`id="${id}"`),
    `required telemetry DOM missing: ${id}`));
assert(controlPlane.includes('root.id = "nomad_control_plane"'));
assert(controlPlane.includes('triggers.id = "nomad_control_triggers"'));
assert(secureRenderer.includes('root.id = "nomad_settings"'));

const firstPartyScripts = resources.filter(resource => resource.startsWith("classes/") || resource === "_renderer_secure.js");
firstPartyScripts.forEach(resource => {
    const source = fs.readFileSync(path.join(srcRoot, resource), "utf8");
    [
        /\brequire\s*\(/, /\bchild_process\b/, /@electron\/remote/, /\bipcRenderer\b/,
        /\bprocess\s*\.\s*(?:env|argv|versions|platform|cwd|getuid|getgid|pid|execPath|exit|kill|nextTick)\b/,
        /window\s*\.\s*require/, /\bmodule\s*\./
    ].forEach(pattern => assert(!pattern.test(source), `${resource} contains a forbidden renderer dependency: ${pattern}`));
});
const globeBundle = read("src/assets/vendor/encom-globe.js");
assert(globeBundle.startsWith("/**\n* This is a fork of the Encom Globe"));
assert(globeBundle.includes("(function e(t,n,r)"), "globe dependency must remain a self-contained browser bundle");
assert(!/@electron\/remote|child_process|ipcRenderer|process\s*\./.test(globeBundle));
assert(!/\b(?:Worker|SharedWorker)\s*\(|new\s+Blob\s*\(/.test(secureRenderer + secureTerminal),
    "secure bootstrap does not require worker-src or blob CSP access");

function executePreload(exposeInMainWorld) {
    const sent = [];
    const invoked = [];
    let exposed = null;
    const ipcRenderer = {
        invoke: (...args) => { invoked.push(args); return Promise.resolve(null); },
        on: () => {},
        removeListener: () => {},
        send: (...args) => sent.push(args),
        sendSync: () => null
    };
    const context = {
        URL,
        process: {
            argv: ["electron", "renderer", "--nomad-secure-renderer"],
            versions: {node: "14.16.0", electron: "12.2.2", chrome: "89.0.4389.128"}
        },
        require(request) {
            assert.strictEqual(request, "electron");
            return {
                contextBridge: {exposeInMainWorld: (key, api) => {
                    exposeInMainWorld(key, api);
                    exposed = {key, api};
                }},
                ipcRenderer
            };
        },
        window: {}
    };
    vm.runInNewContext(preload, context, {filename: "preload.js"});
    return {sent, exposed, invoked};
}

const preloadRun = executePreload(() => {});
assert(preloadRun.exposed, "preload must expose the isolated bridge");
assert.strictEqual(preloadRun.exposed.key, "nomad");
assert.deepStrictEqual(Object.keys(preloadRun.exposed.api).sort(), Array.from(EXPECTED_BRIDGE_KEYS));
assert(Object.isFrozen(preloadRun.exposed.api));
assert.deepStrictEqual(Object.keys(preloadRun.exposed.api.automation).sort(), ["cancel", "log", "onState", "status"]);
const operationId = `automation_${"a".repeat(32)}`;
for (const method of ["status", "cancel", "log"]) {
    preloadRun.exposed.api.automation[method](operationId);
    const request = preloadRun.invoked[preloadRun.invoked.length - 1];
    assert.strictEqual(request[0], `nomad.automation.${method}`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(request[1])), {operationId});
    const before = preloadRun.invoked.length;
    preloadRun.exposed.api.automation[method]({operationId, executable: "/bin/sh", args: []});
    preloadRun.exposed.api.automation[method](1234);
    assert.strictEqual(preloadRun.invoked.length, before, "automation bridge must reject non-opaque input without invoking main");
}

assert(!Object.prototype.hasOwnProperty.call(preloadRun.exposed.api, "require"));
assert(!Object.prototype.hasOwnProperty.call(preloadRun.exposed.api, "process"));
assert(!Object.prototype.hasOwnProperty.call(preloadRun.exposed.api, "module"));
const preloadState = preloadRun.sent.find(args => args[0] === "nomad.renderer.preload-state");
assert(preloadState && preloadState[1].contextIsolated === true && preloadState[1].bridgeVersion === 1);
assert(preloadRun.sent.some(args => args[0] === "nomad.renderer.preload-diagnostic" && args[1].stage === "COMPLETE"));

const failureEvents = [];
assert.throws(() => executePreload(() => { throw new TypeError("bridge exposure failed"); }), /bridge exposure failed/);
const failureContext = {
    URL,
    process: {argv: ["--nomad-secure-renderer"], versions: {}},
    require: () => ({
        contextBridge: {exposeInMainWorld: () => { throw new TypeError("bridge exposure failed"); }},
        ipcRenderer: {
            invoke: (...args) => { invoked.push(args); return Promise.resolve(null); }, on: () => {}, removeListener: () => {}, sendSync: () => null,
            send: (...args) => failureEvents.push(args)
        }
    }),
    window: {}
};
assert.throws(() => vm.runInNewContext(preload, failureContext, {filename: "preload.js"}), /bridge exposure failed/);
assert(failureEvents.some(args => args[0] === "nomad.renderer.preload-diagnostic"
    && args[1].stage === "BRIDGE" && args[1].code === "TypeError"));
assert(!preload.includes("process.contextIsolated"), "Electron 12 does not provide process.contextIsolated");
assert(boot.includes('additionalArguments: productionMode ? ["--nomad-secure-renderer"] : []'));

assert(boot.includes('event=runtime-verification-exception'));
assert(boot.includes("verification.failed.join"));
assert(!/executeJavaScript[\s\S]{0,800}catch\s*\(error\)\s*\{\s*\}/.test(boot),
    "runtime verification exceptions must not be swallowed");
assert(boot.includes("attachRendererLifecycleDiagnostics"));
assert(boot.includes('ipc.on("nomad.renderer.preload-diagnostic"'));

assert(secureTerminal.includes('new WebSocket(`ws://127.0.0.1:${this.port}/${query}`)'));
assert(secureTerminal.includes("TERMINAL TRANSPORT UNAVAILABLE"));
assert(secureTerminal.includes('this.bridge.sendClientEvent(this.port, "Renderer startup")'));
assert(secureTerminal.includes("this.ready = new Promise"));
assert(secureRenderer.includes("await window.term[0].ready"));
assert(preload.includes('const TERMINAL_EVENT_SET = new Set(["Renderer startup", "Resize"])'));
assert(boot.includes('case "Renderer startup"') || read("src/classes/terminal.class.js").includes('case "Renderer startup"'));
assert(boot.includes('signale.success("Connected to frontend!")'));

assert(secureHtml.includes('class="nomad-login"'));
assert(!secureHtml.includes("RETURN TO SAFE SESSION"));
assert(secureRenderer.includes("RETURN TO SAFE SESSION"));
assert(secureRenderer.includes("NOMAD // SECURE RENDERER FAILURE"));
assert(secureRenderer.includes("INITIALIZATION FAILED"));
assert(!/screen\.textContent\s*=.*error.*message/i.test(secureRenderer), "technical failures must not render raw messages");

class FakeElement {
    constructor(tagName, document) {
        this.tagName = tagName;
        this.document = document;
        this.children = [];
        this.attributes = {};
        this.className = "";
        this.textContent = "";
        this.dataset = {};
        this.classList = {
            add: name => { if (!this.className.split(/\s+/).includes(name)) this.className = `${this.className} ${name}`.trim(); },
            remove: name => { this.className = this.className.split(/\s+/).filter(value => value && value !== name).join(" "); },
            toggle: () => false
        };
    }
    set id(value) { this._id = value; this.document.elements.set(value, this); }
    get id() { return this._id || ""; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) { this.children = children; }
}

class FakeDocument {
    constructor() {
        this.elements = new Map();
        this.body = new FakeElement("body", this);
        const bootScreen = new FakeElement("section", this);
        bootScreen.id = "boot_screen";
        this.body.appendChild(bootScreen);
    }
    createElement(tagName) { return new FakeElement(tagName, this); }
    getElementById(id) { return this.elements.get(id) || null; }
}

function visibleText(element) {
    return [element.textContent].concat(element.children.map(visibleText)).join(" ").replace(/\s+/g, " ").trim();
}

async function verifyFallback() {
    const document = new FakeDocument();
    const rendererLogs = [];
    const window = {nomad: undefined};
    const result = vm.runInNewContext(secureRenderer, {
        console: {error: message => rendererLogs.push(String(message))},
        document,
        window
    }, {filename: "_renderer_secure.js"});
    if (result && typeof result.then === "function") await result;
    const output = visibleText(document.body);
    assert(output.includes("NOMAD // SECURE RENDERER FAILURE"));
    assert(output.includes("STAGE PRELOAD"));
    assert(output.includes("STATUS INITIALIZATION FAILED"));
    assert(output.includes("REFERENCE NMD-PRE-001"));
    assert(output.includes("RETURN TO SAFE SESSION"));
    assert(!output.includes("preload bridge unavailable"), "technical detail must remain main-log only");
    assert(rendererLogs.some(message => message.includes("stage=PRELOAD") && message.includes("preload bridge unavailable")));
}

assert(boot.includes("devTools: !productionMode"));
assert(boot.includes("nodeIntegration: !productionMode"));
assert(boot.includes("contextIsolation: productionMode"));
assert(boot.includes("enableRemoteModule: !productionMode"));
const sandboxBypassFlag = ["--no", "sandbox"].join("-");
assert(!boot.includes(sandboxBypassFlag));
assert(!boot.includes("nodeIntegration: true"));
assert(!boot.includes("contextIsolation: false"));
assert(!preload.includes("ipcRenderer.invoke(channel"));
assert(!preload.includes("ipcRenderer.send(channel"));
assert(secureRenderer.includes("bridge.assistant"));
assert(!secureRenderer.includes("bridge.terminal.write"));
assert(!secureRenderer.includes("command:"));
assert(!secureRenderer.includes("executable:"));
assert(secureRenderer.indexOf("await telemetryReady") < secureRenderer.indexOf('"NOMAD secure renderer UI initialized"'));
assert(secureRenderer.includes('"System telemetry initialized"'));
assert(secureRenderer.includes('"Network telemetry initialized"'));
assert(secureRenderer.includes('"Repository projection initialized"'));
assert(secureRenderer.includes('"Workspace manager initialized"'));
assert(secureRenderer.includes('"Virtual keyboard initialized"'));
assert(secureRenderer.includes('"Control Plane initialized"'));
assert(secureRenderer.includes('loadState: () => bridge.windowManager.snapshot()'));
assert(secureRenderer.includes('document.getElementById("repository").style.opacity = "1"'));
assert(secureTelemetry.includes("new window.TimeSeries()"));
assert(secureTelemetry.includes("new window.ENCOM.Globe"));
assert(secureTelemetry.includes("requestAnimationFrame(tick)"));
assert(secureTelemetry.includes("nomadNetworkGraphTimestamp"));
assert(secureTelemetry.includes("nomadCpuGraphTimestamp"));
assert(!/mock|placeholder telemetry|screenshot/i.test(secureTelemetry));
assert(secureKeyboard.includes("this._route(command)"));
assert(secureKeyboard.includes('action = "CONTROL_PLANE"'));

verifyFallback().then(() => {
    console.log("Secure renderer HTML, CSP, preload bridge, dependency chain, readiness, and visible fallback regression checks passed");
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
