const assert = require("assert");
const {EventEmitter} = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    RepositoryProcessManager,
    buildRepositoryRunEnvironment
} = require("../src/classes/repositoryProcessManager.js");

function fakeChild(pid) {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    return child;
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== "ESRCH";
    }
}

async function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-process-manager-"));
    let treeManager = null;
    let treeRepositoryId = null;
    try {
        const repositoryPath = path.join(temporaryRoot, "repo'; touch NEVER; '");
        const stateRoot = path.join(temporaryRoot, "state");
        fs.mkdirSync(repositoryPath);
        fs.writeFileSync(path.join(repositoryPath, ".env"), "REPOSITORY_SECRET=must-not-load\n");
        const stats = fs.statSync(repositoryPath);
        const repository = {
            id: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            canonicalPath: fs.realpathSync(repositoryPath),
            directoryDevice: String(stats.dev),
            directoryInode: String(stats.ino),
            repositoryIdentity: `sha256:${"1".repeat(64)}`,
            executionIdentity: `sha256:${"2".repeat(64)}`,
            public: {
                id: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                displayName: "repo'; touch NEVER; '",
                relativePath: "repo'; touch NEVER; '",
                branch: "test",
                dirty: false,
                status: "CLEAN",
                modifiedFileCount: 0,
                remoteAvailable: false,
                remoteProvider: "NONE"
            }
        };
        const profile = {
            profileId: "npm-dev",
            displayName: "NPM DEV",
            executable: "npm",
            args: ["run", "dev; touch NEVER"],
            workingDirectory: "."
        };
        const spawnCalls = [];
        const children = [];
        const signals = [];
        const manager = new RepositoryProcessManager({
            stateRoot,
            platform: "linux",
            env: {
                PATH: process.env.PATH,
                HOME: temporaryRoot,
                LANG: "C.UTF-8",
                NODE_OPTIONS: "--require=/tmp/never.js",
                REPOSITORY_SECRET: "must-not-inherit",
                API_TOKEN: "must-not-inherit"
            },
            resolveExecutable: () => process.execPath,
            spawn: (executable, args, options) => {
                const child = fakeChild(4100 + children.length);
                children.push(child);
                spawnCalls.push({executable, args, options});
                return child;
            },
            kill: (target, signal) => signals.push([target, signal]),
            gracePeriodMs: 10,
            killWaitMs: 100
        });

        const started = manager.start(repository, profile);
        assert.strictEqual(started.status, "RUNNING");
        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].executable, fs.realpathSync(process.execPath));
        assert.deepStrictEqual(spawnCalls[0].args, ["run", "dev; touch NEVER"], "arguments must remain discrete literals");
        assert.strictEqual(spawnCalls[0].options.cwd, repository.canonicalPath);
        assert.strictEqual(spawnCalls[0].options.shell, false);
        assert.strictEqual(spawnCalls[0].options.detached, true);
        assert.strictEqual(spawnCalls[0].options.env.REPOSITORY_SECRET, undefined);
        assert.strictEqual(spawnCalls[0].options.env.API_TOKEN, undefined);
        assert.strictEqual(spawnCalls[0].options.env.NODE_OPTIONS, undefined);
        assert.strictEqual(spawnCalls[0].options.env.HOME, temporaryRoot);
        assert.strictEqual(fs.existsSync(path.join(temporaryRoot, "NEVER")), false);
        assert.strictEqual(manager.records.get(repository.id).logPath, path.join(stateRoot, repository.id, "run.log"));

        const duplicate = manager.start(repository, profile);
        assert.strictEqual(duplicate.duplicate, true);
        assert.strictEqual(spawnCalls.length, 1, "duplicate RUN must not spawn a second process");
        assert.throws(() => manager.start(Object.assign({}, repository, {
            executionIdentity: `sha256:${"9".repeat(64)}`
        }), profile), error => error.status === "REPOSITORY IDENTITY CONFLICT");
        assert.strictEqual(spawnCalls.length, 1, "trust must not transfer to a replacement at the same repository ID");

        assert.deepStrictEqual(await manager.stop("repo_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), {
            ok: false,
            status: "PROCESS NOT RUNNING"
        });
        assert.strictEqual(signals.length, 0, "untracked repositories must never be signaled");

        const firstStop = manager.stop(repository.id);
        assert.deepStrictEqual(signals, [[-4100, "SIGTERM"]]);
        children[0].exitCode = 0;
        children[0].emit("exit", 0, "SIGTERM");
        assert.strictEqual((await firstStop).status, "STOPPED");
        assert.strictEqual(manager.getStatus(repository.id).state, "STOPPED");

        manager.start(repository, profile);
        const forcedStop = manager.stop(repository.id);
        await delay(25);
        assert.deepStrictEqual(signals.slice(-2), [[-4101, "SIGTERM"], [-4101, "SIGKILL"]]);
        children[1].exitCode = null;
        children[1].signalCode = "SIGKILL";
        children[1].emit("exit", null, "SIGKILL");
        assert.strictEqual((await forcedStop).status, "STOPPED");

        assert.throws(() => manager.start(Object.assign({}, repository, {id: "../escape"}), profile), error => (
            error.status === "REPOSITORY NOT FOUND"
        ));
        assert.strictEqual(spawnCalls.length, 2);

        const unsafeStateRoot = path.join(temporaryRoot, "unsafe-state");
        const unsafeRepositoryDirectory = path.join(unsafeStateRoot, repository.id);
        fs.mkdirSync(unsafeRepositoryDirectory, {recursive: true});
        const outsideLog = path.join(temporaryRoot, "outside.log");
        fs.writeFileSync(outsideLog, "preserve\n");
        fs.symlinkSync(outsideLog, path.join(unsafeRepositoryDirectory, "run.log"));
        const unsafeManager = new RepositoryProcessManager({
            stateRoot: unsafeStateRoot,
            resolveExecutable: () => process.execPath,
            spawn: () => { throw new Error("must not spawn"); }
        });
        assert.throws(() => unsafeManager.start(repository, profile), error => error.status === "RUN LOG UNAVAILABLE");
        assert.strictEqual(fs.readFileSync(outsideLog, "utf8"), "preserve\n");

        const filtered = buildRepositoryRunEnvironment({
            PATH: "/usr/bin",
            LC_ALL: "C",
            LD_PRELOAD: "/tmp/evil.so",
            PYTHONPATH: "/tmp/evil",
            NPM_CONFIG_USERCONFIG: "/tmp/evil-npmrc",
            SECRET_TOKEN: "secret"
        });
        assert.deepStrictEqual(filtered, {PATH: "/usr/bin", LC_ALL: "C"});

        const logRepositoryPath = path.join(temporaryRoot, "log-repository");
        fs.mkdirSync(logRepositoryPath);
        const logStats = fs.statSync(logRepositoryPath);
        const logRepository = Object.assign({}, repository, {
            id: "repo_cccccccccccccccccccccccccccccccc",
            canonicalPath: fs.realpathSync(logRepositoryPath),
            directoryDevice: String(logStats.dev),
            directoryInode: String(logStats.ino),
            public: Object.assign({}, repository.public, {id: "repo_cccccccccccccccccccccccccccccccc", displayName: "LOG TEST"})
        });
        const realManager = new RepositoryProcessManager({
            stateRoot: path.join(temporaryRoot, "real-state"),
            resolveExecutable: () => process.execPath,
            gracePeriodMs: 100,
            killWaitMs: 100
        });
        realManager.start(logRepository, {
            profileId: "safe-log",
            displayName: "SAFE LOG",
            executable: "node",
            args: ["-e", "process.stdout.write('STDOUT\\n'); process.stderr.write('STDERR\\n')"],
            workingDirectory: "."
        });
        const logRecord = realManager.records.get(logRepository.id);
        await new Promise(resolve => logRecord.child.once("exit", resolve));
        const captured = fs.readFileSync(logRecord.logPath, "utf8");
        assert(captured.includes("STDOUT"));
        assert(captured.includes("STDERR"));
        assert.strictEqual(realManager.getStatus(logRepository.id).state, "STOPPED");

        const treeRepositoryPath = path.join(temporaryRoot, "tree-repository");
        fs.mkdirSync(treeRepositoryPath);
        const treeStats = fs.statSync(treeRepositoryPath);
        treeRepositoryId = "repo_dddddddddddddddddddddddddddddddd";
        const treeRepository = Object.assign({}, repository, {
            id: treeRepositoryId,
            canonicalPath: fs.realpathSync(treeRepositoryPath),
            directoryDevice: String(treeStats.dev),
            directoryInode: String(treeStats.ino),
            public: Object.assign({}, repository.public, {id: treeRepositoryId, displayName: "TREE TEST"})
        });
        treeManager = new RepositoryProcessManager({
            stateRoot: path.join(temporaryRoot, "tree-state"),
            resolveExecutable: () => process.execPath,
            gracePeriodMs: 500,
            killWaitMs: 500
        });
        const parentCode = [
            "const {spawn}=require('child_process')",
            "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
            "setTimeout(()=>process.stdout.write(String(child.pid)+'\\n'),200)",
            "setInterval(()=>{},1000)"
        ].join(";");
        treeManager.start(treeRepository, {
            profileId: "safe-tree",
            displayName: "SAFE TREE",
            executable: "node",
            args: ["-e", parentCode],
            workingDirectory: "."
        });
        const treeRecord = treeManager.records.get(treeRepositoryId);
        let childPid = null;
        for (let attempt = 0; attempt < 50 && !childPid; attempt++) {
            await delay(20);
            const output = fs.readFileSync(treeRecord.logPath, "utf8").trim();
            if (/^[0-9]+$/.test(output)) childPid = Number(output);
        }
        assert(Number.isSafeInteger(childPid), "safe process-tree fixture must report its child PID");
        assert.strictEqual(alive(childPid), true);
        assert.strictEqual((await treeManager.stop(treeRepositoryId)).status, "STOPPED");
        for (let attempt = 0; attempt < 50 && alive(childPid); attempt++) await delay(20);
        assert.strictEqual(alive(childPid), false, "process-group STOP must clean up child processes");
        treeManager = null;

        console.log("Repository process exact spawn, controlled environment, logs, supervision, and group STOP passed");
    } finally {
        if (treeManager && treeRepositoryId && treeManager.isActive(treeRepositoryId)) {
            treeManager.terminateAll();
        }
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
