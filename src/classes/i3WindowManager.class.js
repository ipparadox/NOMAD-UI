const {execFile, spawn} = require("child_process");
const {APPLICATION_TYPES, MANAGED_APPLICATIONS, applicationMap} = require("./managedApplications.js");
const APPLICATIONS = Object.freeze(applicationMap(MANAGED_APPLICATIONS.filter(app => app.type === APPLICATION_TYPES.EXTERNAL)));

class I3WindowManager {
    constructor(opts = {}) {
        this.log = opts.log || (() => {});
        this.onState = opts.onState || (() => {});
        this.windows = {};
        this.windowStates = {};
        this.processes = {};
        this.launches = {};
        this.launchErrors = {};
        this.available = false;
        this._monitor = null;
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
            if (operation === "focusNomad") return await this._focusNomad(appId);
            if (!APPLICATIONS[appId]) return this._result(false, appId, "APPLICATION NOT FOUND");
            if (operation === "launch" || operation === "focus" || operation === "restore") {
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
                await this._command(windowNode.id, "fullscreen disable, floating enable");
                await this._place(windowNode.id, geometry, true);
                return this._result(true, appId, "RUNNING", {state: "RUNNING", fullscreen: false, minimized: false, containerId: windowNode.id});
            }
            if (operation === "close") {
                await this._command(windowNode.id, "kill");
                return this._result(true, appId, "CLOSED", {state: "CLOSED", running: false, minimized: false, fullscreen: false, containerId: null});
            }
            if (operation === "geometry") {
                await this._place(windowNode.id, geometry, false);
                return this._result(true, appId, "RUNNING");
            }
            return this._result(false, appId, "UNSUPPORTED OPERATION");
        } catch (error) {
            this.log("warn", `${appId} ${operation} failed: ${error.message}`);
            return this._result(false, appId, error.code === "ENOENT" ? "APPLICATION NOT FOUND" : "APPLICATION FAILED TO START");
        }
    }

    async _show(appId, geometry) {
        let windowNode = await this._managedWindow(appId);
        if (!windowNode) {
            if (!this.launches[appId]) {
                this.launches[appId] = (async () => {
                    const launched = this._launch(appId);
                    if (!launched) return null;
                    return this._waitForWindow(appId, 12000);
                })().finally(() => delete this.launches[appId]);
            }
            windowNode = await this.launches[appId];
        }
        if (!windowNode) return this._result(false, appId, "APPLICATION FAILED TO START");
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

    _launch(appId) {
        const definition = APPLICATIONS[appId];
        try {
            delete this.launchErrors[appId];
            const child = spawn(definition.executable, definition.args, {detached: true, stdio: "ignore"});
            this.processes[appId] = child;
            child.once("error", error => {
                this.launchErrors[appId] = error;
                this.log("warn", `${appId} executable failed: ${error.message}`);
            });
            child.once("exit", () => delete this.processes[appId]);
            child.unref();
            return true;
        } catch (error) {
            return false;
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
        if (!windowNode) windowNode = this._walk(tree, node => this._matches(node, APPLICATIONS[appId]));
        if (windowNode) this.windows[appId] = windowNode.id;
        return windowNode;
    }

    async _findWindow(appId) {
        const tree = await this._tree();
        return this._walk(tree, node => this._matches(node, APPLICATIONS[appId]));
    }

    _matches(node, definition) {
        const props = node.window_properties || {};
        return props.instance === definition.windowMatch.instance && props.class === definition.windowMatch.className;
    }

    _walk(node, predicate) {
        if (predicate(node)) return node;
        const children = (node.nodes || []).concat(node.floating_nodes || []);
        for (let i = 0; i < children.length; i++) {
            const match = this._walk(children[i], predicate);
            if (match) return match;
        }
        return null;
    }

    _walkContext(node, predicate, ancestors = []) {
        if (predicate(node)) return {node, ancestors};
        const children = (node.nodes || []).concat(node.floating_nodes || []);
        for (let i = 0; i < children.length; i++) {
            const match = this._walkContext(children[i], predicate, ancestors.concat(node));
            if (match) return match;
        }
        return null;
    }

    _containsFocusedNode(node) {
        if (!node) return false;
        if (node.focused === true) return true;
        const children = (node.nodes || []).concat(node.floating_nodes || []);
        return children.some(child => this._containsFocusedNode(child));
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
        for (const appId of Object.keys(APPLICATIONS)) {
            const windowNodes = this._walkAll(tree, node => this._matches(node, APPLICATIONS[appId]));
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
        if (predicate(node)) matches.push(node);
        const children = (node.nodes || []).concat(node.floating_nodes || []);
        children.forEach(child => this._walkAll(child, predicate, matches));
        return matches;
    }

    async _checkManagedWindows() {
        if (!this.available) return;
        let tree;
        try { tree = await this._tree(); } catch (error) { return; }
        Object.keys(APPLICATIONS).forEach(appId => {
            const rememberedId = this.windows[appId];
            const rememberedContext = rememberedId ? this._walkContext(tree, node => node.id === rememberedId) : null;
            if (rememberedId && !rememberedContext) {
                delete this.windows[appId];
                delete this.windowStates[appId];
                this.onState(this._result(true, appId, "CLOSED", {state: "CLOSED", running: false, minimized: false, fullscreen: false, containerId: null}));
                return;
            }
            const context = rememberedContext || this._walkContext(tree, node => this._matches(node, APPLICATIONS[appId]));
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

module.exports = {I3WindowManager, APPLICATIONS};
