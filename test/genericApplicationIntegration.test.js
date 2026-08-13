const assert = require("assert");
const {EventEmitter} = require("events");
const {
    I3WindowManager,
    handleWindowManagerRequest,
    validateWindowManagerRequest
} = require("../src/classes/i3WindowManager.class.js");
const {MANAGED_APPLICATIONS, publicApplications} = require("../src/classes/managedApplications.js");
const {WorkspaceManager} = require("../src/classes/workspaceManager.class.js");
const {ApplicationLauncher} = require("../src/classes/applicationLauncher.class.js");
const {I3WorkspaceClient} = require("../src/classes/i3WorkspaceClient.class.js");

const spotifyDefinition = {
    id: "spotify",
    displayName: "SPOTIFY",
    type: "external",
    launcherOrder: 100,
    executable: "spotify",
    args: ["--uri=literal;not-shell"],
    windowMatchers: [{className: "Spotify"}],
    available: true,
    status: ""
};
const applications = MANAGED_APPLICATIONS.concat(spotifyDefinition);
const geometry = {x: 10, y: 20, width: 800, height: 600};

// Renderer requests are a closed vocabulary. Adding launch metadata makes the
// whole request invalid, so it can never reach the trusted manager.
assert.strictEqual(validateWindowManagerRequest({
    requestId: 1,
    operation: "launch",
    appId: "spotify",
    geometry,
    executable: "/bin/sh"
}).ok, false);
assert.strictEqual(validateWindowManagerRequest({
    requestId: 2,
    operation: "launch",
    appId: "SPOTIFY",
    geometry
}).ok, false, "renderer app IDs must already be normalized");

let delegatedOperations = 0;
const boundaryManager = {
    available: true,
    operate: async (operation, appId, requestGeometry) => {
        delegatedOperations++;
        assert.strictEqual(operation, "launch");
        assert.strictEqual(appId, "spotify");
        assert.deepStrictEqual(requestGeometry, geometry);
        return {ok: true, appId, status: "RUNNING"};
    }
};

async function run() {
    const rejected = await handleWindowManagerRequest(boundaryManager, {
        requestId: 3,
        operation: "launch",
        appId: "spotify",
        geometry,
        args: ["renderer-controlled"]
    });
    assert.strictEqual(rejected.status, "INVALID REQUEST");
    assert.strictEqual(delegatedOperations, 0);

    const accepted = await handleWindowManagerRequest(boundaryManager, {
        requestId: 4,
        operation: "launch",
        appId: "spotify",
        geometry
    });
    assert.strictEqual(accepted.status, "RUNNING");
    assert.strictEqual(delegatedOperations, 1);

    // Launch metadata comes only from the injected registry definition and is
    // passed to spawn with shell:false.
    const spawnCalls = [];
    const child = new EventEmitter();
    child.unref = () => {};
    const applicationEnvironment = {PATH: "/usr/bin", LANG: "C"};
    const launchManager = new I3WindowManager({
        applications,
        env: applicationEnvironment,
        spawn: (executable, args, options) => {
            spawnCalls.push({executable, args, options});
            return child;
        }
    });
    assert.strictEqual(launchManager._launch("spotify"), true);
    assert.deepStrictEqual(spawnCalls, [{
        executable: "spotify",
        args: ["--uri=literal;not-shell"],
        options: {detached: true, stdio: "ignore", shell: false, env: applicationEnvironment}
    }]);
    child.emit("exit", 0);

    assert.strictEqual(
        launchManager._matches({window_properties: {class: "Spotify", instance: "spotify"}}, spotifyDefinition),
        true
    );
    assert.strictEqual(
        launchManager._matches({window_properties: {class: "Spotify Beta", instance: "spotify"}}, spotifyDefinition),
        false,
        "WM_CLASS values are exact strings, never regular expressions"
    );

    // Concurrent first-launch requests and later restores reuse one process
    // and one remembered i3 container for a generic registry app.
    const reuseManager = new I3WindowManager({applications});
    let launches = 0;
    reuseManager._managedWindow = async () => null;
    reuseManager._launch = appId => {
        assert.strictEqual(appId, "spotify");
        launches++;
        return true;
    };
    reuseManager._waitForWindow = async () => ({id: 707, scratchpad_state: "none"});
    reuseManager._command = async () => {};
    reuseManager._place = async () => {};
    const [first, second] = await Promise.all([
        reuseManager._show("spotify", geometry),
        reuseManager._show("spotify", geometry)
    ]);
    assert.strictEqual(launches, 1);
    assert.strictEqual(first.containerId, 707);
    assert.strictEqual(second.containerId, 707);
    reuseManager._managedWindow = async () => ({id: 707, scratchpad_state: "changed"});
    await reuseManager._show("spotify", geometry);
    assert.strictEqual(launches, 1, "restore must not launch a duplicate process");

    const closeStates = [];
    const closeManager = new I3WindowManager({applications, onState: state => closeStates.push(state)});
    closeManager.available = true;
    closeManager.windows.spotify = 707;
    closeManager._tree = async () => ({type: "root", nodes: [], floating_nodes: []});
    await closeManager._checkManagedWindows();
    assert.deepStrictEqual(closeStates[0], {
        ok: true,
        appId: "spotify",
        status: "CLOSED",
        state: "CLOSED",
        running: false,
        minimized: false,
        fullscreen: false,
        containerId: null
    });

    // The renderer lifecycle and launcher consume only the public model. A
    // generic app follows the same launch/ACTIVE/restore/close transitions as
    // CODE and BROWSER, with no Spotify-specific conditionals.
    global.window = {addEventListener: () => {}, ResizeObserver: null};
    const sent = [];
    const ipc = {
        on: () => {},
        send: (event, request) => sent.push([event, request])
    };
    const workspace = new WorkspaceManager({
        applications: publicApplications(applications),
        initialApplicationIds: ["terminal"]
    });
    const client = new I3WorkspaceClient({ipc, manager: workspace, viewport: {}});
    client.geometry = () => geometry;
    client.initialize();
    sent.length = 0;
    const launcher = new ApplicationLauncher({manager: workspace});
    assert(launcher.entries.some(entry => entry.id === "spotify"));

    launcher.open();
    assert.strictEqual(launcher.activate("spotify"), true);
    const launchRequest = sent.find(([, request]) => request.operation === "launch")[1];
    assert.deepStrictEqual(Object.keys(launchRequest).sort(), ["appId", "geometry", "operation", "requestId"]);
    assert.strictEqual(launchRequest.appId, "spotify");
    client._apply({
        requestId: launchRequest.requestId,
        ok: true,
        appId: "spotify",
        status: "RUNNING",
        state: "RUNNING",
        running: true,
        minimized: false,
        fullscreen: false
    });
    assert.strictEqual(workspace.activeSlotId, "spotify");
    assert.deepStrictEqual(workspace.getState().slots.map(slot => slot.id), ["spotify", "terminal"]);
    const originalSlot = workspace.getSlot("spotify");

    workspace.minimize("spotify");
    client._apply({
        ok: true,
        appId: "spotify",
        status: "HIDDEN",
        state: "HIDDEN",
        running: true,
        minimized: true
    });
    sent.length = 0;
    launcher.open();
    launcher.activate("spotify");
    assert.strictEqual(workspace.getSlot("spotify"), originalSlot);
    assert.strictEqual(sent.find(([, request]) => request.appId === "spotify")[1].operation, "focus");

    client._apply({
        ok: true,
        appId: "spotify",
        status: "CLOSED",
        state: "CLOSED",
        running: false,
        minimized: false,
        fullscreen: false,
        containerId: null
    });
    assert.strictEqual(workspace.getSlot("spotify"), null);
    assert.strictEqual(workspace.activeSlotId, "terminal");

    const unavailableWorkspace = new WorkspaceManager({
        applications: publicApplications(applications).concat({
            id: "ghost",
            displayName: "GHOST",
            type: "external",
            launcherOrder: 101,
            available: false,
            status: "APPLICATION EXECUTABLE NOT FOUND"
        }),
        initialApplicationIds: ["terminal"]
    });
    const unavailableLauncher = new ApplicationLauncher({manager: unavailableWorkspace});
    assert.strictEqual(unavailableLauncher.entries.find(entry => entry.id === "ghost").state, "UNAVAILABLE");
    assert.strictEqual(unavailableLauncher.activate("ghost"), false);
    assert.strictEqual(unavailableLauncher.errorMessage, "APPLICATION NOT FOUND");
    assert.strictEqual(unavailableWorkspace.getSlot("ghost"), null);

    assert.deepStrictEqual(launchManager.applications.code.windowMatchers, [{instance: "code", className: "code"}]);
    assert.deepStrictEqual(launchManager.applications.browser.windowMatchers, [{instance: "Navigator", className: "firefox_firefox"}]);

    launcher.destroy();
    unavailableLauncher.destroy();
    delete global.window;
    console.log("Generic registry application security and lifecycle integration passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
