const assert = require("assert");
const {I3WindowManager} = require("../src/classes/i3WindowManager.class.js");

const WINDOW_PROPERTIES = {
    code: {instance: "code", class: "code"},
    browser: {instance: "Navigator", class: "firefox_firefox"}
};

function workspaceTree(appId, opts = {}) {
    const containerId = opts.containerId || (appId === "code" ? 505 : 606);
    const client = {
        id: containerId,
        type: "con",
        visible: opts.nodeVisible === true,
        focused: opts.focused === true,
        fullscreen_mode: 0,
        scratchpad_state: "none",
        window_properties: WINDOW_PROPERTIES[appId],
        nodes: opts.children || [],
        floating_nodes: []
    };
    return {
        type: "root",
        nodes: [{
            type: "output",
            nodes: [{
                type: "workspace",
                name: opts.workspaceName || "1",
                visible: opts.workspaceVisible !== false,
                nodes: [],
                floating_nodes: [{
                    id: containerId + 1,
                    type: "floating_con",
                    focused: false,
                    scratchpad_state: opts.scratchpadState || "none",
                    nodes: [client],
                    floating_nodes: []
                }]
            }],
            floating_nodes: []
        }],
        floating_nodes: []
    };
}

async function run() {
    const manager = new I3WindowManager();
    let launches = 0;
    manager._managedWindow = async () => null;
    manager._launch = () => {
        launches++;
        return true;
    };
    manager._waitForWindow = async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return {id: 303, scratchpad_state: "fresh"};
    };
    const commands = [];
    manager._command = async (conId, command) => commands.push([conId, command]);
    manager._place = async () => {};

    const geometry = {x: 0, y: 0, width: 800, height: 600};
    const [first, second] = await Promise.all([
        manager._show("code", geometry),
        manager._show("code", geometry)
    ]);

    assert.strictEqual(launches, 1);
    assert.strictEqual(first.containerId, 303);
    assert.strictEqual(second.containerId, 303);
    assert.strictEqual(first.running, true);

    manager._managedWindow = async () => ({id: 303, scratchpad_state: "fresh"});
    await manager._show("code", geometry);
    await manager._show("browser", geometry);
    assert.strictEqual(launches, 1);
    assert(commands.some(([conId, command]) => conId === 303 && command === "scratchpad show"));

    // i3 exposes visibility on the workspace ancestor. The matching X11 leaf
    // remains visible=false even when it is the focused, displayed window.
    const codeStates = [];
    const codeManager = new I3WindowManager({onState: state => codeStates.push(state)});
    codeManager.available = true;
    let codeTree = workspaceTree("code", {focused: true, nodeVisible: false});
    codeManager._tree = async () => codeTree;

    await codeManager._checkManagedWindows();
    assert.strictEqual(codeStates[0].appId, "code");
    assert.strictEqual(codeStates[0].discovered, true);
    assert.strictEqual(codeStates[0].state, "ACTIVE");
    assert.strictEqual(codeStates[0].visible, true);
    assert.strictEqual(codeStates[0].focused, true);

    await codeManager._checkManagedWindows();
    await codeManager._checkManagedWindows();
    await codeManager._checkManagedWindows();
    assert.strictEqual(codeStates.length, 1, "unchanged CODE polls must not emit new lifecycle events");

    // Focusing the NOMAD host removes X11 focus from CODE, but CODE is still a
    // visible running application rather than a hidden/scratchpad application.
    codeTree = workspaceTree("code", {focused: false, nodeVisible: false});
    await codeManager._checkManagedWindows();
    assert.strictEqual(codeStates[1].state, "RUNNING");
    assert.strictEqual(codeStates[1].status, "RUNNING");
    assert.strictEqual(codeStates[1].visible, true);
    assert.strictEqual(codeStates[1].minimized, false);
    await codeManager._checkManagedWindows();
    await codeManager._checkManagedWindows();
    assert.strictEqual(codeStates.length, 2, "subsequent background polls must remain stable");

    // Some i3 versions omit workspace.visible from GET_TREE. In that shape,
    // the focused NOMAD sibling still proves that CODE's workspace is visible.
    const hostFocusedTree = workspaceTree("code", {focused: false, nodeVisible: false});
    const hostWorkspace = hostFocusedTree.nodes[0].nodes[0];
    delete hostWorkspace.visible;
    hostWorkspace.nodes.push({
        id: 808,
        type: "con",
        focused: true,
        window_properties: {instance: "edex-ui", class: "eDEX-UI"},
        nodes: [],
        floating_nodes: []
    });
    codeTree = hostFocusedTree;
    await codeManager._checkManagedWindows();
    assert.strictEqual(codeStates.length, 2, "NOMAD X11 focus must keep CODE in RUNNING lifecycle");

    codeTree = workspaceTree("code", {
        focused: false,
        nodeVisible: false,
        workspaceName: "__i3_scratch",
        workspaceVisible: false,
        scratchpadState: "changed"
    });
    await codeManager._checkManagedWindows();
    assert.strictEqual(codeStates[2].state, "HIDDEN");
    assert.strictEqual(codeStates[2].minimized, true);

    const browserStates = [];
    const browserManager = new I3WindowManager({onState: state => browserStates.push(state)});
    browserManager.available = true;
    browserManager._tree = async () => workspaceTree("browser", {focused: true, nodeVisible: false});
    await browserManager._checkManagedWindows();
    await browserManager._checkManagedWindows();
    await browserManager._checkManagedWindows();
    assert.strictEqual(browserStates[0].appId, "browser");
    assert.strictEqual(browserStates[0].state, "ACTIVE");
    assert.strictEqual(browserStates.length, 1, "focused BROWSER must remain stable across polls");

    const backgroundStates = [];
    const backgroundManager = new I3WindowManager({onState: state => backgroundStates.push(state)});
    backgroundManager.available = true;
    backgroundManager._tree = async () => workspaceTree("browser", {focused: false, nodeVisible: false});
    await backgroundManager._checkManagedWindows();
    assert.strictEqual(backgroundStates[0].state, "RUNNING");
    assert.strictEqual(backgroundStates[0].focused, false);

    const nestedStates = [];
    const nestedManager = new I3WindowManager({onState: state => nestedStates.push(state)});
    nestedManager.available = true;
    nestedManager._tree = async () => workspaceTree("code", {
        focused: false,
        nodeVisible: false,
        children: [{id: 506, focused: true, nodes: [], floating_nodes: []}]
    });
    await nestedManager._checkManagedWindows();
    assert.strictEqual(nestedStates[0].state, "ACTIVE");
    assert.strictEqual(nestedStates[0].focused, true);

    const geometryManager = new I3WindowManager();
    geometryManager.available = true;
    geometryManager._managedWindow = async () => ({id: 707});
    let geometryPlacement = null;
    geometryManager._place = async (conId, nextGeometry, focus) => {
        geometryPlacement = {conId, geometry: nextGeometry, focus};
    };
    const geometryResult = await geometryManager.operate("geometry", "code", geometry);
    assert.strictEqual(geometryResult.status, "RUNNING");
    assert.deepStrictEqual(geometryPlacement, {conId: 707, geometry, focus: false});

    console.log("I3WindowManager focus, visibility, scratchpad, and geometry observations passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
