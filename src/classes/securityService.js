const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawnSync} = require("child_process");
const {
    SECURITY_PROFILES,
    SecurityProfileError,
    SecurityProfileService
} = require("./securityProfileService.js");
const {
    RepositoryIsolationService,
    isSensitiveEnvironmentKey,
    levelAtLeast,
    resolveExecutable
} = require("./repositoryIsolationService.js");

const SECURITY_CHECK_STATES = Object.freeze([
    "SECURE", "PARTIAL", "INSECURE", "UNAVAILABLE", "UNKNOWN", "NOT_APPLICABLE"
]);
const SECURITY_CHECK_STATE_SET = new Set(SECURITY_CHECK_STATES);
const POLICY_ENFORCEMENT_STATES = new Set(["YES", "NO", "PARTIAL", "UNKNOWN"]);
const PROFILE_COMPLIANCE_STATES = new Set(["COMPLIANT", "NON_COMPLIANT", "UNKNOWN"]);
const AUDIT_SEVERITIES = new Set(["HIGH", "MEDIUM", "LOW", "INFO"]);
const MAX_SYSTEM_FILE_BYTES = 4 * 1024 * 1024;
const CHECK_STATE_RANK = Object.freeze({
    SECURE: 0,
    NOT_APPLICABLE: 0,
    PARTIAL: 1,
    UNKNOWN: 2,
    UNAVAILABLE: 2,
    INSECURE: 3
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function sanitizeText(value, fallback = "UNKNOWN", maximum = 240) {
    if (typeof value !== "string") return fallback;
    const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, maximum);
    return sanitized || fallback;
}

function normalizeFact(value, fallback = "UNKNOWN", maximum = 80) {
    return sanitizeText(value, fallback, maximum).toUpperCase();
}

function decodeMountField(value) {
    return String(value || "").replace(/\\(040|011|012|134)/g, sequence => ({
        "\\040": " ", "\\011": "\t", "\\012": "\n", "\\134": "\\"
    }[sequence]));
}

function parseMountInfo(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_SYSTEM_FILE_BYTES) return null;
    const mounts = [];
    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const separator = line.indexOf(" - ");
        if (separator < 0) continue;
        const left = line.slice(0, separator).split(" ");
        const right = line.slice(separator + 3).split(" ");
        if (left.length < 6 || right.length < 3 || !left[4].startsWith("/")) continue;
        mounts.push({
            majorMinor: left[2],
            mountPoint: decodeMountField(left[4]),
            mountOptions: left[5].split(",").filter(Boolean).slice(0, 64),
            fsType: sanitizeText(right[0], "UNKNOWN", 64),
            source: decodeMountField(right[1]),
            superOptions: right[2].split(",").filter(Boolean).slice(0, 64)
        });
        if (mounts.length >= 4096) break;
    }
    return mounts.length ? mounts : null;
}

function normalizeMountpoints(node) {
    const source = Array.isArray(node.mountpoints) ? node.mountpoints
        : (typeof node.mountpoint === "string" ? [node.mountpoint] : []);
    return source.filter(value => typeof value === "string" && value.length <= 4096)
        .map(value => decodeMountField(value)).filter((value, index, all) => all.indexOf(value) === index);
}

function parseLsblkJson(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_SYSTEM_FILE_BYTES) return null;
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        return null;
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.blockdevices)) return null;
    const devices = [];
    const visit = (node, parentIndex, inherited) => {
        if (!isPlainObject(node) || devices.length >= 4096) return;
        const type = typeof node.type === "string" ? node.type.toLowerCase() : "unknown";
        const removable = node.rm === true || node.rm === 1 || node.rm === "1";
        const rootRemovable = type === "disk" ? removable : inherited.rootRemovable;
        const encrypted = inherited.encrypted || type === "crypt";
        const record = {
            index: devices.length,
            parentIndex,
            name: sanitizeText(node.name, "UNKNOWN", 128),
            kname: sanitizeText(node.kname, "UNKNOWN", 128),
            majorMinor: typeof node["maj:min"] === "string" ? node["maj:min"].slice(0, 32) : null,
            devicePath: typeof node.path === "string" && node.path.startsWith("/dev/")
                ? node.path.slice(0, 4096) : null,
            type,
            removable,
            rootRemovable: typeof rootRemovable === "boolean" ? rootRemovable : null,
            readOnly: node.ro === true || node.ro === 1 || node.ro === "1",
            filesystemType: typeof node.fstype === "string" ? node.fstype.slice(0, 128) : null,
            mountpoints: normalizeMountpoints(node),
            encrypted
        };
        devices.push(record);
        if (Array.isArray(node.children)) {
            node.children.forEach(child => visit(child, record.index, {rootRemovable, encrypted}));
        }
    };
    parsed.blockdevices.forEach(node => visit(node, null, {rootRemovable: null, encrypted: false}));
    return devices.length ? devices : null;
}

function mountForPath(mounts, candidatePath, pathModule = path) {
    if (!Array.isArray(mounts) || typeof candidatePath !== "string" || !pathModule.isAbsolute(candidatePath)) return null;
    let selected = null;
    mounts.forEach(mount => {
        if (!mount || typeof mount.mountPoint !== "string") return;
        const relative = pathModule.relative(mount.mountPoint, candidatePath);
        if (relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative))) {
            if (!selected || mount.mountPoint.length > selected.mountPoint.length) selected = mount;
        }
    });
    return selected;
}

function analyzeHostStorage(devices) {
    if (!Array.isArray(devices)) return {
        actual: "UNKNOWN", rootBacking: "UNKNOWN", internalMountCount: 0,
        removableMountCount: 0, internalDeviceCount: 0, removableDeviceCount: 0
    };
    let rootDevice = null;
    let internalMountCount = 0;
    let removableMountCount = 0;
    let internalDeviceCount = 0;
    let removableDeviceCount = 0;
    devices.forEach(device => {
        if (device.type === "disk") {
            if (device.removable) removableDeviceCount++;
            else internalDeviceCount++;
        }
        device.mountpoints.forEach(mountpoint => {
            if (mountpoint === "/") rootDevice = device;
            if (!mountpoint.startsWith("/")) return;
            if (device.rootRemovable === true) removableMountCount++;
            else if (device.rootRemovable === false) internalMountCount++;
        });
    });
    const rootBacking = !rootDevice || rootDevice.rootRemovable === null ? "UNKNOWN"
        : (rootDevice.rootRemovable ? "REMOVABLE" : "INTERNAL");
    return {
        actual: internalMountCount > 0 ? "ACCESSIBLE"
            : (internalDeviceCount > 0 ? "NOT_DETECTED" : "NOT_DETECTED"),
        rootBacking,
        internalMountCount,
        removableMountCount,
        internalDeviceCount,
        removableDeviceCount
    };
}

function classifyFilesystemBacking(devices, mounts, candidatePath, pathModule = path) {
    if (!Array.isArray(devices)) return "UNKNOWN";
    const mount = mountForPath(mounts, candidatePath, pathModule);
    if (!mount) return "UNKNOWN";
    const device = devices.find(item => (item.majorMinor && item.majorMinor === mount.majorMinor)
        || (item.devicePath && item.devicePath === mount.source));
    if (!device || device.rootRemovable === null) return "UNKNOWN";
    return device.rootRemovable ? "REMOVABLE" : "INTERNAL";
}

function sanitizeHostStorageInventory(inventory) {
    const source = inventory || {};
    return {
        actual: ["ACCESSIBLE", "NOT_DETECTED", "UNKNOWN"].includes(source.actual)
            ? source.actual : "UNKNOWN",
        rootBacking: ["INTERNAL", "REMOVABLE", "UNKNOWN"].includes(source.rootBacking)
            ? source.rootBacking : "UNKNOWN",
        internalMountCount: Number.isSafeInteger(source.internalMountCount) && source.internalMountCount >= 0
            ? source.internalMountCount : 0,
        removableMountCount: Number.isSafeInteger(source.removableMountCount) && source.removableMountCount >= 0
            ? source.removableMountCount : 0,
        internalDeviceCount: Number.isSafeInteger(source.internalDeviceCount) && source.internalDeviceCount >= 0
            ? source.internalDeviceCount : 0,
        removableDeviceCount: Number.isSafeInteger(source.removableDeviceCount) && source.removableDeviceCount >= 0
            ? source.removableDeviceCount : 0,
        repositoryBacking: ["INTERNAL", "REMOVABLE", "UNKNOWN"].includes(source.repositoryBacking)
            ? source.repositoryBacking : "UNKNOWN"
    };
}

function detectEncryption(devices) {
    if (!Array.isArray(devices)) return {actual: "UNKNOWN", reason: "BLOCK DEVICE TOPOLOGY UNAVAILABLE"};
    const root = devices.find(device => device.mountpoints.includes("/"));
    if (!root) return {actual: "UNKNOWN", reason: "ROOT BLOCK DEVICE NOT IDENTIFIED"};
    if (!root.encrypted) return {
        actual: "NOT_VERIFIED",
        reason: "ROOT FILESYSTEM HAS NO VERIFIED CRYPT ANCESTRY"
    };
    const excluded = new Set(["/boot", "/boot/efi"]);
    const unencryptedPersistent = devices.some(device => !device.encrypted && device.rootRemovable === false
        && device.mountpoints.some(mountpoint => mountpoint === "[SWAP]"
            || (mountpoint.startsWith("/") && !excluded.has(mountpoint))));
    if (unencryptedPersistent) return {
        actual: "PARTIAL",
        reason: "ROOT ENCRYPTION DETECTED; AN UNENCRYPTED INTERNAL MOUNT REMAINS"
    };
    return {actual: "VERIFIED", reason: "ROOT AND DETECTED INTERNAL DATA MOUNTS HAVE CRYPT ANCESTRY"};
}

function parseSwapTable(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_SYSTEM_FILE_BYTES) return null;
    const lines = content.trim().split("\n");
    if (!lines.length || !/^Filename\s+Type\s+Size\s+Used\s+Priority/.test(lines[0])) return null;
    const entries = [];
    for (const line of lines.slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 5) continue;
        const source = fields[0];
        entries.push({
            source,
            type: fields[1].slice(0, 64),
            volatile: /^\/dev\/(zram|zswap)/.test(source)
        });
        if (entries.length >= 256) break;
    }
    return entries;
}

function parseSecureBootVariable(content) {
    if (!Buffer.isBuffer(content)) return "UNKNOWN";
    if (content.length >= 5) {
        if (content[4] === 1) return "ENABLED";
        if (content[4] === 0) return "DISABLED";
    }
    if (content.length === 1) {
        if (content[0] === 1) return "ENABLED";
        if (content[0] === 0) return "DISABLED";
    }
    return "UNKNOWN";
}

function parseSecureBootText(content) {
    if (typeof content !== "string") return "UNKNOWN";
    if (/secureboot\s+enabled/i.test(content)) return "ENABLED";
    if (/secureboot\s+disabled/i.test(content)) return "DISABLED";
    return "UNKNOWN";
}

function permissionMode(stats) {
    return (stats.mode & 0o777).toString(8).padStart(3, "0");
}

function auditPermissionPath(spec, opts = {}) {
    const fsModule = opts.fs || fs;
    const uid = Object.prototype.hasOwnProperty.call(opts, "uid")
        ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
    let stats;
    try {
        stats = fsModule.lstatSync(spec.path);
    } catch (error) {
        if (error && error.code === "ENOENT") return {
            id: spec.id,
            label: spec.label,
            state: "NOT_APPLICABLE",
            actual: "NOT_PRESENT",
            detail: "NOMAD-OWNED RESOURCE NOT PRESENT",
            severity: "INFO",
            remediation: "NONE"
        };
        return {
            id: spec.id,
            label: spec.label,
            state: "UNKNOWN",
            actual: "INSPECTION_FAILED",
            detail: "RESOURCE METADATA COULD NOT BE READ",
            severity: "MEDIUM",
            remediation: "INSPECT OWNER, TYPE, AND MODE"
        };
    }
    if (stats.isSymbolicLink()) return {
        id: spec.id,
        label: spec.label,
        state: "INSECURE",
        actual: "SYMLINK",
        detail: "SECURITY-SENSITIVE RESOURCE IS A SYMBOLIC LINK",
        severity: "HIGH",
        remediation: "REPLACE WITH A USER-OWNED REGULAR RESOURCE"
    };
    const typeValid = spec.type === "directory" ? stats.isDirectory() : stats.isFile();
    if (!typeValid || (spec.type !== "directory" && stats.nlink !== 1)) return {
        id: spec.id,
        label: spec.label,
        state: "INSECURE",
        actual: "UNSAFE_TYPE",
        detail: "RESOURCE TYPE OR LINK COUNT IS NOT ACCEPTABLE",
        severity: "HIGH",
        remediation: "RECREATE AS A USER-OWNED REGULAR RESOURCE"
    };
    if (uid !== null && typeof stats.uid === "number" && stats.uid !== uid) return {
        id: spec.id,
        label: spec.label,
        state: "INSECURE",
        actual: "OWNER_MISMATCH",
        detail: "RESOURCE IS NOT OWNED BY THE CURRENT USER",
        severity: "HIGH",
        remediation: "VERIFY OWNERSHIP BEFORE ANY PERMISSION CHANGE"
    };
    const mode = stats.mode & 0o777;
    if ((mode & 0o022) !== 0) return {
        id: spec.id,
        label: spec.label,
        state: "INSECURE",
        actual: `MODE_${permissionMode(stats)}`,
        detail: "RESOURCE IS GROUP- OR WORLD-WRITABLE",
        severity: "HIGH",
        remediation: "AFTER VERIFYING OWNERSHIP, REMOVE GROUP/WORLD WRITE ACCESS"
    };
    if (spec.sensitive && (mode & 0o077) !== 0) return {
        id: spec.id,
        label: spec.label,
        state: "INSECURE",
        actual: `MODE_${permissionMode(stats)}`,
        detail: "SENSITIVE RESOURCE IS ACCESSIBLE TO GROUP OR OTHER USERS",
        severity: "MEDIUM",
        remediation: "AFTER VERIFYING OWNERSHIP, RESTRICT TO USER ACCESS"
    };
    if (spec.type === "directory" && (mode & 0o077) !== 0) return {
        id: spec.id,
        label: spec.label,
        state: "PARTIAL",
        actual: `MODE_${permissionMode(stats)}`,
        detail: "DIRECTORY METADATA IS ACCESSIBLE TO OTHER USERS",
        severity: "LOW",
        remediation: "CONSIDER MODE 0700 AFTER VERIFYING OWNERSHIP"
    };
    return {
        id: spec.id,
        label: spec.label,
        state: "SECURE",
        actual: `MODE_${permissionMode(stats)}`,
        detail: "OWNER, TYPE, LINK COUNT, AND MODE VERIFIED",
        severity: "INFO",
        remediation: "NONE"
    };
}

function aggregatePermissionChecks(id, label, checks) {
    if (!checks.length) return {id, label, state: "UNKNOWN", actual: "UNKNOWN", detail: "NO RESOURCES INSPECTED"};
    const worst = checks.reduce((selected, check) => (
        CHECK_STATE_RANK[check.state] > CHECK_STATE_RANK[selected.state] ? check : selected
    ), checks[0]);
    const active = checks.filter(check => check.state !== "NOT_APPLICABLE");
    if (!active.length) return {
        id, label, state: "NOT_APPLICABLE", actual: "NOT_PRESENT", detail: "NO NOMAD-OWNED RESOURCES PRESENT"
    };
    const unsafeCount = active.filter(check => !["SECURE", "NOT_APPLICABLE"].includes(check.state)).length;
    return {
        id,
        label,
        state: worst.state,
        actual: unsafeCount ? "FINDINGS" : "VERIFIED",
        detail: unsafeCount ? `${unsafeCount} PERMISSION OR TYPE FINDING(S)` : "OWNER, TYPE, AND MODE VERIFIED"
    };
}

function sanitizeCheck(check) {
    return {
        id: typeof check.id === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(check.id)
            ? check.id : "unknown_check",
        label: normalizeFact(check.label, "UNKNOWN CHECK", 64),
        state: SECURITY_CHECK_STATE_SET.has(check.state) ? check.state : "UNKNOWN",
        actual: normalizeFact(check.actual, "UNKNOWN", 96),
        detail: sanitizeText(check.detail, "NO VERIFIED DETAIL AVAILABLE", 240).toUpperCase()
    };
}

function sanitizePolicyItem(item) {
    return {
        id: typeof item.id === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(item.id) ? item.id : "unknown_policy",
        label: normalizeFact(item.label, "UNKNOWN POLICY", 64),
        desired: normalizeFact(item.desired, "UNKNOWN", 96),
        actual: normalizeFact(item.actual, "UNKNOWN", 96),
        compliant: typeof item.compliant === "boolean" ? item.compliant : null,
        enforceable: POLICY_ENFORCEMENT_STATES.has(item.enforceable) ? item.enforceable : "UNKNOWN",
        reason: sanitizeText(item.reason, "NO VERIFIED REASON AVAILABLE", 240).toUpperCase()
    };
}

function sanitizeFinding(finding) {
    return {
        severity: AUDIT_SEVERITIES.has(finding.severity) ? finding.severity : "INFO",
        id: typeof finding.id === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(finding.id)
            ? finding.id : "unknown_finding",
        label: normalizeFact(finding.label, "UNKNOWN FINDING", 64),
        detail: sanitizeText(finding.detail, "NO VERIFIED DETAIL AVAILABLE", 240).toUpperCase(),
        remediation: sanitizeText(finding.remediation, "REVIEW MANUALLY", 240).toUpperCase()
    };
}

function sanitizeSecurityStatus(status, verbose = false) {
    const profile = status && status.profile ? status.profile : {};
    const output = {
        version: 1,
        generatedAt: typeof status.generatedAt === "string" && Number.isFinite(Date.parse(status.generatedAt))
            ? new Date(status.generatedAt).toISOString() : new Date(0).toISOString(),
        profile: {
            id: ["NORMAL", "PUBLIC", "LOCKDOWN", "UNKNOWN"].includes(profile.id) ? profile.id : "UNKNOWN",
            source: ["DEFAULT", "CONFIG", "INVALID", "UNKNOWN"].includes(profile.source) ? profile.source : "UNKNOWN",
            compliance: PROFILE_COMPLIANCE_STATES.has(profile.compliance) ? profile.compliance : "UNKNOWN",
            systemEnforcementPending: profile.systemEnforcementPending === true
        },
        checks: Array.isArray(status && status.checks) ? status.checks.map(sanitizeCheck).slice(0, 64) : []
    };
    if (verbose) {
        output.policy = Array.isArray(status && status.policy) ? status.policy.map(sanitizePolicyItem).slice(0, 64) : [];
        output.findings = Array.isArray(status && status.findings) ? status.findings.map(sanitizeFinding).slice(0, 128) : [];
        const capabilities = status && status.capabilities ? status.capabilities : {};
        output.capabilities = {
            maximumLevel: ["STRONG", "PARTIAL", "NONE", "UNAVAILABLE"].includes(capabilities.maximumLevel)
                ? capabilities.maximumLevel : "UNAVAILABLE",
            preferredBackend: normalizeFact(capabilities.preferredBackend, "UNAVAILABLE", 32),
            backends: Array.isArray(capabilities.backends) ? capabilities.backends.slice(0, 8).map(backend => ({
                id: normalizeFact(backend.id, "UNKNOWN", 32),
                level: ["STRONG", "PARTIAL", "NONE", "UNAVAILABLE"].includes(backend.level)
                    ? backend.level : "UNAVAILABLE",
                available: backend.available === true,
                reason: sanitizeText(backend.reason, "NO VERIFIED REASON AVAILABLE", 160).toUpperCase()
            })) : []
        };
        if (status && status.hostStorage) output.hostStorage = sanitizeHostStorageInventory(status.hostStorage);
    }
    return output;
}

class SecurityService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.os = opts.os || os;
        this.platform = opts.platform || process.platform;
        this.environment = opts.env || process.env;
        this.home = opts.home || this.os.homedir();
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
        this.now = opts.now || (() => new Date());
        this.processArguments = Array.isArray(opts.processArguments)
            ? opts.processArguments.slice() : process.argv.concat(process.execArgv || []);
        this.spawnSync = opts.spawnSync || spawnSync;
        this.commandTimeoutMs = Number.isSafeInteger(opts.commandTimeoutMs) && opts.commandTimeoutMs > 0
            ? opts.commandTimeoutMs : 1500;
        this.commandRunner = typeof opts.commandRunner === "function" ? opts.commandRunner : null;
        this.sources = opts.sources || {};
        this.resolveExecutable = opts.resolveExecutable || (executable => resolveExecutable(executable, {
            fs: this.fs, path: this.path, env: this.environment, platform: this.platform
        }));
        this.profileService = opts.profileService || new SecurityProfileService(opts);
        this.isolationService = opts.isolationService || new RepositoryIsolationService(opts);
        this.productionMode = typeof opts.productionMode === "boolean"
            ? opts.productionMode : this.environment.NOMAD_PRODUCTION === "1";
        this.debugConfiguration = Object.assign({
            devTools: this.productionMode ? false : true,
            nodeIntegration: true,
            enableRemoteModule: true,
            experimentalFeatures: false
        }, opts.debugConfiguration || {});
        this.hasActiveRepositoryProcesses = typeof opts.hasActiveRepositoryProcesses === "function"
            ? opts.hasActiveRepositoryProcesses : null;
        const configRoot = typeof this.environment.XDG_CONFIG_HOME === "string"
            && this.path.isAbsolute(this.environment.XDG_CONFIG_HOME)
            ? this.environment.XDG_CONFIG_HOME : this.path.join(this.home, ".config");
        const stateRoot = typeof this.environment.XDG_STATE_HOME === "string"
            && this.path.isAbsolute(this.environment.XDG_STATE_HOME)
            ? this.environment.XDG_STATE_HOME : this.path.join(this.home, ".local", "state");
        this.nomadConfigRoot = opts.nomadConfigRoot || this.path.join(configRoot, "nomad");
        this.nomadStateRoot = opts.nomadStateRoot || this.path.join(stateRoot, "nomad");
        const configuredRepositoryRoot = opts.repositoryRoot || this.environment.NOMAD_REPOSITORY_ROOT || "~/Repositories";
        this.repositoryRoot = configuredRepositoryRoot === "~" ? this.home
            : (typeof configuredRepositoryRoot === "string" && configuredRepositoryRoot.startsWith("~/")
                ? this.path.join(this.home, configuredRepositoryRoot.slice(2)) : configuredRepositoryRoot);
    }

    status(opts = {}) {
        const verbose = opts.verbose === true;
        const profileResult = this._profile();
        const mounts = parseMountInfo(this._source("mountInfo", "/proc/self/mountinfo"));
        const devices = this._blockDevices();
        const hostStorage = Object.assign(analyzeHostStorage(devices), {
            repositoryBacking: typeof this.repositoryRoot === "string" && this.path.isAbsolute(this.repositoryRoot)
                ? classifyFilesystemBacking(devices, mounts, this.repositoryRoot, this.path) : "UNKNOWN"
        });
        const encryption = detectEncryption(devices);
        const swap = this._swap();
        const firewall = this._firewall();
        const automount = this._automount();
        const secureBoot = this._secureBoot();
        const temp = this._temporaryStorage(mounts);
        const runtime = this._runtimeDirectory(mounts);
        const persistence = this._persistence(mounts);
        const permissions = this._permissions();
        const sensitiveEnvironment = this._sensitiveEnvironment();
        const capabilities = this.isolationService.capabilities();
        const execution = profileResult.profile === "UNKNOWN"
            ? this.isolationService.evaluatePolicy("UNKNOWN")
            : this.isolationService.evaluatePolicy(profileResult.profile);
        const debug = this._debugExposure();
        const repositoryRuntime = this._repositoryRuntime();

        const checks = [
            this._profileCheck(profileResult),
            firewall,
            this._hostStorageCheck(hostStorage),
            automount,
            this._repositoryExecutionCheck(execution, repositoryRuntime),
            this._repositoryIsolationCheck(execution, capabilities),
            {
                id: "application_execution", label: "APPLICATION EXECUTION", state: "PARTIAL",
                actual: "CONTROLLED_REGISTRY",
                detail: "MAIN PROCESS RESOLVES REGISTERED APPLICATIONS; APPLICATION PROCESSES ARE NOT SANDBOXED"
            },
            this._privilegeEscalationCheck(profileResult.profile),
            this._encryptionCheck(encryption),
            this._swapCheck(swap),
            temp,
            runtime,
            persistence,
            this._secureBootCheck(secureBoot),
            this._sessionCheck(),
            debug,
            this._rendererPrivilegeCheck(),
            permissions.config,
            permissions.state,
            permissions.trust,
            permissions.apps,
            permissions.sessionEnv,
            sensitiveEnvironment
        ];
        const observations = {
            profile: profileResult,
            execution,
            hostStorage,
            automount,
            temp,
            persistence,
            firewall,
            debug,
            sensitiveEnvironment,
            capabilities,
            repositoryRuntime
        };
        const policy = this._policy(profileResult.profile, observations);
        const compliance = this._compliance(policy, profileResult.profile);
        const findings = this._findings(checks, permissions.details, profileResult.profile, policy);
        const systemPolicyIds = new Set([
            "host_storage", "automount", "temporary_data", "state_persistence",
            "application_execution", "privilege_escalation", "network_policy"
        ]);
        return sanitizeSecurityStatus({
            generatedAt: this.now().toISOString(),
            profile: {
                id: profileResult.profile,
                source: profileResult.source,
                compliance,
                systemEnforcementPending: policy.some(item => systemPolicyIds.has(item.id)
                    && item.compliant === false && item.enforceable !== "YES")
            },
            checks,
            policy,
            findings,
            capabilities,
            hostStorage
        }, verbose);
    }

    audit() {
        const status = this.status({verbose: true});
        return {
            version: 1,
            generatedAt: status.generatedAt,
            profile: status.profile,
            findings: status.findings
        };
    }

    profile() {
        const current = this.profileService.get();
        let status;
        try {
            status = this.status({verbose: true});
        } catch (error) {
            status = {profile: {compliance: "UNKNOWN", systemEnforcementPending: current.profile !== "NORMAL"}};
        }
        return {
            profile: current.profile,
            source: current.source,
            updatedAt: current.updatedAt,
            policy: clone(current.policy),
            compliance: status.profile.compliance,
            systemEnforcementPending: status.profile.systemEnforcementPending
        };
    }

    setProfile(profileValue) {
        const changed = this.profileService.set(profileValue);
        let status;
        try {
            status = this.status({verbose: true});
        } catch (error) {
            status = {profile: {compliance: "UNKNOWN", systemEnforcementPending: changed.profile !== "NORMAL"}};
        }
        return {
            profile: changed.profile,
            source: changed.source,
            updatedAt: changed.updatedAt,
            policy: clone(changed.policy),
            compliance: status.profile.compliance,
            systemEnforcementPending: status.profile.systemEnforcementPending
        };
    }

    listProfiles() {
        return this.profileService.list();
    }

    _profile() {
        try {
            const current = this.profileService.get();
            return {profile: current.profile, source: current.source, error: null};
        } catch (error) {
            return {
                profile: "UNKNOWN",
                source: "INVALID",
                error: error instanceof SecurityProfileError ? error.status : "SECURITY PROFILE UNAVAILABLE"
            };
        }
    }

    _profileCheck(profile) {
        if (profile.profile === "UNKNOWN") return {
            id: "security_profile", label: "SECURITY PROFILE", state: "INSECURE",
            actual: "UNKNOWN", detail: profile.error || "PROFILE COULD NOT BE VERIFIED"
        };
        return {
            id: "security_profile", label: "SECURITY PROFILE", state: "SECURE",
            actual: profile.profile, detail: `${profile.source} PROFILE SELECTION VERIFIED`
        };
    }

    _blockDevices() {
        let content;
        if (Object.prototype.hasOwnProperty.call(this.sources, "lsblk")) content = this.sources.lsblk;
        else {
            const result = this._run("lsblk", [
                "--json", "--bytes", "--output",
                "NAME,KNAME,PATH,MAJ:MIN,TYPE,RM,RO,MOUNTPOINTS,FSTYPE,PKNAME"
            ]);
            content = result && result.status === 0 ? result.stdout : null;
        }
        return parseLsblkJson(content);
    }

    _firewall() {
        const ufw = this._run("ufw", ["status"]);
        if (ufw) {
            if (/status:\s*active/i.test(ufw.stdout || "")) return {
                id: "firewall", label: "FIREWALL", state: "PARTIAL", actual: "ACTIVE",
                detail: "ACTIVE UFW POLICY DETECTED; POLICY EFFECTIVENESS NOT VERIFIED"
            };
            if (/status:\s*inactive/i.test(ufw.stdout || "")) return {
                id: "firewall", label: "FIREWALL", state: "INSECURE", actual: "NOT_CONFIGURED",
                detail: "UFW REPORTS INACTIVE"
            };
        }
        const firewalld = this._run("firewall-cmd", ["--state"]);
        if (firewalld && firewalld.status === 0 && /^running\s*$/i.test(firewalld.stdout || "")) return {
            id: "firewall", label: "FIREWALL", state: "PARTIAL", actual: "ACTIVE",
            detail: "FIREWALLD REPORTS RUNNING; POLICY EFFECTIVENESS NOT VERIFIED"
        };
        if (firewalld && /not\s+running/i.test(`${firewalld.stdout || ""} ${firewalld.stderr || ""}`)) return {
            id: "firewall", label: "FIREWALL", state: "INSECURE", actual: "NOT_CONFIGURED",
            detail: "FIREWALLD REPORTS NOT RUNNING"
        };
        const nft = this._run("nft", ["list", "ruleset"]);
        if (nft && nft.status === 0) {
            if (/\bhook\s+(input|forward|output)\b/i.test(nft.stdout || "")) return {
                id: "firewall", label: "FIREWALL", state: "PARTIAL", actual: "ACTIVE",
                detail: "NFTABLES FILTER HOOKS DETECTED; POLICY EFFECTIVENESS NOT VERIFIED"
            };
            return {
                id: "firewall", label: "FIREWALL", state: "INSECURE", actual: "NOT_CONFIGURED",
                detail: "NO NFTABLES FILTER HOOKS DETECTED"
            };
        }
        if (!ufw && !firewalld && !nft) return {
            id: "firewall", label: "FIREWALL", state: "UNAVAILABLE", actual: "UNAVAILABLE",
            detail: "NO SUPPORTED FIREWALL INSPECTION TOOL AVAILABLE"
        };
        return {
            id: "firewall", label: "FIREWALL", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "SUPPORTED FIREWALL TOOL COULD NOT PROVIDE VERIFIABLE STATUS"
        };
    }

    _automount() {
        const result = this._run("gsettings", ["get", "org.gnome.desktop.media-handling", "automount"]);
        if (!result) return {
            id: "automount", label: "AUTOMOUNT", state: "UNAVAILABLE", actual: "UNAVAILABLE",
            detail: "GNOME AUTOMOUNT CONFIGURATION TOOL NOT AVAILABLE"
        };
        const output = String(result.stdout || "").trim().toLowerCase();
        if (result.status === 0 && output === "true") return {
            id: "automount", label: "AUTOMOUNT", state: "INSECURE", actual: "ENABLED",
            detail: "GNOME MEDIA AUTOMOUNT CONFIGURATION IS ENABLED"
        };
        if (result.status === 0 && output === "false") return {
            id: "automount", label: "AUTOMOUNT", state: "PARTIAL", actual: "DISABLED_GNOME",
            detail: "GNOME MEDIA AUTOMOUNT IS DISABLED; OTHER AUTOMOUNTERS NOT VERIFIED"
        };
        return {
            id: "automount", label: "AUTOMOUNT", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "AUTOMOUNT CONFIGURATION COULD NOT BE VERIFIED"
        };
    }

    _hostStorageCheck(inventory) {
        if (inventory.actual === "ACCESSIBLE") return {
            id: "host_storage", label: "HOST STORAGE", state: "INSECURE", actual: "ACCESSIBLE",
            detail: `${inventory.internalMountCount} INTERNAL-BACKED MOUNT(S); ROOT ${inventory.rootBacking}; REPOSITORIES ${inventory.repositoryBacking || "UNKNOWN"}`
        };
        if (inventory.actual === "NOT_DETECTED") return {
            id: "host_storage", label: "HOST STORAGE", state: "PARTIAL", actual: "NOT_DETECTED",
            detail: "NO MOUNTED INTERNAL-BACKED FILESYSTEM DETECTED; DEVICE ACCESS POLICY NOT ENFORCED"
        };
        return {
            id: "host_storage", label: "HOST STORAGE", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "BLOCK DEVICE TOPOLOGY COULD NOT BE VERIFIED"
        };
    }

    _swap() {
        const entries = parseSwapTable(this._source("swaps", "/proc/swaps"));
        if (!entries) return {actual: "UNKNOWN", count: 0, persistentCount: 0, volatileCount: 0};
        return {
            actual: entries.length ? (entries.every(entry => entry.volatile)
                ? "ACTIVE_VOLATILE" : "ACTIVE_PERSISTENCE_POSSIBLE") : "INACTIVE",
            count: entries.length,
            persistentCount: entries.filter(entry => !entry.volatile).length,
            volatileCount: entries.filter(entry => entry.volatile).length
        };
    }

    _swapCheck(swap) {
        if (swap.actual === "INACTIVE") return {
            id: "swap", label: "SWAP", state: "SECURE", actual: "INACTIVE",
            detail: "NO ACTIVE SWAP DETECTED"
        };
        if (swap.actual === "ACTIVE_VOLATILE") return {
            id: "swap", label: "SWAP", state: "PARTIAL", actual: "ACTIVE_VOLATILE",
            detail: `${swap.volatileCount} VOLATILE COMPRESSED-RAM SWAP DEVICE(S) ACTIVE`
        };
        if (swap.actual === "ACTIVE_PERSISTENCE_POSSIBLE") return {
            id: "swap", label: "SWAP", state: "INSECURE", actual: "ACTIVE",
            detail: `${swap.persistentCount} SWAP SOURCE(S) MAY WRITE PROCESS DATA TO PERSISTENT STORAGE`
        };
        return {
            id: "swap", label: "SWAP", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "ACTIVE SWAP COULD NOT BE VERIFIED"
        };
    }

    _secureBoot() {
        if (Object.prototype.hasOwnProperty.call(this.sources, "secureBoot")) {
            return Buffer.isBuffer(this.sources.secureBoot)
                ? parseSecureBootVariable(this.sources.secureBoot) : parseSecureBootText(this.sources.secureBoot);
        }
        let entries;
        try {
            entries = this.fs.readdirSync("/sys/firmware/efi/efivars")
                .filter(name => /^SecureBoot-[A-Fa-f0-9-]+$/.test(name)).slice(0, 4);
        } catch (error) {
            entries = [];
        }
        for (const entry of entries) {
            try {
                const state = parseSecureBootVariable(this.fs.readFileSync(
                    this.path.join("/sys/firmware/efi/efivars", entry)
                ));
                if (state !== "UNKNOWN") return state;
            } catch (error) {}
        }
        const mokutil = this._run("mokutil", ["--sb-state"]);
        return mokutil && mokutil.status === 0 ? parseSecureBootText(mokutil.stdout) : "UNKNOWN";
    }

    _secureBootCheck(actual) {
        if (actual === "ENABLED") return {
            id: "secure_boot", label: "SECURE BOOT", state: "SECURE", actual,
            detail: "FIRMWARE SECURE BOOT STATE REPORTED ENABLED"
        };
        if (actual === "DISABLED") return {
            id: "secure_boot", label: "SECURE BOOT", state: "INSECURE", actual,
            detail: "FIRMWARE SECURE BOOT STATE REPORTED DISABLED"
        };
        return {
            id: "secure_boot", label: "SECURE BOOT", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "SECURE BOOT STATE COULD NOT BE VERIFIED"
        };
    }

    _encryptionCheck(result) {
        const state = result.actual === "VERIFIED" ? "SECURE"
            : (result.actual === "PARTIAL" ? "PARTIAL"
                : (result.actual === "NOT_VERIFIED" ? "INSECURE" : "UNKNOWN"));
        return {
            id: "disk_encryption", label: "DISK ENCRYPTION", state,
            actual: result.actual, detail: result.reason
        };
    }

    _temporaryStorage(mounts) {
        const mount = mountForPath(mounts, "/tmp", this.path);
        if (!mount) return {
            id: "temporary_storage", label: "TEMP STORAGE", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "/TMP FILESYSTEM COULD NOT BE VERIFIED"
        };
        if (["tmpfs", "ramfs"].includes(mount.fsType.toLowerCase())) return {
            id: "temporary_storage", label: "TEMP STORAGE", state: "SECURE", actual: "VOLATILE",
            detail: "/TMP IS BACKED BY A VOLATILE MEMORY FILESYSTEM"
        };
        return {
            id: "temporary_storage", label: "TEMP STORAGE", state: "PARTIAL", actual: "PERSISTENCE_POSSIBLE",
            detail: "/TMP IS NOT VERIFIED AS A VOLATILE MEMORY FILESYSTEM"
        };
    }

    _runtimeDirectory(mounts) {
        const runtimePath = this.environment.XDG_RUNTIME_DIR;
        if (typeof runtimePath !== "string" || !this.path.isAbsolute(runtimePath)) return {
            id: "runtime_directory", label: "XDG RUNTIME", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "XDG_RUNTIME_DIR IS NOT AN ABSOLUTE VERIFIED PATH"
        };
        let stats;
        try {
            stats = this.fs.lstatSync(runtimePath);
        } catch (error) {
            return {
                id: "runtime_directory", label: "XDG RUNTIME", state: "UNKNOWN", actual: "UNAVAILABLE",
                detail: "XDG_RUNTIME_DIR METADATA COULD NOT BE VERIFIED"
            };
        }
        if (stats.isSymbolicLink() || !stats.isDirectory()
            || (this.uid !== null && typeof stats.uid === "number" && stats.uid !== this.uid)
            || (stats.mode & 0o077) !== 0) return {
            id: "runtime_directory", label: "XDG RUNTIME", state: "INSECURE", actual: "UNSAFE_METADATA",
            detail: "XDG_RUNTIME_DIR OWNER, TYPE, OR MODE IS UNSAFE"
        };
        const mount = mountForPath(mounts, runtimePath, this.path);
        if (mount && ["tmpfs", "ramfs"].includes(mount.fsType.toLowerCase())) return {
            id: "runtime_directory", label: "XDG RUNTIME", state: "SECURE", actual: "VOLATILE",
            detail: "XDG_RUNTIME_DIR OWNER, MODE, AND VOLATILE FILESYSTEM VERIFIED"
        };
        return {
            id: "runtime_directory", label: "XDG RUNTIME", state: "PARTIAL", actual: "PERSISTENCE_UNKNOWN",
            detail: "XDG_RUNTIME_DIR METADATA IS SAFE; VOLATILE BACKING NOT VERIFIED"
        };
    }

    _persistence(mounts) {
        const configMount = mountForPath(mounts, this.nomadConfigRoot, this.path);
        const stateMount = mountForPath(mounts, this.nomadStateRoot, this.path);
        if (!configMount || !stateMount) return {
            id: "nomad_persistence", label: "NOMAD PERSISTENCE", state: "UNKNOWN", actual: "UNKNOWN",
            detail: "CONFIG AND STATE FILESYSTEM BACKING COULD NOT BE VERIFIED"
        };
        const volatile = mount => ["tmpfs", "ramfs"].includes(mount.fsType.toLowerCase());
        if (volatile(configMount) && volatile(stateMount)) return {
            id: "nomad_persistence", label: "NOMAD PERSISTENCE", state: "SECURE", actual: "EPHEMERAL",
            detail: "NOMAD CONFIG AND STATE ARE ON VOLATILE FILESYSTEMS"
        };
        return {
            id: "nomad_persistence", label: "NOMAD PERSISTENCE", state: "PARTIAL", actual: "PERSISTENT",
            detail: "NOMAD CONFIG OR STATE MAY PERSIST ACROSS SESSIONS"
        };
    }

    _permissions() {
        const specs = [
            {id: "nomad_config_directory", label: "NOMAD CONFIG DIRECTORY", path: this.nomadConfigRoot, type: "directory", sensitive: false},
            {id: "security_profile_store", label: "SECURITY PROFILE STORE", path: this.path.join(this.nomadConfigRoot, "security.json"), type: "file", sensitive: true},
            {id: "session_env", label: "SESSION ENV", path: this.path.join(this.nomadConfigRoot, "session.env"), type: "file", sensitive: true},
            {id: "cli_marker", label: "CLI OWNERSHIP MARKER", path: this.path.join(this.nomadConfigRoot, ".cli-v0.4-d-installed"), type: "file", sensitive: true},
            {id: "repository_trust_store", label: "REPOSITORY TRUST STORE", path: this.path.join(this.nomadConfigRoot, "repository-runs.json"), type: "file", sensitive: true},
            {id: "application_registry", label: "APPLICATION REGISTRY", path: this.path.join(this.nomadConfigRoot, "apps.json"), type: "file", sensitive: true},
            {id: "nomad_state_directory", label: "NOMAD STATE DIRECTORY", path: this.nomadStateRoot, type: "directory", sensitive: true},
            {id: "session_log", label: "SESSION LOG", path: this.path.join(this.nomadStateRoot, "session.log"), type: "file", sensitive: true},
            {id: "ui_log", label: "UI LOG", path: this.path.join(this.nomadStateRoot, "ui.log"), type: "file", sensitive: true}
        ];
        const details = specs.map(spec => auditPermissionPath(spec, {fs: this.fs, uid: this.uid}));
        const byId = id => details.find(check => check.id === id);
        const configDetails = ["nomad_config_directory", "security_profile_store", "session_env", "cli_marker"]
            .map(byId).filter(Boolean);
        const stateDetails = ["nomad_state_directory", "session_log", "ui_log"].map(byId).filter(Boolean);
        const sessionEnv = byId("session_env");
        return {
            config: aggregatePermissionChecks("nomad_config_permissions", "NOMAD CONFIG PERMISSIONS", configDetails),
            state: aggregatePermissionChecks("nomad_state_permissions", "NOMAD STATE PERMISSIONS", stateDetails),
            trust: Object.assign({}, byId("repository_trust_store"), {
                id: "repository_trust_store_permissions", label: "TRUST STORE PERMISSIONS"
            }),
            apps: Object.assign({}, byId("application_registry"), {
                id: "application_registry_permissions", label: "APP REGISTRY PERMISSIONS"
            }),
            sessionEnv: Object.assign({}, sessionEnv, {
                id: "session_env_permissions", label: "SESSION ENV PERMISSIONS"
            }),
            details
        };
    }

    _sensitiveEnvironment() {
        const count = Object.keys(this.environment || {}).filter(isSensitiveEnvironmentKey).length;
        return count ? {
            id: "sensitive_environment", label: "SENSITIVE ENVIRONMENT", state: "INSECURE", actual: "PRESENT",
            detail: `${count} SENSITIVE OR RUNTIME-INJECTION ENVIRONMENT VARIABLE NAME(S) DETECTED`
        } : {
            id: "sensitive_environment", label: "SENSITIVE ENVIRONMENT", state: "SECURE", actual: "NOT_DETECTED",
            detail: "NO KNOWN SENSITIVE OR RUNTIME-INJECTION ENVIRONMENT VARIABLE NAMES DETECTED"
        };
    }

    _repositoryExecutionCheck(execution, runtime) {
        if (execution.securityProfile === "LOCKDOWN" && !execution.allowed) return {
            id: "repository_execution", label: "REPOSITORY EXECUTION",
            state: runtime.available ? (runtime.active ? "INSECURE" : "SECURE") : "PARTIAL",
            actual: runtime.available ? (runtime.active ? "ACTIVE_PROCESS" : "DISABLED") : "NEW_RUNS_DISABLED",
            detail: runtime.available
                ? (runtime.active ? "LOCKDOWN BLOCKS NEW RUNS BUT A NOMAD-MANAGED PROCESS REMAINS ACTIVE"
                    : "LOCKDOWN BLOCKS NEW RUNS AND NO NOMAD-MANAGED REPOSITORY PROCESS IS ACTIVE")
                : "LOCKDOWN FAIL-CLOSED GATE BLOCKS NEW RUNS; PRE-EXISTING PROCESSES ARE NOT VERIFIED HERE"
        };
        if (!execution.allowed) return {
            id: "repository_execution", label: "REPOSITORY EXECUTION", state: "PARTIAL", actual: "BLOCKED",
            detail: "AUTHORIZATION REMAINS CONTROLLED; CURRENT ISOLATION REQUIREMENT CANNOT BE MET"
        };
        return {
            id: "repository_execution", label: "REPOSITORY EXECUTION", state: "PARTIAL", actual: "CONTROLLED",
            detail: "EXACT PROFILE AUTHORIZATION AND FINGERPRINTS REQUIRED; ISOLATION IS EVALUATED SEPARATELY"
        };
    }

    _repositoryIsolationCheck(execution, capabilities) {
        const level = execution.allowed ? execution.level : capabilities.maximumLevel;
        const state = level === "STRONG" ? "SECURE"
            : (level === "PARTIAL" ? "PARTIAL" : (level === "NONE" ? "INSECURE" : "UNAVAILABLE"));
        return {
            id: "repository_isolation", label: "REPOSITORY ISOLATION", state, actual: level,
            detail: level === "NONE" ? "SUPERVISED DIRECT FALLBACK HAS NO FILESYSTEM SANDBOX"
                : (execution.reason || "NO VERIFIED ISOLATION BACKEND")
        };
    }

    _privilegeEscalationCheck(profile) {
        if (profile === "PUBLIC" || profile === "LOCKDOWN") return {
            id: "privilege_escalation", label: "PRIVILEGE ESCALATION", state: "INSECURE",
            actual: "USER_SESSION_EXPOSED",
            detail: "NORMAL TERMINAL CAN REQUEST USER PRIVILEGES; REPOSITORY RUN INTRODUCES NO SUDO OR PKEXEC"
        };
        return {
            id: "privilege_escalation", label: "PRIVILEGE ESCALATION", state: "PARTIAL",
            actual: "USER_CONTROLLED",
            detail: "TERMINAL USER MAY INVOKE SYSTEM TOOLS; REPOSITORY RUN INTRODUCES NO SUDO OR PKEXEC"
        };
    }

    _sessionCheck() {
        const desktop = String(this.environment.DESKTOP_SESSION || "").toLowerCase();
        const current = String(this.environment.XDG_CURRENT_DESKTOP || "").toLowerCase();
        const sessionType = normalizeFact(this.environment.XDG_SESSION_TYPE, "UNKNOWN", 24);
        if (desktop === "nomad" && current.split(":").includes("nomad")) return {
            id: "session_type", label: "SESSION TYPE", state: "SECURE", actual: `NOMAD_${sessionType}`,
            detail: "DEDICATED NOMAD DESKTOP SESSION ENVIRONMENT VERIFIED"
        };
        if (!desktop && !current) return {
            id: "session_type", label: "SESSION TYPE", state: "UNKNOWN", actual: sessionType,
            detail: "DEDICATED NOMAD SESSION COULD NOT BE VERIFIED"
        };
        return {
            id: "session_type", label: "SESSION TYPE", state: "PARTIAL", actual: sessionType,
            detail: "PROCESS IS NOT IDENTIFIED AS THE DEDICATED NOMAD SESSION"
        };
    }

    _debugExposure() {
        const debugSwitch = this.processArguments.some(argument => /^--(remote-debugging-port|inspect|inspect-brk)(=|$)/.test(argument));
        if (debugSwitch) return {
            id: "debug_devtools", label: "DEBUG / DEVTOOLS", state: "INSECURE", actual: "REMOTE_DEBUGGING",
            detail: "A DEBUGGING COMMAND-LINE SWITCH IS ACTIVE"
        };
        if (!this.productionMode || this.debugConfiguration.devTools !== false) return {
            id: "debug_devtools", label: "DEBUG / DEVTOOLS", state: "INSECURE", actual: "DEV_MODE",
            detail: "DEVELOPMENT MODE ALLOWS CHROMIUM DEVTOOLS"
        };
        if (this.debugConfiguration.experimentalFeatures === true) return {
            id: "debug_devtools", label: "DEBUG / DEVTOOLS", state: "PARTIAL", actual: "EXPERIMENTAL_FEATURES",
            detail: "DEVTOOLS ARE DISABLED BUT EXPERIMENTAL CHROMIUM FEATURES ARE ENABLED"
        };
        return {
            id: "debug_devtools", label: "DEBUG / DEVTOOLS", state: "SECURE", actual: "RESTRICTED",
            detail: "PRODUCTION MODE DISABLES DEVTOOLS AND NO DEBUGGING SWITCH WAS DETECTED"
        };
    }

    _rendererPrivilegeCheck() {
        if (this.debugConfiguration.nodeIntegration === false
            && this.debugConfiguration.enableRemoteModule === false) return {
            id: "renderer_privilege", label: "RENDERER PRIVILEGE", state: "SECURE", actual: "ISOLATED",
            detail: "NODE INTEGRATION AND REMOTE MODULE ACCESS ARE DISABLED"
        };
        return {
            id: "renderer_privilege", label: "RENDERER PRIVILEGE", state: "INSECURE", actual: "LEGACY_NODE_ACCESS",
            detail: "LEGACY EDEX RENDERER HAS NODE INTEGRATION OR REMOTE MODULE ACCESS"
        };
    }

    _repositoryRuntime() {
        if (!this.hasActiveRepositoryProcesses) return {available: false, active: null};
        try {
            const active = this.hasActiveRepositoryProcesses();
            if (typeof active !== "boolean") return {available: false, active: null};
            return {available: true, active};
        } catch (error) {
            return {available: false, active: null};
        }
    }

    _policy(profileId, observed) {
        const policy = SECURITY_PROFILES[profileId];
        if (!policy) return [];
        const repositoryDisabled = policy.repositoryExecution === "DISABLED";
        const repositoryRuntime = observed.repositoryRuntime || {available: false, active: null};
        const isolationCompliant = repositoryDisabled
            ? (repositoryRuntime.available && !repositoryRuntime.active ? true : null)
            : levelAtLeast(observed.capabilities.maximumLevel, policy.minimumRepositoryIsolation);
        const automountActual = observed.automount.actual;
        const tempActual = observed.temp.actual;
        const persistenceActual = observed.persistence.actual;
        const debugActual = observed.debug.actual;
        const secretsActual = observed.sensitiveEnvironment.actual;
        return [
            {
                id: "repository_execution", label: "REPOSITORY EXECUTION",
                desired: policy.repositoryExecution,
                actual: repositoryDisabled
                    ? (repositoryRuntime.available ? (repositoryRuntime.active ? "ACTIVE_PROCESS" : "DISABLED") : "NEW_RUNS_DISABLED")
                    : (observed.execution.allowed ? "CONTROLLED" : "BLOCKED"),
                compliant: repositoryDisabled
                    ? (repositoryRuntime.available ? !repositoryRuntime.active : null) : observed.execution.allowed,
                enforceable: repositoryDisabled ? (repositoryRuntime.available ? "YES" : "PARTIAL") : "YES",
                reason: repositoryDisabled
                    ? (repositoryRuntime.available ? "MAIN PROCESS VERIFIED NOMAD-MANAGED PROCESS STATE"
                        : "NEW RUNS ARE BLOCKED; PRE-EXISTING PROCESSES ARE NOT VERIFIED BY THE CLI")
                    : "EXACT PROFILE AUTHORIZATION AND ISOLATION GATES ARE ENFORCED"
            },
            {
                id: "repository_isolation", label: "REPOSITORY ISOLATION",
                desired: repositoryDisabled ? "STRONG_IF_ENABLED" : policy.minimumRepositoryIsolation,
                actual: repositoryDisabled
                    ? (repositoryRuntime.available && !repositoryRuntime.active
                        ? "NOT_APPLICABLE_RUN_DISABLED" : "PRE_EXISTING_PROCESS_UNKNOWN")
                    : observed.capabilities.maximumLevel,
                compliant: isolationCompliant,
                enforceable: isolationCompliant === null ? "PARTIAL" : (isolationCompliant ? "YES" : "NO"),
                reason: repositoryDisabled ? (repositoryRuntime.available && !repositoryRuntime.active
                    ? "REPOSITORY RUN IS DISABLED AND NO MANAGED PROCESS IS ACTIVE"
                    : "NEW RUNS ARE DISABLED; PRE-EXISTING PROCESS ISOLATION IS NOT VERIFIED")
                    : (isolationCompliant ? "A VERIFIED BACKEND MEETS THE MINIMUM"
                        : "NO VERIFIED BACKEND MEETS THE PROFILE MINIMUM")
            },
            {
                id: "host_storage", label: "HOST STORAGE ACCESS",
                desired: policy.hostStorageAccess,
                actual: observed.hostStorage.actual,
                compliant: policy.hostStorageAccess === "OS_POLICY" ? true
                    : observed.hostStorage.actual === "NOT_DETECTED",
                enforceable: policy.hostStorageAccess === "OS_POLICY" ? "YES" : "NO",
                reason: policy.hostStorageAccess === "OS_POLICY" ? "PROFILE DEFERS TO CURRENT OS STORAGE POLICY"
                    : "THIS PHASE INVENTORIES STORAGE BUT DOES NOT UNMOUNT OR BLOCK DEVICES"
            },
            {
                id: "automount", label: "AUTOMOUNT",
                desired: policy.automount,
                actual: automountActual,
                compliant: policy.automount === "OS_POLICY" ? true : automountActual === "DISABLED_GNOME",
                enforceable: policy.automount === "OS_POLICY" ? "YES" : "NO",
                reason: policy.automount === "OS_POLICY" ? "PROFILE DEFERS TO CURRENT OS AUTOMOUNT POLICY"
                    : "THIS PHASE OBSERVES BUT DOES NOT CHANGE AUTOMOUNT SERVICES"
            },
            {
                id: "temporary_data", label: "TEMPORARY DATA",
                desired: policy.temporaryData,
                actual: tempActual,
                compliant: policy.temporaryData === "PERSISTENCE_ALLOWED" ? true
                    : (policy.temporaryData === "EPHEMERAL_PREFERRED" ? tempActual === "VOLATILE"
                        : tempActual === "VOLATILE"),
                enforceable: policy.temporaryData === "PERSISTENCE_ALLOWED" ? "YES" : "NO",
                reason: policy.temporaryData === "PERSISTENCE_ALLOWED" ? "PERSISTENT TEMPORARY DATA IS ALLOWED"
                    : "THIS PHASE DOES NOT REMOUNT /TMP OR GUARANTEE MEMORY ERASURE"
            },
            {
                id: "state_persistence", label: "STATE PERSISTENCE",
                desired: policy.statePersistence,
                actual: persistenceActual,
                compliant: policy.statePersistence === "ALLOWED" ? true : persistenceActual === "EPHEMERAL",
                enforceable: policy.statePersistence === "ALLOWED" ? "YES" : "PARTIAL",
                reason: policy.statePersistence === "ALLOWED" ? "PERSISTENT NOMAD STATE IS ALLOWED"
                    : "PROFILE STORE IS ENFORCED; GENERAL SESSION STATE IS NOT YET EPHEMERAL"
            },
            {
                id: "application_execution", label: "APPLICATION EXECUTION",
                desired: policy.applicationExecution,
                actual: "CONTROLLED_REGISTRY",
                compliant: policy.applicationExecution === "CONTROLLED_REGISTRY",
                enforceable: policy.applicationExecution === "CONTROLLED_REGISTRY" ? "YES" : "PARTIAL",
                reason: policy.applicationExecution === "CONTROLLED_REGISTRY"
                    ? "MAIN PROCESS RESOLVES REGISTERED APPLICATIONS"
                    : "LOCKDOWN BUILTIN-ONLY APPLICATION GATING IS POLICY-ONLY"
            },
            {
                id: "privilege_escalation", label: "PRIVILEGE ESCALATION",
                desired: policy.privilegeEscalation,
                actual: "USER_CONTROLLED",
                compliant: policy.privilegeEscalation === "USER_CONTROLLED",
                enforceable: policy.privilegeEscalation === "USER_CONTROLLED" ? "YES" : "NO",
                reason: policy.privilegeEscalation === "USER_CONTROLLED"
                    ? "NO HIDDEN NOMAD ELEVATION IS INTRODUCED"
                    : "THE NORMAL TERMINAL STILL EXPOSES USER-INVOKED PRIVILEGE TOOLS"
            },
            {
                id: "network_policy", label: "NETWORK POLICY",
                desired: policy.networkPolicy,
                actual: policy.networkPolicy === "OS_POLICY" ? "OS_POLICY" : "NOT_ENFORCED",
                compliant: policy.networkPolicy === "OS_POLICY",
                enforceable: policy.networkPolicy === "OS_POLICY" ? "YES" : "NO",
                reason: policy.networkPolicy === "OS_POLICY" ? "PROFILE DEFERS TO CURRENT OS NETWORK POLICY"
                    : "THIS PHASE DOES NOT APPLY FIREWALL OR NETWORK MUTATIONS"
            },
            {
                id: "debug_exposure", label: "DEBUG EXPOSURE",
                desired: policy.debugExposure,
                actual: debugActual,
                compliant: policy.debugExposure === "PRODUCTION_RESTRICTED" ? debugActual === "RESTRICTED"
                    : debugActual === "RESTRICTED",
                enforceable: "YES",
                reason: "DEDICATED NOMAD SESSION CAN SELECT PRODUCTION MODE WITHOUT REMOVING DEVELOPMENT MODE"
            },
            {
                id: "secrets", label: "SENSITIVE ENVIRONMENT",
                desired: policy.secrets,
                actual: secretsActual,
                compliant: policy.secrets === "MINIMIZED" ? secretsActual === "NOT_DETECTED"
                    : secretsActual === "NOT_DETECTED",
                enforceable: "PARTIAL",
                reason: "REPOSITORY ENVIRONMENT IS ALLOWLISTED; LEGACY RENDERER ENVIRONMENT MAY STILL EXPOSE VALUES"
            }
        ];
    }

    _compliance(policy, profileId) {
        if (profileId === "UNKNOWN" || !policy.length) return "UNKNOWN";
        if (policy.some(item => item.compliant === false)) return "NON_COMPLIANT";
        if (policy.some(item => item.compliant === null)) return "UNKNOWN";
        return "COMPLIANT";
    }

    _findings(checks, permissionDetails, profileId, policy) {
        const findings = [];
        checks.forEach(check => {
            if (check.state === "SECURE" || check.state === "NOT_APPLICABLE") return;
            let severity = "LOW";
            if (check.id === "repository_isolation" && check.actual === "NONE") severity = "HIGH";
            else if (check.id === "renderer_privilege" || check.id === "sensitive_environment") severity = "HIGH";
            else if (check.id === "host_storage" && ["PUBLIC", "LOCKDOWN"].includes(profileId)) severity = "HIGH";
            else if (["swap", "disk_encryption", "debug_devtools", "firewall"].includes(check.id)) severity = "MEDIUM";
            else if (check.id === "privilege_escalation") severity = ["PUBLIC", "LOCKDOWN"].includes(profileId)
                ? "MEDIUM" : "INFO";
            else if (check.id === "repository_execution" && check.actual === "CONTROLLED") severity = "INFO";
            findings.push({
                severity,
                id: check.id,
                label: check.label,
                detail: check.detail,
                remediation: this._remediation(check.id)
            });
        });
        permissionDetails.filter(check => ["INSECURE", "PARTIAL", "UNKNOWN"].includes(check.state))
            .forEach(check => findings.push({
                severity: check.severity,
                id: check.id,
                label: check.label,
                detail: check.detail,
                remediation: check.remediation
            }));
        const policyCheckIds = {
            debug_exposure: "debug_devtools",
            secrets: "sensitive_environment",
            temporary_data: "temporary_storage",
            state_persistence: "nomad_persistence"
        };
        policy.filter(item => item.compliant === false && !findings.some(finding => (
            finding.id === item.id || finding.id === policyCheckIds[item.id]
        )))
            .forEach(item => findings.push({
                severity: ["host_storage", "repository_isolation"].includes(item.id) ? "HIGH" : "MEDIUM",
                id: item.id,
                label: item.label,
                detail: `${item.actual}; DESIRED ${item.desired}`,
                remediation: item.enforceable === "NO" ? "SYSTEM-LEVEL ENFORCEMENT PENDING" : item.reason
            }));
        const severityRank = {HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3};
        findings.sort((left, right) => severityRank[left.severity] - severityRank[right.severity]
            || left.label.localeCompare(right.label));
        return findings;
    }

    _remediation(id) {
        const remediation = {
            firewall: "REVIEW FIREWALL POLICY IN THE NEXT SYSTEM-ENFORCEMENT PHASE",
            host_storage: "REVIEW INTERNAL STORAGE BLOCKING IN THE NEXT SYSTEM-ENFORCEMENT PHASE",
            automount: "REVIEW AUTOMOUNT ENFORCEMENT IN THE NEXT SYSTEM-ENFORCEMENT PHASE",
            repository_isolation: "ENABLE A VERIFIED USER-LEVEL ISOLATION BACKEND OR USE A FAIL-CLOSED PROFILE",
            privilege_escalation: "REVIEW TERMINAL AND APPLICATION POLICY FOR PUBLIC/LOCKDOWN USE",
            disk_encryption: "VERIFY THE COMPLETE BOOT AND DATA DEVICE ENCRYPTION CHAIN",
            swap: "REVIEW SWAP BACKING BEFORE PUBLIC USE; THIS PHASE DOES NOT DISABLE SWAP",
            debug_devtools: "USE NOMAD PRODUCTION MODE FOR THE DEDICATED SESSION",
            renderer_privilege: "PLAN LEGACY RENDERER ISOLATION WITHOUT WEAKENING NAMED IPC",
            sensitive_environment: "START NOMAD WITHOUT SECRET-BEARING ENVIRONMENT VARIABLES",
            temporary_storage: "USE VERIFIED VOLATILE TEMPORARY STORAGE IN A LATER ENFORCEMENT PHASE",
            nomad_persistence: "MOVE SESSION STATE TO VERIFIED EPHEMERAL STORAGE WHEN REQUIRED"
        };
        return remediation[id] || "REVIEW THE VERIFIED CONDITION AND PROFILE POLICY";
    }

    _source(id, filename) {
        if (Object.prototype.hasOwnProperty.call(this.sources, id)) return this.sources[id];
        try {
            const stats = this.fs.lstatSync(filename);
            if (!stats.isFile() || stats.size > MAX_SYSTEM_FILE_BYTES) return null;
            const content = this.fs.readFileSync(filename);
            return content.length <= MAX_SYSTEM_FILE_BYTES ? content : null;
        } catch (error) {
            return null;
        }
    }

    _run(command, args) {
        if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) return null;
        if (this.commandRunner) {
            try {
                const result = this.commandRunner(command, args.slice(), {
                    shell: false,
                    timeout: this.commandTimeoutMs
                });
                return result && typeof result === "object" ? result : null;
            } catch (error) {
                return null;
            }
        }
        const executable = this.resolveExecutable(command);
        if (!executable) return null;
        try {
            const result = this.spawnSync(executable, args, {
                encoding: "utf8",
                env: {PATH: this.environment.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
                shell: false,
                timeout: this.commandTimeoutMs,
                maxBuffer: MAX_SYSTEM_FILE_BYTES,
                windowsHide: true
            });
            return {
                status: Number.isInteger(result.status) ? result.status : null,
                stdout: typeof result.stdout === "string" ? result.stdout.slice(0, MAX_SYSTEM_FILE_BYTES) : "",
                stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 4096) : ""
            };
        } catch (error) {
            return {status: null, stdout: "", stderr: ""};
        }
    }
}

function invalidRequest() {
    return {ok: false, status: "INVALID REQUEST"};
}

async function handleSecurityStatusRequest(service, request) {
    if (!isPlainObject(request) || Object.keys(request).some(key => key !== "verbose")
        || (Object.prototype.hasOwnProperty.call(request, "verbose") && typeof request.verbose !== "boolean")) {
        return invalidRequest();
    }
    try {
        const verbose = request.verbose === true;
        return {ok: true, status: sanitizeSecurityStatus(service.status({verbose}), verbose)};
    } catch (error) {
        return {ok: false, status: "SECURITY STATUS UNAVAILABLE"};
    }
}

async function handleSecurityProfileGetRequest(service, request) {
    if (!isPlainObject(request) || Object.keys(request).length) return invalidRequest();
    try {
        const profile = service.profile();
        return {
            ok: true,
            profile: profile.profile,
            source: profile.source,
            compliance: profile.compliance,
            systemEnforcementPending: profile.systemEnforcementPending
        };
    } catch (error) {
        return {ok: false, status: error instanceof SecurityProfileError ? error.status : "SECURITY PROFILE UNAVAILABLE"};
    }
}

async function handleSecurityProfileSetRequest(service, request) {
    if (!isPlainObject(request) || Object.keys(request).length !== 1 || typeof request.profile !== "string") {
        return invalidRequest();
    }
    try {
        const profile = service.setProfile(request.profile);
        return {
            ok: true,
            status: "PROFILE CHANGED",
            profile: profile.profile,
            compliance: profile.compliance,
            systemEnforcementPending: profile.systemEnforcementPending
        };
    } catch (error) {
        return {ok: false, status: error instanceof SecurityProfileError ? error.status : "SECURITY PROFILE CHANGE REFUSED"};
    }
}

module.exports = {
    SECURITY_CHECK_STATES,
    SecurityService,
    aggregatePermissionChecks,
    analyzeHostStorage,
    auditPermissionPath,
    classifyFilesystemBacking,
    detectEncryption,
    handleSecurityProfileGetRequest,
    handleSecurityProfileSetRequest,
    handleSecurityStatusRequest,
    mountForPath,
    parseLsblkJson,
    parseMountInfo,
    parseSecureBootText,
    parseSecureBootVariable,
    parseSwapTable,
    sanitizeHostStorageInventory,
    sanitizeSecurityStatus
};
