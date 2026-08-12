class WorkspaceManager {
    constructor(opts = {}) {
        this.operationHandlers = {...(opts.operationHandlers || {})};
        this.applications = {};
        (opts.applications || opts.slots || []).forEach(application => {
            this.applications[application.id] = {...application};
        });
        const initialIds = opts.initialApplicationIds || Object.keys(this.applications).slice(0, 1);
        this.slots = initialIds.map(id => this._createSlot(this.applications[id])).filter(Boolean);
        this.activeSlotId = this.slots.length ? this.slots[0].id : null;
        if (this.slots[0]) {
            this.slots[0].active = true;
            this.slots[0].inactive = false;
            this.slots[0].running = true;
            this.slots[0].state = "ACTIVE";
        }
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

    getApplication(id) {
        const application = this.applications[id];
        return application ? {...application} : null;
    }

    setOperationHandler(operation, handler) {
        if (typeof handler !== "function") throw new TypeError("Workspace operation handler must be a function");
        this.operationHandlers[operation] = handler;
    }

    launch(id) {
        const slot = this._ensureSlot(id);
        if (!slot || !slot.available || !this._runOperation("launch", slot)) return false;
        slot.state = slot.type === "external" ? "LAUNCHING" : "RUNNING";
        return this._activate(slot, "launch");
    }

    focus(id) {
        const slot = this._ensureSlot(id);
        if (!slot) return false;
        if (!this._runOperation("focus", slot)) return false;

        return this._activate(slot, "focus");
    }

    minimize(id) {
        const slot = this.getSlot(id);
        if (!slot || slot.placeholder || !this._runOperation("minimize", slot)) return false;
        slot.minimized = true;
        slot.state = "HIDDEN";
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

    close(id, opts = {}) {
        const slot = this.getSlot(id);
        if (!slot || slot.permanent || slot.placeholder || (!opts.skipOperation && !this._runOperation("close", slot))) return false;
        slot.active = false;
        slot.inactive = true;
        slot.running = false;
        slot.state = "CLOSED";
        slot.minimized = false;
        slot.fullscreen = false;
        if (this.activeSlotId === id) this.activeSlotId = null;
        if (!slot.permanent) this.slots = this.slots.filter(item => item.id !== id);
        this._emit("close", slot);
        return true;
    }

    update(id, changes = {}) {
        const slot = this.getSlot(id);
        if (!slot) return false;
        ["available", "minimized", "fullscreen", "running", "status", "state"].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(changes, key)) slot[key] = changes[key];
        });
        this._emit("update", slot);
        return true;
    }

    synchronize(id, changes = {}) {
        const slot = this._ensureSlot(id);
        if (!slot) return false;
        ["available", "minimized", "fullscreen", "running", "status", "state"].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(changes, key)) slot[key] = changes[key];
        });
        if (changes.state === "ACTIVE") return this._activate(slot, "synchronize");
        this._emit("synchronize", slot);
        return true;
    }

    _activate(slot, operation) {
        this.slots.forEach(item => {
            item.active = item.id === slot.id;
            item.inactive = item.id !== slot.id;
            if (item.id !== slot.id && item.state === "ACTIVE") {
                item.state = item.type === "external" ? "HIDDEN" : "RUNNING";
            }
        });
        slot.minimized = false;
        slot.running = true;
        if (slot.state !== "LAUNCHING") slot.state = "ACTIVE";
        this.activeSlotId = slot.id;
        this.slots = [slot].concat(this.slots.filter(item => item.id !== slot.id));
        this._emit(operation, slot);
        return true;
    }

    _ensureSlot(id) {
        const existing = this.getSlot(id);
        if (existing) return existing;
        const slot = this._createSlot(this.applications[id]);
        if (slot) this.slots.push(slot);
        return slot;
    }

    _createSlot(application) {
        if (!application) return null;
        return {
            id: application.id,
            label: application.displayName || application.label || application.id,
            type: application.type || "internal",
            permanent: application.permanent === true,
            available: application.available !== false,
            placeholder: application.placeholder === true,
            active: false,
            inactive: true,
            minimized: false,
            fullscreen: false,
            running: false,
            state: "AVAILABLE",
            status: application.status || ""
        };
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

if (typeof module !== "undefined" && typeof window === "undefined") module.exports = {WorkspaceManager};
