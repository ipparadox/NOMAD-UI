"use strict";
const fs = require("fs");
const path = require("path");
const {resolveTrustedIsolationTool} = require("./repositoryIsolationService.js");
const {digest} = require("./projectAdapters.js");
const {publicApplication} = require("./managedApplications.js");
const {WindowClassLearningService} = require("../cli/windowClassLearningService.js");

class ApplicationAutomationService {
    constructor(opts) {
        this.service = opts.applicationService;
        this.registry = opts.applicationRegistry;
        this.profile = () => { try { return opts.getSecurityProfile(); } catch (_) { return "UNKNOWN"; } };
        this.changed = opts.onChanged || (() => {});
        this.progress = opts.onProgress || (() => {});
        this.learner = opts.learner || new WindowClassLearningService({applicationService: this.service, env: opts.env, authorize: () => this.allowed()});
        this.ignored = new Set();
        this.snapshot = "";
        this.watchers = [];
    }
    allowed() { return ["NORMAL", "PUBLIC"].includes(this.profile()); }
    reload() { this.registry.reload(); this.changed(this.registry.getApplications()); }
    scan() {
        const registered = new Set(this.registry.getApplications().filter(a => a.available !== false).map(a => a.id));
        const discovered = this.service.scan().candidates.filter(c => c.status !== "UNSUPPORTED" && !registered.has(c.id) && !this.ignored.has(c.id)).slice(0, 128);
        return {ok: true, kind: "application-discovery", status: "NEW APPLICATIONS / CONFIRM ADD TO NOMAD", applications: discovered.map(c => ({id: c.id, displayName: c.displayName.replace(/[\u0000-\u001f\u007f]/g, " "), status: c.status}))};
    }
    plan(id) {
        if (!this.allowed()) return {ok: false, status: "APPLICATION REGISTRATION BLOCKED BY SECURITY PROFILE"};
        const c = this.service.findCandidate(id);
        if (c.status === "UNSUPPORTED") return {ok: false, status: "APPLICATION IDENTITY UNSUPPORTED"};
        return {confirmation: {request: "ADD APPLICATION TO NOMAD", target: c.displayName, securityProfile: this.profile(), privilege: "USER", effects: ["VERIFY DESKTOP ENTRY IDENTITY", c.startupWMClass ? "USE VERIFIED STARTUP WM CLASS" : "LAUNCH APPLICATION AND LEARN EXACT WINDOW IDENTITY", "UPDATE LAUNCHER"], fields: [{label: "IDENTITY", value: c.status}]}, stored: {applicationFingerprint: digest(c), profile: this.profile()}};
    }
    async register(id, stored) {
        if (!this.allowed() || stored.profile !== this.profile()) return {ok: false, status: "PROFILE CHANGED / REAUTHORIZE"};
        const c = this.service.findCandidate(id);
        if (digest(c) !== stored.applicationFingerprint) return {ok: false, status: "APPLICATION CHANGED / REAUTHORIZE"};
        const result = this.service.addCandidate(c);
        return this.complete(result);
    }
    async installed(id, installer) {
        const definition = installer.definition(id);
        const candidate = this.service.findInstalledCandidate(definition);
        const executable = candidate && this.trustedInstalledCandidate(candidate);
        if (!executable) return {ok: false, status: "NOMAD REGISTRATION INCOMPLETE / DESKTOP IDENTITY REQUIRES CONFIRMATION"};
        if (!this.allowed()) return {ok: false, status: "REGISTRATION BLOCKED BY SECURITY PROFILE"};
        // Pin the verified absolute executable; never resolve a catalog app again through user PATH.
        return this.complete(this.service.reconcileInstalledCandidate({...candidate, executable}, definition));
    }
    trustedInstalledCandidate(candidate) {
        try {
            const canonical = fs.realpathSync(candidate.path);
            const stat = fs.lstatSync(candidate.path);
            if (canonical !== candidate.path || stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) return false;
            let parent = path.dirname(canonical);
            while (parent !== path.dirname(parent)) {
                const s = fs.lstatSync(parent);
                if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) return false;
                parent = path.dirname(parent);
            }
            const executable = candidate.executable;
            const paths = path.isAbsolute(executable) ? [executable] : [path.join("/usr/bin", executable), path.join("/bin", executable)];
            return resolveTrustedIsolationTool("application", {toolPaths: {application: paths}}) || false;
        } catch (_) { return false; }
    }
    async complete(result) {
        if (!this.allowed()) return {ok: false, status: "REGISTRATION BLOCKED BY SECURITY PROFILE"};
        if (!result || !result.application) return {ok: false, status: "NOMAD REGISTRATION INCOMPLETE / DESKTOP ENTRY NOT FOUND"};
        let application = result.application;
        if (application.status === "WM_CLASS NOT AVAILABLE") {
            this.progress({kind: "application-stage", status: "WINDOW IDENTITY LEARNING", appId: application.id});
            try { application = (await this.learner.learn(application.id)).application; }
            catch (_) {
                this.reload();
                return {ok: false, kind: "application-registration", status: "NOMAD REGISTRATION INCOMPLETE / WINDOW IDENTITY REQUIRES CONFIRMATION OR LEARNING"};
            }
        }
        if (!this.allowed()) return {ok: false, status: "REGISTRATION COMPLETED BUT LAUNCH BLOCKED BY CURRENT PROFILE"};
        this.reload();
        return {ok: application.available !== false, kind: "application-registration", status: application.available !== false ? "APPLICATION READY" : "NOMAD REGISTRATION INCOMPLETE", application: publicApplication(application)};
    }
    ignore(id) { this.ignored.add(id); return this.scan(); }
    start() {
        // Non-recursive watches only on the configured XDG applications directories and registry parent.
        const directories = [...this.service.discovery.directories, path.dirname(this.registry.registryPath)];
        for (const directory of new Set(directories)) {
            try {
                const stat = fs.lstatSync(directory);
                if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || ![0, process.getuid()].includes(stat.uid)) continue;
                const watcher = fs.watch(directory, {persistent: false}, () => this.schedule());
                watcher.on("error", () => {});
                this.watchers.push(watcher);
            } catch (_) {}
        }
        // Fixed-path metadata polling covers directories created after startup and atomic replacement.
        this.poll = setInterval(() => {
            const signature = [...directories, this.registry.registryPath].map(target => {
                try { const s = fs.lstatSync(target); return `${s.dev}:${s.ino}:${s.mtimeMs}:${s.size}`; }
                catch (_) { return "ABSENT"; }
            }).join("|");
            if (signature !== this.directorySignature) { this.directorySignature = signature; this.schedule(); }
        }, 3000);
        this.poll.unref();
        this.schedule();
    }
    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            try {
                this.registry.reload();
                const snapshot = digest({applications: this.registry.getApplications(), discovery: this.scan()});
                if (snapshot !== this.snapshot) { this.snapshot = snapshot; this.changed(this.registry.getApplications()); }
            } catch (_) { /* Existing registry validation preserves malformed configuration. */ }
        }, 300);
        this.timer.unref();
    }
    stop() { clearInterval(this.poll); clearTimeout(this.timer); this.watchers.forEach(w => w.close()); this.watchers = []; }
}
module.exports = {ApplicationAutomationService};
