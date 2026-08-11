class WorkspaceManager {
    constructor(opts = {}) {
        this.operationHandlers = {...(opts.operationHandlers || {})};
        this.slots = (opts.slots || []).map((slot, index) => ({
            id: slot.id,
            label: slot.label || slot.id,
            available: slot.available !== false,
            placeholder: slot.placeholder === true,
            empty: slot.empty === true,
            active: index === 0,
            inactive: index !== 0,
            minimized: false,
            fullscreen: false,
            running: slot.id === "terminal",
            status: slot.status || ""
        }));
        this.activeSlotId = this.slots.length ? this.slots[0].id : null;
        this.listeners = [];
    }

    subscribe(listener) {
        if (typeof listener !== "function") throw new TypeError("Workspace listener must be a function");
        this.listeners.push(listener);
        listener(this.getState());
        return () => {
            this.listeners = this.listeners.filter(item => item !== listener);
        };
    }

    getState() {
        return {
            activeSlotId: this.activeSlotId,
            slots: this.slots.map(slot => ({...slot}))
        };
    }

    getSlot(id) {
        return this.slots.find(slot => slot.id === id) || null;
    }

    setOperationHandler(operation, handler) {
        if (typeof handler !== "function") throw new TypeError("Workspace operation handler must be a function");
        this.operationHandlers[operation] = handler;
    }

    launch(id) {
        const slot = this.getSlot(id);
        if (!slot || !slot.available || slot.placeholder || !this._runOperation("launch", slot)) return false;
        return this._activate(slot, "launch");
    }

    focus(id) {
        const slot = this.getSlot(id);
        if (!slot) return false;
        if (!this._runOperation("focus", slot)) return false;

        return this._activate(slot, "focus");
    }

    minimize(id) {
        const slot = this.getSlot(id);
        if (!slot || slot.placeholder || !this._runOperation("minimize", slot)) return false;
        slot.minimized = true;
        slot.active = false;
        slot.inactive = true;
        if (this.activeSlotId === id) this.activeSlotId = null;
        this._emit("minimize", slot);
        return true;
    }

    restore(id) {
        const slot = this.getSlot(id);
        if (!slot || slot.placeholder || !this._runOperation("restore", slot)) return false;
        return this._activate(slot, "restore");
    }

    fullscreen(id, enabled = true) {
        const slot = this.getSlot(id);
        if (!slot || slot.placeholder || !this._runOperation("fullscreen", slot, Boolean(enabled))) return false;
        slot.fullscreen = Boolean(enabled);
        this._emit("fullscreen", slot);
        return true;
    }

    close(id) {
        const slot = this.getSlot(id);
        if (!slot || slot.id === "terminal" || slot.placeholder || !this._runOperation("close", slot)) return false;
        slot.active = false;
        slot.inactive = true;
        slot.running = false;
        slot.minimized = false;
        slot.fullscreen = false;
        if (this.activeSlotId === id) this.activeSlotId = null;
        this._emit("close", slot);
        return true;
    }

    update(id, changes = {}) {
        const slot = this.getSlot(id);
        if (!slot) return false;
        ["available", "minimized", "fullscreen", "running", "status"].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(changes, key)) slot[key] = changes[key];
        });
        this._emit("update", slot);
        return true;
    }

    _activate(slot, operation) {
        this.slots.forEach(item => {
            item.active = item.id === slot.id;
            item.inactive = item.id !== slot.id;
        });
        slot.minimized = false;
        this.activeSlotId = slot.id;
        this._emit(operation, slot);
        return true;
    }

    _emit(operation, slot) {
        const state = this.getState();
        this.listeners.forEach(listener => listener(state, operation, {...slot}));
    }

    _runOperation(operation, slot, value) {
        const handler = this.operationHandlers[operation];
        return !handler || handler({...slot}, value) !== false;
    }
}
