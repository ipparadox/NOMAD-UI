const {
    buildProductionEnvironment,
    inventoryEnvironment,
    sanitizeEnvironmentInPlace
} = require("./classes/securityEnvironmentService.js");
const productionMode = process.env.NOMAD_PRODUCTION === "1";
const environmentBeforeSanitization = inventoryEnvironment(process.env);
if (productionMode) sanitizeEnvironmentInPlace(process.env, {NOMAD_PRODUCTION: "1"});
const environmentAfterSanitization = inventoryEnvironment(process.env);

const signale = require("signale");
const {app, BrowserWindow, dialog, shell} = require("electron");

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
require('@electron/remote/main').initialize()
const ipc = electron.ipcMain;
const path = require("path");
const url = require("url");
const fs = require("fs");
const crypto = require("crypto");
const which = require("which");
const {Terminal, normalizeTerminalPort} = require("./classes/terminal.class.js");
const {
    I3WindowManager,
    handleWindowManagerRequest
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
ipc.on("nomad.runtime.window-bounds", (event, request) => {
    if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).length) {
        event.returnValue = null;
        return;
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!rendererOwnsRequest(event.sender) || !owner || owner.isDestroyed()) {
        event.returnValue = null;
        return;
    }
    const bounds = owner.getContentBounds();
    event.returnValue = {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height};
});

var win, tty, extraTtys, i3WindowManager, applicationRegistry, repositoryService, repositoryActions, repositoryGitService;
var repositoryRunProfiles, repositoryProcessManager;
var repositoryIsolationService, securityProfileService, securityService, securityEnforcementService;
var securityFirewallService, securityPathPolicyService, securityStoragePolicyService, automountPolicyController;
var applicationPolicyService, runtimePathPolicy;
let repositoryShutdownComplete = false;
let repositoryShutdownPromise = null;
const terminalConnectionTokens = new Map();
function rendererOwnsRequest(sender) {
    return Boolean(win && !win.isDestroyed() && sender === win.webContents);
}
ipc.on("nomad.terminal.connection", (event, request) => {
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
        backgroundColor: '#000000',
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            devTools: !productionMode,
            enableRemoteModule: true,
            contextIsolation: false,
            backgroundThrottling: false,
            webSecurity: true,
            nodeIntegration: true,
            nodeIntegrationInSubFrames: false,
            allowRunningInsecureContent: false,
            experimentalFeatures: settings.experimentalFeatures || false
        }
    });

    win.loadURL(url.format({
        pathname: path.join(__dirname, 'ui.html'),
        protocol: 'file:',
        slashes: true
    }));

    signale.complete("Frontend window created!");
    win.show();
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
            ? path.join(process.env.HOME, settings.repositoryRoot.slice(2)) : settings.repositoryRoot);
    securityStoragePolicyService = new SecurityStoragePolicyService({
        env: process.env,
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
            nodeIntegration: true,
            enableRemoteModule: true,
            contextIsolation: false,
            preloadBridge: true,
            experimentalFeatures: settings.experimentalFeatures === true
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
    ipc.handle("repository-operation", (event, request) => {
        if (!rendererOwnsRequest(event.sender)) return {ok: false, status: "INVALID REQUEST"};
        if (request && request.operation !== "cancel-clone") {
            try {
                const currentSettings = JSON.parse(fs.readFileSync(settingsFile, {encoding: "utf8"}));
                repositoryService.setRepositoryRoot(currentSettings.repositoryRoot || "~/Repositories");
            } catch (error) {
                signale.warn("Repository settings reload failed; retaining the active repository root");
            }
        }
        return handleRepositoryRequest(repositoryActions, request);
    });

    // Support for multithreaded systeminformation calls
    signale.pending("Starting multithreaded calls controller...");
    require("./_multithread.js");

    createWindow(settings);

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
            if (win && !win.isDestroyed()) win.webContents.send("window-manager-state", state);
        }
    });
    await i3WindowManager.initialize();
    ipc.on("window-manager-operation", async (event, request) => {
        if (!rendererOwnsRequest(event.sender)) return;
        const result = await handleWindowManagerRequest(i3WindowManager, request);
        if (!event.sender.isDestroyed()) event.sender.send("window-manager-state", result);
    });

    // Support for more terminals, used for creating tabs (currently limited to 4 extra terms)
    extraTtys = {};
    let basePort = primaryTerminalPort + 2;

    for (let i = 0; i < 4; i++) {
        extraTtys[basePort+i] = null;
    }

    ipc.on("ttyspawn", (e, arg) => {
        if (!rendererOwnsRequest(e.sender) || arg !== "true") {
            if (!e.sender.isDestroyed()) e.sender.send("ttyspawn-reply", "ERROR: invalid request");
            return;
        }
        let port = null;
        Object.keys(extraTtys).forEach(key => {
            if (extraTtys[key] === null && port === null) {
                extraTtys[key] = {};
                port = key;
            }
        });

        if (port === null) {
            signale.error("TTY spawn denied (Reason: exceeded max TTYs number)");
            e.sender.send("ttyspawn-reply", "ERROR: max number of ttys reached");
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
            e.sender.send("ttyspawn-reply", "SUCCESS: "+port);
        }
    });

    // Backend support for theme and keyboard hotswitch
    let themeOverride = null;
    let kbOverride = null;
    ipc.on("getThemeOverride", (e, arg) => {
        if (!rendererOwnsRequest(e.sender)) return;
        e.sender.send("getThemeOverride", themeOverride);
    });
    ipc.on("getKbOverride", (e, arg) => {
        if (!rendererOwnsRequest(e.sender)) return;
        e.sender.send("getKbOverride", kbOverride);
    });
    ipc.on("setThemeOverride", (e, arg) => {
        if (rendererOwnsRequest(e.sender) && typeof arg === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(arg)) {
            themeOverride = arg;
        }
    });
    ipc.on("setKbOverride", (e, arg) => {
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
