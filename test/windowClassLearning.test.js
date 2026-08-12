const assert = require("assert");
const {EventEmitter} = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {ApplicationRegistry} = require("../src/classes/applicationRegistry.js");
const {ApplicationLauncher} = require("../src/classes/applicationLauncher.class.js");
const {DesktopEntryDiscovery} = require("../src/classes/desktopEntryDiscovery.js");
const {
    I3WindowManager,
    collectI3ClientLeaves
} = require("../src/classes/i3WindowManager.class.js");
const {WorkspaceManager} = require("../src/classes/workspaceManager.class.js");
const {ApplicationService} = require("../src/cli/applicationService.js");
const {createNomadLog} = require("../src/cli/nomadLog.js");
const {runCli} = require("../src/cli/nomadCli.js");
const {
    WindowClassLearningService,
    readI3Tree,
    readX11WindowPid
} = require("../src/cli/windowClassLearningService.js");

function capture() {
    let value = "";
    return {
        stream: {write: chunk => { value += String(chunk); }},
        value: () => value
    };
}

async function invoke(args, opts) {
    const stdout = capture();
    const stderr = capture();
    const code = await runCli(args, Object.assign({}, opts, {
        stdout: stdout.stream,
        stderr: stderr.stream
    }));
    return {code, stdout: stdout.value(), stderr: stderr.value()};
}

function writeDesktopFile(directory) {
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, "vlc.desktop"), `[Desktop Entry]
Type=Application
Name=VLC media player
Exec=/usr/bin/vlc --started-from-file %U
`);
}

function initialEntry(overrides = {}) {
    return Object.assign({
        id: "vlc",
        displayName: "VLC",
        type: "external",
        desktopId: "vlc.desktop",
        executable: "/usr/bin/vlc",
        args: ["--started-from-file"],
        launcherOrder: 137
    }, overrides);
}

function writeRegistry(registryPath, applications) {
    fs.mkdirSync(path.dirname(registryPath), {recursive: true});
    fs.writeFileSync(registryPath, `${JSON.stringify({version: 1, applications}, null, 4)}\n`, {mode: 0o600});
}

function createApplicationHarness(root, opts = {}) {
    const applicationsDirectory = path.join(root, "applications");
    const registryPath = path.join(root, "home", ".config", "nomad", "apps.json");
    writeDesktopFile(applicationsDirectory);
    writeRegistry(registryPath, [initialEntry(opts.entry || {})]);

    const renameCalls = [];
    const observedFs = Object.create(fs);
    observedFs.renameSync = (source, target) => {
        renameCalls.push({source, target});
        if (opts.renameFailure) throw opts.renameFailure;
        return fs.renameSync(source, target);
    };
    const discovery = new DesktopEntryDiscovery({directories: [applicationsDirectory]});
    const executableExists = executable => ["code", "firefox", "/usr/bin/vlc"].includes(executable);
    const applicationService = new ApplicationService({
        fs: observedFs,
        registryPath,
        discovery,
        executableExists
    });
    return {
        applicationService,
        applicationsDirectory,
        discovery,
        executableExists,
        registryPath,
        renameCalls
    };
}

function client(id, className, instance, pid, focused = false, opts = {}) {
    const windowProperties = {class: className, instance};
    if (Object.prototype.hasOwnProperty.call(opts, "transientFor")) {
        windowProperties.transient_for = opts.transientFor;
    }
    if (opts.windowRole) windowProperties.window_role = opts.windowRole;
    if (opts.title) windowProperties.title = opts.title;
    const applicationClient = {
        id,
        type: "con",
        window: id + 10000,
        pid,
        focused,
        nodes: [],
        floating_nodes: [],
        window_properties: windowProperties
    };
    if (opts.windowType) applicationClient.window_type = opts.windowType;
    if (opts.rect) applicationClient.rect = opts.rect;
    if (Number.isSafeInteger(opts.fullscreenMode)) applicationClient.fullscreen_mode = opts.fullscreenMode;
    return applicationClient;
}

function floatingTree(clients, opts = {}) {
    const floatingNodes = clients.map((applicationClient, index) => {
        const wrapper = {
            id: 5000 + index,
            type: "floating_con",
            focused: false,
            nodes: [applicationClient],
            floating_nodes: []
        };
        if (!opts.nested || index === 0) return wrapper;
        return {
            id: 6000 + index,
            type: "floating_con",
            focused: false,
            nodes: [],
            floating_nodes: [{
                id: 7000 + index,
                type: "con",
                focused: false,
                nodes: [wrapper],
                floating_nodes: []
            }]
        };
    });
    return {
        id: 1,
        type: "root",
        nodes: [{
            id: 2,
            type: "output",
            nodes: [{
                id: 3,
                type: "workspace",
                name: "1",
                visible: true,
                nodes: [],
                floating_nodes: floatingNodes
            }],
            floating_nodes: []
        }],
        floating_nodes: []
    };
}

function createLearningHarness(applicationService, trees, opts = {}) {
    let clock = 0;
    let treeReads = 0;
    let unrefCalls = 0;
    const spawnCalls = [];
    const logs = [];
    const learningLog = (level, message) => {
        logs.push([level, message]);
        if (typeof opts.log === "function") opts.log(level, message);
    };
    const learningSpawn = (executable, args, options) => {
        spawnCalls.push({executable, args, options});
        const child = new EventEmitter();
        child.pid = opts.launchPid || 4242;
        child.unref = () => { unrefCalls++; };
        process.nextTick(() => child.emit("spawn"));
        return child;
    };
    const learner = new WindowClassLearningService({
        applicationService,
        env: Object.prototype.hasOwnProperty.call(opts, "env") ? opts.env : {I3SOCK: "/run/user/1000/i3/ipc.sock"},
        getTree: async () => {
            const tree = trees[Math.min(treeReads, trees.length - 1)];
            treeReads++;
            if (tree instanceof Error) throw tree;
            return tree;
        },
        learningSpawn,
        now: () => clock,
        sleep: async milliseconds => { clock += milliseconds; },
        defaultTimeoutMs: 3000,
        pollIntervalMs: 100,
        settleIntervalMs: Object.prototype.hasOwnProperty.call(opts, "settleIntervalMs")
            ? opts.settleIntervalMs : 200,
        processCorrelator: opts.processCorrelator,
        readWindowPid: opts.readWindowPid,
        log: learningLog
    });
    return {
        learner,
        logs,
        spawnCalls,
        treeReads: () => treeReads,
        unrefCalls: () => unrefCalls
    };
}

function assertRegistryUnchanged(harness, original) {
    assert.strictEqual(fs.readFileSync(harness.registryPath, "utf8"), original);
    assert.strictEqual(harness.renameCalls.length, 0);
}

async function testSuccessfulLearning(root) {
    const harness = createApplicationHarness(path.join(root, "success"));
    const originalDocument = fs.readFileSync(harness.registryPath, "utf8");
    const originalEntry = JSON.parse(originalDocument).applications[0];
    const host = client(10, "eDEX-UI", "edex-ui", 1000, true);
    const vlc = client(20, "vlc", "vlc", 4242, true);
    const before = floatingTree([host]);
    const after = floatingTree([host, vlc], {nested: true});
    const leaves = collectI3ClientLeaves(after);
    assert.strictEqual(leaves.find(context => context.node.id === 20).node.window_properties.class, "vlc");
    assert(leaves.find(context => context.node.id === 20).ancestors.length >= 5,
        "the actual X11 leaf must be found below nested floating wrappers");

    const learning = createLearningHarness(harness.applicationService, [before, after]);
    const prepared = harness.applicationService.prepareWindowClassLearning("vlc");
    assert.strictEqual(prepared.application.status, "WM_CLASS NOT AVAILABLE");
    assert.strictEqual(prepared.executable, "/usr/bin/vlc");
    assert.deepStrictEqual(prepared.args, ["--started-from-file"]);

    const result = await invoke(["app", "learn", "vlc"], {
        applicationService: harness.applicationService,
        windowClassLearningService: learning.learner
    });
    assert.strictEqual(result.code, 0, result.stderr);
    assert(result.stdout.includes("WINDOW CLASS LEARNED\nAPPLICATION: VLC\nCLASS: vlc\nINSTANCE: vlc"));
    assert(result.stdout.includes("APPLICATION AVAILABLE\nRESTART NOMAD SESSION TO APPLY"));
    assert.deepStrictEqual(learning.spawnCalls, [{
        executable: "/usr/bin/vlc",
        args: ["--started-from-file"],
        options: {detached: true, shell: false, stdio: "ignore"}
    }]);
    assert.strictEqual(learning.unrefCalls(), 1);

    const storedDocument = JSON.parse(fs.readFileSync(harness.registryPath, "utf8"));
    const stored = storedDocument.applications[0];
    Object.keys(originalEntry).forEach(field => {
        assert.deepStrictEqual(stored[field], originalEntry[field], `${field} must be preserved exactly`);
    });
    assert.deepStrictEqual(stored.windowMatchers, [{className: "vlc", instance: "vlc"}]);
    assert.strictEqual(harness.renameCalls.length, 1, "learning must use one atomic registry rename");
    assert(harness.renameCalls[0].source.includes(".apps.json.tmp-"));
    assert.strictEqual(harness.renameCalls[0].target, harness.registryPath);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(harness.registryPath))
        .filter(file => file.startsWith(".apps.json.tmp-")), []);

    const reloadedRegistry = new ApplicationRegistry({
        registryPath: harness.registryPath,
        discovery: harness.discovery,
        executableExists: harness.executableExists
    });
    reloadedRegistry.reload();
    const learnedApplication = reloadedRegistry.get("vlc");
    assert.strictEqual(learnedApplication.available, true);
    assert.deepStrictEqual(learnedApplication.windowMatchers, [{className: "vlc", instance: "vlc"}]);

    const info = await invoke(["app", "info", "vlc"], {applicationService: harness.applicationService});
    assert.strictEqual(info.code, 0);
    assert(info.stdout.includes("STATUS: AVAILABLE"));
    assert(info.stdout.includes('WINDOW MATCHERS: [{"className":"vlc","instance":"vlc"}]'));

    const reconciled = harness.applicationService.reconcileInstalledCandidate({
        id: "vlc",
        displayName: "VLC MEDIA PLAYER",
        desktopId: "vlc.desktop",
        executable: "/usr/bin/vlc",
        args: ["--started-from-file"],
        startupWMClass: "",
        status: "NEEDS WM_CLASS"
    }, {
        id: "vlc",
        aliases: ["vlc"],
        desktopIds: ["vlc.desktop"],
        sources: [{source: "APT", package: "vlc"}]
    });
    assert.strictEqual(reconciled.changed, false, "post-install reconciliation must preserve an existing learned matcher");
    assert.deepStrictEqual(harness.applicationService.info("vlc").windowMatchers, [
        {className: "vlc", instance: "vlc"}
    ]);

    const launchCalls = [];
    const manager = new I3WindowManager({
        applications: harness.applicationService.list(),
        spawn: (executable, args, options) => {
            launchCalls.push({executable, args, options});
            const child = new EventEmitter();
            child.unref = () => {};
            return child;
        }
    });
    assert.strictEqual(manager._matches(vlc, manager.applications.vlc), true);
    assert.strictEqual(manager._matches(client(21, "VLC", "vlc", 4242), manager.applications.vlc), false,
        "learned values must remain exact and case-sensitive");
    assert.strictEqual(manager._launch("vlc"), true);
    assert.deepStrictEqual(launchCalls, [{
        executable: "/usr/bin/vlc",
        args: ["--started-from-file"],
        options: {detached: true, stdio: "ignore", shell: false}
    }]);
    assert.deepStrictEqual(manager.applications.code.windowMatchers, [{instance: "code", className: "code"}]);
    assert.deepStrictEqual(manager.applications.browser.windowMatchers, [{instance: "Navigator", className: "firefox_firefox"}]);

    const workspace = new WorkspaceManager({
        applications: reloadedRegistry.getPublicApplications(),
        initialApplicationIds: ["terminal"]
    });
    const launcher = new ApplicationLauncher({manager: workspace});
    assert.strictEqual(launcher.entries.find(entry => entry.id === "vlc").state, "AVAILABLE");
    assert.strictEqual(launcher.activate("vlc"), true);
    assert.strictEqual(workspace.getSlot("vlc").state, "ACTIVE");
    launcher.destroy();
}

async function testMultipleWindowSelection(root) {
    const host = client(10, "eDEX-UI", "edex-ui", 1000, true);
    const before = floatingTree([host]);

    const sharedHarness = createApplicationHarness(path.join(root, "shared-matcher"));
    const selectionLogPath = path.join(root, "shared-matcher", "state", "session.log");
    const sharedLearning = createLearningHarness(sharedHarness.applicationService, [
        before,
        floatingTree([
            host,
            client(20, "vlc", "vlc", 4242, true, {windowType: "normal"}),
            client(30, "vlc", "vlc", 4242, false, {windowType: "dialog"})
        ], {nested: true})
    ], {log: createNomadLog({logPath: selectionLogPath})});
    const shared = await invoke(["app", "learn", "vlc"], {
        applicationService: sharedHarness.applicationService,
        windowClassLearningService: sharedLearning.learner
    });
    assert.strictEqual(shared.code, 0, shared.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(sharedHarness.registryPath, "utf8"))
        .applications[0].windowMatchers, [{className: "vlc", instance: "vlc"}]);
    assert(sharedLearning.logs.some(([, message]) => message.includes("share one exact matcher")));
    assert(fs.readFileSync(selectionLogPath, "utf8").includes("share one exact matcher"));

    const transientHarness = createApplicationHarness(path.join(root, "main-and-transient"));
    const main = client(40, "vlc-main", "vlc-main", 4242, true, {windowType: "normal"});
    const dialog = client(50, "vlc-dialog", "vlc-dialog", 4242, false, {
        transientFor: main.window,
        windowRole: "dialog",
        windowType: "dialog"
    });
    const transientLearning = createLearningHarness(transientHarness.applicationService, [
        before,
        floatingTree([host, main, dialog], {nested: true})
    ]);
    const transient = await invoke(["app", "learn", "vlc"], {
        applicationService: transientHarness.applicationService,
        windowClassLearningService: transientLearning.learner
    });
    assert.strictEqual(transient.code, 0, transient.stderr);
    assert(transient.stdout.includes("CLASS: vlc-main\nINSTANCE: vlc-main"));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(transientHarness.registryPath, "utf8"))
        .applications[0].windowMatchers, [{className: "vlc-main", instance: "vlc-main"}]);
    assert(transientLearning.logs.some(([, message]) => message.includes("owns the other application's transient window")));

    const splashHarness = createApplicationHarness(path.join(root, "main-and-splash"));
    const splashMain = client(60, "vlc-main", "vlc-main", 4242, true, {windowType: "normal"});
    const splash = client(70, "vlc-splash", "vlc-splash", 4242, false, {windowType: "splash"});
    const splashLearning = createLearningHarness(splashHarness.applicationService, [
        before,
        floatingTree([host, splashMain, splash], {nested: true})
    ]);
    const splashResult = await invoke(["app", "learn", "vlc"], {
        applicationService: splashHarness.applicationService,
        windowClassLearningService: splashLearning.learner
    });
    assert.strictEqual(splashResult.code, 0, splashResult.stderr);
    assert(splashResult.stdout.includes("CLASS: vlc-main\nINSTANCE: vlc-main"));
    assert(splashLearning.logs.some(([, message]) => message.includes("preferred over transient or auxiliary windows")));

    const unrelatedHarness = createApplicationHarness(path.join(root, "process-and-unrelated"));
    const launchedWindow = client(80, "VlcMain", "vlc-main", null, true, {windowType: "normal"});
    const unrelatedWindow = client(90, "vlc", "vlc", null, false, {windowType: "normal"});
    const x11Pids = new Map([
        [launchedWindow.window, 5252],
        [unrelatedWindow.window, 9090]
    ]);
    const pidReads = [];
    const unrelatedLearning = createLearningHarness(unrelatedHarness.applicationService, [
        before,
        floatingTree([host, launchedWindow, unrelatedWindow], {nested: true})
    ], {
        readWindowPid: async windowId => {
            pidReads.push(windowId);
            return x11Pids.get(windowId) || null;
        },
        processCorrelator: (launchPid, candidatePid) => launchPid === 4242 && candidatePid === 5252
    });
    const unrelated = await invoke(["app", "learn", "vlc"], {
        applicationService: unrelatedHarness.applicationService,
        windowClassLearningService: unrelatedLearning.learner
    });
    assert.strictEqual(unrelated.code, 0, unrelated.stderr);
    assert(unrelated.stdout.includes("CLASS: VlcMain\nINSTANCE: vlc-main"));
    assert.deepStrictEqual(pidReads.sort((left, right) => left - right),
        [launchedWindow.window, unrelatedWindow.window].sort((left, right) => left - right));
    assert(unrelatedLearning.logs.some(([, message]) => message.includes("only candidate matched launched process or descendant")));

    const departedHarness = createApplicationHarness(path.join(root, "departed-splash"));
    const lastingMain = client(100, "vlc-main", "vlc-main", 4242, true, {windowType: "normal"});
    const departingSplash = client(110, "vlc-splash", "vlc-splash", 4242, false, {windowType: "splash"});
    const departedLearning = createLearningHarness(departedHarness.applicationService, [
        before,
        floatingTree([host, lastingMain, departingSplash], {nested: true}),
        floatingTree([host, lastingMain], {nested: true})
    ]);
    const departed = await invoke(["app", "learn", "vlc"], {
        applicationService: departedHarness.applicationService,
        windowClassLearningService: departedLearning.learner
    });
    assert.strictEqual(departed.code, 0, departed.stderr);
    assert(departed.stdout.includes("CLASS: vlc-main\nINSTANCE: vlc-main"));
}

async function testProtectedAndExistingMatchers(root) {
    const protectedHarness = createApplicationHarness(path.join(root, "protected"));
    const protectedOriginal = fs.readFileSync(protectedHarness.registryPath, "utf8");
    const tree = floatingTree([client(10, "eDEX-UI", "edex-ui", 1000, true)]);
    const protectedLearning = createLearningHarness(protectedHarness.applicationService, [tree]);
    const protectedResult = await invoke(["app", "learn", "code"], {
        applicationService: protectedHarness.applicationService,
        windowClassLearningService: protectedLearning.learner
    });
    assert.strictEqual(protectedResult.code, 1);
    assert(protectedResult.stderr.includes("NOT ALLOWED FOR BUILT-IN APPLICATION"));
    assert.strictEqual(protectedLearning.spawnCalls.length, 0);
    assert.strictEqual(protectedLearning.treeReads(), 0);
    assertRegistryUnchanged(protectedHarness, protectedOriginal);

    const matcherHarness = createApplicationHarness(path.join(root, "existing-matcher"), {
        entry: {windowMatchers: [{className: "ExistingVlc", instance: "existing-vlc"}]}
    });
    const matcherOriginal = fs.readFileSync(matcherHarness.registryPath, "utf8");
    const matcherLearning = createLearningHarness(matcherHarness.applicationService, [tree]);
    const matcherResult = await invoke(["app", "learn", "vlc"], {
        applicationService: matcherHarness.applicationService,
        windowClassLearningService: matcherLearning.learner
    });
    assert.strictEqual(matcherResult.code, 1);
    assert(matcherResult.stderr.includes("WINDOW MATCHER ALREADY AVAILABLE"));
    assert.strictEqual(matcherLearning.spawnCalls.length, 0);
    assert.strictEqual(matcherLearning.treeReads(), 0);
    assertRegistryUnchanged(matcherHarness, matcherOriginal);

    const unstoredHarness = createApplicationHarness(path.join(root, "desktop-fallback-only"), {
        entry: {executable: undefined, args: undefined}
    });
    const unstoredOriginal = fs.readFileSync(unstoredHarness.registryPath, "utf8");
    const unstoredLearning = createLearningHarness(unstoredHarness.applicationService, [tree]);
    const unstoredResult = await invoke(["app", "learn", "vlc"], {
        applicationService: unstoredHarness.applicationService,
        windowClassLearningService: unstoredLearning.learner
    });
    assert.strictEqual(unstoredResult.code, 1);
    assert(unstoredResult.stderr.includes("DOES NOT HAVE A TRUSTED LEARNABLE EXECUTABLE"));
    assert.strictEqual(unstoredLearning.spawnCalls.length, 0);
    assert.strictEqual(unstoredLearning.treeReads(), 0);
    assertRegistryUnchanged(unstoredHarness, unstoredOriginal);
}

async function testSessionRequirement(root) {
    const harness = createApplicationHarness(path.join(root, "no-i3"));
    const original = fs.readFileSync(harness.registryPath, "utf8");
    const learning = createLearningHarness(harness.applicationService, [floatingTree([])], {env: {}});
    const result = await invoke(["app", "learn", "vlc"], {
        applicationService: harness.applicationService,
        windowClassLearningService: learning.learner
    });
    assert.strictEqual(result.code, 1);
    assert(result.stderr.includes("NOMAD SESSION REQUIRED FOR WINDOW CLASS LEARNING"));
    assert.strictEqual(learning.treeReads(), 0);
    assert.strictEqual(learning.spawnCalls.length, 0);
    assertRegistryUnchanged(harness, original);
}

async function testAmbiguityAndTimeout(root) {
    const ambiguousHarness = createApplicationHarness(path.join(root, "ambiguous"));
    const ambiguousOriginal = fs.readFileSync(ambiguousHarness.registryPath, "utf8");
    const host = client(10, "eDEX-UI", "edex-ui", 1000, true);
    const before = floatingTree([host]);
    const ambiguousAfter = floatingTree([
        host,
        client(20, "vlc", "vlc", 4242, true, {
            title: "private-media-filename-one",
            windowType: "normal"
        }),
        client(30, "vlc-secondary", "vlc-secondary", 4242, false, {
            title: "private-media-filename-two",
            windowType: "normal"
        })
    ], {nested: true});
    const ambiguousLearning = createLearningHarness(ambiguousHarness.applicationService, [before, ambiguousAfter]);
    const ambiguous = await invoke(["app", "learn", "vlc"], {
        applicationService: ambiguousHarness.applicationService,
        windowClassLearningService: ambiguousLearning.learner
    });
    assert.strictEqual(ambiguous.code, 1);
    assert(ambiguous.stderr.includes("WINDOW CLASS LEARNING AMBIGUOUS"));
    assert(ambiguous.stderr.includes("NEW WINDOW CANDIDATES: 2"));
    assert(ambiguous.stderr.includes("CANDIDATE 1\nCLASS: vlc\nINSTANCE: vlc\nPID MATCH: YES"));
    assert(ambiguous.stderr.includes("CANDIDATE 2\nCLASS: vlc-secondary\nINSTANCE: vlc-secondary\nPID MATCH: YES"));
    assert(ambiguous.stderr.includes("FOCUSED: YES"));
    assert(ambiguous.stderr.includes("TRANSIENT: NO"));
    assert(ambiguous.stderr.includes("WINDOW TYPE: NORMAL"));
    assert(!ambiguous.stderr.includes("private-media-filename"), "window titles must not be exposed");
    assert(ambiguousLearning.logs.some(([, message]) => message.includes("ambiguous; reason=")));
    assert(!ambiguousLearning.logs.some(([, message]) => message.includes("private-media-filename")),
        "window titles must not be logged");
    assertRegistryUnchanged(ambiguousHarness, ambiguousOriginal);

    const timeoutHarness = createApplicationHarness(path.join(root, "timeout"));
    const timeoutOriginal = fs.readFileSync(timeoutHarness.registryPath, "utf8");
    const timeoutLearning = createLearningHarness(timeoutHarness.applicationService, [before]);
    const timeout = await invoke(["app", "learn", "vlc", "--timeout", "3"], {
        applicationService: timeoutHarness.applicationService,
        windowClassLearningService: timeoutLearning.learner
    });
    assert.strictEqual(timeout.code, 1);
    assert(timeout.stderr.includes("NO NEW APPLICATION WINDOW DETECTED BEFORE TIMEOUT"));
    assertRegistryUnchanged(timeoutHarness, timeoutOriginal);
}

async function testAtomicFailure(root) {
    const harness = createApplicationHarness(path.join(root, "atomic-failure"), {
        renameFailure: new Error("simulated atomic rename failure")
    });
    const original = fs.readFileSync(harness.registryPath, "utf8");
    const host = client(10, "eDEX-UI", "edex-ui", 1000, true);
    const learning = createLearningHarness(harness.applicationService, [
        floatingTree([host]),
        floatingTree([host, client(20, "vlc", "vlc", 4242, true)], {nested: true})
    ]);
    const result = await invoke(["app", "learn", "vlc"], {
        applicationService: harness.applicationService,
        windowClassLearningService: learning.learner
    });
    assert.strictEqual(result.code, 1);
    assert(result.stderr.includes("REGISTRY WRITE FAILED"));
    assert.strictEqual(fs.readFileSync(harness.registryPath, "utf8"), original);
    assert.strictEqual(harness.renameCalls.length, 1);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(harness.registryPath))
        .filter(file => file.startsWith(".apps.json.tmp-")), []);
}

async function testInstallGuidanceAndHelp() {
    const applicationService = {
        findInstalledCandidate: () => null
    };
    const installService = {
        definition: () => ({id: "vlc"}),
        plan: () => ({
            displayName: "VLC",
            source: "APT",
            package: "vlc",
            requiresAdministrator: false
        }),
        apply: () => Promise.resolve(),
        registerInstalled: () => ({
            application: {
                id: "vlc",
                displayName: "VLC",
                available: false,
                windowMatchers: []
            },
            candidate: {desktopId: "vlc.desktop", status: "NEEDS WM_CLASS"},
            alreadyRegistered: false,
            reconciled: false,
            registryPath: "/test-only/apps.json"
        })
    };
    const installed = await invoke(["install", "vlc", "--apply"], {
        applicationService,
        installService,
        confirm: () => Promise.resolve(true)
    });
    assert.strictEqual(installed.code, 0, installed.stderr);
    assert(installed.stdout.includes("WINDOW CLASS REQUIRED\nRUN: nomad app learn vlc"));

    const generalHelp = await invoke(["--help"], {});
    const appHelp = await invoke(["app", "--help"], {});
    assert(generalHelp.stdout.includes("app learn <application>"));
    assert(appHelp.stdout.includes("nomad app learn <application> [--timeout <seconds>]"));

    let learnCalls = 0;
    const invalidTimeout = await invoke(["app", "learn", "vlc", "--timeout", "31"], {
        windowClassLearningService: {learn: async () => { learnCalls++; }}
    });
    assert.strictEqual(invalidTimeout.code, 2);
    assert(invalidTimeout.stderr.includes("BETWEEN 3 AND 30 SECONDS"));
    assert.strictEqual(learnCalls, 0);
}

async function testFixedI3TreeCommand() {
    const expectedTree = floatingTree([]);
    const env = {I3SOCK: "/test-only/i3.sock"};
    const tree = await readI3Tree({
        env,
        execFile: (executable, args, options, callback) => {
            assert.strictEqual(executable, "i3-msg");
            assert.deepStrictEqual(args, ["-t", "get_tree"]);
            assert.strictEqual(options.shell, false);
            assert.strictEqual(options.env, env);
            callback(null, JSON.stringify(expectedTree));
        }
    });
    assert.deepStrictEqual(tree, expectedTree);

    const pid = await readX11WindowPid(12345, {
        env,
        execFile: (executable, args, options, callback) => {
            assert.strictEqual(executable, "xprop");
            assert.deepStrictEqual(args, ["-id", "12345", "_NET_WM_PID"]);
            assert.strictEqual(options.shell, false);
            assert.strictEqual(options.env.I3SOCK, env.I3SOCK);
            assert.strictEqual(options.env.LC_ALL, "C");
            assert(options.maxBuffer <= 64 * 1024);
            callback(null, "_NET_WM_PID(CARDINAL) = 4242\n");
        }
    });
    assert.strictEqual(pid, 4242);
}

async function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-window-class-learning-"));
    try {
        await testSuccessfulLearning(temporaryRoot);
        await testMultipleWindowSelection(temporaryRoot);
        await testProtectedAndExistingMatchers(temporaryRoot);
        await testSessionRequirement(temporaryRoot);
        await testAmbiguityAndTimeout(temporaryRoot);
        await testAtomicFailure(temporaryRoot);
        await testInstallGuidanceAndHelp();
        await testFixedI3TreeCommand();
    } finally {
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
    console.log("Safe WM_CLASS learning, i3 correlation, atomic persistence, and install guidance passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
