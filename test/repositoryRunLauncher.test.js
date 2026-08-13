const assert = require("assert");
const {RepositoryLauncher} = require("../src/classes/repositoryLauncher.class.js");

const repositoryId = "repo_0123456789abcdef0123456789abcdef";

function repositoryWithProcess(processState = null) {
    return {
        id: repositoryId,
        displayName: "NOMAD-UI",
        relativePath: "NOMAD-UI",
        branch: "feat/v0.5-b",
        dirty: false,
        status: "CLEAN",
        modifiedFileCount: 0,
        remoteAvailable: true,
        remoteProvider: "GITHUB",
        repositoryAvailable: true,
        executionSecurity: {
            allowed: true,
            authorization: "TRUSTED",
            securityProfile: "NORMAL",
            level: "NONE",
            backend: "DIRECT"
        },
        process: processState ? {
            profileId: "npm-dev",
            displayName: "NPM DEV",
            state: processState,
            startedAt: "2026-08-12T12:00:00.000Z",
            exitedAt: processState === "STOPPED" ? "2026-08-12T12:01:00.000Z" : null,
            exitCode: processState === "STOPPED" ? 0 : null,
            signal: null,
            securityProfile: "NORMAL",
            isolationLevel: "NONE",
            isolationBackend: "DIRECT"
        } : null,
        actions: [
            {id: "code", label: "CODE", enabled: true, state: ""},
            {id: "terminal", label: "TERMINAL", enabled: true, state: ""},
            {id: "info", label: "INFO", enabled: true, state: ""},
            {id: "github", label: "GITHUB", enabled: true, state: ""},
            {id: "run", label: "RUN", enabled: processState !== "RUNNING", state: processState || "AUTH REQUIRED"},
            {id: "stop", label: "STOP", enabled: processState === "RUNNING", state: processState || "UNAVAILABLE"}
        ]
    };
}

function keyEvent(key) {
    return {
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
        stopImmediatePropagation: () => {}
    };
}

async function flush() {
    await new Promise(resolve => setImmediate(resolve));
}

async function run() {
    const calls = [];
    const resumes = [];
    const authorizationId = `auth_${"a".repeat(48)}`;
    const launcher = new RepositoryLauncher({
        loadRepositories: async () => ({ok: true, repositories: [repositoryWithProcess()]}),
        getActiveId: () => "browser",
        onResume: id => {
            resumes.push(id);
            return true;
        },
        onaction: async (selectedRepositoryId, actionId, details) => {
            calls.push({selectedRepositoryId, actionId, details});
            if (actionId === "stop") {
                return {ok: true, actionId: "stop", status: "STOPPED", repository: repositoryWithProcess("STOPPED")};
            }
            if (!details.profileId) {
                return {
                    ok: true,
                    actionId: "run",
                    prompt: {
                        kind: "profile-selection",
                        title: "RUN PROFILE",
                        repositoryName: "NOMAD-UI",
                        fields: [],
                        warning: "",
                        choices: [
                            {id: "npm-dev", label: "npm run dev", enabled: true, state: ""},
                            {id: "npm-start", label: "npm run start", enabled: true, state: ""},
                            {id: "cancel", label: "CANCEL", enabled: true, state: ""}
                        ]
                    }
                };
            }
            if (!details.authorization) {
                return {
                    ok: true,
                    actionId: "run",
                    prompt: {
                        kind: "authorization",
                        title: "REPOSITORY EXECUTION",
                        repositoryName: "NOMAD-UI",
                        profileId: details.profileId,
                        authorizationId,
                        fields: [
                            {label: "PROFILE", value: "NPM DEV"},
                            {label: "EXECUTABLE", value: "npm"},
                            {label: "ARGUMENTS", value: "run dev"}
                        ],
                        warning: "REPOSITORY CODE WILL EXECUTE",
                        choices: [
                            {id: "run-once", label: "RUN ONCE", enabled: true, state: ""},
                            {id: "trust-profile", label: "TRUST PROFILE", enabled: true, state: ""},
                            {id: "cancel", label: "CANCEL", enabled: true, state: ""}
                        ]
                    }
                };
            }
            return {ok: true, actionId: "run", status: "RUNNING", repository: repositoryWithProcess("RUNNING")};
        }
    });

    await launcher.render();
    assert.strictEqual(launcher.selectRepository(repositoryId), true);
    assert.strictEqual(await launcher.activate("run"), true);
    assert.strictEqual(launcher.view, "prompt");
    assert.strictEqual(launcher.prompt.kind, "profile-selection");
    assert.deepStrictEqual(calls[0].details, {});

    launcher._handleKeydown(keyEvent("ArrowUp"));
    assert.strictEqual(launcher.selectedChoiceIndex, 2, "profile choice navigation must wrap");
    launcher._handleKeydown(keyEvent("ArrowDown"));
    assert.strictEqual(launcher.selectedChoiceIndex, 0);
    launcher._handleKeydown(keyEvent("Enter"));
    await flush();
    assert.strictEqual(launcher.prompt.kind, "authorization");
    assert.deepStrictEqual(calls[1].details, {profileId: "npm-dev"});

    launcher._handleKeydown(keyEvent("Enter"));
    await flush();
    assert.strictEqual(launcher.view, "actions");
    assert.strictEqual(launcher.isOpen, true, "RUN status should remain visible in the repository HUD");
    assert.deepStrictEqual(calls[2].details, {
        profileId: "npm-dev",
        authorizationId,
        authorization: "run-once"
    });
    const running = launcher._selectedRepository();
    assert.strictEqual(running.process.state, "RUNNING");
    assert.strictEqual(running.executionSecurity.authorization, "TRUSTED");
    assert.strictEqual(running.executionSecurity.securityProfile, "NORMAL");
    assert.strictEqual(running.executionSecurity.level, "NONE");
    assert.strictEqual(running.actions.find(action => action.id === "run").state, "RUNNING");
    assert.strictEqual(running.actions.find(action => action.id === "stop").enabled, true);

    assert.strictEqual(await launcher.activate("stop"), true);
    assert.strictEqual(launcher._selectedRepository().process.state, "STOPPED");
    assert.strictEqual(launcher.isOpen, true);
    assert.deepStrictEqual(calls[3], {selectedRepositoryId: repositoryId, actionId: "stop", details: {}});

    assert.strictEqual(await launcher.activate("run"), true);
    assert.strictEqual(launcher.view, "prompt");
    launcher._handleKeydown(keyEvent("Escape"));
    assert.strictEqual(launcher.isOpen, false);
    assert.deepStrictEqual(resumes, ["browser"]);

    const blocked = repositoryWithProcess();
    blocked.executionSecurity = {
        allowed: false,
        authorization: "TRUSTED",
        securityProfile: "PUBLIC",
        level: "NONE",
        backend: "DIRECT"
    };
    blocked.actions.find(action => action.id === "run").enabled = false;
    blocked.actions.find(action => action.id === "run").state = "ISOLATION BLOCKED";
    launcher.setRepositories([blocked]);
    launcher.selectRepository(repositoryId);
    assert.strictEqual(await launcher.activate("run"), false);
    assert.strictEqual(launcher.errorMessage, "EXECUTION BLOCKED\nISOLATION REQUIREMENT NOT MET");

    launcher.destroy();
    console.log("Repository RUN profile selection, authorization, keyboard, status, and STOP HUD flow passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
