const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "..");
const launcher = path.join(repositoryRoot, "session", "nomad-session");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-session-security-"));

function runFixture(name, prepare) {
    const root = path.join(temporaryRoot, name);
    const home = path.join(root, "home");
    const configRoot = path.join(root, "config");
    const stateRoot = path.join(root, "state");
    const nomadConfig = path.join(configRoot, "nomad");
    const fakeBin = path.join(root, "bin");
    fs.mkdirSync(home, {recursive: true});
    fs.mkdirSync(nomadConfig, {recursive: true});
    fs.mkdirSync(fakeBin, {recursive: true});
    fs.writeFileSync(path.join(fakeBin, "i3-msg"), "#!/usr/bin/env bash\nexit 0\n", {mode: 0o755});
    prepare({root, home, nomadConfig});
    const result = childProcess.spawnSync("bash", [launcher, "--launch-ui"], {
        cwd: repositoryRoot,
        env: Object.assign({}, process.env, {
            HOME: home,
            XDG_CONFIG_HOME: configRoot,
            XDG_STATE_HOME: stateRoot,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`
        }),
        encoding: "utf8",
        shell: false
    });
    const logPath = path.join(stateRoot, "nomad", "session.log");
    assert.notStrictEqual(result.status, 0);
    assert(fs.readFileSync(logPath, "utf8").includes("Refusing unsafe session.env"));
    assert.strictEqual(fs.statSync(path.dirname(logPath)).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(logPath).mode & 0o777, 0o600);
    assert.strictEqual(fs.existsSync(path.join(home, "COMPROMISED")), false);
}

try {
    runFixture("symlink", ({root, home, nomadConfig}) => {
        const victim = path.join(root, "victim.env");
        fs.writeFileSync(victim, `touch "${path.join(home, "COMPROMISED")}"\n`, {mode: 0o600});
        fs.symlinkSync(victim, path.join(nomadConfig, "session.env"));
    });
    runFixture("writable", ({home, nomadConfig}) => {
        fs.writeFileSync(
            path.join(nomadConfig, "session.env"),
            `touch "${path.join(home, "COMPROMISED")}"\n`,
            {mode: 0o666}
        );
        fs.chmodSync(path.join(nomadConfig, "session.env"), 0o666);
    });
    console.log("NOMAD session refuses symlinked or writable session.env files and creates private logs passed");
} finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
