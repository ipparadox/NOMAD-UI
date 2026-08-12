const signale = require("signale");
const {app, BrowserWindow, dialog, shell} = require("electron");

process.on("uncaughtException", e => {
    signale.fatal(e);
    dialog.showErrorBox("eDEX-UI crashed", e.message || "Cannot retrieve error message.");
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
const which = require("which");
const Terminal = require("./classes/terminal.class.js").Terminal;
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
const {handleTerminalOperation} = require("./classes/terminalForegroundProcessController.js");

ipc.on("log", (e, type, content) => {
    signale[type](content);
});

var win, tty, extraTtys, i3WindowManager, applicationRegistry, repositoryService, repositoryActions, repositoryGitService;
var repositoryRunProfiles, repositoryProcessManager;
let repositoryShutdownComplete = false;
let repositoryShutdownPromise = null;
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
    signale.info(`Created config dir at ${electron.app.getPath("userData")}`);
} catch(e) {
    signale.info(`Base config dir is ${electron.app.getPath("userData")}`);
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
    signale.info(`Default settings written to ${settingsFile}`);
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
    signale.info(`Default keymap written to ${shortcutsFile}`);
}
//Create default window state file
if(!fs.existsSync(lastWindowStateFile)) {
    fs.writeFileSync(lastWindowStateFile, JSON.stringify({
        useFullscreen: true
    }, "", 4));
    signale.info(`Default last window state written to ${lastWindowStateFile}`);
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
            devTools: true,
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
    applicationRegistry = new ApplicationRegistry({
        log: (level, message) => signale[level](message)
    });
    applicationRegistry.reload();
    ipc.handle("application-registry-operation", (event, request) => {
        return handleApplicationRegistryRequest(applicationRegistry, i3WindowManager, request);
    });

    signale.pending(`Loading settings file...`);
    let settings = require(settingsFile);
    settings.repositoryRoot = settings.repositoryRoot || "~/Repositories";
    signale.pending(`Resolving shell path...`);
    settings.shell = await which(settings.shell).catch(e => { throw(e) });
    signale.info(`Shell found at ${settings.shell}`);
    signale.success(`Settings loaded!`);

    if (!require("fs").existsSync(settings.cwd)) throw new Error("Configured cwd path does not exist.");

    // See #366
    let cleanEnv = await require("shell-env")(settings.shell).catch(e => { throw e; });

    Object.assign(cleanEnv, {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "eDEX-UI",
        TERM_PROGRAM_VERSION: app.getVersion()
    }, settings.env);

    signale.pending(`Creating new terminal process on port ${settings.port || '3000'}`);
    tty = new Terminal({
        role: "server",
        shell: settings.shell,
        params: settings.shellArgs || '',
        cwd: settings.cwd,
        env: cleanEnv,
        port: settings.port || 3000
    });
    signale.success(`Terminal back-end initialized!`);
    tty.onclosed = (code, signal) => {
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
        return handleTerminalOperation(tty, requestParts);
    });

    repositoryService = new RepositoryService({
        repositoryRoot: settings.repositoryRoot,
        log: (level, message) => signale[level](message)
    });
    repositoryRunProfiles = new RepositoryRunProfileService();
    repositoryGitService = new RepositoryGitService({
        repositoryService,
        log: (level, message) => signale[level](message),
        onState: state => {
            if (win && !win.isDestroyed()) win.webContents.send("repository-git-state", state);
        }
    });
    repositoryProcessManager = new RepositoryProcessManager({
        env: cleanEnv,
        log: (level, message) => signale[level](message),
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
            return Boolean(application && application.available !== false);
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

    i3WindowManager = new I3WindowManager({
        applications: applicationRegistry.getApplications(),
        log: (level, message) => signale[level](message),
        onState: state => {
            if (win && !win.isDestroyed()) win.webContents.send("window-manager-state", state);
        }
    });
    await i3WindowManager.initialize();
    ipc.on("window-manager-operation", async (event, request) => {
        const result = await handleWindowManagerRequest(i3WindowManager, request);
        if (!event.sender.isDestroyed()) event.sender.send("window-manager-state", result);
    });

    // Support for more terminals, used for creating tabs (currently limited to 4 extra terms)
    extraTtys = {};
    let basePort = settings.port || 3000;
    basePort = Number(basePort) + 2;

    for (let i = 0; i < 4; i++) {
        extraTtys[basePort+i] = null;
    }

    ipc.on("ttyspawn", (e, arg) => {
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
            let term = new Terminal({
                role: "server",
                shell: settings.shell,
                params: settings.shellArgs || '',
                cwd: tty.tty._cwd || settings.cwd,
                env: cleanEnv,
                port: port
            });
            signale.success(`New terminal back-end initialized at ${port}`);
            term.onclosed = (code, signal) => {
                term.ondisconnected = () => {};
                term.wss.close();
                signale.complete(`TTY exited at ${port}`, code, signal);
                extraTtys[term.port] = null;
                term = null;
            };
            term.onopened = pid => {
                signale.success(`TTY ${port} connected to frontend (process PID ${pid})`);
            };
            term.onresized = () => {};
            term.ondisconnected = () => {
                term.onclosed = () => {};
                term.close();
                term.wss.close();
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
        e.sender.send("getThemeOverride", themeOverride);
    });
    ipc.on("getKbOverride", (e, arg) => {
        e.sender.send("getKbOverride", kbOverride);
    });
    ipc.on("setThemeOverride", (e, arg) => {
        themeOverride = arg;
    });
    ipc.on("setKbOverride", (e, arg) => {
        kbOverride = arg;
    });
});

app.on('web-contents-created', (e, contents) => {
    // Prevent creating more than one window
    contents.on('new-window', (e, url) => {
        e.preventDefault();
        shell.openExternal(url);
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
    signale.complete("Shutting down...");
});
