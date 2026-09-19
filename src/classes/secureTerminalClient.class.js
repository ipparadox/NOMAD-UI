"use strict";

class SecureTerminalClient {
    constructor(opts = {}) {
        if (!opts.bridge || !opts.parentId || !Number.isSafeInteger(opts.port)
            || opts.port < 1 || opts.port > 65535 || !/^[a-f0-9]{64}$/.test(opts.authToken || "")) {
            throw new TypeError("Secure terminal connection invalid");
        }
        this.bridge = opts.bridge;
        this.port = opts.port;
        this.authToken = opts.authToken;
        this.cwd = "";
        this.oncwdchange = () => {};
        this.onprocesschange = () => {};
        this.onclose = () => {};
        this.lastRefit = 0;
        this.lastSoundFX = 0;
        this.isReady = false;
        let resolveReady;
        let rejectReady;
        this.ready = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        const Xterm = window.Terminal;
        const Fit = window.FitAddon && window.FitAddon.FitAddon;
        const Attach = window.AttachAddon && window.AttachAddon.AttachAddon;
        if (!Xterm || !Fit || !Attach) throw new Error("Terminal renderer libraries unavailable");
        const theme = opts.theme || {};
        const colors = theme.colors || {};
        const terminalTheme = theme.terminal || {};
        this.term = new Xterm({
            cols: 80,
            rows: 24,
            cursorBlink: terminalTheme.cursorBlink !== false,
            cursorStyle: ["block", "underline", "bar"].includes(terminalTheme.cursorStyle)
                ? terminalTheme.cursorStyle : "block",
            allowTransparency: terminalTheme.allowTransparency === true,
            fontFamily: String(terminalTheme.fontFamily || "Fira Mono").slice(0, 128),
            fontSize: Number.isFinite(opts.fontSize) ? opts.fontSize : 15,
            fontWeight: terminalTheme.fontWeight || "normal",
            fontWeightBold: terminalTheme.fontWeightBold || "bold",
            letterSpacing: Number.isFinite(terminalTheme.letterSpacing) ? terminalTheme.letterSpacing : 0,
            lineHeight: Number.isFinite(terminalTheme.lineHeight) ? terminalTheme.lineHeight : 1,
            scrollback: 1500,
            bellStyle: "none",
            theme: {
                foreground: terminalTheme.foreground || "#ffffff",
                background: terminalTheme.background || "#000000",
                cursor: terminalTheme.cursor || "#ffffff",
                cursorAccent: terminalTheme.cursorAccent || "#000000",
                selection: terminalTheme.selection || "rgba(255,255,255,.25)",
                black: colors.black || "#2e3436",
                red: colors.red || "#cc0000",
                green: colors.green || "#4e9a06",
                yellow: colors.yellow || "#c4a000",
                blue: colors.blue || "#3465a4",
                magenta: colors.magenta || "#75507b",
                cyan: colors.cyan || "#06989a",
                white: colors.white || "#d3d7cf",
                brightBlack: colors.brightBlack || "#555753",
                brightRed: colors.brightRed || "#ef2929",
                brightGreen: colors.brightGreen || "#8ae234",
                brightYellow: colors.brightYellow || "#fce94f",
                brightBlue: colors.brightBlue || "#729fcf",
                brightMagenta: colors.brightMagenta || "#ad7fa8",
                brightCyan: colors.brightCyan || "#34e2e2",
                brightWhite: colors.brightWhite || "#eeeeec"
            }
        });
        this.fitAddon = new Fit();
        this.term.loadAddon(this.fitAddon);
        const parent = document.getElementById(opts.parentId);
        if (!parent) throw new Error("Terminal container unavailable");
        this.term.open(parent);
        this.term.attachCustomKeyEventHandler(event => {
            if (window.keyboard && typeof window.keyboard.keydownHandler === "function") {
                if (event.type === "keyup") window.keyboard.keyupHandler(event);
                else window.keyboard.keydownHandler(event);
            }
            return true;
        });
        parent.addEventListener("wheel", event => this.term.scrollLines(Math.round(event.deltaY / 10)));
        this._removeClientState = this.bridge.onClientState(this.port, payload => this._clientState(payload));
        this.bridge.sendClientEvent(this.port, "Renderer startup");
        const query = `?token=${encodeURIComponent(this.authToken)}`;
        this.socket = new WebSocket(`ws://127.0.0.1:${this.port}/${query}`);
        this.socket.addEventListener("open", () => {
            this.term.loadAddon(new Attach(this.socket));
            this.fit();
            this.isReady = true;
            resolveReady(true);
        });
        this.socket.addEventListener("message", () => {
            const timestamp = Date.now();
            if (timestamp - this.lastSoundFX > 30 && window.passwordMode === "false") {
                window.audioManager.stdout.play();
                this.lastSoundFX = timestamp;
            }
        });
        this.socket.addEventListener("close", event => {
            if (!this.isReady) rejectReady(new Error("Terminal transport closed before initialization"));
            this.onclose(event);
        });
        this.socket.addEventListener("error", () => {
            this.term.writeln("\r\nTERMINAL TRANSPORT UNAVAILABLE");
            if (!this.isReady) rejectReady(new Error("Terminal transport unavailable"));
        });
        this.clipboard = {
            copy: async () => {
                if (!this.term.hasSelection()) return false;
                const selected = this.term.getSelection();
                try { await navigator.clipboard.writeText(selected); } catch (error) { return false; }
                this.term.clearSelection();
                return true;
            },
            paste: async () => {
                const result = await this.bridge.readClipboard();
                if (!result || result.ok !== true || typeof result.text !== "string") return false;
                return this.write(result.text);
            }
        };
    }

    fit() {
        this.lastRefit = Date.now();
        const dimensions = this.fitAddon.proposeDimensions();
        if (!dimensions || !Number.isSafeInteger(dimensions.cols) || !Number.isSafeInteger(dimensions.rows)) return false;
        const cols = Math.max(1, Math.min(500, dimensions.cols));
        const rows = Math.max(1, Math.min(500, dimensions.rows));
        if (this.term.cols !== cols || this.term.rows !== rows) this.resize(cols, rows);
        return true;
    }

    resize(cols, rows) {
        if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)
            || cols < 1 || cols > 500 || rows < 1 || rows > 500) return false;
        this.term.resize(cols, rows);
        return this.bridge.sendClientEvent(this.port, "Resize", cols, rows);
    }

    write(text) {
        if (typeof text !== "string" || text.length > 1024 * 1024 || !this.socket
            || this.socket.readyState !== WebSocket.OPEN) return false;
        this.socket.send(text);
        return true;
    }

    writelr(text) {
        return typeof text === "string" && !/[\r\n]/.test(text) && this.write(`${text}\r`);
    }

    resendCWD() { this.oncwdchange(this.cwd || null); }

    dispose() {
        if (typeof this._removeClientState === "function") this._removeClientState();
        try { this.socket.close(); } catch (error) {}
        this.term.dispose();
    }

    _clientState(payload) {
        if (!Array.isArray(payload) || typeof payload[0] !== "string") return;
        if (payload[0] === "New cwd" || payload[0] === "Fallback cwd") {
            this.cwd = payload[0] === "Fallback cwd" ? `FALLBACK |-- ${String(payload[1] || "")}` : String(payload[1] || "");
            this.oncwdchange(this.cwd);
        } else if (payload[0] === "New process") {
            this.onprocesschange(String(payload[1] || "").slice(0, 256));
        }
    }
}

if (typeof module !== "undefined" && typeof window === "undefined") module["exports"] = {SecureTerminalClient};
