class InputCaptureController {
    constructor(opts = {}) {
        this.getKeyboard = typeof opts.getKeyboard === "function"
            ? opts.getKeyboard : (() => opts.keyboard || null);
        this.isTerminalActive = typeof opts.isTerminalActive === "function"
            ? opts.isTerminalActive : (() => false);
        this.focusTerminal = typeof opts.focusTerminal === "function" ? opts.focusTerminal : (() => {});
        this.onchange = typeof opts.onchange === "function" ? opts.onchange : (() => {});
        this.owners = new Set();
        this.restoreTerminalKeyboard = false;
    }

    get active() {
        return this.owners.size > 0;
    }

    acquire(owner) {
        if (!owner || this.owners.has(owner)) return false;
        const wasActive = this.active;
        this.owners.add(owner);
        if (!wasActive) {
            const keyboard = this.getKeyboard();
            this.restoreTerminalKeyboard = Boolean(keyboard && keyboard.linkedToTerm);
            if (this.restoreTerminalKeyboard && typeof keyboard.detach === "function") keyboard.detach();
            this.onchange(true);
        }
        return true;
    }

    release(owner) {
        if (!this.owners.delete(owner)) return false;
        if (!this.active) {
            const keyboard = this.getKeyboard();
            if (this.restoreTerminalKeyboard && keyboard && typeof keyboard.attach === "function") keyboard.attach();
            this.restoreTerminalKeyboard = false;
            this.onchange(false);
        }
        return true;
    }

    handleMouseup() {
        if (this.active) return false;
        const keyboard = this.getKeyboard();
        if (!keyboard || !keyboard.linkedToTerm || !this.isTerminalActive()) return false;
        this.focusTerminal();
        return true;
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") module.exports = {InputCaptureController};
