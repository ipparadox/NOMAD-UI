const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawnSync} = require("child_process");

const root = path.resolve(__dirname, "..");
const installer = path.join(root, "scripts", "install-nomad-security-helper.sh");
const source = fs.readFileSync(installer, "utf8");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-helper-installer-"));

function plan(environment, args = []) {
    return spawnSync("/bin/bash", [installer].concat(args), {
        encoding: "utf8",
        env: Object.assign({
            HOME: temporaryRoot,
            XDG_CONFIG_HOME: path.join(temporaryRoot, "config"),
            XDG_STATE_HOME: path.join(temporaryRoot, "state"),
            PATH: path.join(temporaryRoot, "attacker-path"),
            NODE_OPTIONS: `--require=${path.join(temporaryRoot, "must-not-load.js")}`
        }, environment || {}),
        shell: false,
        timeout: 10000
    });
}

try {
    const initial = plan();
    assert.strictEqual(initial.status, 0, initial.stderr);
    assert(initial.stdout.includes("NOMAD SECURITY HELPER INSTALLATION PLAN"));
    assert(initial.stdout.includes(path.join(temporaryRoot, "Repositories")));
    assert(initial.stdout.includes("PLAN ONLY"));
    assert(initial.stdout.includes("No firewall or mount change"));

    const settingsDirectory = path.join(temporaryRoot, "config", "eDEX-UI");
    fs.mkdirSync(settingsDirectory, {recursive: true, mode: 0o700});
    const settingsPath = path.join(settingsDirectory, "settings.json");
    const customRepositoryRoot = path.join(temporaryRoot, "Custom Repositories");
    fs.writeFileSync(settingsPath, `${JSON.stringify({repositoryRoot: customRepositoryRoot}, null, 4)}\n`, {mode: 0o600});
    const configured = plan();
    assert.strictEqual(configured.status, 0, configured.stderr);
    assert(configured.stdout.includes(`"repositoryRoots": ["${customRepositoryRoot}"]`));
    assert(!configured.stdout.includes("must-not-load"), "runtime-injection environment values must not reach Node");

    fs.chmodSync(settingsPath, 0o664);
    const unsafe = plan();
    assert.strictEqual(unsafe.status, 1);
    assert(unsafe.stderr.includes("Refusing unsafe eDEX settings"));

    const invalid = plan({}, ["--arbitrary"]);
    assert.strictEqual(invalid.status, 2);
    assert(invalid.stderr.includes("USAGE"));

    assert(source.includes('"$SUDO_EXECUTABLE" "$INSTALL_EXECUTABLE"'));
    assert(source.includes('HELPER_SOURCE_FD_PATH="/proc/$$/fd/$helper_source_fd"'));
    assert(source.includes('"$helper_temp" "$HELPER_TARGET"'),
        "sudo must install an inode-pinned private snapshot rather than reopening the repository path");
    assert(!source.includes("sudo sh"));
    assert(!source.includes("eval "));
    assert(!source.includes("shell: true"));
    console.log("Helper installation dry-run, configured repository protection, unsafe settings refusal, and fixed privileged install surface passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
