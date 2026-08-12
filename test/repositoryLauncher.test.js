const assert = require("assert");
const {RepositoryLauncher} = require("../src/classes/repositoryLauncher.class.js");

const repositoryId = "repo_0123456789abcdef0123456789abcdef";
const repository = {
    id: repositoryId,
    displayName: "NOMAD-UI",
    relativePath: "NOMAD-UI",
    branch: "feat/v0.5-test",
    dirty: false,
    status: "CLEAN",
    modifiedFileCount: 0,
    remoteAvailable: true,
    remoteProvider: "GITHUB",
    actions: [
        {id: "code", label: "CODE", enabled: true},
        {id: "terminal", label: "TERMINAL", enabled: true},
        {id: "info", label: "INFO", enabled: true},
        {id: "github", label: "GITHUB", enabled: true}
    ]
};

function keyEvent(key) {
    const state = {prevented: false, stopped: false, immediate: false};
    return {
        key,
        state,
        preventDefault: () => { state.prevented = true; },
        stopPropagation: () => { state.stopped = true; },
        stopImmediatePropagation: () => { state.immediate = true; }
    };
}

async function run() {
    const workspace = {activeSlotId: "browser"};
    const actions = [];
    const resumed = [];
    const launcher = new RepositoryLauncher({
        loadRepositories: async () => ({ok: true, status: null, repositories: [repository]}),
        getActiveId: () => workspace.activeSlotId,
        onResume: id => {
            resumed.push(id);
            return true;
        },
        onaction: async (selectedRepositoryId, actionId) => {
            actions.push([selectedRepositoryId, actionId]);
            if (actionId === "info") {
                return {
                    ok: true,
                    actionId,
                    repository: Object.assign({}, repository, {
                        dirty: true,
                        status: "MODIFIED",
                        modifiedFileCount: 2
                    })
                };
            }
            return {ok: true, actionId, activateAppId: actionId};
        }
    });

    await launcher.render();
    assert.deepStrictEqual(launcher.repositories.map(item => item.id), [repositoryId]);
    assert.strictEqual(launcher.selectRepository(repositoryId), true);
    assert.strictEqual(launcher.isOpen, true);
    assert.strictEqual(workspace.activeSlotId, "browser", "selection must not change the workspace");
    assert.deepStrictEqual(actions, []);

    const down = keyEvent("ArrowDown");
    launcher._handleKeydown(down);
    assert.strictEqual(launcher.selectedActionIndex, 1);
    assert.strictEqual(down.state.prevented, true);
    launcher._handleKeydown(keyEvent("ArrowUp"));
    assert.strictEqual(launcher.selectedActionIndex, 0);
    launcher._handleKeydown(keyEvent("ArrowUp"));
    assert.strictEqual(launcher.selectedActionIndex, 3, "action navigation must wrap");

    launcher._handleKeydown(keyEvent("Enter"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(actions, [[repositoryId, "github"]]);
    assert.strictEqual(launcher.isOpen, false);
    assert.deepStrictEqual(resumed, [], "successful actions must own the resulting workspace focus");

    launcher.selectRepository(repositoryId);
    assert.strictEqual(await launcher.activate("info"), true);
    assert.strictEqual(launcher.isOpen, true);
    assert.strictEqual(launcher.view, "info");
    assert.strictEqual(launcher.info.status, "MODIFIED");
    assert.strictEqual(launcher.info.modifiedFileCount, 2);
    const escape = keyEvent("Escape");
    launcher._handleKeydown(escape);
    assert.strictEqual(launcher.isOpen, false);
    assert.strictEqual(workspace.activeSlotId, "browser", "Escape must not change the workspace");
    assert.deepStrictEqual(actions, [[repositoryId, "github"], [repositoryId, "info"]]);
    assert.deepStrictEqual(resumed, ["browser"], "Escape must restore the previously active managed app");

    launcher.selectRepository(repositoryId);
    launcher.setRepositories([], "NO REPOSITORIES DETECTED");
    assert.strictEqual(launcher.isOpen, false, "an open action view must close when its repository disappears");
    assert.strictEqual(launcher.selectedRepositoryId, null);
    assert.deepStrictEqual(resumed, ["browser", "browser"]);

    const unavailable = Object.assign({}, repository, {
        actions: repository.actions.map(action => Object.assign({}, action, {enabled: action.id !== "github"}))
    });
    launcher.setRepositories([unavailable]);
    launcher.selectRepository(repositoryId);
    assert.strictEqual(await launcher.activate("github"), false);
    assert.strictEqual(launcher.errorMessage, "ACTION UNAVAILABLE");
    assert.deepStrictEqual(actions, [[repositoryId, "github"], [repositoryId, "info"]], "disabled actions must never cross the renderer callback boundary");

    launcher.destroy();
    console.log("Repository action selection, keyboard navigation, Escape, and disappearance behavior passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
