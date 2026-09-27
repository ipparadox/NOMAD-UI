class I3WorkspaceClient {
    constructor(opts) {
        this.ipc = opts.ipc;
        this.manager = opts.manager;
        this.viewport = opts.viewport;
        this.log = opts.log || (() => {});
        this.getWindowBounds = typeof opts.getWindowBounds === "function" ? opts.getWindowBounds : null;
        this.onApplicationError = typeof opts.onApplicationError === "function" ? opts.onApplicationError : (() => {});
        this.loadState = typeof opts.loadState === "function" ? opts.loadState : null;
        this.requestId = 0;
        this.pendingRequests = {};
        this.activeExternalId = null;
        this._geometryTimer = null;
        this._onState = (event, result) => this._apply(result);
        this._onGeometry = () => this.scheduleGeometry();
        this._subscriptions = [this.ipc.on("window-manager-state", this._onState),
            this.ipc.on("window-manager-geometry-changed", this._onGeometry)];
    }

    initialize() {
        if (this.destroyed) return Promise.resolve([]);
        if (this.initialization) return this.initialization;
        this.initialization = this._initialize();
        return this.initialization;
    }

    _initialize() {
        this.manager.setOperationHandler("launch", slot => {
            this.activeExternalId = slot.id;
            this.manager.update(slot.id, {status: "LAUNCHING APPLICATION"});
            this._send("launch", slot.id, this.geometry());
            return true;
        });
        this.manager.setOperationHandler("focus", slot => {
            if (slot.type !== "external") {
                this.activeExternalId = null;
                this._send("focusNomad", slot.id);
            } else if (slot.type === "external") {
                if (this.activeExternalId && this.activeExternalId !== slot.id) {
                    this._send("minimize", this.activeExternalId);
                }
                this.activeExternalId = slot.id;
                this.manager.update(slot.id, {
                    status: slot.running ? "RESTORING APPLICATION" : "LAUNCHING APPLICATION",
                    state: slot.running ? slot.state : "LAUNCHING"
                });
                this._send(slot.running ? "focus" : "launch", slot.id, this.geometry());
            }
            return true;
        });
        ["minimize", "restore", "close"].forEach(operation => {
            this.manager.setOperationHandler(operation, slot => {
                this._send(operation, slot.id, this.geometry());
                if (operation === "close" || operation === "minimize") this.activeExternalId = null;
                return true;
            });
        });
        this.manager.setOperationHandler("fullscreen", (slot, enabled) => {
            this._send(enabled ? "fullscreen" : "unfullscreen", slot.id, this.geometry());
            return true;
        });
        this._onResize = () => this.scheduleGeometry();
        window.addEventListener("resize", this._onResize);
        if (window.ResizeObserver) {
            this.observer = new ResizeObserver(() => this.scheduleGeometry());
            this.observer.observe(this.viewport);
        }
        this._send("availability", "terminal");
        if (!this.loadState) return Promise.resolve([]);
        return Promise.resolve(this.loadState()).then(states => {
            if (!Array.isArray(states)) return [];
            states.forEach(state => this._apply(state));
            return states;
        }).catch(error => {
            this.log("warn", "managed application snapshot unavailable");
            return [];
        });
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        clearTimeout(this._geometryTimer);
        if (this.observer) this.observer.disconnect();
        window.removeEventListener("resize", this._onResize);
        this._subscriptions.forEach(unsubscribe => { if (typeof unsubscribe === "function") unsubscribe(); });
        if (typeof this.ipc.removeListener === "function") {
            this.ipc.removeListener("window-manager-state", this._onState);
            this.ipc.removeListener("window-manager-geometry-changed", this._onGeometry);
        }
        this.pendingRequests = {};
    }

    geometry() {
        const rect = this.viewport.getBoundingClientRect();
        const bounds = this.getWindowBounds ? this.getWindowBounds() : {
            x: 0,
            y: 0,
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight
        };
        const scaleX = bounds.width / document.documentElement.clientWidth;
        const scaleY = bounds.height / document.documentElement.clientHeight;
        return {
            x: bounds.x + (rect.left * scaleX),
            y: bounds.y + (rect.top * scaleY),
            width: rect.width * scaleX,
            height: rect.height * scaleY
        };
    }

    scheduleGeometry() {
        if (this.destroyed) return;
        clearTimeout(this._geometryTimer);
        this._geometryTimer = setTimeout(() => {
            if (this.activeExternalId) this._send("geometry", this.activeExternalId, this.geometry());
        }, 100);
    }

    refocus(id) {
        const slot = this.manager.getSlot(id);
        if (!slot || slot.type !== "external" || !slot.running) return false;
        this.activeExternalId = id;
        this._send("focus", id, this.geometry());
        return true;
    }

    _send(operation, appId, geometry) {
        if (this.destroyed) return;
        const now = Date.now();
        Object.keys(this.pendingRequests).forEach(id => {
            if (now - this.pendingRequests[id].sentAt > 10000) delete this.pendingRequests[id];
        });
        const ids = Object.keys(this.pendingRequests);
        if (ids.length >= 128) delete this.pendingRequests[ids[0]];
        const requestId = ++this.requestId;
        this.pendingRequests[requestId] = {operation, appId, sentAt: now};
        this.ipc.send("window-manager-operation", {requestId, operation, appId, geometry});
    }

    _apply(result) {
        if (this.destroyed || !result || !result.appId) return;
        const pending = this.pendingRequests[result.requestId] || null;
        if (pending) delete this.pendingRequests[result.requestId];
        if (result.appId === "terminal") {
            if (result.status === "WINDOW MANAGER UNAVAILABLE") {
                Object.keys(this.manager.applications).forEach(id => {
                    if (this.manager.applications[id].type === "external") this.manager.update(id, {status: result.status});
                });
            }
            return;
        }
        const changes = {status: result.status || ""};
        ["running", "minimized", "fullscreen", "state"].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(result, key)) changes[key] = result[key];
        });
        // A tree scan started before a tab selection can arrive while the new
        // application's launch/focus is pending. Keep its runtime information,
        // but do not let that old observation undo the user's selection.
        const selectingOtherApplication = Object.values(this.pendingRequests).some(request =>
            ["launch", "focus", "restore", "focusNomad"].includes(request.operation)
            && request.appId === this.manager.activeSlotId && request.appId !== result.appId);
        if (result.observed && changes.state === "ACTIVE" && selectingOtherApplication) changes.state = "RUNNING";
        const passiveStateForActiveSlot = changes.state === "RUNNING" || (result.observed && changes.state === "HIDDEN");
        if (passiveStateForActiveSlot && this.manager.activeSlotId === result.appId) changes.state = "ACTIVE";
        if (changes.state === "ACTIVE") {
            const activeBefore = this.manager.activeSlotId;
            this.manager.synchronize(result.appId, changes);
            this.log("info", `${result.appId} synchronize(ACTIVE): activeSlotId=${activeBefore} -> ${this.manager.activeSlotId}`);
            this.activeExternalId = result.appId;
            if (result.observed && result.state === "ACTIVE") this._send("geometry", result.appId, this.geometry());
        } else if (!this.manager.getSlot(result.appId) && result.running) {
            this.manager.synchronize(result.appId, changes);
        } else {
            this.manager.update(result.appId, changes);
        }
        if (result.status === "CLOSED") this.manager.close(result.appId, {skipOperation: true});
        const failed = !result.ok && result.state !== "RUNNING";
        if (failed) {
            this.manager.close(result.appId, {skipOperation: true});
            this.manager.focus("terminal");
            if (!pending || ["launch", "focus", "restore"].includes(pending.operation)) {
                this.onApplicationError(
                    result.status === "APPLICATION NOT FOUND" ? "APPLICATION NOT FOUND" : "APPLICATION FAILED TO START",
                    result.appId
                );
            }
        }
        if (result.status === "CLOSED") {
            if (this.manager.activeSlotId === result.appId || this.manager.activeSlotId === null) {
                this.manager.focus("terminal");
            }
        }
        if (!result.ok || result.status === "CLOSED" || result.status === "HIDDEN") {
            if (this.activeExternalId === result.appId) this.activeExternalId = null;
        }
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") module["exports"] = {I3WorkspaceClient};
