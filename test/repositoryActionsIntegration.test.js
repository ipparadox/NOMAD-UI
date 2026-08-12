const assert = require("assert");
const {EventEmitter} = require("events");
const {I3WindowManager} = require("../src/classes/i3WindowManager.class.js");
const {MANAGED_APPLICATIONS} = require("../src/classes/managedApplications.js");

function emptyTree() {
    return {type: "root", nodes: [], floating_nodes: []};
}

async function run() {
    const geometry = {x: 15, y: 25, width: 900, height: 650};
    const repositoryPath = "/trusted/Repositories/repo'; touch NEVER; '";
    const spawnCalls = [];
    const children = [];
    const manager = new I3WindowManager({
        applications: MANAGED_APPLICATIONS,
        spawn: (executable, args, options) => {
            const child = new EventEmitter();
            child.unref = () => {};
            children.push(child);
            spawnCalls.push({executable, args, options});
            return child;
        }
    });
    manager.available = true;
    manager._tree = async () => emptyTree();
    manager._waitForWindow = async appId => ({
        id: appId === "code" ? 501 : 601,
        scratchpad_state: "none"
    });
    manager._command = async () => {};
    manager._place = async () => {};

    const first = await manager.openCodeRepository(repositoryPath, geometry);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.state, "ACTIVE");
    assert.deepStrictEqual(spawnCalls[0], {
        executable: "code",
        args: ["--reuse-window", repositoryPath],
        options: {detached: true, stdio: "ignore", shell: false}
    });

    manager._managedWindow = async appId => appId === "code" ? {id: 501, scratchpad_state: "none"} : null;
    const secondRepositoryPath = "/trusted/Repositories/another";
    const second = await manager.openCodeRepository(secondRepositoryPath, geometry);
    assert.strictEqual(second.ok, true);
    assert.deepStrictEqual(spawnCalls[1], {
        executable: "code",
        args: ["--reuse-window", secondRepositoryPath],
        options: {detached: true, stdio: "ignore", shell: false}
    });
    assert.strictEqual(spawnCalls.filter(call => call.executable === "code").length, 2);
    assert.strictEqual(manager.windows.code, 501, "repository CODE actions must reuse the managed CODE container");

    manager._managedWindow = async appId => {
        if (appId === "browser") return {id: 601, scratchpad_state: "changed"};
        return {id: 501, scratchpad_state: "none"};
    };
    const browser = await manager.openGithubRepository("https://github.com/owner/repo", geometry);
    assert.strictEqual(browser.ok, true);
    assert.deepStrictEqual(spawnCalls[2], {
        executable: "firefox",
        args: ["https://github.com/owner/repo"],
        options: {detached: true, stdio: "ignore", shell: false}
    });

    const rejectedUrl = await manager.openGithubRepository("https://github.com.evil.example/owner/repo", geometry);
    assert.strictEqual(rejectedUrl.status, "INVALID URL");
    assert.strictEqual(spawnCalls.length, 3);

    const rejectedPath = await manager.openCodeRepository("relative/repository", geometry);
    assert.strictEqual(rejectedPath.status, "INVALID REPOSITORY");
    assert.strictEqual(spawnCalls.length, 3);

    children.forEach(child => child.emit("exit", 0));
    console.log("Repository CODE/BROWSER trusted launch context and managed lifecycle passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
