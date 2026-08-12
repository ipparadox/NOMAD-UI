class TerminalForegroundControl {
    constructor(opts = {}) {
        if (!opts.button || !opts.ipc) throw new TypeError("Terminal foreground control requires a button and IPC");
        this.button = opts.button;
        this.ipc = opts.ipc;
        this.container = opts.container || this.button.parentElement || null;
        this.onResume = typeof opts.onResume === "function" ? opts.onResume : (() => {});
        this.running = false;
        this.stopping = false;
        this._initializePromise = null;

        this._onState = (event, state) => this.update(state);
        this._onClick = event => {
            event.preventDefault();
            event.stopPropagation();
            this.stop();
        };
        this.ipc.on("terminal-foreground-state", this._onState);
        this.button.addEventListener("click", this._onClick);
        this._render();
    }

    initialize() {
        if (this._initializePromise) return this._initializePromise;
        this._initializePromise = this.ipc.invoke("terminal-operation", "terminal.getForegroundState")
            .then(state => {
                this.update(state);
                return state;
            }).catch(() => null).finally(() => {
                this._initializePromise = null;
            });
        return this._initializePromise;
    }

    async stop() {
        if (!this.running || this.stopping) return false;
        this.stopping = true;
        this._render();
        try {
            const state = await this.ipc.invoke("terminal-operation", "terminal.stopForeground");
            this.update(state);
            return Boolean(state && state.ok !== false);
        } catch (error) {
            return false;
        } finally {
            this.stopping = false;
            this._render();
            try {
                this.onResume();
            } catch (error) {}
        }
    }

    update(state) {
        if (!state || typeof state.foregroundProcessRunning !== "boolean") return;
        this.running = state.foregroundProcessRunning;
        if (!this.running) this.stopping = false;
        this._render();
    }

    destroy() {
        this.ipc.removeListener("terminal-foreground-state", this._onState);
        this.button.removeEventListener("click", this._onClick);
    }

    _render() {
        if (this.container) this.container.hidden = !this.running;
        this.button.hidden = !this.running;
        this.button.disabled = !this.running || this.stopping;
        this.button.setAttribute("aria-hidden", this.running ? "false" : "true");
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") {
    module.exports = {TerminalForegroundControl};
}
