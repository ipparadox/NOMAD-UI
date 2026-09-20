"use strict";

const LOGIN_TRANSITIONS = Object.freeze({
    BOOTSTRAP: ["AUTH_INITIALIZING", "FATAL"],
    AUTH_INITIALIZING: ["AUTH_READY", "FATAL"],
    AUTH_READY: ["AUTHENTICATING", "FATAL"],
    AUTHENTICATING: ["AUTH_FAILED", "AUTH_SUCCESS", "FATAL"],
    AUTH_FAILED: ["AUTHENTICATING", "FATAL"],
    AUTH_SUCCESS: ["SESSION_INITIALIZING", "FATAL"],
    SESSION_INITIALIZING: ["NOMAD_READY", "FATAL"],
    NOMAD_READY: [], FATAL: []
});

class LoginExperience {
    constructor(root, provider) {
        this.root = root;
        this.provider = provider;
        this.state = "BOOTSTRAP";
        this.wave = new AsciiWaveBackground(root.querySelector("canvas"));
        this.button = root.querySelector("button");
        this.status = root.querySelector("[data-login-status]");
        this.onKey = event => {
            if (this.state === "NOMAD_READY" || this.state === "FATAL") return;
            // Capture before terminal, virtual keyboard, and Control Plane handlers.
            event.stopImmediatePropagation();
            if (event.type !== "keydown") return;
            if (event.key === "Enter") { event.preventDefault(); this.confirm(); }
            if (event.key === "Escape") { event.preventDefault(); this.button.focus(); }
            if (event.key === "Tab") { event.preventDefault(); this.button.focus(); }
        };
        ["keydown", "keyup", "keypress"].forEach(type => window.addEventListener(type, this.onKey, true));
        this.onFocus = event => {
            if (!this.root.contains(event.target) && !this.button.disabled) this.button.focus();
        };
        document.addEventListener("focusin", this.onFocus);
        this.onClick = () => this.confirm();
        this.button.addEventListener("click", this.onClick);
        this.onUnload = () => this.destroy();
        window.addEventListener("pagehide", this.onUnload, {once: true});
        this.wave.start();
        this.clock = setInterval(() => this.signal("time", new Date().toLocaleTimeString([], {hour12: false})), 1000);
        this.signal("time", new Date().toLocaleTimeString([], {hour12: false}));
        this.confirmed = new Promise(resolve => { this.resolveConfirmation = resolve; });
        this.root.dataset.state = this.state;
    }
    transition(next) {
        if (!LOGIN_TRANSITIONS[this.state].includes(next)) throw new Error("Invalid login transition");
        this.state = next;
        this.root.dataset.state = next;
        document.body.dataset.nomadLoginState = next;
    }
    signal(name, value) {
        const target = this.root.querySelector(`[data-login-${name}]`);
        if (target) target.textContent = value || "UNKNOWN";
    }
    async initialize() {
        this.transition("AUTH_INITIALIZING");
        // Poll an actual main-process verification result, never infer readiness
        // from elapsed time. Timeout is a failure bound, not simulated progress.
        const deadline = performance.now() + 15000;
        let session;
        do {
            session = await this.provider.getSession();
            if (!session || !session.ok) throw new Error("Session provider unavailable");
            if (session.rendererVerified) break;
            if (performance.now() >= deadline) throw new Error("Renderer verification unavailable");
            await new Promise(resolve => setTimeout(resolve, 100));
        } while (true);
        this.signal("operator", session.identity.operator);
        this.signal("node", session.identity.node);
        this.signal("channel", session.authentication.channel);
        this.root.dataset.authChannel = session.authentication.channel;
        this.signal("session", session.authentication.description);
        this.signal("renderer", "VERIFIED / ISOLATED");
        this.transition("AUTH_READY");
        this.status.textContent = "AWAITING OPERATOR CONFIRMATION";
        this.button.disabled = false;
        this.button.focus();
    }
    async confirm() {
        if (!["AUTH_READY", "AUTH_FAILED"].includes(this.state)) return;
        this.transition("AUTHENTICATING");
        this.button.disabled = true;
        this.status.textContent = "CONFIRMING SESSION";
        try {
            const result = await this.provider.confirmSession();
            if (!result || !result.ok || !result.confirmed) throw new Error("Session confirmation unavailable");
            this.transition("AUTH_SUCCESS");
            this.status.textContent = "SESSION CONFIRMED";
            this.button.textContent = "[ SESSION CONFIRMED ]";
            this.resolveConfirmation();
        } catch (error) {
            // This is a service failure, not a fabricated wrong-password flow.
            this.transition("AUTH_FAILED");
            this.status.textContent = "SESSION CONFIRMATION UNAVAILABLE // RETRY";
            this.button.disabled = false;
            this.button.focus();
        }
    }
    async reveal() {
        // Initialization has finished; only this cosmetic dissolve uses duration.
        this.root.classList.add("nomad-login-reveal");
        document.body.classList.add("nomad-revealing");
        await new Promise(resolve => {
            const animation = this.root.animate([{opacity: 1}, {opacity: 1, offset: 0.25}, {opacity: 0}],
                {duration: 2100, easing: "cubic-bezier(.22,.61,.36,1)", fill: "forwards"});
            animation.onfinish = resolve;
            animation.oncancel = resolve;
        });
        this.transition("NOMAD_READY");
        document.body.classList.remove("nomad-login-active", "nomad-revealing");
        this.destroy();
        this.root.remove();
    }
    destroy() {
        this.wave.destroy();
        clearInterval(this.clock);
        ["keydown", "keyup", "keypress"].forEach(type => window.removeEventListener(type, this.onKey, true));
        document.removeEventListener("focusin", this.onFocus);
        window.removeEventListener("pagehide", this.onUnload);
        this.button.removeEventListener("click", this.onClick);
    }
    fatal() {
        if (LOGIN_TRANSITIONS[this.state].includes("FATAL")) this.transition("FATAL");
        this.destroy();
    }
}
