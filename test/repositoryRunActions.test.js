const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFile} = require("child_process");
const {
    RepositoryActionService,
    RepositoryService,
    handleRepositoryRequest
} = require("../src/classes/repositoryService.js");
const {
    RepositoryRunProfileService,
    RepositoryRunTrustStore
} = require("../src/classes/repositoryRunProfileService.js");

function runFile(executable, args) {
    return new Promise((resolve, reject) => {
        execFile(executable, args, {encoding: "utf8", shell: false}, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

class FakeProcessManager {
    constructor() {
        this.record = null;
        this.starts = [];
        this.stops = [];
    }

    start(repository, profile) {
        if (this.isActive(repository.id)) {
            return {ok: true, status: "RUNNING", duplicate: true, process: this.getStatus(repository.id)};
        }
        this.starts.push({repository, profile});
        this.record = {
            repositoryId: repository.id,
            profileId: profile.profileId,
            displayName: profile.displayName,
            state: "RUNNING",
            startedAt: "2026-08-12T12:00:00.000Z",
            exitedAt: null,
            exitCode: null,
            signal: null,
            repository: Object.assign({}, repository.public, {repositoryAvailable: true})
        };
        return {ok: true, status: "RUNNING", duplicate: false, process: this.getStatus(repository.id)};
    }

    async stop(repositoryId) {
        if (!this.isActive(repositoryId)) return {ok: false, status: "PROCESS NOT RUNNING"};
        this.stops.push(repositoryId);
        this.record.state = "STOPPED";
        this.record.exitedAt = "2026-08-12T12:01:00.000Z";
        this.record.exitCode = 0;
        return {ok: true, status: "STOPPED", process: this.getStatus(repositoryId)};
    }

    isActive(repositoryId) {
        return Boolean(this.record && this.record.repositoryId === repositoryId
            && ["STARTING", "RUNNING", "STOPPING"].includes(this.record.state));
    }

    matchesRepository() {
        return true;
    }

    getStatus(repositoryId) {
        if (!this.record || this.record.repositoryId !== repositoryId) return null;
        const result = Object.assign({}, this.record);
        delete result.repository;
        return result;
    }

    getRepositorySnapshot(repositoryId) {
        return this.record && this.record.repositoryId === repositoryId ? Object.assign({}, this.record.repository) : null;
    }

    getActiveRepositorySnapshots() {
        return this.isActive(this.record && this.record.repositoryId)
            ? [Object.assign({}, this.record.repository, {repositoryAvailable: false})] : [];
    }
}

async function initializeRepository(repositoryPath) {
    fs.mkdirSync(repositoryPath, {recursive: true});
    await runFile("git", ["init", "-q", "-b", "feat/v0.5-b-test", repositoryPath]);
    await runFile("git", ["-C", repositoryPath, "config", "user.name", "NOMAD Tests"]);
    await runFile("git", ["-C", repositoryPath, "config", "user.email", "nomad@example.invalid"]);
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "SAFE FIXTURE\n");
    await runFile("git", ["-C", repositoryPath, "add", "README.md"]);
    await runFile("git", ["-C", repositoryPath, "commit", "-q", "-m", "initial"]);
    await runFile("git", ["-C", repositoryPath, "remote", "add", "origin", "git@github.com:nomad-lab/safe-fixture.git"]);
}

function writeManifest(repositoryPath, devScript = "node safe-dev.js") {
    fs.writeFileSync(path.join(repositoryPath, "package.json"), JSON.stringify({
        scripts: {dev: devScript, start: "node safe-start.js"}
    }, null, 2));
}

async function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-run-actions-"));
    try {
        const repositoryRoot = path.join(temporaryRoot, "Repositories");
        const repositoryPath = path.join(repositoryRoot, "SAFE-REPOSITORY");
        const movedPath = path.join(temporaryRoot, "moved-repository");
        const trustStorePath = path.join(temporaryRoot, "config", "repository-runs.json");
        await initializeRepository(repositoryPath);
        writeManifest(repositoryPath);

        const repositoryService = new RepositoryService({repositoryRoot});
        const runProfileService = new RepositoryRunProfileService({
            trustStore: new RepositoryRunTrustStore({trustStorePath}),
            now: () => new Date("2026-08-12T12:00:00.000Z")
        });
        const processManager = new FakeProcessManager();
        const terminalWrites = [];
        const codeCalls = [];
        const browserCalls = [];
        const actions = new RepositoryActionService({
            repositoryService,
            runProfileService,
            processManager,
            shell: "/bin/bash",
            randomBytes: () => Buffer.alloc(24, 7),
            writeTerminal: command => terminalWrites.push(command),
            openCode: (trustedPath, geometry) => {
                codeCalls.push({trustedPath, geometry});
                return {ok: true, status: "RUNNING"};
            },
            openBrowser: (trustedUrl, geometry) => {
                browserCalls.push({trustedUrl, geometry});
                return {ok: true, status: "RUNNING"};
            }
        });

        let listing = await actions.list();
        const repository = listing.repositories[0];
        assert.deepStrictEqual(repository.actions.map(action => action.id), ["code", "terminal", "info", "github", "run", "stop", "pull"]);
        assert.deepStrictEqual(repository.actions.slice(0, 4).map(action => action.enabled), [true, true, true, true]);
        assert.deepStrictEqual(repository.actions.find(action => action.id === "run"), {
            id: "run", label: "RUN", enabled: true, state: "AUTH REQUIRED"
        });
        assert.deepStrictEqual(repository.actions.find(action => action.id === "stop"), {
            id: "stop", label: "STOP", enabled: false, state: "UNAVAILABLE"
        });
        assert.strictEqual(JSON.stringify(listing).includes(repositoryPath), false);

        const geometry = {x: 1, y: 2, width: 800, height: 600};
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "terminal"
        })).status, "TERMINAL OPENED");
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "code", geometry
        })).status, "CODE OPENED");
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "info"
        })).status, "REPOSITORY INFO");
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "github", geometry
        })).status, "GITHUB OPENED");
        assert.strictEqual(terminalWrites.length, 1);
        assert.deepStrictEqual(codeCalls, [{trustedPath: fs.realpathSync(repositoryPath), geometry}]);
        assert.deepStrictEqual(browserCalls, [{trustedUrl: "https://github.com/nomad-lab/safe-fixture", geometry}]);

        for (const injected of [
            {executable: "/tmp/renderer-command"},
            {cwd: "/tmp/renderer-cwd"},
            {path: "/tmp/renderer-path"},
            {pid: process.pid}
        ]) {
            const rejected = await handleRepositoryRequest(actions, Object.assign({
                operation: "action",
                repositoryId: repository.id,
                actionId: "run"
            }, injected));
            assert.strictEqual(rejected.status, "INVALID REQUEST");
        }
        assert.strictEqual(processManager.starts.length, 0);
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: "../escape", actionId: "run"
        })).status, "INVALID REQUEST");

        const selection = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run"
        });
        assert.strictEqual(selection.prompt.kind, "profile-selection");
        assert.deepStrictEqual(selection.prompt.choices.map(choice => choice.label), ["npm run dev", "npm run start", "CANCEL"]);
        assert.strictEqual(processManager.starts.length, 0, "detecting package.json candidates must not execute them");

        const confirmation = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run", profileId: "npm-dev"
        });
        assert.strictEqual(confirmation.prompt.kind, "authorization");
        assert.deepStrictEqual(confirmation.prompt.fields, [
            {label: "PROFILE", value: "NPM DEV"},
            {label: "EXECUTABLE", value: "npm"},
            {label: "ARGUMENTS", value: "run dev"}
        ]);
        assert.strictEqual(processManager.starts.length, 0);

        const runOnce = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "run",
            profileId: "npm-dev",
            authorizationId: confirmation.prompt.authorizationId,
            authorization: "run-once"
        });
        assert.strictEqual(runOnce.status, "RUNNING");
        assert.strictEqual(processManager.starts.length, 1);
        assert.strictEqual(processManager.starts[0].repository.canonicalPath, fs.realpathSync(repositoryPath));
        assert.deepStrictEqual(
            [processManager.starts[0].profile.executable, processManager.starts[0].profile.args],
            ["npm", ["run", "dev"]]
        );
        assert.strictEqual(fs.existsSync(trustStorePath), false, "RUN ONCE must not persist trust");
        assert.strictEqual(runOnce.repository.actions.find(action => action.id === "run").state, "RUNNING");
        assert.strictEqual(runOnce.repository.actions.find(action => action.id === "stop").enabled, true);

        const duplicate = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run", profileId: "npm-start"
        });
        assert.strictEqual(duplicate.duplicate, true);
        assert.strictEqual(processManager.starts.length, 1);

        const rejectedPidStop = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "stop", pid: 1
        });
        assert.strictEqual(rejectedPidStop.status, "INVALID REQUEST");
        assert.strictEqual(processManager.stops.length, 0);
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "stop"
        })).status, "STOPPED");
        assert.deepStrictEqual(processManager.stops, [repository.id]);

        const trustConfirmation = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run", profileId: "npm-dev"
        });
        const trustedRun = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "run",
            profileId: "npm-dev",
            authorizationId: trustConfirmation.prompt.authorizationId,
            authorization: "trust-profile"
        });
        assert.strictEqual(trustedRun.status, "RUNNING");
        const trustDocument = JSON.parse(fs.readFileSync(trustStorePath, "utf8"));
        assert.strictEqual(trustDocument.profiles.length, 1);
        assert.strictEqual(trustDocument.profiles[0].executable, "npm");
        assert.deepStrictEqual(trustDocument.profiles[0].args, ["run", "dev"]);
        await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "stop"
        });

        const approvedRun = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run", profileId: "npm-dev"
        });
        assert.strictEqual(approvedRun.status, "RUNNING");
        assert.strictEqual(approvedRun.prompt, undefined, "an unchanged approved profile may run without another prompt");
        await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "stop"
        });

        writeManifest(repositoryPath, "node changed-profile.js");
        const changed = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run", profileId: "npm-dev"
        });
        assert.strictEqual(changed.status, "RUN PROFILE CHANGED\nAUTHORIZATION REQUIRED");
        assert(changed.prompt.warning.includes("RUN PROFILE CHANGED"));
        const startsBeforeStaleAuthorization = processManager.starts.length;
        writeManifest(repositoryPath, "node changed-again-after-prompt.js");
        const staleAuthorization = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "run",
            profileId: "npm-dev",
            authorizationId: changed.prompt.authorizationId,
            authorization: "run-once"
        });
        assert.strictEqual(staleAuthorization.status, "RUN PROFILE CHANGED\nAUTHORIZATION REQUIRED");
        assert.strictEqual(processManager.starts.length, startsBeforeStaleAuthorization);

        fs.unlinkSync(path.join(repositoryPath, "package.json"));
        listing = await actions.list();
        assert.deepStrictEqual(listing.repositories[0].actions.find(action => action.id === "run"), {
            id: "run", label: "RUN", enabled: false, state: "NO PROFILE"
        });
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run"
        })).status, "NO SAFE RUN PROFILE DETECTED");
        writeManifest(repositoryPath, "node changed-again-after-prompt.js");

        const currentConfirmation = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "run", profileId: "npm-dev"
        });
        await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "run",
            profileId: "npm-dev",
            authorizationId: currentConfirmation.prompt.authorizationId,
            authorization: "run-once"
        });
        fs.renameSync(repositoryPath, movedPath);
        listing = await actions.list();
        assert.strictEqual(listing.repositories.length, 1, "a running disappeared repository must remain stoppable");
        assert.strictEqual(listing.repositories[0].repositoryAvailable, false);
        assert.strictEqual(listing.repositories[0].actions.find(action => action.id === "stop").enabled, true);
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action", repositoryId: repository.id, actionId: "stop"
        })).status, "STOPPED");
        listing = await actions.list();
        assert.strictEqual(listing.repositories.length, 0, "a disappeared stopped repository must leave the UI");

        console.log("Repository RUN/STOP IPC trust boundary, authorization, state, and disappearance handling passed");
    } finally {
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
