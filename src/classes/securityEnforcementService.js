const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawnSync} = require("child_process");
const {SecurityFirewallService, resolveTrustedSecurityTool} = require("./securityFirewallService.js");
const {SecurityPathPolicyService} = require("./securityPathPolicyService.js");
const {SecurityProfileError, SecurityProfileService, normalizeSecurityProfile} = require("./securityProfileService.js");
const {AutomountPolicyController, SecurityStoragePolicyService} = require("./securityStoragePolicyService.js");

const HELPER_OPERATIONS = Object.freeze([
    "apply-public", "apply-lockdown", "restore", "verify-firewall", "verify-storage", "status"
]);
const HELPER_OPERATION_SET = new Set(HELPER_OPERATIONS);
const MAX_ENFORCEMENT_STATE_BYTES = 128 * 1024;
const ENFORCEMENT_STATE_KEYS = new Set([
    "version", "phase", "originalProfile", "enforcedProfile", "updatedAt", "automount", "helper", "sessionRestartRequired"
]);

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function defaultEnforcementStatePath(home = os.homedir(), environment = process.env, pathModule = path) {
    const configRoot = typeof environment.XDG_CONFIG_HOME === "string" && pathModule.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME : pathModule.join(home, ".config");
    return pathModule.join(configRoot, "nomad", "enforcement-state.json");
}

function parseEnforcementState(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_ENFORCEMENT_STATE_BYTES) {
        throw new Error("enforcement state is too large");
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        throw new Error("enforcement state is not JSON");
    }
    if (!isPlainObject(parsed) || Object.keys(parsed).some(key => !ENFORCEMENT_STATE_KEYS.has(key))
        || parsed.version !== 1 || (typeof parsed.phase !== "undefined" && !["APPLYING", "APPLIED"].includes(parsed.phase))
        || normalizeSecurityProfile(parsed.originalProfile) !== parsed.originalProfile
        || normalizeSecurityProfile(parsed.enforcedProfile) !== parsed.enforcedProfile
        || typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt))
        || typeof parsed.sessionRestartRequired !== "boolean"
        || !isPlainObject(parsed.automount) || Object.keys(parsed.automount).some(key => !["owned", "pending", "previous"].includes(key))
        || typeof parsed.automount.owned !== "boolean"
        || (typeof parsed.automount.pending !== "undefined" && typeof parsed.automount.pending !== "boolean")
        || ![null, "true", "false"].includes(parsed.automount.previous)
        || !isPlainObject(parsed.helper) || Object.keys(parsed.helper).some(key => !["owned", "pending", "profile"].includes(key))
        || typeof parsed.helper.owned !== "boolean"
        || (typeof parsed.helper.pending !== "undefined" && typeof parsed.helper.pending !== "boolean")
        || ![null, "PUBLIC", "LOCKDOWN"].includes(parsed.helper.profile)) {
        throw new Error("enforcement state is invalid");
    }
    const automountPending = parsed.automount.pending === true;
    const helperPending = parsed.helper.pending === true;
    if ((parsed.automount.owned || automountPending) && !["true", "false"].includes(parsed.automount.previous)) {
        throw new Error("enforcement automount state is invalid");
    }
    if ((parsed.helper.owned || helperPending) && !["PUBLIC", "LOCKDOWN"].includes(parsed.helper.profile)) {
        throw new Error("enforcement helper state is invalid");
    }
    return {
        version: 1,
        phase: parsed.phase || "APPLIED",
        originalProfile: parsed.originalProfile,
        enforcedProfile: parsed.enforcedProfile,
        updatedAt: new Date(parsed.updatedAt).toISOString(),
        automount: {owned: parsed.automount.owned, pending: automountPending, previous: parsed.automount.previous},
        helper: {owned: parsed.helper.owned, pending: helperPending, profile: parsed.helper.profile},
        sessionRestartRequired: parsed.sessionRestartRequired
    };
}

class SecurityTransactionStore {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.storePath = opts.storePath || defaultEnforcementStatePath(opts.home, opts.env, this.path);
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
        this.randomBytes = opts.randomBytes || crypto.randomBytes;
    }

    read() {
        let stats;
        try {
            stats = this.fs.lstatSync(this.storePath);
        } catch (error) {
            if (error && error.code === "ENOENT") return null;
            throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        }
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || stats.size > MAX_ENFORCEMENT_STATE_BYTES
            || !this._owned(stats) || (stats.mode & 0o077) !== 0) throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        const constants = this.fs.constants || fs.constants;
        let descriptor;
        try {
            descriptor = this.fs.openSync(this.storePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
            const opened = this.fs.fstatSync(descriptor);
            if (!opened.isFile() || opened.nlink !== 1 || !this._owned(opened)
                || opened.dev !== stats.dev || opened.ino !== stats.ino || opened.size > MAX_ENFORCEMENT_STATE_BYTES) {
                throw new Error("state changed");
            }
            const content = this.fs.readFileSync(descriptor, {encoding: "utf8"});
            return parseEnforcementState(content);
        } catch (error) {
            throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }

    inspect() {
        if (typeof this.storePath !== "string" || !this.path.isAbsolute(this.storePath)) {
            return {safe: false, status: "SECURITY ENFORCEMENT STATE PATH REFUSED", state: null};
        }
        let state;
        try {
            state = this.read();
        } catch (error) {
            return {safe: false, status: "SECURITY ENFORCEMENT STATE REFUSED", state: null};
        }
        if (state && (state.phase !== "APPLIED" || state.automount.pending || state.helper.pending)) {
            return {safe: false, status: "INCOMPLETE SECURITY TRANSACTION REQUIRES RESTORE", state};
        }
        const directory = this.path.dirname(this.storePath);
        try {
            const stats = this.fs.lstatSync(directory);
            if (stats.isSymbolicLink() || !stats.isDirectory() || !this._owned(stats)
                || (stats.mode & 0o077) !== 0 || this.fs.realpathSync(directory) !== this.path.resolve(directory)) {
                return {safe: false, status: "SECURITY ENFORCEMENT STATE DIRECTORY REFUSED", state};
            }
            return {safe: true, status: "READY", state};
        } catch (error) {
            if (!error || error.code !== "ENOENT") {
                return {safe: false, status: "SECURITY ENFORCEMENT STATE DIRECTORY REFUSED", state};
            }
        }
        const parent = this.path.dirname(directory);
        try {
            const stats = this.fs.lstatSync(parent);
            if (stats.isSymbolicLink() || !stats.isDirectory() || !this._owned(stats)
                || (stats.mode & 0o022) !== 0 || this.fs.realpathSync(parent) !== this.path.resolve(parent)) {
                return {safe: false, status: "SECURITY ENFORCEMENT STATE PARENT REFUSED", state};
            }
        } catch (error) {
            return {safe: false, status: "SECURITY ENFORCEMENT STATE PARENT REFUSED", state};
        }
        return {safe: true, status: "PRIVATE STATE DIRECTORY WILL BE CREATED", state};
    }

    write(document) {
        const parsed = parseEnforcementState(`${JSON.stringify(document)}\n`);
        const directory = this.path.dirname(this.storePath);
        const expectedTarget = this._targetSnapshot();
        let temporaryPath;
        let descriptor;
        try {
            this.fs.mkdirSync(directory, {recursive: true, mode: 0o700});
            const rootStats = this.fs.lstatSync(directory);
            if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || !this._owned(rootStats)
                || (rootStats.mode & 0o077) !== 0 || this.fs.realpathSync(directory) !== this.path.resolve(directory)) {
                throw new Error("unsafe state directory");
            }
            temporaryPath = this.path.join(directory, `.enforcement-state.json.tmp-${process.pid}-${this.randomBytes(8).toString("hex")}`);
            const constants = this.fs.constants || fs.constants;
            descriptor = this.fs.openSync(temporaryPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
            this.fs.fchmodSync(descriptor, 0o600);
            this.fs.writeFileSync(descriptor, `${JSON.stringify(parsed, null, 4)}\n`, {encoding: "utf8"});
            this.fs.fsyncSync(descriptor);
            this.fs.closeSync(descriptor);
            descriptor = undefined;
            if (!this._sameSnapshot(expectedTarget, this._targetSnapshot())) throw new Error("state target changed");
            this.fs.renameSync(temporaryPath, this.storePath);
            temporaryPath = null;
            this._syncDirectory(directory);
            return clone(parsed);
        } catch (error) {
            throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
            if (temporaryPath) {
                try { this.fs.unlinkSync(temporaryPath); } catch (error) {}
            }
        }
    }

    clear() {
        let stats;
        try {
            stats = this.fs.lstatSync(this.storePath);
        } catch (error) {
            if (error && error.code === "ENOENT") return false;
            throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        }
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || !this._owned(stats)
            || (stats.mode & 0o077) !== 0) throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        const snapshot = {dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs};
        const constants = this.fs.constants || fs.constants;
        let descriptor;
        try {
            descriptor = this.fs.openSync(this.storePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
            const opened = this.fs.fstatSync(descriptor);
            if (!opened.isFile() || opened.nlink !== 1 || !this._owned(opened)
                || opened.dev !== stats.dev || opened.ino !== stats.ino || (opened.mode & 0o077) !== 0) {
                throw new Error("state changed");
            }
        } catch (error) {
            throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
        if (!this._sameSnapshot(snapshot, this._targetSnapshot())) {
            throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        }
        this.fs.unlinkSync(this.storePath);
        this._syncDirectory(this.path.dirname(this.storePath));
        return true;
    }

    _owned(stats) {
        return this.uid === null || typeof stats.uid !== "number" || stats.uid === this.uid;
    }

    _targetSnapshot() {
        try {
            const stats = this.fs.lstatSync(this.storePath);
            if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1 || !this._owned(stats)
                || (stats.mode & 0o077) !== 0 || stats.size > MAX_ENFORCEMENT_STATE_BYTES) {
                throw new Error("unsafe state target");
            }
            return {dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs};
        } catch (error) {
            if (error && error.code === "ENOENT") return null;
            throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
        }
    }

    _sameSnapshot(left, right) {
        if (!left || !right) return left === right;
        return left.dev === right.dev && left.ino === right.ino
            && left.size === right.size && left.mtimeMs === right.mtimeMs;
    }

    _syncDirectory(directory) {
        const constants = this.fs.constants || fs.constants;
        let descriptor;
        try {
            descriptor = this.fs.openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
            this.fs.fsyncSync(descriptor);
        } catch (error) {
            if (!error || !["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) {
                throw new Error("SECURITY ENFORCEMENT STATE REFUSED");
            }
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }
}

class SecurityHelperClient {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.environment = opts.env || process.env;
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
        this.helperPath = opts.helperPath || "/usr/local/libexec/nomad-security-helper";
        this.spawnSync = opts.spawnSync || spawnSync;
        this.runner = typeof opts.runner === "function" ? opts.runner : null;
        this.resolveExecutable = opts.resolveExecutable || (command => resolveTrustedSecurityTool(command, opts));
        this.usePkexec = opts.usePkexec !== false;
    }

    capability() {
        let stats;
        try {
            stats = this.fs.lstatSync(this.helperPath);
        } catch (error) {
            return {installed: false, trusted: false, available: false, status: "HELPER NOT INSTALLED"};
        }
        let parentTrusted = true;
        let parentPath = this.path ? this.path.dirname(this.helperPath) : path.dirname(this.helperPath);
        const pathModule = this.path || path;
        while (parentTrusted) {
            try {
                const parent = this.fs.lstatSync(parentPath);
                parentTrusted = !parent.isSymbolicLink() && parent.isDirectory() && parent.uid === 0
                    && (parent.mode & 0o022) === 0 && this.fs.realpathSync(parentPath) === pathModule.resolve(parentPath);
            } catch (error) {
                parentTrusted = false;
            }
            if (!parentTrusted || parentPath === pathModule.parse(parentPath).root) break;
            parentPath = pathModule.dirname(parentPath);
        }
        const trusted = !stats.isSymbolicLink() && stats.isFile() && stats.nlink === 1 && stats.uid === 0
            && (stats.mode & 0o022) === 0 && (stats.mode & 0o111) !== 0 && parentTrusted;
        const elevation = this.uid === 0 || (this.usePkexec && Boolean(this.resolveExecutable("pkexec")));
        return {
            installed: true,
            trusted,
            available: trusted && elevation,
            status: !trusted ? "HELPER TRUST CHECK FAILED" : (elevation ? "AVAILABLE" : "EXPLICIT ROOT EXECUTION REQUIRED")
        };
    }

    invoke(operation, opts = {}) {
        if (!HELPER_OPERATION_SET.has(operation)) return {ok: false, status: "INVALID HELPER OPERATION"};
        if (opts.authorized !== true) return {ok: false, status: "EXPLICIT AUTHORIZATION REQUIRED"};
        const capability = this.capability();
        if (!capability.available) return {ok: false, status: capability.status, unavailable: true};
        let command = this.helperPath;
        let args = [operation];
        if (this.uid !== 0) {
            command = this.resolveExecutable("pkexec");
            args = [this.helperPath, operation];
        }
        let result;
        try {
            result = this.runner ? this.runner(command, args.slice(), {shell: false, timeout: 30000})
                : this.spawnSync(command, args, {
                    encoding: "utf8",
                    env: {PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
                    shell: false,
                    timeout: 30000,
                    maxBuffer: 1024 * 1024,
                    windowsHide: true
                });
        } catch (error) {
            return {ok: false, status: "HELPER EXECUTION FAILED"};
        }
        let payload = null;
        try {
            payload = JSON.parse(String(result && result.stdout || ""));
        } catch (error) {}
        const responseKeys = ["ok", "status", "profile", "firewall", "storage"];
        if (!isPlainObject(payload) || Object.keys(payload).length !== responseKeys.length
            || Object.keys(payload).some(key => !responseKeys.includes(key))
            || typeof payload.ok !== "boolean" || typeof payload.status !== "string") {
            return {ok: false, status: "HELPER RESPONSE INVALID"};
        }
        return {
            ok: result.status === 0 && payload.ok === true,
            status: String(payload.status).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160),
            profile: ["PUBLIC", "LOCKDOWN", "NONE"].includes(payload.profile) ? payload.profile : "NONE",
            firewall: ["VERIFIED", "PARTIAL", "UNAVAILABLE", "FAILED", "NOT_APPLIED"].includes(payload.firewall)
                ? payload.firewall : "FAILED",
            storage: ["VERIFIED", "PARTIAL", "UNAVAILABLE", "FAILED", "NOT_APPLIED"].includes(payload.storage)
                ? payload.storage : "FAILED"
        };
    }

    commandFor(operation) {
        if (!HELPER_OPERATION_SET.has(operation)) return null;
        return `pkexec ${this.helperPath} ${operation}`;
    }
}

class SecurityEnforcementService {
    constructor(opts = {}) {
        this.now = opts.now || (() => new Date());
        this.profileService = opts.profileService || new SecurityProfileService(opts);
        this.firewallService = opts.firewallService || new SecurityFirewallService(opts);
        this.pathPolicyService = opts.pathPolicyService || new SecurityPathPolicyService(opts);
        this.storageService = opts.storageService || new SecurityStoragePolicyService(opts);
        this.automountController = opts.automountController || new AutomountPolicyController(opts);
        this.helperClient = opts.helperClient || new SecurityHelperClient(opts);
        this.store = opts.store || new SecurityTransactionStore(opts);
    }

    plan(profileValue, opts = {}) {
        const targetProfile = normalizeSecurityProfile(profileValue || this.profileService.get().profile);
        if (!targetProfile) throw new SecurityProfileError("SECURITY PROFILE INVALID");
        let selected;
        try {
            selected = this.profileService.get();
        } catch (error) {
            return {
                version: 1, targetProfile, selectedProfile: "UNKNOWN", safeToApply: false,
                status: "CURRENT PROFILE AMBIGUOUS", categories: [], privilegedPending: true
            };
        }
        const firewall = this.firewallService.plan(targetProfile);
        const firewallStatus = this.firewallService.inspect(targetProfile);
        const storage = this.storageService.inspect(opts.verbose === true);
        const automount = this.automountController.observe();
        const paths = this.pathPolicyService.resolve(targetProfile);
        const helper = this.helperClient.capability();
        const transaction = this._transactionPreflight();
        const restricted = targetProfile === "PUBLIC" || targetProfile === "LOCKDOWN";
        const categories = [
            {
                id: "transaction_state", label: "TRANSACTION STATE", current: transaction.status,
                desired: "SAFE RECOVERABLE JOURNAL", action: "RECORD INTENT BEFORE EACH NOMAD-OWNED CHANGE",
                privileged: false, available: transaction.safe
            },
            {
                id: "profile_gates", label: "PROFILE GATES", current: selected.profile, desired: targetProfile,
                action: targetProfile === "LOCKDOWN" ? "BLOCK NEW REPOSITORY RUN AND EXTERNAL APP LAUNCH"
                    : "APPLY PROFILE-AWARE REPOSITORY AND APPLICATION POLICY",
                privileged: false, available: true
            },
            {
                id: "automount", label: "AUTOMOUNT", current: automount.state,
                desired: restricted ? "DISABLED" : "RESTORE_NOMAD_CHANGE",
                action: restricted ? "SET GNOME USER AUTOMOUNT FALSE AND RECORD PREVIOUS VALUE"
                    : "RESTORE ONLY A VALUE PREVIOUSLY CHANGED BY NOMAD",
                privileged: false, available: automount.available
            },
            {
                id: "network", label: "FIREWALL / NETWORK", current: firewallStatus.nomadPolicyState,
                desired: targetProfile === "NORMAL" ? "NO_NOMAD_POLICY" : targetProfile,
                action: firewall.operation, privileged: true,
                available: firewall.available && helper.available
            },
            {
                id: "host_storage", label: "HOST STORAGE", current: storage.state,
                desired: restricted ? "UNMOUNT_SAFE_ELIGIBLE_INTERNAL_MOUNTS" : "RESTORE_NOMAD_UNMOUNTS",
                action: restricted ? `REVALIDATE AND UNMOUNT ${storage.eligibleCount} STRICTLY ELIGIBLE MOUNT(S)`
                    : "RESTORE ONLY MOUNTS RECORDED BY THE TRUSTED HELPER",
                privileged: true, available: helper.available && !storage.ambiguous
            },
            {
                id: "ephemeral_state", label: "EPHEMERAL STATE", current: paths.ephemeral ? "VOLATILE_CAPABLE" : "PERSISTENT",
                desired: restricted ? (targetProfile === "LOCKDOWN" ? "VOLATILE_REQUIRED" : "VOLATILE_PREFERRED") : "PERSISTENCE_ALLOWED",
                action: restricted ? "ROUTE ELIGIBLE STATE, LOGS, CACHES, AND RUNTIME ON NEXT SESSION"
                    : "RESTORE PERSISTENT RUNTIME ROUTES ON NEXT SESSION",
                privileged: false, available: !restricted || paths.volatileRuntimeVerified,
                restartRequired: paths.sessionRestartRequired
            },
            {
                id: "environment", label: "PRODUCTION ENVIRONMENT", current: "CURRENT_SESSION",
                desired: restricted ? "ALLOWLISTED_MINIMAL" : "ALLOWLISTED_MINIMAL",
                action: "SANITIZE AT PRODUCTION SESSION BOUNDARY; NEVER FORWARD CREDENTIAL OR INJECTION VARIABLES",
                privileged: false, available: true, restartRequired: paths.sessionRestartRequired
            }
        ];
        const safeToApply = transaction.safe && (!restricted || !storage.ambiguous);
        const recordedChanges = Boolean(transaction.state && (
            transaction.state.automount.owned || transaction.state.helper.owned
        ));
        const privilegedPending = restricted ? (!helper.available || !firewallStatus.compliant
            || storage.eligibleCount > 0 || storage.protectedCount > 0 || storage.refusedCount > 0
            || storage.manualRemountPreventionVerified !== true)
            : (recordedChanges || firewallStatus.nomadPolicyState !== "NOT_APPLIED");
        return {
            version: 1,
            selectedProfile: selected.profile,
            targetProfile,
            safeToApply,
            status: safeToApply ? "PLAN READY"
                : (transaction.safe ? "AMBIGUOUS STORAGE OBSERVATION - APPLY REFUSED" : transaction.status),
            dryRun: true,
            privilegedPending,
            sessionRestartRequired: paths.sessionRestartRequired,
            helper,
            transaction: {safe: transaction.safe, status: transaction.status},
            firewall,
            storage: sanitizePlanStorage(storage, opts.verbose === true),
            categories
        };
    }

    apply(profileValue, opts = {}) {
        const targetProfile = normalizeSecurityProfile(profileValue || this.profileService.get().profile);
        if (!targetProfile) throw new SecurityProfileError("SECURITY PROFILE INVALID");
        if (opts.authorized !== true) return {ok: false, applied: false, status: "EXPLICIT AUTHORIZATION REQUIRED"};
        if (targetProfile === "NORMAL") return this.restore({
            apply: true, authorized: true, targetProfile: "NORMAL"
        });
        const plan = this.plan(targetProfile, {verbose: opts.verbose === true});
        if (!plan.safeToApply) return {ok: false, applied: false, status: plan.status, plan};
        const previousProfile = this.profileService.get().profile;
        let existing;
        try {
            existing = this.store.read();
        } catch (error) {
            return {ok: false, applied: false, status: "SECURITY ENFORCEMENT STATE REFUSED", plan};
        }
        const transaction = existing || {
            version: 1,
            originalProfile: previousProfile,
            enforcedProfile: targetProfile,
            updatedAt: this.now().toISOString(),
            automount: {owned: false, pending: false, previous: null},
            helper: {owned: false, pending: false, profile: null},
            sessionRestartRequired: plan.sessionRestartRequired
        };
        const changes = {
            profile: false,
            automount: null,
            automountIntent: false,
            helper: null,
            helperAttempted: false,
            transactionWritten: false
        };
        try {
            transaction.phase = "APPLYING";
            transaction.enforcedProfile = targetProfile;
            transaction.updatedAt = this.now().toISOString();
            transaction.sessionRestartRequired = plan.sessionRestartRequired;
            this.store.write(transaction);
            changes.transactionWritten = true;
            if (previousProfile !== targetProfile) {
                this.profileService.set(targetProfile);
                changes.profile = true;
            }
            if (transaction.automount.owned) {
                const currentAutomount = this.automountController.observe();
                if (!currentAutomount || currentAutomount.value !== "false") {
                    throw new Error("NOMAD-OWNED AUTOMOUNT STATE CHANGED EXTERNALLY");
                }
            } else {
                const before = this.automountController.observe();
                if (before && before.value === "true") {
                    transaction.automount = {owned: false, pending: true, previous: "true"};
                    this.store.write(transaction);
                    changes.automountIntent = true;
                }
                const automount = this.automountController.disable();
                changes.automount = automount;
                if (automount.available === false || automount.status === "UNAVAILABLE") {
                    changes.automount = automount;
                } else if (!automount.ok) {
                    throw new Error("AUTOMOUNT ENFORCEMENT FAILED");
                } else if (automount.changed) {
                    transaction.automount = {owned: true, pending: false, previous: automount.previous};
                    this.store.write(transaction);
                } else if (transaction.automount.pending) {
                    transaction.automount = {owned: false, pending: false, previous: null};
                    this.store.write(transaction);
                }
            }
            const helperCapability = this.helperClient.capability();
            if (helperCapability.available) {
                transaction.helper = {
                    owned: transaction.helper.owned,
                    pending: true,
                    profile: targetProfile
                };
                this.store.write(transaction);
                changes.helperAttempted = true;
                const helper = this.helperClient.invoke(targetProfile === "PUBLIC" ? "apply-public" : "apply-lockdown", {
                    authorized: true
                });
                changes.helper = helper;
                if (!helper.ok) throw new Error("PRIVILEGED HELPER FAILED");
                transaction.helper = {owned: true, pending: false, profile: targetProfile};
                this.store.write(transaction);
            }
            transaction.enforcedProfile = targetProfile;
            transaction.phase = "APPLIED";
            transaction.updatedAt = this.now().toISOString();
            transaction.sessionRestartRequired = plan.sessionRestartRequired;
            this.store.write(transaction);
        } catch (error) {
            const rollback = this._rollbackApply(changes, previousProfile, transaction, existing);
            return {
                ok: false,
                applied: true,
                status: rollback.ok ? "APPLY FAILED - NOMAD CHANGES ROLLED BACK" : "APPLY FAILED - ROLLBACK PARTIAL",
                failure: String(error && error.message || "ENFORCEMENT FAILED").slice(0, 160),
                rollback,
                plan
            };
        }
        const verification = this._verification(changes.helper);
        return {
            ok: verification.profileGates && !verification.ambiguous,
            applied: true,
            status: verification.systemEnforcementPending ? "PARTIAL - SYSTEM ENFORCEMENT PENDING" : "ENFORCEMENT APPLIED",
            profile: targetProfile,
            systemEnforcementPending: verification.systemEnforcementPending,
            sessionRestartRequired: verification.sessionRestartRequired,
            verification,
            plan
        };
    }

    verify(opts = {}) {
        let systemVerification = null;
        if (opts.systemAuthorized === true) {
            const capability = this.helperClient.capability();
            systemVerification = capability.available
                ? this.helperClient.invoke("status", {authorized: true})
                : {
                    ok: false,
                    status: capability.status,
                    profile: "NONE",
                    firewall: "UNAVAILABLE",
                    storage: "UNAVAILABLE"
                };
        }
        return this._verification(systemVerification);
    }

    _verification(systemVerification = null) {
        let selected = "UNKNOWN";
        try { selected = this.profileService.get().profile; } catch (error) {}
        let transaction = null;
        let stateValid = true;
        try { transaction = this.store.read(); } catch (error) { stateValid = false; }
        const target = transaction ? transaction.enforcedProfile : selected;
        const firewall = this.firewallService.inspect(target);
        const storage = this.storageService.inspect(false);
        const automount = this.automountController.observe();
        const paths = normalizeSecurityProfile(target) ? this.pathPolicyService.observe(target) : null;
        const restricted = target === "PUBLIC" || target === "LOCKDOWN";
        const trustedSystemObservation = isPlainObject(systemVerification)
            && typeof systemVerification.ok === "boolean"
            && typeof systemVerification.status === "string"
            && ["PUBLIC", "LOCKDOWN", "NONE"].includes(systemVerification.profile)
            && ["VERIFIED", "PARTIAL", "UNAVAILABLE", "FAILED", "NOT_APPLIED"].includes(systemVerification.firewall)
            && ["VERIFIED", "PARTIAL", "UNAVAILABLE", "FAILED", "NOT_APPLIED"].includes(systemVerification.storage)
            ? clone(systemVerification) : null;
        const systemProfileVerified = Boolean(trustedSystemObservation && trustedSystemObservation.ok
            && trustedSystemObservation.profile === target && trustedSystemObservation.firewall === "VERIFIED");
        const systemNormalVerified = Boolean(trustedSystemObservation && trustedSystemObservation.ok
            && trustedSystemObservation.profile === "NONE" && trustedSystemObservation.firewall === "NOT_APPLIED");
        const profileGates = stateValid && selected === target;
        const firewallVerified = !restricted || systemProfileVerified
            || (firewall.compliant && firewall.nomadPolicyState === target);
        const automountVerified = !restricted || automount.state === "DISABLED";
        const helperOwned = Boolean(transaction && transaction.helper.owned && !transaction.helper.pending
            && (!restricted || transaction.helper.profile === target));
        const transactionPending = Boolean(transaction
            && (transaction.phase !== "APPLIED" || transaction.helper.pending || transaction.automount.pending));
        const ephemeralVerified = !restricted || Boolean(paths && paths.actual === "VOLATILE");
        const storageVerified = !restricted || (storage.eligibleCount === 0 && storage.protectedCount === 0
            && storage.refusedCount === 0 && !storage.ambiguous
            && storage.manualRemountPreventionVerified === true);
        const staleNormalFirewall = !restricted && !systemNormalVerified && firewall.nomadPolicyState !== "NOT_APPLIED";
        const systemEnforcementPending = !stateValid || transactionPending || staleNormalFirewall
            || Boolean(!restricted && paths && paths.sessionRestartRequired)
            || (restricted && (!helperOwned || !firewallVerified || !automountVerified
                || !ephemeralVerified || !storageVerified));
        return {
            version: 1,
            selectedProfile: selected,
            desiredProfile: target,
            enforcedProfile: transaction ? transaction.enforcedProfile : "NONE",
            stateValid,
            profileGates,
            firewallVerified,
            automountVerified,
            helperOwned,
            transactionPending,
            ephemeralVerified,
            storageVerified,
            ambiguous: storage.ambiguous,
            systemEnforcementPending,
            systemVerification: trustedSystemObservation,
            sessionRestartRequired: Boolean(paths && paths.sessionRestartRequired),
            firewall: {
                backend: firewall.backend,
                available: firewall.available,
                currentState: firewall.currentState,
                nomadPolicyState: firewall.nomadPolicyState,
                verificationResult: firewall.verificationResult,
                ipv4: firewall.ipv4,
                ipv6: firewall.ipv6
            },
            storage: sanitizePlanStorage(storage, false),
            automount: automount.state,
            ephemeral: paths ? paths.actual : "UNKNOWN"
        };
    }

    restore(opts = {}) {
        const apply = opts.apply === true;
        let transaction;
        try {
            transaction = this.store.read();
        } catch (error) {
            return {ok: false, applied: false, status: "SECURITY ENFORCEMENT STATE REFUSED"};
        }
        const targetProfile = normalizeSecurityProfile(opts.targetProfile)
            || (transaction ? transaction.originalProfile : "NORMAL");
        const actions = transaction ? [
            transaction.helper.owned || transaction.helper.pending ? "RESTORE NOMAD FIREWALL AND RECORDED MOUNTS" : null,
            transaction.automount.owned || transaction.automount.pending
                ? `RESTORE AUTOMOUNT TO ${transaction.automount.previous.toUpperCase()}` : null,
            `SELECT ${targetProfile}`
        ].filter(Boolean) : [`SELECT ${targetProfile}`];
        if (!apply) return {ok: true, applied: false, status: "PLAN_ONLY", targetProfile, actions};
        if (opts.authorized !== true) return {ok: false, applied: false, status: "EXPLICIT AUTHORIZATION REQUIRED", actions};
        const results = {helper: null, automount: null, profile: null};
        if (transaction && (transaction.helper.owned || transaction.helper.pending)) {
            results.helper = this.helperClient.invoke("restore", {authorized: true});
            if (!results.helper.ok) return {
                ok: false, applied: true, status: "RESTORE PARTIAL - PRIVILEGED STATE REMAINS", results, actions
            };
            transaction.helper = {owned: false, pending: false, profile: null};
            transaction.updatedAt = this.now().toISOString();
            try { this.store.write(transaction); } catch (error) {
                return {ok: false, applied: true, status: "RESTORE PARTIAL - TRANSACTION STATE REFUSED", results, actions};
            }
        }
        if (transaction && (transaction.automount.owned || transaction.automount.pending)) {
            results.automount = this.automountController.restore(transaction.automount);
            if (!results.automount.ok) return {
                ok: false, applied: true, status: "RESTORE PARTIAL - USER SETTING CHANGED OR UNAVAILABLE", results, actions
            };
            transaction.automount = {owned: false, pending: false, previous: null};
            transaction.updatedAt = this.now().toISOString();
            try { this.store.write(transaction); } catch (error) {
                return {ok: false, applied: true, status: "RESTORE PARTIAL - TRANSACTION STATE REFUSED", results, actions};
            }
        }
        try {
            results.profile = this.profileService.set(targetProfile);
            if (transaction) this.store.clear();
        } catch (error) {
            return {ok: false, applied: true, status: "RESTORE PARTIAL - PROFILE STATE REFUSED", results, actions};
        }
        const verification = this.verify();
        if (targetProfile === "NORMAL" && verification.firewall.nomadPolicyState !== "NOT_APPLIED") {
            return {
                ok: false,
                applied: true,
                status: "RESTORE PARTIAL - UNJOURNALED NOMAD FIREWALL REMAINS",
                profile: targetProfile,
                systemEnforcementPending: true,
                sessionRestartRequired: verification.sessionRestartRequired,
                verification,
                results,
                actions
            };
        }
        return {
            ok: true,
            applied: true,
            status: "NOMAD-OWNED CHANGES RESTORED",
            profile: targetProfile,
            systemEnforcementPending: verification.systemEnforcementPending,
            sessionRestartRequired: verification.sessionRestartRequired,
            verification,
            results,
            actions
        };
    }

    _rollbackApply(changes, previousProfile, transaction, existing) {
        const result = {ok: true, helper: null, automount: null, profile: null};
        if (changes.helperAttempted) {
            const operation = existing && existing.helper && existing.helper.owned && existing.helper.profile
                ? (existing.helper.profile === "PUBLIC" ? "apply-public" : "apply-lockdown") : "restore";
            result.helper = this.helperClient.invoke(operation, {authorized: true});
            if (!result.helper.ok) result.ok = false;
        }
        if (changes.automountIntent || (changes.automount && changes.automount.changed)) {
            result.automount = this.automountController.restore({
                owned: true,
                pending: changes.automountIntent,
                changed: true,
                previous: changes.automount && changes.automount.previous || "true"
            });
            if (!result.automount.ok) result.ok = false;
        }
        if (changes.profile) {
            try {
                result.profile = this.profileService.set(previousProfile);
            } catch (error) {
                result.ok = false;
            }
        }
        if (changes.transactionWritten) {
            try {
                if (existing) this.store.write(existing);
                else {
                    const current = this.store.read();
                    if (current) this.store.clear();
                }
            } catch (error) {
                result.ok = false;
            }
        }
        return result;
    }

    _transactionPreflight() {
        try {
            if (this.store && typeof this.store.inspect === "function") return this.store.inspect();
            const state = this.store.read();
            if (state && (state.phase && state.phase !== "APPLIED"
                || (state.automount && state.automount.pending)
                || (state.helper && state.helper.pending))) {
                return {safe: false, status: "INCOMPLETE SECURITY TRANSACTION REQUIRES RESTORE", state};
            }
            return {safe: true, status: "READY", state};
        } catch (error) {
            return {safe: false, status: "SECURITY ENFORCEMENT STATE REFUSED", state: null};
        }
    }
}

function sanitizePlanStorage(storage, verbose) {
    const output = {
        state: storage && storage.state || "UNKNOWN",
        ambiguous: Boolean(storage && storage.ambiguous),
        eligibleCount: Number.isSafeInteger(storage && storage.eligibleCount) ? storage.eligibleCount : 0,
        protectedCount: Number.isSafeInteger(storage && storage.protectedCount) ? storage.protectedCount : 0,
        refusedCount: Number.isSafeInteger(storage && storage.refusedCount) ? storage.refusedCount : 0,
        removableCount: Number.isSafeInteger(storage && storage.removableCount) ? storage.removableCount : 0,
        manualRemountPreventionVerified: storage && storage.manualRemountPreventionVerified === true
    };
    if (verbose && Array.isArray(storage && storage.eligibleMounts)) {
        output.eligibleMounts = storage.eligibleMounts.slice(0, 64);
    }
    return output;
}

module.exports = {
    HELPER_OPERATIONS,
    MAX_ENFORCEMENT_STATE_BYTES,
    SecurityEnforcementService,
    SecurityHelperClient,
    SecurityTransactionStore,
    defaultEnforcementStatePath,
    parseEnforcementState,
    sanitizePlanStorage
};
