"use strict";

const os = require("os");
const {execFile} = require("child_process");

// Confirmation of the OS session, NOT a password authenticator or screen lock.
// Fixed executable/arguments, bounded output/time; no renderer-supplied OS input.
function inspectSession() {
    return new Promise(resolve => execFile("/usr/bin/loginctl", ["show-session", "self",
        "--property=User", "--property=Service", "--property=Active", "--property=Remote"],
    {timeout: 2000, maxBuffer: 4096, encoding: "utf8", env: {PATH: "/usr/bin:/bin", LANG: "C"}},
    (error, stdout) => resolve(error ? {} : Object.fromEntries(stdout.trim().split("\n")
        .map(line => line.split("=")).filter(parts => parts.length === 2)))));
}

class SessionAuthProvider {
    constructor({userInfo = os.userInfo, hostname = os.hostname, inspect = inspectSession} = {}) {
        this.userInfo = userInfo;
        this.hostname = hostname;
        this.inspect = inspect;
        this.confirmed = false;
        this.sessionRead = null;
        this.sessionReadAt = 0;
    }
    async getIdentity() {
        const user = this.userInfo();
        const clean = value => String(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 128);
        return {operator: clean(user.username), node: clean(this.hostname())};
    }
    async getAuthenticationState() {
        // Coalesce renderer polling and bound OS metadata reads to once/second.
        if (!this.sessionRead || Date.now() - this.sessionReadAt >= 1000) {
            this.sessionReadAt = Date.now();
            this.sessionRead = Promise.resolve().then(() => this.inspect()).catch(() => ({}));
        }
        const session = await this.sessionRead;
        const user = this.userInfo();
        const gdm = session.User === String(user.uid) && session.Active === "yes"
            && session.Remote === "no" && session.Service === "gdm-password";
        return {provider: "OS_SESSION_CONFIRMATION", credentialRequired: false,
            channel: gdm ? "GDM" : "UNKNOWN", confirmed: this.confirmed,
            description: gdm ? "SESSION AUTHENTICATED BY GDM" : "EXISTING OS SESSION // AUTH CHANNEL UNKNOWN"};
    }
    getRateLimitState() {
        return {applicable: false, reason: "NO CREDENTIAL AUTHENTICATOR"};
    }
    async authenticate(...args) {
        if (args.length) return {ok: false};
        // Acknowledgement only. No credentials accepted, verified, retained or logged.
        this.confirmed = true;
        return {ok: true, confirmed: true, status: "SESSION CONFIRMED"};
    }
}

function validRequest(request) {
    return Boolean(request) && typeof request === "object" && !Array.isArray(request)
        && Object.keys(request).length === 0;
}
function registerSessionAuth(ipc, provider, owns, verified) {
    ipc.handle("nomad.auth.session.get", async (event, request) => {
        if (!owns(event.sender) || !validRequest(request)) return {ok: false};
        return {ok: true, identity: await provider.getIdentity(),
            authentication: await provider.getAuthenticationState(), rateLimit: provider.getRateLimitState(),
            rendererVerified: verified() === true};
    });
    ipc.handle("nomad.auth.session.confirm", (event, request) => {
        if (!owns(event.sender) || !validRequest(request) || verified() !== true) return {ok: false};
        return provider.authenticate();
    });
}
module.exports = {SessionAuthProvider, registerSessionAuth};
