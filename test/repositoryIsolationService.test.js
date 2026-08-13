const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    RepositoryIsolationService,
    buildRepositoryRunEnvironment,
    escapeSystemdPath,
    isSensitiveEnvironmentKey
} = require("../src/classes/repositoryIsolationService.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-isolation-"));

try {
    const repositoryPath = path.join(temporaryRoot, "repository");
    const runtimeRoot = path.join(temporaryRoot, "runtime");
    fs.mkdirSync(repositoryPath);
    const repository = {
        id: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        canonicalPath: fs.realpathSync(repositoryPath)
    };
    const sourceEnvironment = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C",
        TERM: "xterm-256color",
        HOME: "/home/real-user",
        DISPLAY: ":0",
        XAUTHORITY: "/home/real-user/.Xauthority",
        XDG_RUNTIME_DIR: "/run/user/1000",
        SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
        GITHUB_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        AZURE_CLIENT_SECRET: "secret",
        GOOGLE_APPLICATION_CREDENTIALS: "/secret.json",
        DATABASE_URL: "postgres://secret",
        SERVICE_PASSWORD: "secret",
        NODE_OPTIONS: "--require=/tmp/inject.js",
        LD_PRELOAD: "/tmp/inject.so",
        NVM_DIR: "/home/real-user/.nvm"
    };
    const minimal = buildRepositoryRunEnvironment(sourceEnvironment, {
        HOME: "/isolated/home",
        TMPDIR: "/isolated/tmp",
        ATTACKER_TOKEN: "must-not-be-added"
    });
    assert.strictEqual(minimal.ATTACKER_TOKEN, undefined);
    assert.strictEqual(escapeSystemdPath("/home/user/My Repo:demo"), "/home/user/My\\x20Repo\\x3ademo");
    assert.deepStrictEqual(minimal, {
        PATH: sourceEnvironment.PATH,
        LANG: "C.UTF-8",
        LC_ALL: "C",
        TERM: "xterm-256color",
        HOME: "/isolated/home",
        TMPDIR: "/isolated/tmp"
    });
    [
        "SSH_AUTH_SOCK", "GITHUB_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY",
        "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS", "DATABASE_URL",
        "SERVICE_PASSWORD", "NODE_OPTIONS", "LD_PRELOAD", "NVM_DIR"
    ].forEach(key => assert.strictEqual(isSensitiveEnvironmentKey(key), true, `${key} must be considered sensitive`));

    const direct = new RepositoryIsolationService({
        env: sourceEnvironment,
        runtimeRoot,
        probeBackend: () => false
    });
    const capabilities = direct.capabilities();
    assert.strictEqual(capabilities.maximumLevel, "NONE");
    assert.strictEqual(capabilities.preferredBackend, "DIRECT");
    assert.strictEqual(direct.evaluatePolicy("NORMAL").allowed, true);
    assert.strictEqual(direct.evaluatePolicy("NORMAL").level, "NONE");
    assert.deepStrictEqual(
        direct.evaluatePolicy("PUBLIC").status,
        "EXECUTION BLOCKED\nISOLATION REQUIREMENT NOT MET"
    );
    assert.deepStrictEqual(
        direct.evaluatePolicy("LOCKDOWN").status,
        "EXECUTION BLOCKED\nLOCKDOWN POLICY DISABLES REPOSITORY EXECUTION"
    );

    const directPlan = direct.prepareExecution({
        repository,
        executable: process.execPath,
        args: ["--version"],
        securityProfile: "NORMAL"
    });
    assert.strictEqual(directPlan.allowed, true);
    assert.strictEqual(directPlan.level, "NONE");
    assert.strictEqual(directPlan.backend, "DIRECT");
    assert.strictEqual(directPlan.executable, process.execPath);
    assert.deepStrictEqual(directPlan.args, ["--version"]);
    assert(directPlan.env.HOME.startsWith(`${runtimeRoot}${path.sep}${repository.id}-`));
    assert.notStrictEqual(directPlan.env.HOME, sourceEnvironment.HOME);
    assert.strictEqual(directPlan.env.GITHUB_TOKEN, undefined);
    assert.strictEqual(directPlan.env.DISPLAY, undefined);
    const directRuntime = directPlan.runtimeDirectory;
    assert(fs.statSync(directRuntime).isDirectory());
    direct.cleanup(directPlan);
    assert.strictEqual(fs.existsSync(directRuntime), false, "only the generated runtime directory should be removed");

    const toolPaths = {
        bwrap: "/usr/bin/bwrap",
        true: "/usr/bin/true",
        "systemd-run": "/usr/bin/systemd-run",
        systemctl: "/usr/bin/systemctl",
        env: "/usr/bin/env"
    };
    const strong = new RepositoryIsolationService({
        env: sourceEnvironment,
        home: "/home/real-user",
        resolveExecutable: name => toolPaths[name] || (path.isAbsolute(name) ? name : null),
        probeBackend: id => id === "BUBBLEWRAP"
    });
    assert.strictEqual(strong.capabilities().maximumLevel, "STRONG");
    const strongPlan = strong.prepareExecution({
        repository,
        executable: "/usr/bin/node",
        args: ["app.js", "literal;argument"],
        securityProfile: "PUBLIC"
    });
    assert.strictEqual(strongPlan.level, "STRONG");
    assert.strictEqual(strongPlan.backend, "BUBBLEWRAP");
    assert.strictEqual(strongPlan.executable, "/usr/bin/bwrap");
    assert(strongPlan.args.includes("--clearenv"));
    assert(strongPlan.args.includes("--unshare-all"));
    assert(strongPlan.args.includes("--cap-drop"));
    assert(strongPlan.args.includes(repository.canonicalPath));
    assert(!strongPlan.args.some((argument, index) => argument === "--ro-bind"
        && strongPlan.args[index + 1] === "/" && strongPlan.args[index + 2] === "/"));
    assert(!JSON.stringify(strongPlan).includes("/home/real-user"));
    assert.deepStrictEqual(strongPlan.args.slice(-3), ["/usr/bin/node", "app.js", "literal;argument"]);
    assert(!JSON.stringify(strongPlan).includes("secret"));
    assert(!JSON.stringify(strongPlan).includes("SSH_AUTH_SOCK"));
    const nvmExecutable = "/home/real-user/.nvm/versions/node/v14.21.3/lib/node_modules/npm/bin/npm-cli.js";
    const nvmPlan = strong.prepareExecution({
        repository,
        executable: nvmExecutable,
        args: ["run", "start"],
        securityProfile: "PUBLIC"
    });
    const nvmRuntimeRoot = "/home/real-user/.nvm/versions/node/v14.21.3";
    assert(nvmPlan.args.some((argument, index) => argument === "--ro-bind"
        && nvmPlan.args[index + 1] === nvmRuntimeRoot && nvmPlan.args[index + 2] === nvmRuntimeRoot));
    assert(!nvmPlan.args.some((argument, index) => argument === "--ro-bind"
        && nvmPlan.args[index + 1] === "/home/real-user"));

    const controlCalls = [];
    const partial = new RepositoryIsolationService({
        env: sourceEnvironment,
        home: "/home/real-user",
        resolveExecutable: name => toolPaths[name] || (path.isAbsolute(name) ? name : null),
        probeBackend: id => id === "SYSTEMD_USER",
        spawnSync: (executable, args, options) => {
            controlCalls.push({executable, args, options});
            return {status: 0, stdout: "", stderr: ""};
        },
        randomBytes: () => Buffer.alloc(6, 4)
    });
    assert.strictEqual(partial.capabilities().maximumLevel, "PARTIAL");
    const partialPlan = partial.prepareExecution({
        repository,
        executable: "/usr/bin/python3",
        args: ["main.py"],
        securityProfile: "PUBLIC"
    });
    assert.strictEqual(partialPlan.level, "PARTIAL");
    assert.strictEqual(partialPlan.backend, "SYSTEMD_USER");
    assert.strictEqual(partialPlan.executable, "/usr/bin/systemd-run");
    assert(partialPlan.args.includes("--property=NoNewPrivileges=yes"));
    assert(partialPlan.args.includes("--property=ProtectHome=tmpfs"));
    assert(partialPlan.args.includes(`--property=BindPaths=${repository.canonicalPath}`));
    assert(partialPlan.args.includes("/usr/bin/env"));
    assert(partialPlan.args.includes("-i"));
    assert.deepStrictEqual(partialPlan.args.slice(-2), ["/usr/bin/python3", "main.py"]);
    assert(!JSON.stringify(partialPlan).match(/sudo|pkexec|mount|umount|shell.?true/i));
    assert.strictEqual(partialPlan.env.GITHUB_TOKEN, undefined);
    assert.strictEqual(partial.signal(partialPlan.controller, "SIGTERM"), true);
    assert.deepStrictEqual(controlCalls[0].args, [
        "--user", "kill", "--kill-whom=all", "--signal=SIGTERM", partialPlan.controller.unitName
    ]);
    assert.strictEqual(controlCalls[0].options.shell, false);

    const probeCalls = [];
    const probed = new RepositoryIsolationService({
        env: {PATH: "/usr/bin", LANG: "C"},
        resolveExecutable: name => toolPaths[name] || (path.isAbsolute(name) ? name : null),
        spawnSync: (executable, args, options) => {
            probeCalls.push({executable, args, options});
            return {status: 0, stdout: "", stderr: ""};
        },
        randomBytes: () => Buffer.alloc(6, 8)
    });
    assert.strictEqual(probed.capabilities().maximumLevel, "STRONG");
    assert(probeCalls.length >= 2);
    assert(probeCalls.every(call => call.options.shell === false));
    assert(probeCalls.some(call => call.executable === "/usr/bin/bwrap"));
    assert(probeCalls.some(call => call.executable === "/usr/bin/systemd-run"));

    console.log("Repository isolation capability probes, profile minimums, structured backends, and minimal environments passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
