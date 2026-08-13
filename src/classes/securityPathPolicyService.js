const fs = require("fs");
const os = require("os");
const path = require("path");
const {normalizeSecurityProfile} = require("./securityProfileService.js");

const VOLATILE_FILESYSTEMS = new Set(["tmpfs", "ramfs"]);
const MAX_MOUNTINFO_BYTES = 4 * 1024 * 1024;

function decodeMountField(value) {
    return String(value || "").replace(/\\(040|011|012|134)/g, sequence => ({
        "\\040": " ", "\\011": "\t", "\\012": "\n", "\\134": "\\"
    }[sequence]));
}

function parseMountInfoForPaths(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_MOUNTINFO_BYTES) return [];
    return content.split("\n").map(line => {
        const separator = line.indexOf(" - ");
        if (separator < 0) return null;
        const left = line.slice(0, separator).split(" ");
        const right = line.slice(separator + 3).split(" ");
        if (left.length < 6 || right.length < 3) return null;
        return {mountPoint: decodeMountField(left[4]), fsType: right[0]};
    }).filter(Boolean);
}

function mountForPath(mounts, candidate, pathModule = path) {
    if (!Array.isArray(mounts) || typeof candidate !== "string" || !pathModule.isAbsolute(candidate)) return null;
    let selected = null;
    mounts.forEach(mount => {
        if (!mount || typeof mount.mountPoint !== "string") return;
        const relative = pathModule.relative(mount.mountPoint, candidate);
        if (relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative))) {
            if (!selected || mount.mountPoint.length > selected.mountPoint.length) selected = mount;
        }
    });
    return selected;
}

function defaultRoots(home = os.homedir(), environment = process.env, pathModule = path) {
    const configBase = typeof environment.XDG_CONFIG_HOME === "string" && pathModule.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME : pathModule.join(home, ".config");
    const stateBase = typeof environment.XDG_STATE_HOME === "string" && pathModule.isAbsolute(environment.XDG_STATE_HOME)
        ? environment.XDG_STATE_HOME : pathModule.join(home, ".local", "state");
    const cacheBase = typeof environment.XDG_CACHE_HOME === "string" && pathModule.isAbsolute(environment.XDG_CACHE_HOME)
        ? environment.XDG_CACHE_HOME : pathModule.join(home, ".cache");
    return {
        configRoot: pathModule.join(configBase, "nomad"),
        stateRoot: pathModule.join(stateBase, "nomad"),
        cacheRoot: pathModule.join(cacheBase, "nomad")
    };
}

class SecurityPathPolicyService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.os = opts.os || os;
        this.environment = opts.env || process.env;
        this.home = opts.home || this.os.homedir();
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
        this.sources = opts.sources || {};
        this.roots = Object.assign(defaultRoots(this.home, this.environment, this.path), opts.roots || {});
    }

    resolve(profileValue) {
        const profile = normalizeSecurityProfile(profileValue);
        if (!profile) throw new Error("SECURITY PROFILE INVALID");
        const wantsEphemeral = profile === "PUBLIC" || profile === "LOCKDOWN";
        const runtime = this._runtime();
        const ephemeral = wantsEphemeral && runtime.verified;
        const runtimeRoot = ephemeral ? this.path.join(runtime.path, "nomad") : this.roots.stateRoot;
        const sessionProfile = normalizeSecurityProfile(this.environment.NOMAD_SESSION_PROFILE) || "UNKNOWN";
        const sessionEphemeral = this.environment.NOMAD_EPHEMERAL_ACTIVE === "1";
        const routedState = this.environment.NOMAD_RUNTIME_STATE_DIR;
        const routedLogs = this.environment.NOMAD_LOG_ROOT;
        const routeMismatch = ephemeral && (routedState !== this.path.join(runtimeRoot, "state")
            || routedLogs !== this.path.join(runtimeRoot, "log"));
        const profileMismatch = sessionProfile === "UNKNOWN" ? wantsEphemeral : sessionProfile !== profile;
        const sessionRestartRequired = profileMismatch
            || (wantsEphemeral && (!sessionEphemeral || !runtime.verified))
            || (!wantsEphemeral && sessionEphemeral) || routeMismatch;
        return {
            profile,
            configRoot: this.roots.configRoot,
            persistentStateRoot: this.roots.stateRoot,
            persistentCacheRoot: this.roots.cacheRoot,
            runtimeRoot,
            runtimeStateRoot: ephemeral ? this.path.join(runtimeRoot, "state") : this.roots.stateRoot,
            repositoryStateRoot: ephemeral
                ? this.path.join(runtimeRoot, "state", "repositories")
                : this.path.join(this.roots.stateRoot, "repositories"),
            logRoot: ephemeral ? this.path.join(runtimeRoot, "log") : this.roots.stateRoot,
            cacheRoot: ephemeral ? this.path.join(runtimeRoot, "cache") : this.roots.cacheRoot,
            temporaryRoot: ephemeral ? this.path.join(runtimeRoot, "tmp") : this.os.tmpdir(),
            ephemeral,
            volatileRuntimeVerified: runtime.verified,
            runtimeReason: runtime.reason,
            sessionProfile,
            sessionRestartRequired,
            essentialPersistent: [
                "SECURITY PROFILE", "REPOSITORY TRUST FINGERPRINTS", "APPLICATION REGISTRY",
                "USER REPOSITORIES", "USER SETTINGS"
            ]
        };
    }

    activate(profileValue) {
        const policy = this.resolve(profileValue);
        if (!policy.ephemeral) return policy;
        [policy.runtimeRoot, policy.runtimeStateRoot, policy.repositoryStateRoot, policy.logRoot,
            policy.cacheRoot, policy.temporaryRoot]
            .forEach(directory => this._ensurePrivateDirectory(directory, policy.runtimeRoot));
        return policy;
    }

    observe(profileValue) {
        const policy = this.resolve(profileValue);
        const restricted = policy.profile === "PUBLIC" || policy.profile === "LOCKDOWN";
        const active = restricted && !policy.sessionRestartRequired && policy.ephemeral;
        return {
            state: restricted ? (active ? "SECURE" : (policy.volatileRuntimeVerified ? "PARTIAL" : "UNAVAILABLE")) : "SECURE",
            actual: restricted ? (active ? "VOLATILE" : "PERSISTENT_SESSION") : "PERSISTENT_ALLOWED",
            detail: restricted
                ? (active ? "ELIGIBLE NOMAD STATE, LOGS, CACHES, AND REPOSITORY RUNTIME USE VERIFIED VOLATILE STORAGE"
                    : `${policy.runtimeReason}; SESSION RESTART REQUIRED`)
                : "NORMAL PROFILE ALLOWS PERSISTENT NOMAD STATE AND LOGS",
            sessionRestartRequired: policy.sessionRestartRequired,
            ephemeralActive: active,
            policy
        };
    }

    _runtime() {
        const runtimePath = this.environment.XDG_RUNTIME_DIR;
        if (typeof runtimePath !== "string" || !this.path.isAbsolute(runtimePath)) return {
            path: null, verified: false, reason: "XDG RUNTIME DIRECTORY UNAVAILABLE"
        };
        let stats;
        try {
            stats = this.fs.lstatSync(runtimePath);
            const canonical = this.fs.realpathSync(runtimePath);
            if (canonical !== runtimePath || stats.isSymbolicLink() || !stats.isDirectory()
                || (this.uid !== null && typeof stats.uid === "number" && stats.uid !== this.uid)
                || (stats.mode & 0o077) !== 0) {
                return {path: runtimePath, verified: false, reason: "XDG RUNTIME DIRECTORY METADATA IS UNSAFE"};
            }
        } catch (error) {
            return {path: runtimePath, verified: false, reason: "XDG RUNTIME DIRECTORY COULD NOT BE VERIFIED"};
        }
        let content = this.sources.mountInfo;
        if (!Object.prototype.hasOwnProperty.call(this.sources, "mountInfo")) {
            try {
                const sourceStats = this.fs.lstatSync("/proc/self/mountinfo");
                content = sourceStats.isFile() && sourceStats.size <= MAX_MOUNTINFO_BYTES
                    ? this.fs.readFileSync("/proc/self/mountinfo") : null;
            } catch (error) {
                content = null;
            }
        }
        const mount = mountForPath(parseMountInfoForPaths(content), runtimePath, this.path);
        if (!mount || !VOLATILE_FILESYSTEMS.has(String(mount.fsType).toLowerCase())) return {
            path: runtimePath, verified: false, reason: "XDG RUNTIME DIRECTORY VOLATILE BACKING NOT VERIFIED"
        };
        return {path: runtimePath, verified: true, reason: "XDG RUNTIME DIRECTORY TMPFS VERIFIED"};
    }

    _ensurePrivateDirectory(directory, boundary) {
        const relative = this.path.relative(boundary, directory);
        if (relative.startsWith("..") || this.path.isAbsolute(relative)) throw new Error("EPHEMERAL PATH REFUSED");
        this.fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        const stats = this.fs.lstatSync(directory);
        if (stats.isSymbolicLink() || !stats.isDirectory()
            || this.fs.realpathSync(directory) !== this.path.resolve(directory)
            || (this.uid !== null && typeof stats.uid === "number" && stats.uid !== this.uid)) {
            throw new Error("EPHEMERAL PATH REFUSED");
        }
        this.fs.chmodSync(directory, 0o700);
    }
}

module.exports = {
    SecurityPathPolicyService,
    VOLATILE_FILESYSTEMS,
    defaultRoots,
    mountForPath,
    parseMountInfoForPaths
};
