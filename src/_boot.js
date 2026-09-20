const {
    buildProductionEnvironment,
    inventoryEnvironment,
    sanitizeEnvironmentInPlace
} = require("./classes/securityEnvironmentService.js");
// Compatibility rendering requires an explicit development opt-in.
const productionMode = process.env.NOMAD_PRODUCTION === "1" || process.env.NOMAD_DEVELOPMENT !== "1";
const environmentBeforeSanitization = inventoryEnvironment(process.env);
if (productionMode) sanitizeEnvironmentInPlace(process.env, {NOMAD_PRODUCTION: "1"});
const environmentAfterSanitization = inventoryEnvironment(process.env);

const signale = require("signale");
const {app, BrowserWindow, clipboard, dialog, shell} = require("electron");

process.on("uncaughtException", e => {
    signale.fatal(productionMode ? sanitizeRendererLog(e && e.message) : e);
    dialog.showErrorBox("eDEX-UI crashed", productionMode
        ? sanitizeRendererLog(e && e.message) : (e.message || "Cannot retrieve error message."));
    if (repositoryGitService && repositoryGitService.hasActiveClone()) repositoryGitService.cancelClone(true);
    if (repositoryProcessManager) repositoryProcessManager.terminateAll();
    if (tty) {
        tty.close();
    }
    if (extraTtys) {
        Object.keys(extraTtys).forEach(key => {
            if (extraTtys[key] !== null) {
                extraTtys[key].close();
            }
        });
    }
    process.exit(1);
});

signale.start(`Starting eDEX-UI v${app.getVersion()}`);
signale.info(`With Node ${process.versions.node} and Electron ${process.versions.electron}`);
signale.info(`Renderer is Chrome ${process.versions.chrome}`);
if (productionMode) signale.info(`Production environment names: ${environmentBeforeSanitization.totalCount} -> ${environmentAfterSanitization.totalCount}; sensitive/runtime-injection names: ${environmentBeforeSanitization.sensitiveCount} -> ${environmentAfterSanitization.sensitiveCount}`);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    signale.fatal("Error: Another instance of eDEX is already running. Cannot proceed.");
    app.exit(1);
}

signale.time("Startup");

const electron = require("electron");
const ipc = electron.ipcMain;
const path = require("path");
const url = require("url");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const {SessionAuthProvider, registerSessionAuth} = require("./classes/sessionAuthProvider.js");
const which = require("which");
const {Terminal, normalizeTerminalPort} = require("./classes/terminal.class.js");
const {
    I3WindowManager,
    handleWindowManagerRequest,
    publicWindowManagerResult
} = require("./classes/i3WindowManager.class.js");
const {
    ApplicationRegistry,
    handleApplicationRegistryRequest
} = require("./classes/applicationRegistry.js");
const {
    RepositoryActionService,
    RepositoryGitService,
    RepositoryService,
    handleRepositoryRequest
} = require("./classes/repositoryService.js");
const {RepositoryRunProfileService} = require("./classes/repositoryRunProfileService.js");
const {RepositoryProcessManager} = require("./classes/repositoryProcessManager.js");
const {RepositoryIsolationService} = require("./classes/repositoryIsolationService.js");
const {SecurityProfileService, normalizeSecurityProfile} = require("./classes/securityProfileService.js");
const {ApplicationPolicyService} = require("./classes/applicationPolicyService.js");
const {SecurityEnforcementService} = require("./classes/securityEnforcementService.js");
const {SecurityFirewallService} = require("./classes/securityFirewallService.js");
const {SecurityPathPolicyService} = require("./classes/securityPathPolicyService.js");
const {AutomountPolicyController, SecurityStoragePolicyService} = require("./classes/securityStoragePolicyService.js");
const {
    SecurityService,
    handleSecurityProfileGetRequest,
    handleSecurityStatusRequest
} = require("./classes/securityService.js");
const {handleTerminalOperation} = require("./classes/terminalForegroundProcessController.js");
const {AutomationEngine, OPERATION_ID} = require("./classes/automationEngine.js");
const {ApplicationAutomationService} = require("./classes/applicationAutomationService.js");
const {ControlPlaneService, validateControlRequest} = require("./classes/controlPlaneService.js");
const {RendererSystemService} = require("./classes/rendererSystemService.js");
const {RendererTelemetryService} = require("./classes/rendererTelemetryService.js");
const {ManagedApplicationGeometryService} = require("./classes/managedApplicationGeometryService.js");
const managedGeometryService = new ManagedApplicationGeometryService();
const {
    attachRendererLifecycleDiagnostics,
    attachSecureProgressDiagnostics,
    rendererVerificationReport
} = require("./classes/rendererDiagnostics.js");
const {ApplicationService} = require("./cli/applicationService.js");
const {InstallService} = require("./cli/installService.js");
const {PACKAGE_CATALOG} = require("./cli/packageCatalog.js");

if (!productionMode) require("@electron/remote/main").initialize();

const rendererLogLevels = new Set(["info", "warn", "error", "debug", "note"]);
function sanitizeRendererLog(content) {
    let output = typeof content === "string" ? content : "RENDERER EVENT";
    output = output.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 1024);
    output = output.replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/ig, "$1[REDACTED]")
        .replace(/((?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[=:]\s*)[^\s,;]+/ig, "$1[REDACTED]")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/ig, "$1[REDACTED]@");
    [
        [process.env.NOMAD_ROOT, "[NOMAD_ROOT]"],
        [process.env.XDG_RUNTIME_DIR, "[XDG_RUNTIME_DIR]"],
        [process.env.HOME, "~"]
    ].filter(entry => typeof entry[0] === "string" && entry[0].startsWith("/"))
        .sort((left, right) => right[0].length - left[0].length)
        .forEach(entry => { output = output.split(entry[0]).join(entry[1]); });
    return output || "RENDERER EVENT";
}
function logNomadEvent(level, message) {
    const normalized = rendererLogLevels.has(level) ? level : "info";
    signale[normalized](productionMode ? sanitizeRendererLog(message) : message);
}
ipc.on("log", (e, type, content) => {
    if (!rendererOwnsRequest(e.sender)) return;
    if (!rendererLogLevels.has(type)) return;
    signale[type](sanitizeRendererLog(content));
});
var win, tty, extraTtys, i3WindowManager, applicationRegistry, repositoryService, repositoryActions, repositoryGitService;
var repositoryRunProfiles, repositoryProcessManager;
var repositoryIsolationService, securityProfileService, securityService, securityEnforcementService;
var securityFirewallService, securityPathPolicyService, securityStoragePolicyService, automountPolicyController;
var applicationPolicyService, runtimePathPolicy;
var controlPlaneService, rendererSystemService, rendererTelemetryService, applicationControlService, installService;
var automationEngine, applicationAutomation;
let themeOverride = null;
let kbOverride = null;
let rendererPreloadIsolated = false;
let repositoryShutdownComplete = false;
let repositoryShutdownPromise = null;
const terminalConnectionTokens = new Map();
function rendererOwnsRequest(sender) {
    return Boolean(win && !win.isDestroyed() && sender === win.webContents);
}
function managedApplicationGeometry() {
    return managedGeometryService.get(win);
}
ipc.on("nomad.renderer.preload-state", (event, state) => {
    if (!productionMode || !rendererOwnsRequest(event.sender)) return;
    if (!state || typeof state !== "object" || Array.isArray(state) || Object.keys(state).length !== 2
        || state.contextIsolated !== true || state.bridgeVersion !== 1) {
        logNomadEvent("warn", "Renderer diagnostic: event=preload-state code=INVALID description=isolated preload state rejected");
        return;
    }
    rendererPreloadIsolated = true;
    logNomadEvent("info", "Renderer diagnostic: event=preload-state code=OK description=isolated preload state accepted");
});
ipc.on("nomad.renderer.preload-diagnostic", (event, diagnostic) => {
    if (!productionMode || !rendererOwnsRequest(event.sender) || !diagnostic || typeof diagnostic !== "object"
        || Array.isArray(diagnostic) || Object.keys(diagnostic).length !== 3
        || !/^(START|BRIDGE|STATE|COMPLETE)$/.test(diagnostic.stage || "")
        || !/^[A-Za-z0-9_.-]{1,64}$/.test(diagnostic.code || "")
        || typeof diagnostic.description !== "string") return;
    const level = diagnostic.code === "OK" ? "info" : "error";
    logNomadEvent(level, `Renderer diagnostic: event=preload-stage stage=${diagnostic.stage} code=${diagnostic.code} description=${diagnostic.description}`);
});
if (!productionMode) ipc.on("nomad.terminal.connection", (event, request) => {
    event.returnValue = null;
    if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
        || Array.isArray(request) || Object.keys(request).length !== 1) return;
    const port = normalizeTerminalPort(request.port);
    const authToken = port === null ? null : terminalConnectionTokens.get(port);
    if (typeof authToken === "string") event.returnValue = {port, authToken};
});
securityProfileService = new SecurityProfileService();
securityPathPolicyService = new SecurityPathPolicyService();
let startupProfile = normalizeSecurityProfile(process.env.NOMAD_SESSION_PROFILE);
if (!startupProfile) {
    try { startupProfile = securityProfileService.get().profile; } catch (error) { startupProfile = "NORMAL"; }
}
try {
    runtimePathPolicy = securityPathPolicyService.activate(startupProfile);
    if (runtimePathPolicy.ephemeral) {
        app.setPath("cache", runtimePathPolicy.cacheRoot);
        try { app.setPath("crashDumps", path.join(runtimePathPolicy.runtimeRoot, "crash")); } catch (error) {}
        app.commandLine.appendSwitch("disk-cache-dir", runtimePathPolicy.cacheRoot);
    }
} catch (error) {
    runtimePathPolicy = securityPathPolicyService.resolve("NORMAL");
    signale.warn("Verified volatile runtime activation failed; persistent paths retained and compliance will remain pending");
}
const settingsFile = path.join(electron.app.getPath("userData"), "settings.json");
const shortcutsFile = path.join(electron.app.getPath("userData"), "shortcuts.json");
const lastWindowStateFile = path.join(electron.app.getPath("userData"), "lastWindowState.json");
const themesDir = path.join(electron.app.getPath("userData"), "themes");
const innerThemesDir = path.join(__dirname, "assets/themes");
const kblayoutsDir = path.join(electron.app.getPath("userData"), "keyboards");
const innerKblayoutsDir = path.join(__dirname, "assets/kb_layouts");
const fontsDir = path.join(electron.app.getPath("userData"), "fonts");
const innerFontsDir = path.join(__dirname, "assets/fonts");
const rendererThemesDir = productionMode ? innerThemesDir : themesDir;
const rendererKeyboardsDir = productionMode ? innerKblayoutsDir : kblayoutsDir;

// Unset proxy env variables to avoid connection problems on the internal websockets
// See #222
if (process.env.http_proxy) delete process.env.http_proxy;
if (process.env.https_proxy) delete process.env.https_proxy;

// Bypass GPU acceleration blocklist, trading a bit of stability for a great deal of performance, mostly on Linux
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-video-decode");

// Fix userData folder not setup on Windows
try {
    fs.mkdirSync(electron.app.getPath("userData"));
    signale.info(productionMode ? "Created NOMAD configuration directory" : `Created config dir at ${electron.app.getPath("userData")}`);
} catch(e) {
    signale.info(productionMode ? "NOMAD configuration directory available" : `Base config dir is ${electron.app.getPath("userData")}`);
}
// Create default settings file
if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
        shell: (process.platform === "win32") ? "powershell.exe" : "bash",
        shellArgs: '',
        cwd: electron.app.getPath("userData"),
        keyboard: "en-US",
        virtualKeyboard: true,
        repositoryRoot: "~/Repositories",
        theme: "tron",
        termFontSize: 15,
        audio: true,
        audioVolume: 1.0,
        disableFeedbackAudio: false,
        clockHours: 24,
        pingAddr: "1.1.1.1",
        port: 3000,
        nointro: false,
        nocursor: false,
        forceFullscreen: true,
        allowWindowed: false,
        excludeThreadsFromToplist: true,
        hideDotfiles: false,
        fsListView: false,
        experimentalGlobeFeatures: false,
        experimentalFeatures: false
    }, "", 4));
    signale.info(productionMode ? "Default settings written" : `Default settings written to ${settingsFile}`);
}
// Create default shortcuts file
if (!fs.existsSync(shortcutsFile)) {
    fs.writeFileSync(shortcutsFile, JSON.stringify([
        { type: "app", trigger: "Ctrl+Shift+C", action: "COPY", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+V", action: "PASTE", enabled: true },
        { type: "app", trigger: "Ctrl+Tab", action: "NEXT_TAB", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+Tab", action: "PREVIOUS_TAB", enabled: true },
        { type: "app", trigger: "Ctrl+X", action: "TAB_X", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+S", action: "SETTINGS", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+K", action: "SHORTCUTS", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+F", action: "FUZZY_SEARCH", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+L", action: "FS_LIST_VIEW", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+H", action: "FS_DOTFILES", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+P", action: "KB_PASSMODE", enabled: true },
        { type: "app", trigger: "Ctrl+Shift+I", action: "DEV_DEBUG", enabled: false },
        { type: "app", trigger: "Ctrl+Shift+F5", action: "DEV_RELOAD", enabled: true },
        { type: "shell", trigger: "Ctrl+Shift+Alt+Space", action: "neofetch", linebreak: true, enabled: false }
    ], "", 4));
    signale.info(productionMode ? "Default keymap written" : `Default keymap written to ${shortcutsFile}`);
}
//Create default window state file
if(!fs.existsSync(lastWindowStateFile)) {
    fs.writeFileSync(lastWindowStateFile, JSON.stringify({
        useFullscreen: true
    }, "", 4));
    signale.info(productionMode ? "Default window state written" : `Default last window state written to ${lastWindowStateFile}`);
}

// Copy default themes & keyboard layouts & fonts
signale.pending("Mirroring internal assets...");
try {
    fs.mkdirSync(themesDir);
} catch(e) {
    // Folder already exists
}
fs.readdirSync(innerThemesDir).forEach(e => {
    fs.writeFileSync(path.join(themesDir, e), fs.readFileSync(path.join(innerThemesDir, e), {encoding:"utf-8"}));
});
try {
    fs.mkdirSync(kblayoutsDir);
} catch(e) {
    // Folder already exists
}
fs.readdirSync(innerKblayoutsDir).forEach(e => {
    fs.writeFileSync(path.join(kblayoutsDir, e), fs.readFileSync(path.join(innerKblayoutsDir, e), {encoding:"utf-8"}));
});
try {
    fs.mkdirSync(fontsDir);
} catch(e) {
    // Folder already exists
}
fs.readdirSync(innerFontsDir).forEach(e => {
    fs.writeFileSync(path.join(fontsDir, e), fs.readFileSync(path.join(innerFontsDir, e)));
});

// Version history logging
const versionHistoryPath = path.join(electron.app.getPath("userData"), "versions_log.json");
var versionHistory = fs.existsSync(versionHistoryPath) ? require(versionHistoryPath) : {};
var version = app.getVersion();
if (typeof versionHistory[version] === "undefined") {
	versionHistory[version] = {
		firstSeen: Date.now(),
		lastSeen: Date.now()
	};
} else {
	versionHistory[version].lastSeen = Date.now();
}
fs.writeFileSync(versionHistoryPath, JSON.stringify(versionHistory, 0, 2), {encoding:"utf-8"});

const RENDERER_SETTING_KEYS = new Set([
    "username", "keyboard", "virtualKeyboard", "theme", "termFontSize", "audio", "audioVolume",
    "disableFeedbackAudio", "clockHours", "monitor", "nointro", "nocursor", "allowWindowed",
    "keepGeometry", "excludeThreadsFromToplist", "hideDotfiles", "fsListView", "experimentalGlobeFeatures"
]);

function rendererSettingsPatchValid(patch, themeIds, keyboardIds) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)
        || Object.keys(patch).length === 0 || Object.keys(patch).some(key => !RENDERER_SETTING_KEYS.has(key))) return false;
    const booleans = [
        "virtualKeyboard", "audio", "disableFeedbackAudio", "nointro", "nocursor", "allowWindowed",
        "keepGeometry", "excludeThreadsFromToplist", "hideDotfiles", "fsListView", "experimentalGlobeFeatures"
    ];
    if (booleans.some(key => Object.prototype.hasOwnProperty.call(patch, key) && typeof patch[key] !== "boolean")) return false;
    if (Object.prototype.hasOwnProperty.call(patch, "username")
        && (typeof patch.username !== "string" || patch.username.length > 64 || /[\u0000-\u001f\u007f]/.test(patch.username))) return false;
    if (Object.prototype.hasOwnProperty.call(patch, "theme") && !themeIds.includes(patch.theme)) return false;
    if (Object.prototype.hasOwnProperty.call(patch, "keyboard") && !keyboardIds.includes(patch.keyboard)) return false;
    if (Object.prototype.hasOwnProperty.call(patch, "termFontSize")
        && (!Number.isInteger(patch.termFontSize) || patch.termFontSize < 8 || patch.termFontSize > 48)) return false;
    if (Object.prototype.hasOwnProperty.call(patch, "audioVolume")
        && (!Number.isFinite(patch.audioVolume) || patch.audioVolume < 0 || patch.audioVolume > 1)) return false;
    if (Object.prototype.hasOwnProperty.call(patch, "clockHours") && ![12, 24].includes(patch.clockHours)) return false;
    if (Object.prototype.hasOwnProperty.call(patch, "monitor")
        && (!Number.isInteger(patch.monitor) || patch.monitor < 0 || patch.monitor > 31)) return false;
    return true;
}

function writeFixedJson(filename, value) {
    const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(12).toString("hex")}`;
    let descriptor;
    try {
        const current = fs.lstatSync(filename);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
            || (typeof process.getuid === "function" && current.uid !== process.getuid())) return false;
        descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        fs.fchmodSync(descriptor, 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 4)}\n`, {encoding: "utf8"});
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filename);
        return true;
    } catch (error) {
        try { if (typeof descriptor === "number") fs.closeSync(descriptor); } catch (closeError) {}
        try { fs.unlinkSync(temporary); } catch (unlinkError) {}
        return false;
    }
}

function rendererAssetIds(directory, suffix) {
    try {
        return fs.readdirSync(directory).filter(name => name.endsWith(suffix))
            .map(name => name.slice(0, -suffix.length))
            .filter(name => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name)).sort();
    } catch (error) {
        return [];
    }
}

function readRendererJson(directory, id, fallbackId) {
    const selected = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(id || "") ? id : fallbackId;
    for (const candidate of [selected, fallbackId]) {
        try {
            const filename = path.join(directory, `${candidate}.json`);
            if (path.dirname(filename) !== directory) continue;
            const stats = fs.lstatSync(filename);
            if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4 * 1024 * 1024) continue;
            return JSON.parse(fs.readFileSync(filename, {encoding: "utf8"}));
        } catch (error) {}
    }
    return null;
}

function readRendererGlobeGrid() {
    try {
        const filename = path.join(__dirname, "assets", "misc", "grid.json");
        const stats = fs.lstatSync(filename);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2 * 1024 * 1024) return null;
        const source = JSON.parse(fs.readFileSync(filename, {encoding: "utf8"}));
        if (!source || !Array.isArray(source.tiles) || source.tiles.length > 10000) return null;
        const tiles = source.tiles.map(tile => {
            if (!tile || !Number.isFinite(tile.lat) || !Number.isFinite(tile.lon)
                || !Array.isArray(tile.b) || tile.b.length > 16) throw new Error("invalid globe tile");
            return {
                lat: tile.lat,
                lon: tile.lon,
                b: tile.b.map(point => {
                    if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) throw new Error("invalid globe point");
                    return {x: point.x, y: point.y, z: point.z};
                })
            };
        });
        return {tiles};
    } catch (error) {
        return null;
    }
}

function rendererBootstrap(settings) {
    const themeIds = rendererAssetIds(rendererThemesDir, ".json");
    const keyboardIds = rendererAssetIds(rendererKeyboardsDir, ".json");
    const selectedTheme = themeOverride && themeIds.includes(themeOverride) ? themeOverride : settings.theme;
    const selectedKeyboard = kbOverride && keyboardIds.includes(kbOverride) ? kbOverride : settings.keyboard;
    const projectedSettings = {
        username: typeof settings.username === "string" ? settings.username : "",
        virtualKeyboard: settings.virtualKeyboard !== false,
        termFontSize: Number.isInteger(settings.termFontSize) ? settings.termFontSize : 15,
        audio: settings.audio !== false,
        audioVolume: Number.isFinite(settings.audioVolume) ? settings.audioVolume : 1,
        disableFeedbackAudio: settings.disableFeedbackAudio === true,
        clockHours: settings.clockHours === 12 ? 12 : 24,
        monitor: Number.isInteger(settings.monitor) ? settings.monitor : 0,
        nointro: settings.nointro === true,
        nocursor: settings.nocursor === true,
        allowWindowed: settings.allowWindowed === true,
        keepGeometry: settings.keepGeometry !== false,
        excludeThreadsFromToplist: settings.excludeThreadsFromToplist !== false,
        hideDotfiles: settings.hideDotfiles === true,
        fsListView: settings.fsListView === true,
        experimentalGlobeFeatures: settings.experimentalGlobeFeatures === true,
        port: Number.isSafeInteger(Number(settings.port)) ? Number(settings.port) : 3000,
        theme: themeIds.includes(selectedTheme) ? selectedTheme : "tron",
        keyboard: keyboardIds.includes(selectedKeyboard) ? selectedKeyboard : "en-US"
    };
    let bootLog = "";
    try { bootLog = fs.readFileSync(path.join(__dirname, "assets", "misc", "boot_log.txt"), {encoding: "utf8"}).slice(0, 1024 * 1024); } catch (error) {}
    let archLinux = false;
    try { archLinux = fs.readFileSync("/etc/os-release", {encoding: "utf8"}).includes("Arch Linux"); } catch (error) {}
    let displayName = projectedSettings.username || "";
    if (!displayName) {
        try { displayName = os.userInfo().username; } catch (error) {}
    }
    return {
        settings: projectedSettings,
        shortcuts: [],
        theme: readRendererJson(rendererThemesDir, projectedSettings.theme, "tron"),
        keyboardLayout: readRendererJson(rendererKeyboardsDir, projectedSettings.keyboard, "en-US"),
        globeGrid: readRendererGlobeGrid(),
        themeIds,
        keyboardIds,
        displayCount: electron.screen.getAllDisplays().length,
        displayName: String(displayName || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 64),
        appVersion: app.getVersion(),
        platform: process.platform,
        runtime: rendererSystemService ? rendererSystemService.runtime() : {platform: process.platform, type: os.type(), uptime: Math.floor(os.uptime())},
        argv: {nointro: process.argv.includes("--nointro"), nocursor: process.argv.includes("--nocursor")},
        bootLog,
        archLinux
    };
}

function createWindow(settings) {
    signale.info("Creating window...");

    let display;
    if (!isNaN(settings.monitor)) {
        display = electron.screen.getAllDisplays()[settings.monitor] || electron.screen.getPrimaryDisplay();
    } else {
        display = electron.screen.getPrimaryDisplay();
    }
    let {x, y, width, height} = display.bounds;
    width++; height++;
    win = new BrowserWindow({
        title: "eDEX-UI",
        x,
        y,
        width,
        height,
        show: false,
        resizable: true,
        movable: settings.allowWindowed || false,
        fullscreen: settings.forceFullscreen || false,
        autoHideMenuBar: true,
        frame: settings.allowWindowed || false,
        backgroundColor: productionMode ? '#050505' : '#000000',
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            devTools: !productionMode,
            enableRemoteModule: !productionMode,
            contextIsolation: productionMode,
            backgroundThrottling: false,
            webSecurity: true,
            nodeIntegration: !productionMode,
            nodeIntegrationInSubFrames: false,
            allowRunningInsecureContent: false,
            experimentalFeatures: !productionMode && settings.experimentalFeatures === true,
            additionalArguments: productionMode ? ["--nomad-secure-renderer"] : []
        }
    });

    const rendererUrl = url.format({
        pathname: path.join(__dirname, productionMode ? "ui-secure.html" : "ui.html"),
        protocol: 'file:',
        slashes: true
    });
    if (productionMode) attachRendererLifecycleDiagnostics(win, {log: logNomadEvent});
    if (productionMode) attachSecureProgressDiagnostics(win, logNomadEvent);
    if (productionMode) win.webContents.on("did-start-navigation", (event, navigationUrl, isInPlace, isMainFrame) => {
        if (isMainFrame === false || isInPlace === true) return;
        rendererPreloadIsolated = false;
        if (securityService) securityService.debugConfiguration.runtimeVerified = false;
    });
    if (productionMode) win.webContents.on("did-finish-load", async () => {
        let probe = null;
        try {
            probe = await win.webContents.executeJavaScript(`(() => ({
                requireType: typeof globalThis.require,
                processType: typeof globalThis.process,
                moduleType: typeof globalThis.module,
                bridgeType: typeof globalThis.nomad,
                bridgeKeys: globalThis.nomad ? Object.keys(globalThis.nomad).sort() : []
            }))()`, true);
        } catch (error) {
            logNomadEvent("error", `Renderer diagnostic: event=runtime-verification-exception description=${sanitizeRendererLog(error && error.message)}`);
        }
        const verification = rendererVerificationReport({
            rendererPreloadIsolated,
            currentUrl: win.webContents.getURL(),
            expectedUrl: rendererUrl,
            probe
        });
        const verified = verification.verified;
        if (securityService) {
            securityService.debugConfiguration.runtimeVerified = verified === true;
            securityService.debugConfiguration.nodeIntegration = !(probe && probe.requireType === "undefined"
                && probe.processType === "undefined" && probe.moduleType === "undefined");
            securityService.debugConfiguration.contextIsolation = rendererPreloadIsolated;
            securityService.debugConfiguration.preloadBridge = Boolean(probe && probe.bridgeType === "object");
        }
        if (!verified) {
            logNomadEvent("warn", `Production renderer isolation runtime verification failed; failed predicates: ${verification.failed.join(", ")}; security status remains non-compliant`);
        } else {
            logNomadEvent("info", "Production renderer isolation runtime verification passed; renderer status is secure and isolated");
        }
    });
    if (productionMode) win.once("ready-to-show", () => win.show());
    win.loadURL(rendererUrl);
    if (!productionMode) require("@electron/remote/main").enable(win.webContents);

    signale.complete("Frontend window created!");
    if (!productionMode) win.show();
    win.on("resize", () => win.webContents.send("nomad.window.resize", {}));
    win.on("leave-full-screen", () => win.webContents.send("nomad.window.leave-fullscreen", {}));
    win.on("move", () => win.webContents.send("window-manager-geometry-changed"));
    electron.screen.on("display-metrics-changed", () => {
        if (win && !win.isDestroyed()) win.webContents.send("window-manager-geometry-changed");
    });
    if (!settings.allowWindowed) {
        win.setResizable(false);
    } else if (!require(lastWindowStateFile)["useFullscreen"]) {
        win.setFullScreen(false);
    }

    signale.watch("Waiting for frontend connection...");
}

app.on('ready', async () => {
    registerSessionAuth(ipc, new SessionAuthProvider(), rendererOwnsRequest,
        () => Boolean(securityService && securityService.debugConfiguration.runtimeVerified));
    applicationPolicyService = new ApplicationPolicyService({
        getSecurityProfile: () => securityProfileService.get().profile,
        getRunningExternalCount: () => i3WindowManager ? i3WindowManager.getExternalProcessObservation() : null
    });
    applicationRegistry = new ApplicationRegistry({
        log: logNomadEvent
    });
    applicationRegistry.reload();
    ipc.handle("application-registry-operation", (event, request) => {
        if (!rendererOwnsRequest(event.sender)) return {ok: false, status: "INVALID REQUEST", applications: []};
        return handleApplicationRegistryRequest(applicationRegistry, i3WindowManager, request, applicationPolicyService);
    });

    signale.pending(`Loading settings file...`);
    let settings = require(settingsFile);
    settings.repositoryRoot = typeof settings.repositoryRoot === "string" && settings.repositoryRoot
        ? settings.repositoryRoot : "~/Repositories";
    signale.pending(`Resolving shell path...`);
    settings.shell = await which(settings.shell).catch(e => { throw(e) });
    signale.info(productionMode ? `Shell resolved: ${path.basename(settings.shell)}` : `Shell found at ${settings.shell}`);
    signale.success(`Settings loaded!`);

    rendererSystemService = new RendererSystemService({pingTarget: settings.pingAddr || "1.1.1.1"});
    rendererTelemetryService = new RendererTelemetryService({
        pingTarget: settings.pingAddr || "1.1.1.1",
        preferredInterface: settings.iface || null,
        log: logNomadEvent
    });
    ipc.handle("nomad.runtime.bootstrap.get", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) return null;
        try { return rendererBootstrap(settings); } catch (error) { return null; }
    });
    if (!productionMode) ipc.on("nomad.runtime.bootstrap", (event, request) => {
        event.returnValue = null;
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) return;
        try { event.returnValue = rendererBootstrap(settings); } catch (error) { event.returnValue = null; }
    });
    ipc.handle("nomad.system.query", (event, request) => rendererOwnsRequest(event.sender)
        ? rendererSystemService.query(request) : {ok: false, status: "INVALID REQUEST"});
    ipc.handle("nomad.system.ping", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) return {ok: false, status: "INVALID REQUEST"};
        return rendererSystemService.ping();
    });
    ipc.handle("nomad.system.telemetry.get", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) {
            return {ok: false, status: "INVALID REQUEST"};
        }
        return rendererTelemetryService.getSystemTelemetry();
    });
    ipc.handle("nomad.network.telemetry.get", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) {
            return {ok: false, status: "INVALID REQUEST"};
        }
        return rendererTelemetryService.getNetworkTelemetry();
    });
    ipc.handle("nomad.settings.update", (event, patch) => {
        if (!rendererOwnsRequest(event.sender)) return {ok: false, status: "INVALID REQUEST"};
        const themeIds = rendererAssetIds(rendererThemesDir, ".json");
        const keyboardIds = rendererAssetIds(rendererKeyboardsDir, ".json");
        if (!rendererSettingsPatchValid(patch, themeIds, keyboardIds)) return {ok: false, status: "INVALID SETTINGS"};
        const next = Object.assign({}, settings, patch);
        if (!writeFixedJson(settingsFile, next)) return {ok: false, status: "SETTINGS WRITE REFUSED"};
        settings = next;
        return {ok: true, status: "SETTINGS SAVED", settings: rendererBootstrap(settings).settings};
    });
    ipc.handle("nomad.settings.theme", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).length !== 1 || !rendererAssetIds(rendererThemesDir, ".json").includes(request.themeId)) {
            return {ok: false, status: "INVALID THEME"};
        }
        themeOverride = request.themeId;
        return {ok: true, status: "THEME SELECTED"};
    });
    ipc.handle("nomad.settings.keyboard", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).length !== 1 || !rendererAssetIds(rendererKeyboardsDir, ".json").includes(request.keyboardId)) {
            return {ok: false, status: "INVALID KEYBOARD"};
        }
        kbOverride = request.keyboardId;
        return {ok: true, status: "KEYBOARD SELECTED"};
    });
    ipc.handle("nomad.settings.open-document", async (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).length !== 1 || !["settings", "shortcuts"].includes(request.documentId)) {
            return {ok: false, status: "INVALID DOCUMENT"};
        }
        let selectedProfile = "UNKNOWN";
        try { selectedProfile = securityProfileService.get().profile; } catch (error) {}
        if (productionMode && !["NORMAL", "PUBLIC"].includes(selectedProfile)) {
            return {ok: false, status: "EXTERNAL DOCUMENT EDITOR BLOCKED BY SECURITY POLICY"};
        }
        const result = await shell.openPath(request.documentId === "settings" ? settingsFile : shortcutsFile);
        if (!result && win && !win.isDestroyed()) win.minimize();
        return {ok: !result, status: result ? "DOCUMENT OPEN FAILED" : "DOCUMENT OPENED"};
    });
    ipc.handle("nomad.window.action", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).length !== 1 || !["focus", "minimize", "toggle-fullscreen", "restart", "quit", "toggle-devtools"].includes(request.action)
            || !win || win.isDestroyed()) return {ok: false, status: "INVALID WINDOW ACTION"};
        if (request.action === "focus") win.focus();
        else if (request.action === "minimize") win.minimize();
        else if (request.action === "toggle-fullscreen") win.setFullScreen(!win.isFullScreen());
        else if (request.action === "restart") { app.relaunch(); app.quit(); }
        else if (request.action === "quit") app.quit();
        else if (request.action === "toggle-devtools") {
            if (productionMode) return {ok: false, status: "DEVTOOLS DISABLED"};
            win.webContents.toggleDevTools();
        }
        return {ok: true, status: "WINDOW ACTION COMPLETE"};
    });
    ipc.handle("nomad.terminal.clipboard-read", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) return {ok: false, status: "INVALID REQUEST"};
        return {ok: true, text: clipboard.readText().slice(0, 1024 * 1024)};
    });
    ipc.handle("nomad.terminal.connection.get", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length !== 1) return null;
        const port = normalizeTerminalPort(request.port);
        const authToken = port === null ? null : terminalConnectionTokens.get(port);
        return typeof authToken === "string" ? {port, authToken} : null;
    });

    if (!require("fs").existsSync(settings.cwd)) throw new Error("Configured cwd path does not exist.");

    // See #366
    let cleanEnv = await require("shell-env")(settings.shell).catch(e => { throw e; });
    const terminalEnvironment = {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "eDEX-UI",
        TERM_PROGRAM_VERSION: app.getVersion()
    };
    if (productionMode && runtimePathPolicy.ephemeral) {
        terminalEnvironment.HISTFILE = "/dev/null";
        terminalEnvironment.TMPDIR = runtimePathPolicy.temporaryRoot;
        terminalEnvironment.XDG_CACHE_HOME = runtimePathPolicy.cacheRoot;
    }
    if (productionMode) cleanEnv = buildProductionEnvironment(Object.assign({}, cleanEnv, process.env), terminalEnvironment);
    else Object.assign(cleanEnv, terminalEnvironment, settings.env);

    repositoryIsolationService = new RepositoryIsolationService({
        env: cleanEnv,
        runtimeRoot: path.join(runtimePathPolicy.runtimeRoot, "repository-sandboxes")
    });
    securityFirewallService = new SecurityFirewallService({env: process.env});
    const resolvedRepositoryRoot = settings.repositoryRoot === "~" ? process.env.HOME
        : (settings.repositoryRoot.startsWith("~/")
            ? path.join(process.env.HOME, settings.repositoryRoot.slice(2)) : path.resolve(settings.repositoryRoot));
    securityStoragePolicyService = new SecurityStoragePolicyService({
        env: process.env,
        repositoryPath: resolvedRepositoryRoot,
        protectedPaths: [
            path.resolve(__dirname, ".."),
            resolvedRepositoryRoot,
            runtimePathPolicy.configRoot,
            runtimePathPolicy.persistentStateRoot,
            electron.app.getPath("userData")
        ].filter(candidate => typeof candidate === "string" && path.isAbsolute(candidate))
    });
    automountPolicyController = new AutomountPolicyController({env: process.env});
    securityEnforcementService = new SecurityEnforcementService({
        profileService: securityProfileService,
        firewallService: securityFirewallService,
        pathPolicyService: securityPathPolicyService,
        storageService: securityStoragePolicyService,
        automountController: automountPolicyController
    });
    securityService = new SecurityService({
        profileService: securityProfileService,
        isolationService: repositoryIsolationService,
        repositoryRoot: settings.repositoryRoot,
        appRoot: path.resolve(__dirname, ".."),
        uiConfigRoot: electron.app.getPath("userData"),
        firewallService: securityFirewallService,
        pathPolicyService: securityPathPolicyService,
        applicationPolicyService,
        getRunningExternalApplicationCount: () => i3WindowManager
            ? i3WindowManager.getExternalProcessObservation() : null,
        hasActiveRepositoryProcesses: () => repositoryProcessManager
            ? repositoryProcessManager.hasActive() : null,
        enforcementStatusProvider: () => securityEnforcementService.verify(),
        productionMode,
        debugConfiguration: {
            devTools: !productionMode,
            nodeIntegration: !productionMode,
            enableRemoteModule: !productionMode,
            contextIsolation: productionMode,
            preloadBridge: true,
            compatibilityRenderer: !productionMode,
            runtimeVerified: false,
            experimentalFeatures: !productionMode && settings.experimentalFeatures === true
        }
    });
    ipc.handle("security.status", (event, request) => rendererOwnsRequest(event.sender)
        ? handleSecurityStatusRequest(securityService, request) : {ok: false, status: "INVALID REQUEST"});
    ipc.handle("security.profile.get", (event, request) => rendererOwnsRequest(event.sender)
        ? handleSecurityProfileGetRequest(securityService, request) : {ok: false, status: "INVALID REQUEST"});

    const primaryTerminalPort = normalizeTerminalPort(settings.port || 3000);
    if (primaryTerminalPort === null || primaryTerminalPort > 65530) {
        throw new Error("Configured terminal port must be an integer between 1 and 65530");
    }
    const primaryTerminalAuthToken = crypto.randomBytes(32).toString("hex");
    terminalConnectionTokens.set(primaryTerminalPort, primaryTerminalAuthToken);
    signale.pending(`Creating new terminal process on port ${primaryTerminalPort}`);
    tty = new Terminal({
        role: "server",
        shell: settings.shell,
        params: settings.shellArgs || '',
        cwd: settings.cwd,
        env: cleanEnv,
        host: productionMode ? "127.0.0.1" : undefined,
        port: primaryTerminalPort,
        authToken: primaryTerminalAuthToken,
        requireAuthentication: true,
        isRendererAuthorized: rendererOwnsRequest
    });
    signale.success(`Terminal back-end initialized!`);
    tty.onclosed = (code, signal) => {
        terminalConnectionTokens.delete(primaryTerminalPort);
        tty.ondisconnected = () => {};
        signale.complete("Terminal exited", code, signal);
        app.quit();
    };
    tty.onopened = () => {
        signale.success("Connected to frontend!");
        signale.timeEnd("Startup");
    };
    tty.onresized = (cols, rows) => {
        signale.info("Resized TTY to ", cols, rows);
    };
    tty.ondisconnected = () => {
        signale.error("Lost connection to frontend");
        signale.watch("Waiting for frontend connection...");
    };
    tty.onforegroundprocesschange = state => {
        if (win && !win.isDestroyed()) win.webContents.send("terminal-foreground-state", state);
    };
    ipc.handle("terminal-operation", (event, ...requestParts) => {
        if (!rendererOwnsRequest(event.sender)) return {ok: false, status: "INVALID REQUEST"};
        return handleTerminalOperation(tty, requestParts);
    });

    repositoryService = new RepositoryService({
        repositoryRoot: settings.repositoryRoot,
        log: logNomadEvent
    });
    repositoryRunProfiles = new RepositoryRunProfileService();
    repositoryGitService = new RepositoryGitService({
        repositoryService,
        log: logNomadEvent,
        onState: state => {
            if (win && !win.isDestroyed()) win.webContents.send("repository-git-state", state);
        }
    });
    repositoryProcessManager = new RepositoryProcessManager({
        env: cleanEnv,
        stateRoot: runtimePathPolicy.repositoryStateRoot,
        isolationService: repositoryIsolationService,
        getSecurityProfile: () => securityProfileService.get().profile,
        log: logNomadEvent,
        onState: state => {
            if (win && !win.isDestroyed()) win.webContents.send("repository-process-state", state);
        }
    });
    repositoryActions = new RepositoryActionService({
        repositoryService,
        gitService: repositoryGitService,
        runProfileService: repositoryRunProfiles,
        processManager: repositoryProcessManager,
        shell: settings.shell,
        applicationAvailable: appId => {
            const application = applicationRegistry.get(appId);
            return Boolean(application && application.available !== false
                && applicationPolicyService.evaluate(application).allowed);
        },
        writeTerminal: command => {
            if (!tty || !tty.tty) throw new Error("Terminal unavailable");
            tty.tty.write(command+"\r");
        },
        openCode: (repositoryPath, geometry) => {
            if (!i3WindowManager) return {ok: false, appId: "code", status: "WINDOW MANAGER UNAVAILABLE"};
            return i3WindowManager.openCodeRepository(repositoryPath, geometry);
        },
        openBrowser: (githubUrl, geometry) => {
            if (!i3WindowManager) return {ok: false, appId: "browser", status: "WINDOW MANAGER UNAVAILABLE"};
            return i3WindowManager.openGithubRepository(githubUrl, geometry);
        }
    });
    ipc.handle("repository-operation", async (event, request) => {
        if (!rendererOwnsRequest(event.sender)) return {ok: false, status: "INVALID REQUEST"};
        if (productionMode && request && (request.operation === "clone"
            || (request.operation === "action" && request.actionId === "pull"))) {
            return {ok: false, status: "USE NOMAD CONTROL PLANE"};
        }
        let trustedRequest = request;
        if (productionMode && request && request.operation === "action") {
            if (Object.prototype.hasOwnProperty.call(request, "geometry")) return {ok: false, status: "INVALID REQUEST"};
            trustedRequest = Object.assign({}, request);
            if (["code", "github"].includes(request.actionId)) trustedRequest.geometry = await managedApplicationGeometry();
        }
        if (request && request.operation !== "cancel-clone") {
            try {
                const currentSettings = JSON.parse(fs.readFileSync(settingsFile, {encoding: "utf8"}));
                repositoryService.setRepositoryRoot(currentSettings.repositoryRoot || "~/Repositories");
            } catch (error) {
                signale.warn("Repository settings reload failed; retaining the active repository root");
            }
        }
        return handleRepositoryRequest(repositoryActions, trustedRequest);
    });

    // The legacy development renderer keeps its compatibility-only
    // systeminformation proxy. Production uses RendererSystemService's fixed
    // method enum through the preload bridge.
    if (!productionMode) {
        signale.pending("Starting development compatibility calls controller...");
        require("./_multithread.js");
    }

    const managedApplicationEnvironment = productionMode ? buildProductionEnvironment(
        process.env,
        runtimePathPolicy.ephemeral ? {
            TMPDIR: runtimePathPolicy.temporaryRoot,
            XDG_CACHE_HOME: runtimePathPolicy.cacheRoot
        } : {}
    ) : process.env;
    i3WindowManager = new I3WindowManager({
        applications: applicationRegistry.getApplications(),
        applicationPolicy: applicationPolicyService,
        env: managedApplicationEnvironment,
        log: logNomadEvent,
        onState: state => {
            if (win && !win.isDestroyed()) win.webContents.send("window-manager-state",
                productionMode ? publicWindowManagerResult(state) : state);
        }
    });
    await i3WindowManager.initialize();
    if (!productionMode) ipc.on("window-manager-operation", async (event, request) => {
        if (!rendererOwnsRequest(event.sender)) return;
        const result = await handleWindowManagerRequest(i3WindowManager, request);
        if (!event.sender.isDestroyed()) event.sender.send("window-manager-state", result);
    });
    ipc.on("nomad.workspace.operate", async (event, request) => {
        if (!productionMode || !rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).some(key => !["requestId", "operation", "appId"].includes(key))) return;
        const geometryOperations = new Set(["launch", "focus", "restore", "unfullscreen", "geometry"]);
        const trustedRequest = Object.assign({}, request);
        if (geometryOperations.has(request.operation)) trustedRequest.geometry = await managedApplicationGeometry();
        const result = await handleWindowManagerRequest(i3WindowManager, trustedRequest);
        if (!event.sender.isDestroyed()) event.sender.send("window-manager-state", publicWindowManagerResult(result));
    });
    ipc.handle("nomad.workspace.snapshot.get", async (event, request) => {
        if (!productionMode || !rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) return [];
        const states = await i3WindowManager.snapshot();
        return states.map(publicWindowManagerResult);
    });

    // Support for more terminals, used for creating tabs (currently limited to 4 extra terms)
    extraTtys = {};
    let basePort = primaryTerminalPort + 2;

    for (let i = 0; i < 4; i++) {
        extraTtys[basePort+i] = null;
    }

    const createExtraTerminal = () => {
        let port = null;
        Object.keys(extraTtys).forEach(key => {
            if (extraTtys[key] === null && port === null) {
                extraTtys[key] = {};
                port = key;
            }
        });

        if (port === null) {
            signale.error("TTY spawn denied (Reason: exceeded max TTYs number)");
            return {ok: false, status: "MAXIMUM TERMINALS REACHED"};
        } else {
            signale.pending(`Creating new TTY process on port ${port}`);
            const terminalPort = normalizeTerminalPort(port);
            const authToken = crypto.randomBytes(32).toString("hex");
            terminalConnectionTokens.set(terminalPort, authToken);
            let term = new Terminal({
                role: "server",
                shell: settings.shell,
                params: settings.shellArgs || '',
                cwd: tty.tty._cwd || settings.cwd,
                env: cleanEnv,
                host: productionMode ? "127.0.0.1" : undefined,
                port: terminalPort,
                authToken,
                requireAuthentication: true,
                isRendererAuthorized: rendererOwnsRequest
            });
            signale.success(`New terminal back-end initialized at ${port}`);
            term.onclosed = (code, signal) => {
                term.ondisconnected = () => {};
                term.wss.close();
                signale.complete(`TTY exited at ${port}`, code, signal);
                terminalConnectionTokens.delete(term.port);
                extraTtys[term.port] = null;
                term = null;
            };
            term.onopened = pid => {
                signale.success(productionMode ? `TTY ${port} connected to frontend`
                    : `TTY ${port} connected to frontend (process PID ${pid})`);
            };
            term.onresized = () => {};
            term.ondisconnected = () => {
                term.onclosed = () => {};
                term.close();
                term.wss.close();
                terminalConnectionTokens.delete(term.port);
                extraTtys[term.port] = null;
                term = null;
            };

            extraTtys[port] = term;
            return {ok: true, status: "TERMINAL CREATED", port: terminalPort};
        }
    };
    ipc.handle("nomad.terminal.create", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
            || Array.isArray(request) || Object.keys(request).length) return {ok: false, status: "INVALID REQUEST"};
        return createExtraTerminal();
    });

    if (!productionMode) ipc.on("ttyspawn", (event, arg) => {
        if (!rendererOwnsRequest(event.sender) || arg !== "true") {
            if (!event.sender.isDestroyed()) event.sender.send("ttyspawn-reply", "ERROR: invalid request");
            return;
        }
        const result = createExtraTerminal();
        if (!event.sender.isDestroyed()) event.sender.send("ttyspawn-reply", result.ok
            ? `SUCCESS: ${result.port}` : `ERROR: ${result.status.toLowerCase()}`);
    });

    applicationControlService = new ApplicationService({
        registryPath: applicationRegistry.registryPath,
        env: managedApplicationEnvironment,
        log: logNomadEvent
    });
    installService = new InstallService({
        applicationService: applicationControlService,
        env: managedApplicationEnvironment
    });
    const automationProgress = result => {
        if (win && !win.isDestroyed()) win.webContents.send("nomad.automation.state", result);
    };
    const applicationsChanged = applications => {
        i3WindowManager.setApplications(applications);
        if (win && !win.isDestroyed()) win.webContents.send("nomad.control.applications-changed", {});
    };
    automationEngine = new AutomationEngine({
        repositoryService, processManager: repositoryProcessManager,
        pathPolicyAllows: profile => profile !== "PUBLIC" || (runtimePathPolicy.profile === "PUBLIC" && runtimePathPolicy.ephemeral && runtimePathPolicy.volatileRuntimeVerified),
        getSecurityProfile: () => securityProfileService.get().profile,
        onState: automationProgress
    });
    repositoryActions.automation = automationEngine;
    applicationAutomation = new ApplicationAutomationService({
        applicationService: applicationControlService, applicationRegistry,
        getSecurityProfile: () => securityProfileService.get().profile,
        env: managedApplicationEnvironment, onChanged: applicationsChanged,
        onProgress: automationProgress
    });
    applicationAutomation.start();
    ["status", "cancel", "log"].forEach(operation => {
        ipc.handle(`nomad.automation.${operation}`, (event, request) => {
            if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object"
                || Array.isArray(request) || Object.keys(request).length !== 1
                || typeof request.operationId !== "string" || !OPERATION_ID.test(request.operationId)) return {ok: false, status: "AUTOMATION REQUEST INVALID"};
            return automationEngine[operation](request.operationId);
        });
    });
    controlPlaneService = new ControlPlaneService({
        automation: automationEngine, applicationAutomation,
        onProgress: automationProgress,
        securityService,
        profileService: securityProfileService,
        enforcementService: securityEnforcementService,
        repositoryActions,
        applicationRegistry,
        applicationPolicy: applicationPolicyService,
        windowManager: i3WindowManager,
        applicationService: applicationControlService,
        installService,
        packageCatalog: PACKAGE_CATALOG,
        getGeometry: managedApplicationGeometry,
        onApplicationsChanged: applications => {
            i3WindowManager.setApplications(applications);
            if (win && !win.isDestroyed()) win.webContents.send("nomad.control.applications-changed", {});
        }
    });
    ipc.handle("nomad.control.request", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !validateControlRequest(request)) {
            return {ok: false, status: "UNKNOWN TRUSTED ACTION"};
        }
        return controlPlaneService.request(request);
    });
    ipc.handle("nomad.control.confirm", (event, request) => rendererOwnsRequest(event.sender)
        ? controlPlaneService.confirm(request) : {ok: false, status: "CONFIRMATION INVALID"});
    ipc.handle("nomad.control.cancel", (event, request) => rendererOwnsRequest(event.sender)
        ? controlPlaneService.cancel(request) : {ok: false, status: "CONFIRMATION INVALID"});
    ipc.handle("nomad.control.context", (event, request) => rendererOwnsRequest(event.sender)
        ? controlPlaneService.setContext(request) : {ok: false, status: "INVALID CONTEXT"});
    ipc.handle("nomad.assistant.interpret", (event, request) => {
        if (!rendererOwnsRequest(event.sender) || !request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).length !== 1 || typeof request.input !== "string") {
            return {ok: false, status: "INTENT INPUT INVALID"};
        }
        return controlPlaneService.interpret(request.input);
    });

    createWindow(settings);
    if (productionMode) {
        rendererTelemetryService.start({
            systemInterval: 1000,
            networkInterval: 1000,
            locationCachePath: path.join(electron.app.getPath("userData"), "geoIPcache"),
            onSystemTelemetry: telemetry => {
                if (win && !win.isDestroyed()) win.webContents.send("nomad.system.telemetry", telemetry);
            },
            onNetworkTelemetry: telemetry => {
                if (win && !win.isDestroyed()) win.webContents.send("nomad.network.telemetry", telemetry);
            }
        });
    }

    // Backend support for theme and keyboard hotswitch
    if (!productionMode) ipc.on("getThemeOverride", (e, arg) => {
        if (!rendererOwnsRequest(e.sender)) return;
        e.sender.send("getThemeOverride", themeOverride);
    });
    if (!productionMode) ipc.on("getKbOverride", (e, arg) => {
        if (!rendererOwnsRequest(e.sender)) return;
        e.sender.send("getKbOverride", kbOverride);
    });
    if (!productionMode) ipc.on("setThemeOverride", (e, arg) => {
        if (rendererOwnsRequest(e.sender) && typeof arg === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(arg)) {
            themeOverride = arg;
        }
    });
    if (!productionMode) ipc.on("setKbOverride", (e, arg) => {
        if (rendererOwnsRequest(e.sender) && typeof arg === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(arg)) {
            kbOverride = arg;
        }
    });
});

app.on('web-contents-created', (e, contents) => {
    if (productionMode) {
        contents.on("devtools-opened", () => {
            if (!contents.isDestroyed()) contents.closeDevTools();
        });
    }
    // Prevent creating more than one window
    contents.on('new-window', (e, url) => {
        e.preventDefault();
        if (productionMode) return;
        try {
            const target = new URL(url);
            const browser = applicationRegistry && applicationRegistry.get("browser");
            const browserPolicy = browser && applicationPolicyService
                ? applicationPolicyService.evaluate(browser) : {allowed: false};
            if (["https:", "http:"].includes(target.protocol) && browserPolicy.allowed) {
                shell.openExternal(target.toString());
            }
        } catch (error) {}
    });

    // Prevent loading something else than the UI
    contents.on('will-navigate', (e, url) => {
        if (url !== contents.getURL()) e.preventDefault();
    });
});

app.on('window-all-closed', () => {
    signale.info("All windows closed");
    app.quit();
});

app.on('before-quit', event => {
    if (applicationAutomation) applicationAutomation.stop();
    if (automationEngine) automationEngine.shutdown();
    const hasRepositoryProcesses = repositoryProcessManager && repositoryProcessManager.hasActive();
    const hasRepositoryClone = repositoryGitService && repositoryGitService.hasActiveClone();
    if ((hasRepositoryProcesses || hasRepositoryClone) && !repositoryShutdownComplete) {
        event.preventDefault();
        if (!repositoryShutdownPromise) {
            signale.pending("Stopping managed repository operations...");
            const stops = [];
            if (hasRepositoryProcesses) stops.push(repositoryProcessManager.stopAll());
            if (hasRepositoryClone) stops.push(repositoryGitService.cancelClone(true));
            repositoryShutdownPromise = Promise.all(stops).finally(() => {
                repositoryShutdownComplete = true;
                app.quit();
            });
        }
        return;
    }
    repositoryShutdownComplete = true;
    if (rendererTelemetryService) rendererTelemetryService.stop();
    if (i3WindowManager) i3WindowManager.destroy();
    if (tty) tty.close();
    Object.keys(extraTtys || {}).forEach(key => {
        if (extraTtys[key] !== null) {
            extraTtys[key].close();
        }
    });
    terminalConnectionTokens.clear();
    signale.complete("Shutting down...");
});
