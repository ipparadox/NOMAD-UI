"use strict";

class SecureKeyboard {
    constructor(opts = {}) {
        if (!opts.container || !opts.layout || typeof opts.layout !== "object" || Array.isArray(opts.layout)) {
            throw new TypeError("Secure keyboard requires a trusted layout projection");
        }
        this.container = typeof opts.container === "string"
            ? document.getElementById(opts.container) : opts.container;
        if (!this.container) throw new TypeError("Secure keyboard container unavailable");
        this.getTerminal = typeof opts.getTerminal === "function" ? opts.getTerminal : (() => null);
        this.onShortcut = typeof opts.onShortcut === "function" ? opts.onShortcut : (() => false);
        this.linkedToTerm = true;
        this.shift = false;
        this.ctrl = false;
        this.alt = false;
        this.fn = false;
        this.caps = false;
        this.pendingDeadKey = null;
        this._lastPhysicalKeydown = null;
        this._lastPhysicalKeyup = null;
        this.container.dataset.passwordMode = "false";
        this._mount(JSON.parse(JSON.stringify(opts.layout)));
        this._onPhysicalKeydown = event => this.keydownHandler(event);
        this._onPhysicalKeyup = event => this.keyupHandler(event);
        document.addEventListener("keydown", this._onPhysicalKeydown);
        document.addEventListener("keyup", this._onPhysicalKeyup);
        window.addEventListener("blur", () => this._releaseAll());
    }

    attach() { this.linkedToTerm = true; }
    detach() { this._releaseAll(); this.linkedToTerm = false; }

    togglePasswordMode() {
        const enabled = this.container.dataset.passwordMode !== "true";
        this.container.dataset.passwordMode = enabled ? "true" : "false";
        window.passwordMode = enabled ? "true" : "false";
        return enabled;
    }

    keydownHandler(event) {
        if (!event || typeof event !== "object") return true;
        if (this._lastPhysicalKeydown === event) return true;
        this._lastPhysicalKeydown = event;
        this.ctrl = event.ctrlKey === true;
        this.shift = event.shiftKey === true;
        this.alt = event.altKey === true;
        if (event.code === "CapsLock" && event.repeat !== true) this.caps = !this.caps;
        this._state();
        const keys = this._findPhysicalKeys(event);
        keys.forEach(key => key.classList.add("active"));
        if (keys.length && event.repeat !== true && this.container.dataset.passwordMode === "false") {
            window.audioManager.stdin.play();
        }
        return true;
    }

    keyupHandler(event) {
        if (!event || typeof event !== "object") return true;
        if (this._lastPhysicalKeyup === event) return true;
        this._lastPhysicalKeyup = event;
        this.ctrl = event.ctrlKey === true;
        this.shift = event.shiftKey === true;
        this.alt = event.altKey === true;
        this._state();
        this._findPhysicalKeys(event).forEach(key => this._blink(key));
        if (event.key === "Enter" && this.container.dataset.passwordMode === "false") window.audioManager.granted.play();
        return true;
    }

    _mount(layout) {
        this.container.replaceChildren();
        Object.keys(layout).slice(0, 16).forEach(rowId => {
            const row = document.createElement("div");
            row.className = "keyboard_row";
            row.id = rowId;
            (Array.isArray(layout[rowId]) ? layout[rowId] : []).slice(0, 32).forEach(definition => {
                if (!definition || typeof definition !== "object") return;
                const key = document.createElement("div");
                key.className = "keyboard_key";
                key.tabIndex = -1;
                const command = this._decode(definition.cmd);
                if (command === " ") key.id = "keyboard_spacebar";
                if (command === "\r") key.classList.add("keyboard_enter");
                Object.keys(definition).filter(name => name.endsWith("cmd")).forEach(name => {
                    key.dataset[name] = this._decode(definition[name]);
                });
                this._renderKey(key, definition);
                key.addEventListener("pointerdown", event => {
                    event.preventDefault();
                    clearTimeout(key.holdTimeout);
                    clearInterval(key.holdInterval);
                    if (typeof key.setPointerCapture === "function") {
                        try { key.setPointerCapture(event.pointerId); } catch (error) {}
                    }
                    key.classList.add("active");
                    const modifier = this._momentaryModifier(definition);
                    if (modifier) {
                        this[modifier] = true;
                        this._state();
                    } else {
                        this._press(definition);
                        if (!this._escapedAction(definition)) {
                            key.holdTimeout = setTimeout(() => {
                                key.holdInterval = setInterval(() => this._press(definition), 70);
                            }, 400);
                        }
                    }
                    const terminal = this.getTerminal();
                    if (this.linkedToTerm && terminal && terminal.term && typeof terminal.term.focus === "function") terminal.term.focus();
                    if (this.container.dataset.passwordMode === "false") {
                        (command === "\r" ? window.audioManager.granted : window.audioManager.stdin).play();
                    }
                });
                const release = () => {
                    clearTimeout(key.holdTimeout);
                    clearInterval(key.holdInterval);
                    const modifier = this._momentaryModifier(definition);
                    if (modifier) {
                        this[modifier] = false;
                        this._state();
                    }
                    this._blink(key);
                };
                key.addEventListener("pointerup", release);
                key.addEventListener("pointercancel", release);
                key.addEventListener("lostpointercapture", release);
                key.addEventListener("pointerleave", release);
                row.appendChild(key);
            });
            this.container.appendChild(row);
        });
        this._state();
    }

    _press(definition) {
        if (this._activateShortcut(definition)) return true;
        let field = "cmd";
        if (this.fn && typeof definition.fn_cmd === "string") field = "fn_cmd";
        else if (this.ctrl && typeof definition.ctrl_cmd === "string") field = "ctrl_cmd";
        else if (this.alt && this.shift && typeof definition.altshift_cmd === "string") field = "altshift_cmd";
        else if (this.alt && typeof definition.alt_cmd === "string") field = "alt_cmd";
        else if ((this.shift || this.caps) && typeof definition.shift_cmd === "string") field = "shift_cmd";
        if (this.caps && typeof definition.capslck_cmd === "string") field = "capslck_cmd";
        let command = this._decode(definition[field]);
        if (command.startsWith("ESCAPED|-- ")) return this._applyEscaped(command);
        if (this.caps && !this.shift && /^[a-z]$/.test(command)) command = command.toUpperCase();
        if (this.pendingDeadKey) command = this._applyDeadKey(command);
        return this._route(command);
    }

    _route(command) {
        if (!command) return false;
        if (this.linkedToTerm) {
            const terminal = this.getTerminal();
            return Boolean(terminal && typeof terminal.write === "function" && terminal.write(command));
        }
        const target = document.activeElement;
        if (!target || typeof target.value !== "string" || target.disabled || target.readOnly) return false;
        const start = Number.isSafeInteger(target.selectionStart) ? target.selectionStart : target.value.length;
        const end = Number.isSafeInteger(target.selectionEnd) ? target.selectionEnd : start;
        if (command === "\b") target.setRangeText("", Math.max(0, start - (start === end ? 1 : 0)), end, "end");
        else if (command === "\u001bOD") target.setSelectionRange(Math.max(0, start - 1), Math.max(0, start - 1));
        else if (command === "\u001bOC") target.setSelectionRange(Math.min(target.value.length, end + 1), Math.min(target.value.length, end + 1));
        else if (command === "\r") {
            target.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", code: "Enter", bubbles: true, cancelable: true}));
            return true;
        } else if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(command)) {
            target.setRangeText(command, start, end, "end");
        } else return false;
        target.dispatchEvent(new Event("input", {bubbles: true}));
        target.focus();
        return true;
    }

    _renderKey(key, definition) {
        const iconName = typeof definition.name === "string" && definition.name.startsWith("ESCAPED|-- ICON: ")
            ? definition.name.slice(17) : null;
        if (iconName) {
            key.appendChild(this._icon(iconName));
            key.setAttribute("aria-label", iconName.replace(/_/g, " "));
            return;
        }
        ["altshift_name", "fn_name", "alt_name", "shift_name", "name"].forEach((name, index) => {
            const heading = document.createElement(`h${5 - index}`);
            heading.textContent = this._label(definition[name] || "");
            key.appendChild(heading);
        });
        key.setAttribute("aria-label", this._label(definition.name || "") || "KEY");
    }

    _icon(name) {
        const paths = {
            ARROW_UP: ["m12.00004 7.99999 4.99996 5h-2.99996v4.00001h-4v-4.00001h-3z", "m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"],
            ARROW_LEFT: ["m7.500015 12.499975 5-4.99996v2.99996h4.00001v4h-4.00001v3z", "m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"],
            ARROW_DOWN: ["m12 17-4.99996-5h2.99996v-4.00001h4v4.00001h3z", "m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"],
            ARROW_RIGHT: ["m16.500025 12.500015-5 4.99996v-2.99996h-4.00001v-4h4.00001v-3z", "m4 3h16c1.1046 0 1-0.10457 1 1v16c0 1.1046 0.1046 1-1 1h-16c-1.10457 0-1 0.1046-1-1v-16c0-1.10457-0.10457-1 1-1zm0 1v16h16v-16z"]
        };
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        (paths[name] || paths.ARROW_UP).forEach((data, index) => {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", data);
            path.setAttribute("fill-opacity", index === 0 ? "1" : "0.65");
            svg.appendChild(path);
        });
        return svg;
    }

    _momentaryModifier(definition) {
        const raw = typeof definition.cmd === "string" ? definition.cmd.toUpperCase() : "";
        if (raw.startsWith("ESCAPED|-- SHIFT")) return "shift";
        if (raw.startsWith("ESCAPED|-- CTRL")) return "ctrl";
        if (raw.startsWith("ESCAPED|-- ALT")) return "alt";
        return null;
    }

    _escapedAction(definition) {
        return [definition.cmd, definition.shift_cmd, definition.fn_cmd]
            .some(value => typeof value === "string" && value.startsWith("ESCAPED|-- "));
    }

    _applyEscaped(command) {
        const token = command.slice(11).toUpperCase();
        if (token === "CAPSLCK: ON") this.caps = true;
        else if (token === "CAPSLCK: OFF") this.caps = false;
        else if (token === "FN: ON") this.fn = true;
        else if (token === "FN: OFF") this.fn = false;
        else if ([
            "CIRCUM", "TREMA", "ACUTE", "GRAVE", "CARON", "BAR", "BREVE", "TILDE",
            "MACRON", "CEDILLA", "OVERRING", "GREEK", "IOTASUB"
        ].includes(token)) this.pendingDeadKey = token;
        else return false;
        this._state();
        return true;
    }

    _applyDeadKey(command) {
        const token = this.pendingDeadKey;
        this.pendingDeadKey = null;
        if (!command || command.length > 4) return command;
        if (token === "GREEK") {
            const greek = {
                a: "α", b: "β", c: "ψ", d: "δ", e: "ε", f: "φ", g: "γ", h: "η",
                i: "ι", j: "ξ", k: "κ", l: "λ", m: "μ", n: "ν", o: "ο", p: "π",
                q: "θ", r: "ρ", s: "σ", t: "τ", u: "υ", v: "ς", w: "ω", x: "χ", y: "υ", z: "ζ"
            };
            const mapped = greek[command.toLowerCase()];
            return mapped && command === command.toUpperCase() ? mapped.toUpperCase() : (mapped || command);
        }
        const combining = {
            CIRCUM: "\u0302", TREMA: "\u0308", ACUTE: "\u0301", GRAVE: "\u0300",
            CARON: "\u030c", BAR: "\u0335", BREVE: "\u0306", TILDE: "\u0303",
            MACRON: "\u0304", CEDILLA: "\u0327", OVERRING: "\u030a", IOTASUB: "\u0345"
        }[token];
        return combining ? `${command}${combining}`.normalize("NFC") : command;
    }

    _activateShortcut(definition) {
        const base = this._decode(definition.cmd);
        let action = null;
        if (this.ctrl && this.shift) {
            const actions = {c: "COPY", v: "PASTE", s: "SETTINGS", k: "SHORTCUTS", p: "KB_PASSMODE"};
            action = actions[base.toLowerCase()] || (base === "\t" ? "PREVIOUS_TAB" : null);
        } else if (this.ctrl) {
            if (base === "\t") action = "NEXT_TAB";
            else if (base === " ") action = "CONTROL_PLANE";
            else if (/^[1-5]$/.test(base)) action = `TAB_${base}`;
        }
        if (!this.linkedToTerm && action !== "CONTROL_PLANE") return false;
        return Boolean(action && this.onShortcut(action) !== false);
    }

    _findPhysicalKeys(event) {
        if (event.code === "Enter" || event.code === "NumpadEnter") {
            return Array.from(this.container.querySelectorAll(".keyboard_enter"));
        }
        const special = {
            ShiftLeft: "ESCAPED|-- SHIFT: LEFT",
            ShiftRight: "ESCAPED|-- SHIFT: RIGHT",
            ControlLeft: "ESCAPED|-- CTRL: LEFT",
            ControlRight: "ESCAPED|-- CTRL: RIGHT",
            AltLeft: "ESCAPED|-- FN: ON",
            AltRight: "ESCAPED|-- ALT: RIGHT",
            CapsLock: "ESCAPED|-- CAPSLCK: ON",
            Escape: "\u001b",
            Backspace: "\b",
            ArrowUp: "\u001bOA",
            ArrowLeft: "\u001bOD",
            ArrowDown: "\u001bOB",
            ArrowRight: "\u001bOC"
        };
        const expected = Object.prototype.hasOwnProperty.call(special, event.code) ? special[event.code] : event.key;
        return Array.from(this.container.querySelectorAll(".keyboard_key")).filter(key => {
            return [key.dataset.cmd, key.dataset.shift_cmd, key.dataset.ctrl_cmd, key.dataset.alt_cmd]
                .some(value => value === expected);
        }).slice(0, 2);
    }

    _blink(key) {
        const keys = key.classList.contains("keyboard_enter")
            ? Array.from(this.container.querySelectorAll(".keyboard_enter")) : [key];
        keys.forEach(item => {
            item.classList.remove("active");
            item.classList.add("blink");
        });
        setTimeout(() => keys.forEach(item => item.classList.remove("blink")), 100);
    }

    _releaseAll() {
        this.shift = false;
        this.ctrl = false;
        this.alt = false;
        this._state();
        this.container.querySelectorAll(".keyboard_key.active").forEach(key => {
            clearTimeout(key.holdTimeout);
            clearInterval(key.holdInterval);
            key.classList.remove("active");
        });
    }

    _decode(value) {
        if (typeof value !== "string") return "";
        const controls = ["", "\u001b", "\u001c", "\u001d", "\u001e", "\u001f", "\u0011", "\u0017", "\u0012", "\u0012", "\u0019", "\u0015", "\u0010", "\u0001", "\u0013", "\u0004", "\u0006", "\u001a", "\u0018", "\u0003", "\u0016", "\u0002"];
        return value.replace(/~~~CTRLSEQ(\d{1,2})~~~/g, (match, index) => controls[Number(index)] || "");
    }

    _label(value) {
        if (typeof value !== "string") return "";
        if (!value.startsWith("ESCAPED|-- ")) return value.slice(0, 12);
        if (value.startsWith("ESCAPED|-- ICON: ")) return "";
        return value.slice(11).split(":")[0].slice(0, 8);
    }

    _state() {
        this.container.dataset.isShiftOn = String(this.shift);
        this.container.dataset.isCapsLckOn = String(this.caps);
        this.container.dataset.isAltOn = String(this.alt);
        this.container.dataset.isCtrlOn = String(this.ctrl);
        this.container.dataset.isFnOn = String(this.fn);
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") module["exports"] = {SecureKeyboard};
