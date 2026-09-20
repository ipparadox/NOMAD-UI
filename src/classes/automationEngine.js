"use strict";

const crypto = require("crypto");
const {inspectProject, digest} = require("./projectAdapters.js");
const OPERATION_ID = /^automation_[a-f0-9]{32}$/;
const copy = value => JSON.parse(JSON.stringify(value));
const clean = value => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);

// Main-side coordinator. It accepts repository IDs and sealed plans, never commands.
class AutomationEngine {
    constructor(opts) {
        this.repositories = opts.repositoryService;
        this.processes = opts.processManager;
        this.profile = () => {
            try { return opts.getSecurityProfile(); } catch (_) { return "UNKNOWN"; }
        };
        this.inspectAdapter = opts.inspectProject || inspectProject;
        this.onState = opts.onState || (() => {});
        this.pathPolicyAllows = opts.pathPolicyAllows || (() => true);
        this.operations = new Map();
        this.ready = new Map();
        this.plans = new Map();
    }
    inspectRecord(repository) {
        try {
            const inspected = this.inspectAdapter(repository);
            const ready = this.ready.get(repository.id);
            if (ready && ready.identity === repository.executionIdentity) {
                if (ready.fingerprint === inspected.fingerprint) inspected.state = "READY";
                else { inspected.state = "SETUP_REQUIRED"; inspected.notice = "PROJECT CHANGED / REINSPECTION REQUIRED"; }
            }
            if (this.processes.isActive(repository.id)) inspected.state = "RUNNING";
            if (this.profile() === "LOCKDOWN") inspected.state = "BLOCKED";
            return inspected;
        } catch (_) { return {type: "UNKNOWN", profiles: [], steps: [], state: "ERROR", blocked: "PROJECT INPUT INVALID OR UNSAFE"}; }
    }
    project(repository) {
        const i = this.inspectRecord(repository);
        const latest = Array.from(this.operations.values()).reverse().find(operation => operation.repositoryId === repository.id);
        if (i.state !== "BLOCKED" && latest && latest.state === "FAILED") {
            i.state = "ERROR";
            i.notice = latest.status;
        }
        if (i.state !== "BLOCKED" && this.active(repository.id)) i.state = "RUNNING";
        return {repositoryId: repository.id, displayName: clean(repository.public && repository.public.displayName), type: i.type, runtime: i.runtime || "UNKNOWN", manager: i.manager || "UNKNOWN", lockfile: i.lockfile || "NONE", state: i.state, notice: i.notice || i.blocked || "", profiles: i.profiles.map(p => ({profileId: p.profileId, displayName: p.displayName})), isolation: this.processes.getExecutionSecurityStatus().level};
    }
    async inspect(id) {
        const repository = await this.repositories.resolveRepository(id);
        return {ok: true, kind: "project", status: "PROJECT INSPECTED", project: this.project(repository)};
    }
    async list() {
        await this.repositories.refresh();
        return {ok: true, kind: "projects", status: "PROJECTS READY", projects: Array.from(this.repositories.repositories.values()).map(r => this.project(r)).filter(p => p.type !== "UNKNOWN")};
    }
    _setupSteps(inspected, enableLifecycle) {
        const steps = copy(inspected.steps);
        if (enableLifecycle) {
            if (inspected.type !== "NODE") throw new Error("LIFECYCLE MODE REQUIRES NODE PROJECT");
            steps.forEach(step => { step.args = step.args.filter(arg => !["--ignore-scripts", "--mode=skip-builds"].includes(arg)); });
        }
        return steps;
    }
    async plan(id, enableLifecycle = false) {
        const repository = await this.repositories.resolveRepository(id);
        const inspected = this.inspectRecord(repository);
        const policy = this.processes.getExecutionSecurityStatus();
        if (!this.pathPolicyAllows(this.profile()) || !policy.allowed || policy.level !== "STRONG" || !["NORMAL", "PUBLIC"].includes(this.profile())) return {ok: false, status: "SETUP BLOCKED / VERIFIED STRONG ISOLATION REQUIRED"};
        if (this.processes.isActive(id) || this.active(id)) return {ok: false, status: "PROJECT OPERATION ALREADY RUNNING"};
        if (["ERROR", "BLOCKED", "UNSUPPORTED"].includes(inspected.state)) return {ok: false, status: inspected.blocked || inspected.state};
        const token = crypto.randomBytes(24).toString("hex");
        const generatedLockfile = inspected.lockfile === "NONE" ? ({NPM: "package-lock.json", PNPM: "pnpm-lock.yaml", YARN: "yarn.lock", CARGO: "Cargo.lock"}[inspected.manager] || null) : null;
        const stored = {id, identity: repository.executionIdentity, fingerprint: inspected.fingerprint, inputFingerprints: inspected.inputFingerprints, generatedLockfile, profile: this.profile(), steps: this._setupSteps(inspected, enableLifecycle), enableLifecycle, expires: Date.now() + 120000};
        this.plans.set(token, stored);
        while (this.plans.size > 128) this.plans.delete(this.plans.keys().next().value);
        return {confirmation: {request: "AUTHORIZE PROJECT SETUP", target: repository.public.displayName, securityProfile: stored.profile, privilege: "NONE", effects: [...stored.steps.map(s => s.type.replace(/_/g, " ")), "VERIFY RESULT", "REGISTER PROJECT", "NO AUTOMATIC DEPENDENCY ROLLBACK"], fields: [{label: "TYPE", value: inspected.type}, {label: "PACKAGE MANAGER", value: inspected.manager}, {label: "DEPENDENCIES", value: inspected.lockfile}, {label: "EXECUTION RISK", value: enableLifecycle ? "REPOSITORY AND DEPENDENCY LIFECYCLE SCRIPTS WILL BE ENABLED; ARBITRARY REPOSITORY CODE MAY EXECUTE" : inspected.risk}, {label: "NODE LIFECYCLES", value: inspected.type === "NODE" ? enableLifecycle ? "ENABLED BY THIS EXPLICIT AUTHORIZATION" : "REQUESTED DISABLED; PROJECTS NEEDING BUILD HOOKS CAN AUTHORIZE PREPARE + HOOKS" : "NOT APPLICABLE"}, {label: "DECLARED HOOKS", value: inspected.hooks || "NONE"}, {label: "FINGERPRINT", value: inspected.fingerprint}, {label: "ISOLATION", value: "STRONG / REPOSITORY WRITABLE / NETWORK FOR INSTALL OR BUILD ONLY / HOST HOME AND CREDENTIAL ENV HIDDEN"}, {label: "CREDENTIALS", value: "AUTOMATIC SECRET EXPOSURE REFUSED"}]}, stored: {automationPlan: token}};
    }
    shutdown() { this.plans.clear(); this.operations.forEach(o => { if (o.state === "RUNNING") o.cancelled = true; }); }
    active(id) { return Array.from(this.operations.values()).find(o => o.repositoryId === id && o.state === "RUNNING"); }
    async authorize(token) {
        const plan = this.plans.get(token);
        this.plans.delete(token);
        if (!plan || plan.expires < Date.now()) return {ok: false, status: "SETUP AUTHORIZATION EXPIRED"};
        const repository = await this.repositories.resolveRepository(plan.id);
        const current = this.inspectRecord(repository);
        if (!this.pathPolicyAllows(this.profile()) || plan.profile !== this.profile() || plan.identity !== repository.executionIdentity || plan.fingerprint !== current.fingerprint || digest(plan.steps) !== digest(this._setupSteps(current, plan.enableLifecycle))) return {ok: false, status: "PROJECT OR PROFILE CHANGED / REAUTHORIZE SETUP"};
        if (this.active(plan.id) || this.processes.isActive(plan.id)) return {ok: false, status: "PROJECT OPERATION ALREADY RUNNING"};
        const operation = {id: `automation_${crypto.randomBytes(16).toString("hex")}`, repositoryId: plan.id, state: "RUNNING", status: "SETUP RUNNING", steps: [...plan.steps.map(s => ({type: s.type, state: "PENDING"})), {type: "VERIFY_RESULT", state: "PENDING"}, {type: "REGISTER_PROJECT", state: "PENDING"}], log: "", rollback: "UNAVAILABLE / DEPENDENCY CHANGES ARE NOT AUTOMATICALLY REVERSIBLE"};
        while (this.operations.size >= 64) {
            const old = Array.from(this.operations.values()).find(o => o.state !== "RUNNING");
            if (!old) return {ok: false, status: "AUTOMATION CAPACITY REACHED"};
            this.operations.delete(old.id);
        }
        this.ready.delete(plan.id);
        this.operations.set(operation.id, operation);
        this._execute(operation, plan).catch(error => {
            const credentialFailure = /authentication (?:required|failed)|could not read username|401 unauthorized|permission denied \(publickey\)/i.test(operation.log);
            const known = ["PROJECT CHANGED", "IDENTITY OR PROFILE CHANGED", "PROFILE OR IDENTITY CHANGED", "VERIFICATION FAILED", "SETUP STEP FAILED", "RUN EXECUTABLE NOT FOUND"];
            this._finish(operation, "FAILED", credentialFailure ? "CREDENTIALS REQUIRED / AUTOMATIC SECRET EXPOSURE REFUSED"
                : known.includes(error.message) ? error.message : "SETUP FAILED / SEE EXECUTION LOG");
        });
        return this.status(operation.id);
    }
    async _execute(operation, plan) {
        for (let index = 0; index < plan.steps.length; index++) {
            if (operation.cancelled) return this._finish(operation, "FAILED", "CANCELLED");
            const repository = await this.repositories.resolveRepository(plan.id);
            if (operation.cancelled) return this._finish(operation, "FAILED", "CANCELLED");
            if (!this.pathPolicyAllows(this.profile()) || repository.executionIdentity !== plan.identity || this.profile() !== plan.profile) throw new Error("IDENTITY OR PROFILE CHANGED");
            // Each dependent executable step must still match the approved inputs.
            if (this.inspectRecord(repository).fingerprint !== plan.fingerprint) throw new Error("PROJECT CHANGED");
            operation.steps[index].state = "RUNNING";
            operation.status = plan.steps[index].type.replace(/_/g, " ");
            this._emit(operation);
            this.processes.start(repository, {...plan.steps[index], boundedOutput: chunk => {
                operation.log = (operation.log + chunk.toString("utf8")).slice(-65536);
            }});
            const state = await this._wait(operation, plan.profile);
            if (operation.cancelled || state.exitCode !== 0 || state.state === "FAILED") throw new Error("SETUP STEP FAILED");
            operation.steps[index].state = "SUCCESS";
            this._emit(operation);
        }
        const repository = await this.repositories.resolveRepository(plan.id);
        if (operation.cancelled || !this.pathPolicyAllows(this.profile()) || this.profile() !== plan.profile || repository.executionIdentity !== plan.identity) throw new Error("PROFILE OR IDENTITY CHANGED");
        operation.steps[plan.steps.length].state = "RUNNING";
        this._emit(operation);
        const inspected = this.inspectAdapter(repository);
        if (inspected.blocked || inspected.state === "UNSUPPORTED") throw new Error("VERIFICATION FAILED");
        if (inspected.fingerprint !== plan.fingerprint) {
            // An install may create its missing lockfile. Existing inputs, new config,
            // and entrypoints must never be silently blessed by final verification.
            const remaining = {...inspected.inputFingerprints};
            if (plan.generatedLockfile) delete remaining[plan.generatedLockfile];
            if (!plan.inputFingerprints || digest(remaining) !== digest(plan.inputFingerprints)) throw new Error("PROJECT CHANGED");
        }
        operation.steps[plan.steps.length].state = "SUCCESS";
        this.ready.set(plan.id, {identity: repository.executionIdentity, fingerprint: inspected.fingerprint});
        operation.steps[plan.steps.length + 1].state = "SUCCESS";
        this._finish(operation, "SUCCESS", "PROJECT READY / RUN AUTHORIZATION REMAINS SEPARATE");
    }
    _wait(operation, profile) {
        return new Promise((resolve, reject) => {
            const poll = async () => {
                try {
                    if (this.profile() !== profile) operation.cancelled = true;
                    if (operation.cancelled && this.processes.isActive(operation.repositoryId)) {
                        const result = await this.processes.stop(operation.repositoryId);
                        if (result && result.ok === false && this.processes.isActive(operation.repositoryId)) throw new Error("STOP FAILED");
                    }
                    if (!this.processes.isActive(operation.repositoryId)) return resolve(this.processes.getStatus(operation.repositoryId) || {state: "FAILED"});
                    setTimeout(poll, 100);
                } catch (error) {
                    operation.stopFailed = operation.cancelled;
                    reject(error);
                }
            };
            poll();
        });
    }
    async cancel(id) {
        if (!OPERATION_ID.test(id || "")) return {ok: false, status: "AUTOMATION ID INVALID"};
        const operation = this.operations.get(id);
        if (!operation || operation.state !== "RUNNING") return {ok: false, status: "NO ACTIVE AUTOMATION"};
        operation.cancelled = true;
        if (this.processes.isActive(operation.repositoryId)) {
            try {
                const result = await this.processes.stop(operation.repositoryId);
                if (result && result.ok === false && this.processes.isActive(operation.repositoryId)) throw new Error("STOP FAILED");
            } catch (_) {
                operation.stopFailed = true;
                return {ok: false, status: "CANCELLATION FAILED / PROCESS MAY STILL BE RUNNING"};
            }
        }
        return {ok: true, status: "CANCELLATION REQUESTED"};
    }
    status(id) {
        const o = this.operations.get(id);
        if (!o) return {ok: false, status: "AUTOMATION NOT FOUND"};
        return {ok: o.state !== "FAILED", kind: "automation", status: o.status, operation: {id: o.id, repositoryId: o.repositoryId, state: o.state, steps: copy(o.steps), rollback: o.rollback}};
    }
    log(id) { const o = this.operations.get(id); return o ? {ok: true, kind: "automation-log", status: "REPOSITORY EXECUTION OUTPUT", output: o.log} : {ok: false, status: "AUTOMATION NOT FOUND"}; }
    _finish(o, state, status) {
        o.state = state; o.status = o.stopFailed ? "CANCELLATION FAILED / PROCESS MAY STILL BE RUNNING" : o.cancelled ? "CANCELLED" : status;
        o.steps.forEach(s => { if (s.state === "RUNNING") s.state = "FAILED"; else if (s.state === "PENDING") s.state = "SKIPPED"; });
        this._emit(o);
    }
    _emit(o) { try { this.onState(this.status(o.id)); } catch (_) {} }
}
module.exports = {AutomationEngine, OPERATION_ID};
