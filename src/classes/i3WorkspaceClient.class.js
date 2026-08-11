class I3WorkspaceClient {
    constructor(opts) {
        this.ipc = opts.ipc;
        this.manager = opts.manager;
        this.viewport = opts.viewport;
        this.requestId = 0;
        this.activeExternalId = null;
        this._geometryTimer = null;
        this.ipc.on("window-manager-state", (event, result) => this._apply(result));
        this.ipc.on("window-manager-geometry-changed", () => this.scheduleGeometry());
    }

    initialize() {
        this.manager.setOperationHandler("launch", slot => {
            this.activeExternalId = slot.id;
            this.manager.update(slot.id, {status: "LAUNCHING APPLICATION"});
            this._send("launch", slot.id, this.geometry());
            return true;
        });
        this.manager.setOperationHandler("focus", slot => {
            if (slot.id === "terminal" || slot.id === "notes") {
                this.activeExternalId = null;
                this._send("focusNomad", slot.id);
            } else if (slot.id === "code" || slot.id === "browser") {
                if (this.activeExternalId && this.activeExternalId !== slot.id) {
                    this._send("minimize", this.activeExternalId);
                }
                this.activeExternalId = slot.id;
                this.manager.update(slot.id, {status: "LAUNCHING APPLICATION"});
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
        window.addEventListener("resize", () => this.scheduleGeometry());
        if (window.ResizeObserver) {
            this.observer = new ResizeObserver(() => this.scheduleGeometry());
            this.observer.observe(this.viewport);
        }
        this._send("availability", "terminal");
    }

    geometry() {
        const rect = this.viewport.getBoundingClientRect();
        const bounds = require("@electron/remote").getCurrentWindow().getContentBounds();
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
        clearTimeout(this._geometryTimer);
        this._geometryTimer = setTimeout(() => {
            if (this.activeExternalId) this._send("geometry", this.activeExternalId, this.geometry());
        }, 100);
    }

    _send(operation, appId, geometry) {
        this.ipc.send("window-manager-operation", {requestId: ++this.requestId, operation, appId, geometry});
    }

    _apply(result) {
        if (!result || !result.appId) return;
        if (result.appId === "terminal") {
            if (result.status === "WINDOW MANAGER UNAVAILABLE") {
                ["code", "browser"].forEach(id => this.manager.update(id, {status: result.status}));
            }
            return;
        }
        const changes = {status: result.status || ""};
        ["running", "minimized", "fullscreen"].forEach(key => {
            if (typeof result[key] === "boolean") changes[key] = result[key];
        });
        this.manager.update(result.appId, changes);
        if (result.status === "MINIMIZED" || result.status === "CLOSED") {
            if (this.manager.activeSlotId === result.appId || this.manager.activeSlotId === null) {
                this.manager.focus("terminal");
            }
        }
        if (!result.ok || result.status === "CLOSED" || result.status === "MINIMIZED") {
            if (this.activeExternalId === result.appId) this.activeExternalId = null;
        }
    }
}
