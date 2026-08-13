const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {inventoryEnvironment, isSensitiveEnvironmentKey} = require("../src/classes/securityEnvironmentService.js");

const repositoryRoot = path.resolve(__dirname, "..");
const launcher = path.join(repositoryRoot, "session", "nomad-session");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-session-environment-"));

try {
    const home = path.join(temporaryRoot, "home");
    const configBase = path.join(temporaryRoot, "config");
    const stateBase = path.join(temporaryRoot, "state");
    const runtime = path.join(temporaryRoot, "runtime");
    const nomadRoot = path.join(temporaryRoot, "NOMAD-UI");
    const nvmRoot = path.join(temporaryRoot, "nvm");
    const fakeBin = path.join(nvmRoot, "versions", "node", "v14.99.0", "bin");
    const captureNames = path.join(temporaryRoot, "environment-names.txt");
    const captureRequired = path.join(temporaryRoot, "required-session.txt");
    const nomadConfig = path.join(configBase, "nomad");
    [home, nomadConfig, stateBase, runtime, nomadRoot, nvmRoot, fakeBin].forEach(directory => {
        fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    });
    [home, nomadConfig, stateBase, runtime, nomadRoot, nvmRoot, fakeBin].forEach(directory => fs.chmodSync(directory, 0o700));
    fs.writeFileSync(path.join(nomadRoot, "package.json"), "{}\n", {mode: 0o600});
    fs.writeFileSync(path.join(nomadConfig, "session.env"),
        `NOMAD_ROOT=${nomadRoot}\nNVM_DIR=${nvmRoot}\n`, {mode: 0o600});
    fs.chmodSync(path.join(nomadConfig, "session.env"), 0o600);
    fs.writeFileSync(path.join(nvmRoot, "nvm.sh"), [
        "nvm() {",
        "    if [[ \"${1:-}\" == \"use\" && \"${2:-}\" == \"14\" ]]; then",
        `        PATH=${fakeBin}:\"$PATH\"`,
        "        export PATH",
        "        return 0",
        "    fi",
        "    return 1",
        "}",
        ""
    ].join("\n"), {mode: 0o600});
    fs.writeFileSync(path.join(fakeBin, "npm"), [
        "#!/bin/bash",
        `env | sed 's/=.*//' | sort >${JSON.stringify(captureNames)}`,
        `printf '%s\\n' \"$DISPLAY\" \"$XAUTHORITY\" \"$DBUS_SESSION_BUS_ADDRESS\" \"$XDG_RUNTIME_DIR\" >${JSON.stringify(captureRequired)}`,
        "exit 0",
        ""
    ].join("\n"), {mode: 0o700});
    fs.chmodSync(path.join(fakeBin, "npm"), 0o700);

    const secretValues = ["github-value-must-not-cross", "aws-value-must-not-cross", "node-injection-must-not-cross"];
    const parentEnvironment = {
            HOME: home,
            USER: "nomad-test",
            LOGNAME: "nomad-test",
            SHELL: "/bin/bash",
            PATH: "/usr/bin:/bin",
            LANG: "C.UTF-8",
            TERM: "xterm-256color",
            XDG_CONFIG_HOME: configBase,
            XDG_STATE_HOME: stateBase,
            XDG_RUNTIME_DIR: runtime,
            DISPLAY: ":42",
            XAUTHORITY: path.join(runtime, "Xauthority"),
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtime, "bus")}`,
            XDG_SESSION_TYPE: "x11",
            XDG_CURRENT_DESKTOP: "NOMAD",
            XDG_SESSION_DESKTOP: "NOMAD",
            I3SOCK: path.join(runtime, "i3.sock"),
            GH_TOKEN: secretValues[0],
            AWS_SECRET_ACCESS_KEY: secretValues[1],
            NODE_OPTIONS: `--require=${secretValues[2]}`,
            PYTHONPATH: "/tmp/runtime-injection",
            NPM_CONFIG_USERCONFIG: "/tmp/credential-npmrc"
        };
    const beforeInventory = inventoryEnvironment(parentEnvironment);
    assert.strictEqual(beforeInventory.sensitiveCount, 5);
    const result = childProcess.spawnSync(launcher, ["--launch-ui"], {
        cwd: repositoryRoot,
        env: parentEnvironment,
        encoding: "utf8",
        shell: false
    });
    assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const names = new Set(fs.readFileSync(captureNames, "utf8").trim().split(/\r?\n/));
    assert.strictEqual(Array.from(names).filter(isSensitiveEnvironmentKey).length, 0);
    [
        "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "PYTHONPATH",
        "NPM_CONFIG_USERCONFIG", "SSH_AUTH_SOCK", "NOMAD_BOOTSTRAP_NVM_DIR"
    ].forEach(name => assert.strictEqual(names.has(name), false, `${name} crossed the production launch boundary`));
    [
        "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "TERM", "DISPLAY", "XAUTHORITY",
        "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_DESKTOP", "NOMAD_PRODUCTION", "NOMAD_SESSION_PROFILE"
    ].forEach(name => assert.strictEqual(names.has(name), true, `${name} was not retained`));
    assert.deepStrictEqual(fs.readFileSync(captureRequired, "utf8").trim().split(/\r?\n/), [
        ":42", path.join(runtime, "Xauthority"), `unix:path=${path.join(runtime, "bus")}`, runtime
    ]);
    const logs = [
        path.join(stateBase, "nomad", "session.log"),
        path.join(stateBase, "nomad", "ui.log")
    ].map(filename => fs.readFileSync(filename, "utf8")).join("\n");
    secretValues.forEach(value => assert(!logs.includes(value), "secret value appeared in a NOMAD log"));
    assert.strictEqual(fs.statSync(path.join(stateBase, "nomad", "session.log")).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.join(stateBase, "nomad", "ui.log")).mode & 0o777, 0o600);

    const launcherSource = fs.readFileSync(launcher, "utf8");
    assert(launcherSource.indexOf("exec /usr/bin/env -i") < launcherSource.indexOf("ensure_private_directory \"$NOMAD_CONFIG_DIR\""),
        "the environment must be cleared before the launcher calls external utilities");
    console.log(`Dedicated session production allowlist retained X11/DBus and reduced sensitive/injection names ${beforeInventory.sensitiveCount} -> 0`);
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
