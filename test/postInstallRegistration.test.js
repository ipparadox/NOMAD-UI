const assert = require("assert");
const {EventEmitter} = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {ApplicationService} = require("../src/cli/applicationService.js");
const {InstallService} = require("../src/cli/installService.js");
const {runCli} = require("../src/cli/nomadCli.js");
const {DesktopEntryDiscovery} = require("../src/classes/desktopEntryDiscovery.js");

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

function writeRegistry(registryPath, applications) {
    fs.mkdirSync(path.dirname(registryPath), {recursive: true});
    fs.writeFileSync(registryPath, `${JSON.stringify({version: 1, applications}, null, 4)}\n`, {mode: 0o600});
}

function writeVlcDesktop(applicationsDirectory) {
    fs.writeFileSync(path.join(applicationsDirectory, "vlc.desktop"), `[Desktop Entry]
Type=Application
Name=VLC media player
Exec=vlc --started-from-file %F
StartupWMClass=vlc
`);
}

function observedFilesystem(renameCalls, renameFailure) {
    const observed = Object.create(fs);
    observed.renameSync = (source, target) => {
        renameCalls.push({source, target});
        if (renameFailure) throw renameFailure;
        return fs.renameSync(source, target);
    };
    return observed;
}

function createHarness(root, opts = {}) {
    const applicationsDirectory = path.join(root, "applications");
    const registryPath = path.join(root, "home", ".config", "nomad", "apps.json");
    fs.mkdirSync(applicationsDirectory, {recursive: true});
    if (opts.initialApplications) writeRegistry(registryPath, opts.initialApplications);

    const executables = new Set(["code", "firefox"]);
    const renameCalls = [];
    const discovery = new DesktopEntryDiscovery({directories: [applicationsDirectory]});
    const applicationService = new ApplicationService({
        fs: observedFilesystem(renameCalls, opts.renameFailure),
        registryPath,
        discovery,
        executableExists: executable => executables.has(executable)
    });
    let spawnCount = 0;
    const tools = {
        sudo: "/trusted/bin/sudo",
        "apt-get": "/trusted/bin/apt-get",
        "apt-cache": "/trusted/bin/apt-cache"
    };
    const installService = new InstallService({
        applicationService,
        resolveTool: name => tools[name] || null,
        probe: executable => path.basename(executable) === "apt-cache"
            ? {status: 0, stdout: "Package: vlc\n"}
            : {status: 1, stdout: ""},
        spawn: () => {
            spawnCount++;
            const child = new EventEmitter();
            process.nextTick(() => {
                executables.add("vlc");
                writeVlcDesktop(applicationsDirectory);
                child.emit("exit", 0, null);
            });
            return child;
        }
    });

    return {
        applicationService,
        applicationsDirectory,
        executables,
        installService,
        registryPath,
        renameCalls,
        spawnCount: () => spawnCount
    };
}

function templateVlc(overrides = {}) {
    return Object.assign({
        id: "vlc",
        displayName: "MY VLC",
        type: "external",
        executable: "vlc",
        args: ["--template-argument"],
        wmClass: ["template-vlc"],
        launcherOrder: 42
    }, overrides);
}

function assertAtomicRename(harness) {
    assert.strictEqual(harness.renameCalls.length, 1, "registration must use one atomic rename");
    assert(harness.renameCalls[0].source.includes(".apps.json.tmp-"));
    assert.strictEqual(harness.renameCalls[0].target, harness.registryPath);
    const temporaryFiles = fs.readdirSync(path.dirname(harness.registryPath))
        .filter(file => file.startsWith(".apps.json.tmp-"));
    assert.deepStrictEqual(temporaryFiles, []);
}

async function testUnavailableEntryReconciles(root) {
    const harness = createHarness(path.join(root, "unavailable"), {
        initialApplications: [templateVlc()]
    });
    assert.strictEqual(harness.applicationService.info("vlc").available, false);

    const result = await invoke(["install", "vlc", "--apply"], {
        applicationService: harness.applicationService,
        installService: harness.installService,
        confirm: () => Promise.resolve(true)
    });
    assert.strictEqual(result.code, 0);
    assert(result.stdout.includes("INSTALL COMPLETE\nAPPLICATION REGISTERED\nAPPLICATION UPDATED"));
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(harness.spawnCount(), 1);

    const stored = JSON.parse(fs.readFileSync(harness.registryPath, "utf8")).applications;
    assert.strictEqual(stored.length, 1, "reconciliation must not create a duplicate");
    assert.strictEqual(stored[0].id, "vlc");
    assert.strictEqual(stored[0].displayName, "MY VLC");
    assert.strictEqual(stored[0].launcherOrder, 42);
    assert.strictEqual(stored[0].desktopId, "vlc.desktop");
    assert.strictEqual(stored[0].executable, "vlc");
    assert.deepStrictEqual(stored[0].args, ["--started-from-file"]);
    assert.deepStrictEqual(stored[0].wmClass, ["vlc"]);
    const installed = harness.applicationService.info("vlc");
    assert.strictEqual(installed.available, true);
    assert.strictEqual(installed.desktopId, "vlc.desktop");
    assert.strictEqual(installed.executable, "vlc");
    assert.deepStrictEqual(installed.args, ["--started-from-file"]);
    assert.deepStrictEqual(installed.windowMatchers, [{className: "vlc"}]);
    assertAtomicRename(harness);
}

async function testNoExistingEntryRegistersNormally(root) {
    const harness = createHarness(path.join(root, "new-entry"));
    const result = await invoke(["install", "vlc", "--apply"], {
        applicationService: harness.applicationService,
        installService: harness.installService,
        confirm: () => Promise.resolve(true)
    });
    assert.strictEqual(result.code, 0);
    assert(result.stdout.includes("INSTALL COMPLETE\nAPPLICATION REGISTERED\nAPPLICATION ADDED"));
    const stored = JSON.parse(fs.readFileSync(harness.registryPath, "utf8")).applications;
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].id, "vlc");
    assertAtomicRename(harness);
}

function testProtectedBuiltInsAreRejected(root) {
    const harness = createHarness(path.join(root, "protected"), {initialApplications: []});
    const original = fs.readFileSync(harness.registryPath, "utf8");
    ["terminal", "notes", "code", "browser"].forEach(id => {
        const candidate = {
            id,
            displayName: id.toUpperCase(),
            desktopId: `${id}.desktop`,
            executable: `protected-${id}`,
            args: [],
            startupWMClass: id,
            status: "MANAGEABLE"
        };
        assert.throws(() => harness.applicationService.reconcileInstalledCandidate(candidate, {
            id,
            aliases: [],
            desktopIds: [`${id}.desktop`],
            sources: [{source: "APT", package: id}]
        }), /PROTECTED APPLICATION CANNOT BE OVERRIDDEN/);
    });
    assert.strictEqual(fs.readFileSync(harness.registryPath, "utf8"), original);
    assert.strictEqual(harness.renameCalls.length, 0);
}

async function testUnrelatedSameIdIsRejected(root) {
    const harness = createHarness(path.join(root, "unrelated"), {
        initialApplications: [templateVlc({
            displayName: "UNRELATED PLAYER",
            desktopId: "unrelated-player.desktop",
            executable: "unrelated-player",
            args: [],
            wmClass: ["UnrelatedPlayer"]
        })]
    });
    const original = fs.readFileSync(harness.registryPath, "utf8");
    const result = await invoke(["install", "vlc", "--apply"], {
        applicationService: harness.applicationService,
        installService: harness.installService,
        confirm: () => Promise.resolve(true)
    });
    assert.strictEqual(result.code, 1);
    assert(result.stdout.includes("INSTALL COMPLETE\nAPPLICATION REGISTRATION FAILED"));
    assert(!result.stdout.includes("APPLICATION REGISTERED"));
    assert(result.stderr.includes("APPLICATION ID CONFLICT: vlc"));
    assert(result.stderr.includes("DOES NOT MATCH TRUSTED APPLICATION METADATA"));
    assert.strictEqual(harness.spawnCount(), 1, "package installation still completes before registration fails");
    assert.strictEqual(fs.readFileSync(harness.registryPath, "utf8"), original);
    assert.strictEqual(harness.renameCalls.length, 0);
}

async function testAlreadyInstalledRetryRepairsTemplate(root) {
    const harness = createHarness(path.join(root, "retry"), {
        initialApplications: [templateVlc()]
    });
    harness.executables.add("vlc");
    writeVlcDesktop(harness.applicationsDirectory);

    const result = await invoke(["install", "vlc", "--apply"], {
        applicationService: harness.applicationService,
        installService: harness.installService,
        confirm: () => Promise.resolve(true)
    });
    assert.strictEqual(result.code, 0);
    assert(result.stdout.includes("APPLICATION ALREADY INSTALLED\nAPPLICATION REGISTERED\nAPPLICATION UPDATED"));
    assert.strictEqual(harness.spawnCount(), 0, "repairing registration must not reinstall the package");
    assert.strictEqual(harness.applicationService.info("vlc").available, true);
    assertAtomicRename(harness);
}

function testAtomicFailurePreservesRegistry(root) {
    const harness = createHarness(path.join(root, "atomic-failure"), {
        initialApplications: [templateVlc()],
        renameFailure: new Error("simulated atomic rename failure")
    });
    harness.executables.add("vlc");
    writeVlcDesktop(harness.applicationsDirectory);
    const original = fs.readFileSync(harness.registryPath, "utf8");
    const definition = harness.installService.definition("vlc");

    assert.throws(() => harness.installService.registerInstalled(definition), /REGISTRY WRITE FAILED/);
    assert.strictEqual(fs.readFileSync(harness.registryPath, "utf8"), original);
    assert.strictEqual(harness.renameCalls.length, 1);
    const temporaryFiles = fs.readdirSync(path.dirname(harness.registryPath))
        .filter(file => file.startsWith(".apps.json.tmp-"));
    assert.deepStrictEqual(temporaryFiles, [], "failed atomic writes must clean up their temporary file");
}

async function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-post-install-registration-"));
    try {
        await testUnavailableEntryReconciles(temporaryRoot);
        await testNoExistingEntryRegistersNormally(temporaryRoot);
        testProtectedBuiltInsAreRejected(temporaryRoot);
        await testUnrelatedSameIdIsRejected(temporaryRoot);
        await testAlreadyInstalledRetryRepairsTemplate(temporaryRoot);
        testAtomicFailurePreservesRegistry(temporaryRoot);
    } finally {
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
    console.log("Post-install application registration reconciliation, conflicts, preferences, and atomicity passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
