const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const installScript = path.join(repositoryRoot, "scripts", "install-nomad-session.sh");
const uninstallScript = path.join(repositoryRoot, "scripts", "uninstall-nomad-session.sh");
const cliSource = path.join(repositoryRoot, "bin", "nomad");

function environment(root) {
    const fakeBin = path.join(root, "fake-bin");
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const userBin = path.join(home, ".local", "bin");
    const systemRoot = path.join(root, "system");
    fs.mkdirSync(fakeBin, {recursive: true});
    fs.mkdirSync(home, {recursive: true});
    const sudo = path.join(fakeBin, "sudo");
    fs.writeFileSync(sudo, "#!/usr/bin/env bash\nexec \"$@\"\n", {mode: 0o755});
    return {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        NOMAD_USER_BIN_DIR: userBin,
        NOMAD_SYSTEM_LAUNCHER: path.join(systemRoot, "usr", "local", "bin", "nomad-session"),
        NOMAD_SYSTEM_DESKTOP: path.join(systemRoot, "usr", "share", "xsessions", "nomad.desktop"),
        NOMAD_SYSTEM_MARKER: path.join(systemRoot, "usr", "local", "share", "nomad", "session-v0.3-a"),
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        NOMAD_NODE: process.execPath
    };
}

function run(script, env) {
    return childProcess.spawnSync("bash", [script], {
        cwd: repositoryRoot,
        env: Object.assign({}, process.env, env),
        encoding: "utf8",
        shell: false
    });
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-cli-installer-"));

const ownedRoot = path.join(temporaryRoot, "owned");
const ownedEnv = environment(ownedRoot);
const installed = run(installScript, ownedEnv);
assert.strictEqual(installed.status, 0, installed.stderr);
const ownedLauncher = path.join(ownedEnv.NOMAD_USER_BIN_DIR, "nomad");
const ownedMarker = path.join(ownedEnv.XDG_CONFIG_HOME, "nomad", ".cli-v0.4-d-installed");
assert(fs.lstatSync(ownedLauncher).isSymbolicLink());
assert.strictEqual(fs.readlinkSync(ownedLauncher), cliSource);
assert.deepStrictEqual(fs.readFileSync(ownedMarker, "utf8").trim().split("\n"), [
    "NOMAD-UI CLI v0.4-d",
    cliSource
]);
assert(installed.stdout.includes("Installed the NOMAD CLI launcher"));

fs.accessSync(cliSource, fs.constants.X_OK);

const preservedRegistry = path.join(ownedEnv.XDG_CONFIG_HOME, "nomad", "apps.json");
fs.writeFileSync(preservedRegistry, "{\n    \"version\": 1,\n    \"applications\": []\n}\n");
const uninstalled = run(uninstallScript, ownedEnv);
assert.strictEqual(uninstalled.status, 0, uninstalled.stderr);
assert(!fs.existsSync(ownedLauncher));
assert(!fs.existsSync(ownedMarker));
assert(fs.existsSync(preservedRegistry), "uninstaller must preserve the user application registry");
assert(fs.existsSync(path.join(ownedEnv.XDG_CONFIG_HOME, "nomad", "session.env")));
assert(uninstalled.stdout.includes("Removed the NOMAD-owned CLI launcher"));

const collisionRoot = path.join(temporaryRoot, "collision");
const collisionEnv = environment(collisionRoot);
const collisionLauncher = path.join(collisionEnv.NOMAD_USER_BIN_DIR, "nomad");
fs.mkdirSync(path.dirname(collisionLauncher), {recursive: true});
fs.writeFileSync(collisionLauncher, "unrelated launcher\n", {mode: 0o755});
const collisionInstall = run(installScript, collisionEnv);
assert.notStrictEqual(collisionInstall.status, 0);
assert(collisionInstall.stderr.includes("Refusing to overwrite an unmanaged file"));
assert.strictEqual(fs.readFileSync(collisionLauncher, "utf8"), "unrelated launcher\n");

const changedRoot = path.join(temporaryRoot, "changed");
const changedEnv = environment(changedRoot);
const changedInstall = run(installScript, changedEnv);
assert.strictEqual(changedInstall.status, 0, changedInstall.stderr);
const changedLauncher = path.join(changedEnv.NOMAD_USER_BIN_DIR, "nomad");
fs.unlinkSync(changedLauncher);
fs.writeFileSync(changedLauncher, "replacement launcher\n", {mode: 0o755});
const changedUninstall = run(uninstallScript, changedEnv);
assert.strictEqual(changedUninstall.status, 0, changedUninstall.stderr);
assert.strictEqual(fs.readFileSync(changedLauncher, "utf8"), "replacement launcher\n");
assert(changedUninstall.stdout.includes("CLI launcher changed; leaving it untouched"));

fs.rmSync(temporaryRoot, {recursive: true, force: true});
console.log("NOMAD session installer CLI ownership, collision handling, and safe uninstall passed");
