const assert = require("assert");
const {EventEmitter} = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {ApplicationService} = require("../src/cli/applicationService.js");
const {InstallService} = require("../src/cli/installService.js");
const {runCli} = require("../src/cli/nomadCli.js");
const {DesktopEntryDiscovery} = require("../src/classes/desktopEntryDiscovery.js");

function desktopEntry(values) {
    return `[Desktop Entry]
Type=${values.type || "Application"}
Name=${values.name}
Exec=${values.exec || values.id}
${values.wmClass ? `StartupWMClass=${values.wmClass}\n` : ""}Hidden=${values.hidden ? "true" : "false"}
NoDisplay=${values.noDisplay ? "true" : "false"}
Terminal=${values.terminal ? "true" : "false"}
`;
}

function writeDesktop(directory, desktopId, values) {
    fs.writeFileSync(path.join(directory, desktopId), desktopEntry(Object.assign({id: desktopId.replace(/\.desktop$/, "")}, values)));
}

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

async function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-cli-"));
    const home = path.join(temporaryRoot, "home");
    const applicationsDirectory = path.join(temporaryRoot, "applications");
    const registryPath = path.join(home, ".config", "nomad", "apps.json");
    fs.mkdirSync(applicationsDirectory, {recursive: true});

    writeDesktop(applicationsDirectory, "spotify.desktop", {
        name: "Spotify",
        exec: "spotify --safe semi;colon-is-literal %U",
        wmClass: "Spotify"
    });
    writeDesktop(applicationsDirectory, "vlc.desktop", {
        name: "VLC media player",
        exec: "vlc --started-from-file %F",
        wmClass: "vlc"
    });
    writeDesktop(applicationsDirectory, "obsidian.desktop", {
        name: "Obsidian",
        exec: "obsidian"
    });
    writeDesktop(applicationsDirectory, "code.desktop", {
        name: "Attempted Code Override",
        exec: "code",
        wmClass: "CodeOverride"
    });
    writeDesktop(applicationsDirectory, "hidden.desktop", {
        name: "Hidden Utility",
        exec: "hidden",
        wmClass: "Hidden",
        hidden: true
    });
    writeDesktop(applicationsDirectory, "nodisplay.desktop", {
        name: "No Display Utility",
        exec: "nodisplay",
        wmClass: "NoDisplay",
        noDisplay: true
    });
    writeDesktop(applicationsDirectory, "link-handler.desktop", {
        name: "Link Handler",
        exec: "link-handler",
        type: "Link",
        wmClass: "Link"
    });
    writeDesktop(applicationsDirectory, "system-helper.desktop", {
        name: "System Helper",
        exec: "system-helper",
        wmClass: "Helper"
    });
    writeDesktop(applicationsDirectory, "terminal-task.desktop", {
        name: "Terminal Task",
        exec: "terminal-task",
        wmClass: "TerminalTask",
        terminal: true
    });
    writeDesktop(applicationsDirectory, "unsafe.desktop", {
        name: "Unsafe Wrapper",
        exec: "sh -c anything",
        wmClass: "Unsafe"
    });

    const executables = new Set(["code", "firefox", "spotify", "vlc", "obsidian"]);
    const discovery = new DesktopEntryDiscovery({directories: [applicationsDirectory]});
    const renameCalls = [];
    const observedFs = Object.create(fs);
    observedFs.renameSync = (source, target) => {
        renameCalls.push({source, target});
        return fs.renameSync(source, target);
    };
    const applicationService = new ApplicationService({
        fs: observedFs,
        home,
        registryPath,
        discovery,
        executableExists: executable => executables.has(executable)
    });

    const scan = await invoke(["app", "scan"], {applicationService});
    assert.strictEqual(scan.code, 0);
    assert(scan.stdout.includes("ID: spotify"));
    assert(scan.stdout.includes("STATUS: MANAGEABLE"));
    assert(scan.stdout.includes("ID: obsidian"));
    assert(scan.stdout.includes("STATUS: NEEDS WM_CLASS"));
    assert(scan.stdout.includes("ID: unsafe"));
    assert(scan.stdout.includes("STATUS: UNSUPPORTED"));
    ["Hidden Utility", "No Display Utility", "Link Handler", "System Helper", "Terminal Task"].forEach(name => {
        assert(!scan.stdout.includes(name), `${name} must be filtered from scan candidates`);
    });

    const added = await invoke(["app", "add", "spotify"], {applicationService});
    assert.strictEqual(added.code, 0);
    assert(added.stdout.includes("APPLICATION ADDED"));
    assert(fs.existsSync(registryPath), "app add must create apps.json and its parents");
    assert.strictEqual(fs.statSync(registryPath).mode & 0o777, 0o600);
    const registryAfterAdd = fs.readFileSync(registryPath, "utf8");
    const parsedAfterAdd = JSON.parse(registryAfterAdd);
    assert.strictEqual(parsedAfterAdd.version, 1);
    assert.strictEqual(parsedAfterAdd.applications.length, 1);
    assert.deepStrictEqual(parsedAfterAdd.applications[0].args, ["--safe", "semi;colon-is-literal"]);
    assert.deepStrictEqual(parsedAfterAdd.applications[0].wmClass, ["Spotify"]);
    assert.strictEqual(renameCalls.length, 1, "app add must use one atomic rename");
    assert(renameCalls[0].source.includes(".apps.json.tmp-"));
    assert.strictEqual(renameCalls[0].target, registryPath);

    const duplicate = await invoke(["app", "add", "spotify.desktop"], {applicationService});
    assert.strictEqual(duplicate.code, 0);
    assert(duplicate.stdout.includes("APPLICATION ALREADY REGISTERED"));
    assert.strictEqual(fs.readFileSync(registryPath, "utf8"), registryAfterAdd);
    assert.strictEqual(renameCalls.length, 1, "a duplicate add must not rewrite the registry");

    const listed = await invoke(["app", "list"], {applicationService});
    assert.strictEqual(listed.code, 0);
    assert(listed.stdout.includes("CODE"));
    assert(listed.stdout.includes("BROWSER"));
    assert(listed.stdout.includes("SPOTIFY"));
    assert(listed.stdout.includes("BUILTIN"));
    assert(listed.stdout.includes("USER"));

    const protectedBefore = fs.readFileSync(registryPath, "utf8");
    const protectedAdd = await invoke(["app", "add", "code.desktop"], {applicationService});
    assert.strictEqual(protectedAdd.code, 1);
    assert(protectedAdd.stderr.includes("PROTECTED APPLICATION"));
    assert.strictEqual(fs.readFileSync(registryPath, "utf8"), protectedBefore);

    const incomplete = await invoke(["app", "add", "obsidian"], {applicationService});
    assert.strictEqual(incomplete.code, 0);
    assert(incomplete.stdout.includes("WINDOW CLASS REQUIRED"));
    const incompleteInfo = await invoke(["app", "info", "obsidian"], {applicationService});
    assert(incompleteInfo.stdout.includes("STATUS: UNAVAILABLE"));
    assert(incompleteInfo.stdout.includes("WINDOW CLASS REQUIRED"));
    assert(!incompleteInfo.stdout.includes("EXECUTABLE:"), "default info must hide execution metadata");
    const verboseInfo = await invoke(["app", "info", "obsidian", "--verbose"], {applicationService});
    assert(verboseInfo.stdout.includes("EXECUTABLE: obsidian"));

    const removed = await invoke(["app", "remove", "spotify"], {applicationService});
    assert.strictEqual(removed.code, 0);
    assert(removed.stdout.includes("APPLICATION REMOVED"));
    assert(!JSON.parse(fs.readFileSync(registryPath, "utf8")).applications.some(application => application.id === "spotify"));
    const removeBuiltIn = await invoke(["app", "remove", "terminal"], {applicationService});
    assert.strictEqual(removeBuiltIn.code, 1);
    assert(removeBuiltIn.stderr.includes("BUILT-IN APPLICATION CANNOT BE REMOVED"));

    const validRegistry = fs.readFileSync(registryPath, "utf8");
    const corruptedRegistry = "{ this registry is deliberately malformed\n";
    fs.writeFileSync(registryPath, corruptedRegistry);
    const corruptAdd = await invoke(["app", "add", "vlc"], {applicationService});
    assert.strictEqual(corruptAdd.code, 1);
    assert(corruptAdd.stderr.includes("REGISTRY INVALID"));
    assert(corruptAdd.stderr.includes("PRESERVED"));
    assert.strictEqual(fs.readFileSync(registryPath, "utf8"), corruptedRegistry);
    fs.writeFileSync(registryPath, validRegistry, {mode: 0o600});

    for (const invalidIdentifier of ["../spotify", "spotify;touch", `bad\u0007id`, "x".repeat(300)]) {
        const invalid = await invoke(["app", "add", invalidIdentifier], {applicationService});
        assert.strictEqual(invalid.code, 1);
        assert(invalid.stderr.includes("IDENTIFIER INVALID"));
    }

    const symlinkRoot = path.join(temporaryRoot, "symlink-test");
    const victim = path.join(symlinkRoot, "victim.json");
    const symlinkRegistry = path.join(symlinkRoot, "config", "apps.json");
    fs.mkdirSync(path.dirname(symlinkRegistry), {recursive: true});
    fs.writeFileSync(victim, "DO NOT CHANGE");
    fs.symlinkSync(victim, symlinkRegistry);
    const symlinkService = new ApplicationService({
        registryPath: symlinkRegistry,
        discovery,
        executableExists: executable => executables.has(executable)
    });
    const symlinkAdd = await invoke(["app", "add", "vlc"], {applicationService: symlinkService});
    assert.strictEqual(symlinkAdd.code, 1);
    assert(symlinkAdd.stderr.includes("symbolic link"));
    assert.strictEqual(fs.readFileSync(victim, "utf8"), "DO NOT CHANGE");

    const installRoot = path.join(temporaryRoot, "install");
    const installApplications = path.join(installRoot, "applications");
    const installRegistry = path.join(installRoot, "home", ".config", "nomad", "apps.json");
    fs.mkdirSync(installApplications, {recursive: true});
    const installedExecutables = new Set(["code", "firefox"]);
    const installApplicationService = new ApplicationService({
        registryPath: installRegistry,
        discovery: new DesktopEntryDiscovery({directories: [installApplications]}),
        executableExists: executable => installedExecutables.has(executable)
    });
    const tools = {
        sudo: "/trusted/bin/sudo",
        "apt-get": "/trusted/bin/apt-get",
        "apt-cache": "/trusted/bin/apt-cache",
        snap: "/trusted/bin/snap",
        flatpak: "/trusted/bin/flatpak"
    };
    const probes = [];
    const spawnCalls = [];
    const installService = new InstallService({
        applicationService: installApplicationService,
        resolveTool: name => tools[name] || null,
        probe: (executable, args, options) => {
            probes.push({executable, args, options});
            if (path.basename(executable) === "apt-cache") return {status: 0, stdout: "Package: vlc\n"};
            return {status: 1, stdout: ""};
        },
        spawn: (executable, args, options) => {
            spawnCalls.push({executable, args, options});
            const child = new EventEmitter();
            process.nextTick(() => {
                installedExecutables.add("vlc");
                writeDesktop(installApplications, "vlc.desktop", {
                    name: "VLC media player",
                    exec: "vlc --started-from-file %F",
                    wmClass: "vlc"
                });
                child.emit("exit", 0, null);
            });
            return child;
        }
    });

    assert.deepStrictEqual(installService.detectSources(), [
        {source: "APT", available: true},
        {source: "SNAP", available: true},
        {source: "FLATPAK", available: true}
    ]);
    const plan = installService.plan("vlc");
    assert.strictEqual(plan.executable, "/trusted/bin/sudo");
    assert.deepStrictEqual(Array.from(plan.args), ["/trusted/bin/apt-get", "install", "--", "vlc"]);
    assert.strictEqual(plan.source, "APT");
    assert(probes.every(probe => probe.options.shell === false));
    assert(!JSON.stringify(plan).match(/add-apt-repository|apt-key|curl|wget|repository|signing/i));

    const planOnly = await invoke(["install", "vlc"], {
        applicationService: installApplicationService,
        installService
    });
    assert.strictEqual(planOnly.code, 0);
    assert(planOnly.stdout.includes("PLAN ONLY"));
    assert.strictEqual(spawnCalls.length, 0, "install without --apply must never spawn a package manager");

    let confirmationRequests = 0;
    const cancelled = await invoke(["install", "vlc", "--apply"], {
        applicationService: installApplicationService,
        installService,
        confirm: () => {
            confirmationRequests++;
            return Promise.resolve(false);
        }
    });
    assert.strictEqual(cancelled.code, 0);
    assert(cancelled.stdout.includes("INSTALL CANCELLED"));
    assert.strictEqual(confirmationRequests, 1);
    assert.strictEqual(spawnCalls.length, 0);

    const applied = await invoke(["install", "vlc", "--apply"], {
        applicationService: installApplicationService,
        installService,
        confirm: () => {
            confirmationRequests++;
            return Promise.resolve(true);
        }
    });
    assert.strictEqual(applied.code, 0);
    assert(applied.stdout.includes("INSTALL COMPLETE"));
    assert(applied.stdout.includes("APPLICATION REGISTERED"));
    assert(applied.stdout.includes("APPLICATION ADDED"));
    assert.strictEqual(spawnCalls.length, 1);
    assert.deepStrictEqual(spawnCalls[0], {
        executable: "/trusted/bin/sudo",
        args: ["/trusted/bin/apt-get", "install", "--", "vlc"],
        options: {stdio: "inherit", shell: false}
    });
    assert(JSON.parse(fs.readFileSync(installRegistry, "utf8")).applications.some(application => application.id === "vlc"));
    assert(installApplicationService.info("vlc").available, "post-install registration must validate availability");

    const arbitrary = await invoke(["install", "sudo;apt-get"], {
        applicationService: installApplicationService,
        installService,
        confirm: () => Promise.resolve(true)
    });
    assert.strictEqual(arbitrary.code, 1);
    assert(arbitrary.stderr.includes("IDENTIFIER INVALID"));
    assert.strictEqual(spawnCalls.length, 1);

    const reload = await invoke(["app", "reload"], {applicationService: installApplicationService});
    assert.strictEqual(reload.code, 0);
    assert(reload.stdout.includes("RESTART NOMAD SESSION TO APPLY"));

    const repositoryCalls = [];
    const repositoryCliService = {
        list: async () => ({
            status: null,
            repositories: [{
                id: "repo_0123456789abcdef0123456789abcdef",
                displayName: "NOMAD-UI",
                branch: "main",
                status: "CLEAN",
                pullState: "PULL"
            }]
        }),
        clone: async repositoryUrl => {
            repositoryCalls.push(["clone", repositoryUrl]);
            return {ok: true, status: "CLONE COMPLETE\nREPOSITORY REGISTERED"};
        },
        info: async repository => {
            repositoryCalls.push(["info", repository]);
            return {
                id: "repo_0123456789abcdef0123456789abcdef",
                displayName: "NOMAD-UI",
                branch: "main",
                status: "CLEAN",
                remote: "https://github.com/nomad-lab/NOMAD-UI",
                upstream: "origin/main",
                ahead: 0,
                behind: 1,
                pullState: "PULL"
            };
        },
        pull: async repository => {
            repositoryCalls.push(["pull", repository]);
            return {ok: true, status: "UPDATE COMPLETE"};
        }
    };
    const repositoryList = await invoke(["repo", "list"], {repositoryCliService});
    assert.strictEqual(repositoryList.code, 0);
    assert(repositoryList.stdout.includes("NOMAD REPOSITORIES"));
    assert(repositoryList.stdout.includes("NOMAD-UI"));
    assert(repositoryList.stdout.includes("PULL"));
    const repositoryClone = await invoke(["repo", "clone", "git@github.com:owner/repo.git"], {repositoryCliService});
    assert.strictEqual(repositoryClone.code, 0);
    assert(repositoryClone.stdout.includes("REPOSITORY REGISTERED"));
    const repositoryInfo = await invoke(["repo", "info", "NOMAD-UI"], {repositoryCliService});
    assert.strictEqual(repositoryInfo.code, 0);
    assert(repositoryInfo.stdout.includes("UPSTREAM: origin/main"));
    assert(repositoryInfo.stdout.includes("BEHIND: 1"));
    const repositoryPull = await invoke(["repo", "pull", "NOMAD-UI"], {repositoryCliService});
    assert.strictEqual(repositoryPull.code, 0);
    assert(repositoryPull.stdout.includes("UPDATE COMPLETE"));
    assert.deepStrictEqual(repositoryCalls, [
        ["clone", "git@github.com:owner/repo.git"],
        ["info", "NOMAD-UI"],
        ["pull", "NOMAD-UI"]
    ]);
    const rawGit = await invoke(["repo", "git", "status"], {repositoryCliService});
    assert.strictEqual(rawGit.code, 2);
    assert(rawGit.stderr.includes("UNKNOWN REPO COMMAND"));

    const help = await invoke(["--help"], {});
    const appHelp = await invoke(["app", "--help"], {});
    const repoHelp = await invoke(["repo", "--help"], {});
    assert.strictEqual(help.code, 0);
    assert(help.stdout.includes("nomad install <application> [--apply]"));
    assert(help.stdout.includes("repo clone <github-url>"));
    assert.strictEqual(appHelp.code, 0);
    assert(appHelp.stdout.includes("nomad app scan"));
    assert.strictEqual(repoHelp.code, 0);
    assert(repoHelp.stdout.includes("nomad repo pull <repository>"));

    fs.rmSync(temporaryRoot, {recursive: true, force: true});
    console.log("NOMAD CLI registry, discovery, install planning, execution safety, and post-install registration passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
