const {execFile, spawn} = require("child_process");
const path = require("path");
const {APPLICATION_TYPES, MANAGED_APPLICATIONS, applicationMap, normalizeApplicationId} = require("./managedApplications.js");
const {isNormalizedGithubUrl} = require("./repositoryService.js");
const WINDOW_MANAGER_OPERATIONS = new Set([
    "availability", "focusNomad", "launch", "focus", "restore", "minimize",
    "fullscreen", "unfullscreen", "close", "geometry"
]);
const GEOMETRY_OPERATIONS = new Set(["launch", "focus", "restore", "unfullscreen", "geometry"]);

function i3TreeChildren(node) {
    if (!node || typeof node !== "object") return [];
    const tiled = Array.isArray(node.nodes) ? node.nodes : [];
    const floating = Array.isArray(node.floating_nodes) ? node.floating_nodes : [];
    return tiled.concat(floating);
}

function findI3TreeNode(node, predicate) {
    if (!node || typeof predicate !== "function") return null;
    if (predicate(node)) return node;
    const children = i3TreeChildren(node);
    for (let index = 0; index < children.length; index++) {
        const match = findI3TreeNode(children[index], predicate);
        if (match) return match;
    }
    return null;
}

function findI3TreeContext(node, predicate, ancestors = []) {
    if (!node || typeof predicate !== "function") return null;
    if (predicate(node)) return {node, ancestors};
    const children = i3TreeChildren(node);
    for (let index = 0; index < children.length; index++) {
        const match = findI3TreeContext(children[index], predicate, ancestors.concat(node));
        if (match) return match;
    }
    return null;
}

function collectI3TreeNodes(node, predicate, matches = []) {
    if (!node || typeof predicate !== "function") return matches;
    if (predicate(node)) matches.push(node);
    i3TreeChildren(node).forEach(child => collectI3TreeNodes(child, predicate, matches));
    return matches;
}

function containsFocusedI3Node(node) {
    if (!node) return false;
    if (node.focused === true) return true;
    return i3TreeChildren(node).some(child => containsFocusedI3Node(child));
}

// i3 places X11 clients below one or more wrapper containers, particularly
// for floating windows. A wrapper can occasionally carry copied properties,
// so only the deepest property/window-bearing node in each branch is a client
// leaf suitable for window identity work.
function collectI3ClientLeaves(node, ancestors = []) {
    if (!node || typeof node !== "object") return [];
    const descendants = [];
    i3TreeChildren(node).forEach(child => {
        descendants.push(...collectI3ClientLeaves(child, ancestors.concat(node)));
    });
    if (descendants.length) return descendants;

    const properties = node.window_properties;
    const hasProperties = properties && typeof properties === "object" && !Array.isArray(properties);
    const hasWindow = Number.isSafeInteger(node.window) && node.window > 0;
    return hasProperties || hasWindow ? [{node, ancestors}] : [];
}

function normalizeGeometry(geometry) {
    if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return null;
    if (Object.keys(geometry).some(key => !["x", "y", "width", "height"].includes(key))) return null;
    if (![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)) return null;
    if (Math.abs(geometry.x) > 100000 || Math.abs(geometry.y) > 100000) return null;
    if (geometry.width <= 0 || geometry.height <= 0 || geometry.width > 100000 || geometry.height > 100000) return null;
    return {
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height
    };
}

function validateWindowManagerRequest(request) {
    const invalid = {ok: false, appId: null, status: "INVALID REQUEST"};
    if (!request || typeof request !== "object" || Array.isArray(request)) return invalid;
    if (Object.keys(request).some(key => !["requestId", "operation", "appId", "geometry"].includes(key))) return invalid;
    if (!Number.isSafeInteger(request.requestId) || request.requestId < 0) return invalid;
    if (!WINDOW_MANAGER_OPERATIONS.has(request.operation)) return Object.assign({}, invalid, {requestId: request.requestId});
    const appId = normalizeApplicationId(request.appId);
    if (!appId || appId !== request.appId) return Object.assign({}, invalid, {requestId: request.requestId});
    const geometry = typeof request.geometry === "undefined" ? null : normalizeGeometry(request.geometry);
    if ((GEOMETRY_OPERATIONS.has(request.operation) && !geometry) || (typeof request.geometry !== "undefined" && !geometry)) {
        return Object.assign({}, invalid, {requestId: request.requestId, appId});
    }
    return {
        ok: true,
        requestId: request.requestId,
        operation: request.operation,
        appId,
        geometry
    };
}

async function handleWindowManagerRequest(manager, request) {
    const validated = validateWindowManagerRequest(request);
    if (!validated.ok) return validated;
    if (validated.operation === "availability") {
        return {
            ok: manager.available,
            requestId: validated.requestId,
            appId: validated.appId,
            status: manager.available ? "RUNNING" : "WINDOW MANAGER UNAVAILABLE"
        };
    }
    const result = await manager.operate(validated.operation, validated.appId, validated.geometry);
    return Object.assign({requestId: validated.requestId}, result);
}

class I3WindowManager {
    constructor(opts = {}) {
        this.log = opts.log || (() => {});
        this.onState = opts.onState || (() => {});
        this.spawn = opts.spawn || spawn;
        this.windows = {};
        this.windowStates = {};
        this.processes = {};
        this.launches = {};
        this.launchErrors = {};
        this.available = false;
        this._monitor = null;
        this.setApplications(opts.applications || MANAGED_APPLICATIONS);
    }

    setApplications(applications) {
        this.applicationDefinitions = applicationMap(applications || []);
        this.applications = applicationMap((applications || []).filter(application => application.type === APPLICATION_TYPES.EXTERNAL));
        Object.keys(this.windows).forEach(appId => {
            if (!this.applications[appId]) {
                delete this.windows[appId];
                delete this.windowStates[appId];
                delete this.processes[appId];
                delete this.launchErrors[appId];
            }
        });
    }

    async initialize() {
        try {
            await this._i3(["-t", "get_version"]);
            this.available = true;
            this.log("info", `i3 window integration available (I3SOCK=${process.env.I3SOCK || "not set"})`);
            this._monitor = setInterval(() => this._checkManagedWindows(), 2000);
        } catch (error) {
            this.available = false;
            this.log("warn", `i3 IPC unavailable (I3SOCK=${process.env.I3SOCK || "not set"}): ${error.message}`);
        }
        return this.available;
    }

    destroy() {
        if (this._monitor) clearInterval(this._monitor);
        this._monitor = null;
    }

    async operate(operation, appId, geometry) {
        if (!this.available) return this._result(false, appId, "WINDOW MANAGER UNAVAILABLE");

        try {
            if (operation === "focusNomad") {
                const target = this.applicationDefinitions[appId];
                if (!target || target.type !== APPLICATION_TYPES.INTERNAL) return this._result(false, appId, "APPLICATION NOT FOUND");
                return await this._focusNomad(appId);
            }
            const definition = this.applications[appId];
            if (!definition) return this._result(false, appId, "APPLICATION NOT FOUND");
            if (operation === "launch" || operation === "focus" || operation === "restore") {
                if (definition.available === false || !definition.executable || !definition.windowMatchers || !definition.windowMatchers.length) {
                    return this._result(false, appId, "APPLICATION NOT FOUND");
                }
                if (!normalizeGeometry(geometry)) return this._result(false, appId, "INVALID GEOMETRY");
                return await this._show(appId, geometry);
            }
            const windowNode = await this._managedWindow(appId);
            if (!windowNode) return this._result(false, appId, "APPLICATION NOT RUNNING");
            if (operation === "minimize") {
                await this._command(windowNode.id, "move scratchpad");
                this.windowStates[appId] = {focused: false, hidden: true, visible: false};
                return this._result(true, appId, "HIDDEN", {state: "HIDDEN", minimized: true, fullscreen: false, containerId: windowNode.id});
            }
            if (operation === "fullscreen") {
                await this._command(windowNode.id, "fullscreen enable, focus");
                return this._result(true, appId, "RUNNING", {state: "RUNNING", fullscreen: true, minimized: false, containerId: windowNode.id});
            }
            if (operation === "unfullscreen") {
                if (!normalizeGeometry(geometry)) return this._result(false, appId, "INVALID GEOMETRY");
                await this._command(windowNode.id, "fullscreen disable, floating enable");
                await this._place(windowNode.id, geometry, true);
                return this._result(true, appId, "RUNNING", {state: "RUNNING", fullscreen: false, minimized: false, containerId: windowNode.id});
            }
            if (operation === "close") {
                await this._command(windowNode.id, "kill");
                return this._result(true, appId, "CLOSED", {state: "CLOSED", running: false, minimized: false, fullscreen: false, containerId: null});
            }
            if (operation === "geometry") {
                if (!normalizeGeometry(geometry)) return this._result(false, appId, "INVALID GEOMETRY");
                await this._place(windowNode.id, geometry, false);
                return this._result(true, appId, "RUNNING");
            }
            return this._result(false, appId, "UNSUPPORTED OPERATION");
        } catch (error) {
            this.log("warn", `${appId} ${operation} failed: ${error.message}`);
            return this._result(false, appId, error.code === "ENOENT" ? "APPLICATION NOT FOUND" : "APPLICATION FAILED TO START");
        }
    }

    async openCodeRepository(repositoryPath, geometry) {
        if (typeof repositoryPath !== "string" || !path.isAbsolute(repositoryPath) || repositoryPath.includes("\0")) {
            return this._result(false, "code", "INVALID REPOSITORY");
        }
        return this._openTrustedApplication("code", ["--reuse-window", repositoryPath], geometry);
    }

    async openGithubRepository(githubUrl, geometry) {
        if (!isNormalizedGithubUrl(githubUrl)) return this._result(false, "browser", "INVALID URL");
        return this._openTrustedApplication("browser", [githubUrl], geometry);
    }

    async _openTrustedApplication(appId, additionalArgs, geometry) {
        if (!this.available) return this._result(false, appId, "WINDOW MANAGER UNAVAILABLE");
        const definition = this.applications[appId];
        if (!definition || definition.available === false || !definition.executable || !definition.windowMatchers || !definition.windowMatchers.length) {
            return this._result(false, appId, "APPLICATION NOT FOUND");
        }
        if (!normalizeGeometry(geometry)) return this._result(false, appId, "INVALID GEOMETRY");

        try {
            await this._hideManagedApplicationsExcept(appId);
            const result = await this._showWithLaunchArgs(appId, geometry, additionalArgs);
            if (result.ok) result.state = "ACTIVE";
            return result;
        } catch (error) {
            this.log("warn", `${appId} trusted context failed: ${error.message}`);
            return this._result(false, appId, error.code === "ENOENT" ? "APPLICATION NOT FOUND" : "APPLICATION FAILED TO START");
        }
    }

    async _show(appId, geometry) {
        return this._showWithLaunchArgs(appId, geometry, null);
    }

    async _showWithLaunchArgs(appId, geometry, additionalArgs) {
        let windowNode = await this._managedWindow(appId);
        let launchedWithContext = false;
        if (!windowNode) {
            if (!this.launches[appId]) {
                this.launches[appId] = (async () => {
                    const launched = this._launch(appId, additionalArgs);
                    if (!launched) return null;
                    return this._waitForWindow(appId, 12000);
                })().finally(() => delete this.launches[appId]);
                launchedWithContext = Boolean(additionalArgs);
            }
            windowNode = await this.launches[appId];
        }
        if (!windowNode) return this._result(false, appId, "APPLICATION FAILED TO START");
        if (additionalArgs && !launchedWithContext) {
            const launched = this._launch(appId, additionalArgs, {trackProcess: false, trackErrors: false});
            if (!launched) return this._result(false, appId, "APPLICATION FAILED TO START");
        }
        this.windows[appId] = windowNode.id;
        this.log("info", `${appId} show requested: con_id=${windowNode.id} scratchpad_state=${windowNode.scratchpad_state || "none"}`);
        if (windowNode.scratchpad_state && windowNode.scratchpad_state !== "none") {
            await this._command(windowNode.id, "scratchpad show");
        }
        await this._command(windowNode.id, "fullscreen disable, floating enable, border pixel 0");
        await this._place(windowNode.id, geometry, true);
        this.windowStates[appId] = {focused: true, hidden: false, visible: true};
        return this._result(true, appId, "RUNNING", {state: "RUNNING", running: true, minimized: false, fullscreen: false, containerId: windowNode.id});
    }

    _launch(appId, additionalArgs, opts = {}) {
        const definition = this.applications[appId];
        try {
            if (opts.trackErrors !== false) delete this.launchErrors[appId];
            const args = definition.args.slice().concat(additionalArgs || []);
            const child = this.spawn(definition.executable, args, {
                detached: true,
                stdio: "ignore",
                shell: false
            });
            if (opts.trackProcess !== false) this.processes[appId] = child;
            child.once("error", error => {
                if (opts.trackErrors !== false) this.launchErrors[appId] = error;
                this.log("warn", `${appId} executable failed: ${error.message}`);
            });
            child.once("exit", () => {
                if (this.processes[appId] === child) delete this.processes[appId];
            });
            if (typeof child.unref === "function") child.unref();
            return true;
        } catch (error) {
            return false;
        }
    }

    async _hideManagedApplicationsExcept(targetAppId) {
        const tree = await this._tree();
        for (const appId of Object.keys(this.applications)) {
            if (appId === targetAppId) continue;
            const windowNodes = this._walkAll(tree, node => this._matches(node, this.applications[appId]));
            for (const windowNode of windowNodes) {
                if (!windowNode.scratchpad_state || windowNode.scratchpad_state === "none") {
                    await this._command(windowNode.id, "move scratchpad");
                }
            }
            if (windowNodes.length) {
                const containerId = windowNodes[0].id;
                this.windows[appId] = containerId;
                this.windowStates[appId] = {focused: false, hidden: true, visible: false};
                this.onState(this._result(true, appId, "HIDDEN", {
                    state: "HIDDEN",
                    running: true,
                    minimized: true,
                    fullscreen: false,
                    containerId
                }));
            }
        }
    }

    async _waitForWindow(appId, timeout) {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            if (this.launchErrors[appId]) {
                const error = this.launchErrors[appId];
                delete this.launchErrors[appId];
                throw error;
            }
            const windowNode = await this._findWindow(appId);
            if (windowNode) return windowNode;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return null;
    }

    async _managedWindow(appId) {
        const rememberedId = this.windows[appId];
        const tree = await this._tree();
        let windowNode = rememberedId ? this._walk(tree, node => node.id === rememberedId) : null;
        if (!windowNode) windowNode = this._walk(tree, node => this._matches(node, this.applications[appId]));
        if (windowNode) this.windows[appId] = windowNode.id;
        return windowNode;
    }

    async _findWindow(appId) {
        const tree = await this._tree();
        return this._walk(tree, node => this._matches(node, this.applications[appId]));
    }

    _matches(node, definition) {
        if (!definition || !Array.isArray(definition.windowMatchers)) return false;
        const props = node.window_properties || {};
        return definition.windowMatchers.some(matcher => {
            if (matcher.instance && props.instance !== matcher.instance) return false;
            if (matcher.className && props.class !== matcher.className) return false;
            return Boolean(matcher.instance || matcher.className);
        });
    }

    _walk(node, predicate) {
        return findI3TreeNode(node, predicate);
    }

    _walkContext(node, predicate, ancestors = []) {
        return findI3TreeContext(node, predicate, ancestors);
    }

    _containsFocusedNode(node) {
        return containsFocusedI3Node(node);
    }

    _observeWindow(context) {
        const lineage = context.ancestors.concat(context.node);
        const workspace = lineage.slice().reverse().find(node => node.type === "workspace") || null;
        const scratchpadContainer = lineage.slice().reverse().find(node => node.scratchpad_state && node.scratchpad_state !== "none") || null;
        const hidden = workspace ? workspace.name === "__i3_scratch" : Boolean(scratchpadContainer);
        const workspaceVisible = workspace
            ? (typeof workspace.visible === "boolean" ? workspace.visible : this._containsFocusedNode(workspace))
            : null;
        const nodeVisible = Boolean(context.node.visible);
        const descendantFocused = this._containsFocusedNode(context.node);
        const focused = descendantFocused && !hidden;
        const visible = focused || (!hidden && (workspaceVisible === null ? nodeVisible : workspaceVisible));
        return {
            hidden,
            visible,
            focused,
            descendantFocused,
            nodeVisible,
            workspaceName: workspace ? workspace.name : "unknown",
            workspaceVisible,
            scratchpadState: scratchpadContainer ? scratchpadContainer.scratchpad_state : "none"
        };
    }

    async _place(conId, geometry, focus) {
        if (!geometry || ![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)) {
            throw new Error("Invalid workspace geometry");
        }
        const x = Math.round(geometry.x);
        const y = Math.round(geometry.y);
        const width = Math.max(1, Math.round(geometry.width));
        const height = Math.max(1, Math.round(geometry.height));
        let command = `floating enable, border pixel 0, resize set ${width} px ${height} px, move position ${x} px ${y} px`;
        if (focus) command += ", focus";
        await this._command(conId, command);
    }

    async _focusNomad(targetAppId) {
        const tree = await this._tree();
        for (const appId of Object.keys(this.applications)) {
            const windowNodes = this._walkAll(tree, node => this._matches(node, this.applications[appId]));
            for (const windowNode of windowNodes) {
                const scratchpadState = windowNode.scratchpad_state || "none";
                this.log("info", `${appId} hide requested: con_id=${windowNode.id} visible=${Boolean(windowNode.visible)} scratchpad_state=${scratchpadState}`);
                if (scratchpadState === "none") {
                    await this._command(windowNode.id, "move scratchpad");
                    this.log("info", `${appId} hidden: con_id=${windowNode.id}`);
                } else {
                    this.log("info", `${appId} already hidden: con_id=${windowNode.id}`);
                }
            }
            if (windowNodes.length) {
                this.windows[appId] = windowNodes[0].id;
                this.windowStates[appId] = {focused: false, hidden: true, visible: false};
                this.onState(this._result(true, appId, "HIDDEN", {state: "HIDDEN", minimized: true, fullscreen: false, containerId: windowNodes[0].id}));
            } else {
                this.log("info", `${appId} hide requested: no managed window found`);
            }
        }
        await this._i3(["[class=\"^eDEX-UI$\" instance=\"^edex-ui$\"] focus"]);
        this.log("info", "NOMAD focused after managed applications were hidden");
        return this._result(true, targetAppId, "RUNNING");
    }

    _walkAll(node, predicate, matches = []) {
        return collectI3TreeNodes(node, predicate, matches);
    }

    async _checkManagedWindows() {
        if (!this.available) return;
        let tree;
        try { tree = await this._tree(); } catch (error) { return; }
        Object.keys(this.applications).forEach(appId => {
            const rememberedId = this.windows[appId];
            const rememberedContext = rememberedId ? this._walkContext(tree, node => node.id === rememberedId) : null;
            if (rememberedId && !rememberedContext) {
                delete this.windows[appId];
                delete this.windowStates[appId];
                this.onState(this._result(true, appId, "CLOSED", {state: "CLOSED", running: false, minimized: false, fullscreen: false, containerId: null}));
                return;
            }
            const context = rememberedContext || this._walkContext(tree, node => this._matches(node, this.applications[appId]));
            if (!context) return;
            const windowNode = context.node;
            const observationState = this._observeWindow(context);
            const {hidden, visible, focused, descendantFocused} = observationState;
            const previousState = this.windowStates[appId];
            this.windowStates[appId] = {focused, hidden, visible};
            const lifecycle = focused ? "ACTIVE" : (visible ? "RUNNING" : "HIDDEN");
            const changed = !previousState || focused !== previousState.focused || hidden !== previousState.hidden || visible !== previousState.visible;
            const workspaceVisible = observationState.workspaceVisible === null ? "unknown" : observationState.workspaceVisible;
            this.log("info", `${appId} tree scan: con_id=${windowNode.id} node.focused=${Boolean(windowNode.focused)} descendantFocused=${descendantFocused} node.visible=${observationState.nodeVisible} workspace=${observationState.workspaceName} workspace.visible=${workspaceVisible} scratchpad_state=${observationState.scratchpadState} visible=${visible} discovered=${!rememberedId} lifecycle=${changed ? lifecycle : "none"}`);
            if (!rememberedId || changed) {
                this.windows[appId] = windowNode.id;
                const observation = this._result(true, appId, visible ? "RUNNING" : "HIDDEN", {
                    discovered: !rememberedId,
                    observed: true,
                    state: lifecycle,
                    running: true,
                    minimized: hidden,
                    fullscreen: Boolean(windowNode.fullscreen_mode),
                    visible,
                    focused,
                    containerId: windowNode.id
                });
                this.log("info", `${appId} lifecycle emitted: ${lifecycle} con_id=${windowNode.id}`);
                this.onState(observation);
            }
        });
    }

    _command(conId, command) {
        if (!Number.isInteger(conId)) return Promise.reject(new Error("Invalid i3 container id"));
        return this._i3([`[con_id=\"${conId}\"] ${command}`]).then(output => {
            const replies = JSON.parse(output);
            if (replies.some(reply => reply.success === false)) throw new Error("i3 rejected window command");
            return replies;
        });
    }

    async _tree() {
        const output = await this._i3(["-t", "get_tree"]);
        return JSON.parse(output);
    }

    _i3(args) {
        return new Promise((resolve, reject) => {
            execFile("i3-msg", args, {encoding: "utf8", timeout: 3000}, (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
            });
        });
    }

    _result(ok, appId, status, state) {
        return Object.assign({ok, appId, status}, state || {});
    }
}

module.exports = {
    I3WindowManager,
    WINDOW_MANAGER_OPERATIONS,
    collectI3ClientLeaves,
    collectI3TreeNodes,
    containsFocusedI3Node,
    findI3TreeContext,
    findI3TreeNode,
    handleWindowManagerRequest,
    i3TreeChildren,
    normalizeGeometry,
    validateWindowManagerRequest
};
