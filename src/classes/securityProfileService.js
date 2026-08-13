const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SECURITY_PROFILE_IDS = Object.freeze(["NORMAL", "PUBLIC", "LOCKDOWN"]);
const SECURITY_PROFILE_PATTERN = /^(NORMAL|PUBLIC|LOCKDOWN)$/;
const MAX_PROFILE_STORE_BYTES = 64 * 1024;
const PROFILE_STORE_KEYS = new Set(["version", "profile", "updatedAt"]);

const SECURITY_PROFILES = Object.freeze({
    NORMAL: Object.freeze({
        id: "NORMAL",
        label: "NORMAL",
        description: "PERSISTENT NOMAD USE WITH CONTROLLED REPOSITORY EXECUTION",
        repositoryExecution: "CONTROLLED",
        minimumRepositoryIsolation: "NONE",
        hostStorageAccess: "OS_POLICY",
        automount: "OS_POLICY",
        temporaryData: "PERSISTENCE_ALLOWED",
        statePersistence: "ALLOWED",
        applicationExecution: "CONTROLLED_REGISTRY",
        privilegeEscalation: "USER_CONTROLLED",
        networkPolicy: "OS_POLICY",
        debugExposure: "PRODUCTION_RESTRICTED",
        secrets: "MINIMIZED"
    }),
    PUBLIC: Object.freeze({
        id: "PUBLIC",
        label: "PUBLIC",
        description: "PUBLIC-HARDWARE POLICY WITH FAIL-CLOSED REPOSITORY ISOLATION",
        repositoryExecution: "CONTROLLED",
        minimumRepositoryIsolation: "PARTIAL",
        hostStorageAccess: "BLOCKED",
        automount: "DISABLED",
        temporaryData: "EPHEMERAL_PREFERRED",
        statePersistence: "EXPLICIT_ONLY",
        applicationExecution: "CONTROLLED_REGISTRY",
        privilegeEscalation: "NOT_EXPOSED",
        networkPolicy: "OS_POLICY",
        debugExposure: "PRODUCTION_RESTRICTED",
        secrets: "CLOSED_BY_DEFAULT"
    }),
    LOCKDOWN: Object.freeze({
        id: "LOCKDOWN",
        label: "LOCKDOWN",
        description: "RESTRICTIVE POLICY WITH REPOSITORY EXECUTION DISABLED",
        repositoryExecution: "DISABLED",
        minimumRepositoryIsolation: "STRONG",
        hostStorageAccess: "BLOCKED",
        automount: "DISABLED",
        temporaryData: "EPHEMERAL_REQUIRED",
        statePersistence: "EPHEMERAL",
        applicationExecution: "BUILTIN_ONLY",
        privilegeEscalation: "NOT_EXPOSED",
        networkPolicy: "RESTRICTED",
        debugExposure: "DISABLED",
        secrets: "CLOSED"
    })
});

class SecurityProfileError extends Error {
    constructor(status) {
        super(status);
        this.name = "SecurityProfileError";
        this.status = status;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeSecurityProfile(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toUpperCase();
    return SECURITY_PROFILE_PATTERN.test(normalized) ? normalized : null;
}

function defaultSecurityProfilePath(home = os.homedir(), environment = process.env) {
    const configRoot = environment && typeof environment.XDG_CONFIG_HOME === "string"
        && path.isAbsolute(environment.XDG_CONFIG_HOME) ? environment.XDG_CONFIG_HOME : path.join(home, ".config");
    return path.join(configRoot, "nomad", "security.json");
}

function parseSecurityProfileContent(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_PROFILE_STORE_BYTES) {
        throw new Error("security profile store is too large");
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        throw new Error("security profile store is not valid JSON");
    }
    if (!isPlainObject(parsed) || Object.keys(parsed).some(key => !PROFILE_STORE_KEYS.has(key))
        || parsed.version !== 1 || !normalizeSecurityProfile(parsed.profile)
        || parsed.profile !== parsed.profile.toUpperCase()
        || typeof parsed.updatedAt !== "string" || !Number.isFinite(Date.parse(parsed.updatedAt))) {
        throw new Error("security profile store is invalid");
    }
    return {
        version: 1,
        profile: parsed.profile,
        updatedAt: new Date(parsed.updatedAt).toISOString()
    };
}

class SecurityProfileStore {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.storePath = opts.storePath || defaultSecurityProfilePath(opts.home, opts.env);
        this.randomBytes = opts.randomBytes || crypto.randomBytes;
        this.now = opts.now || (() => new Date());
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
    }

    read() {
        if (typeof this.storePath !== "string" || !this.path.isAbsolute(this.storePath)) {
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }
        const file = this._readFile();
        if (!file) return null;
        try {
            return Object.assign(parseSecurityProfileContent(file.content), {snapshot: file.snapshot});
        } catch (error) {
            throw new SecurityProfileError("SECURITY PROFILE STORE INVALID");
        }
    }

    write(profileValue) {
        if (typeof this.storePath !== "string" || !this.path.isAbsolute(this.storePath)) {
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }
        const profile = normalizeSecurityProfile(profileValue);
        if (!profile) throw new SecurityProfileError("SECURITY PROFILE INVALID");
        let current;
        try {
            current = this.read();
        } catch (error) {
            throw error instanceof SecurityProfileError
                ? error : new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }
        const document = {
            version: 1,
            profile,
            updatedAt: this.now().toISOString()
        };
        this._atomicWrite(document, current ? current.snapshot : null);
        return clone(document);
    }

    _readFile() {
        let stats;
        try {
            stats = this.fs.lstatSync(this.storePath);
        } catch (error) {
            if (error && error.code === "ENOENT") return null;
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
            || stats.size > MAX_PROFILE_STORE_BYTES || !this._ownedByUser(stats)
            || (stats.mode & 0o077) !== 0) {
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }

        const constants = this.fs.constants || fs.constants;
        const noFollow = constants.O_NOFOLLOW || 0;
        let descriptor;
        try {
            descriptor = this.fs.openSync(this.storePath, constants.O_RDONLY | noFollow);
            const openedStats = this.fs.fstatSync(descriptor);
            if (!openedStats.isFile() || openedStats.nlink !== 1 || !this._ownedByUser(openedStats)
                || openedStats.dev !== stats.dev || openedStats.ino !== stats.ino
                || openedStats.size > MAX_PROFILE_STORE_BYTES || (openedStats.mode & 0o077) !== 0) {
                throw new Error("security profile store changed while opening");
            }
            const buffer = Buffer.alloc(openedStats.size);
            let offset = 0;
            while (offset < buffer.length) {
                const bytesRead = this.fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
                if (!bytesRead) break;
                offset += bytesRead;
            }
            return {
                content: buffer.subarray(0, offset).toString("utf8"),
                snapshot: this._snapshot(openedStats)
            };
        } catch (error) {
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }

    _atomicWrite(document, expectedSnapshot) {
        const content = `${JSON.stringify(document, null, 4)}\n`;
        try {
            parseSecurityProfileContent(content);
        } catch (error) {
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }

        const directory = this.path.dirname(this.storePath);
        let descriptor;
        let temporaryPath;
        try {
            this._ensureSafeDirectory(directory);
            this._assertTargetUnchanged(expectedSnapshot);
            temporaryPath = this.path.join(
                directory,
                `.${this.path.basename(this.storePath)}.tmp-${process.pid}-${this.randomBytes(12).toString("hex")}`
            );
            const constants = this.fs.constants || fs.constants;
            const noFollow = constants.O_NOFOLLOW || 0;
            descriptor = this.fs.openSync(
                temporaryPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
                0o600
            );
            this.fs.fchmodSync(descriptor, 0o600);
            this.fs.writeFileSync(descriptor, content, {encoding: "utf8"});
            this.fs.fsyncSync(descriptor);
            this.fs.closeSync(descriptor);
            descriptor = undefined;
            this._assertTargetUnchanged(expectedSnapshot);
            this.fs.renameSync(temporaryPath, this.storePath);
            temporaryPath = null;
            this._syncDirectory(directory);
        } catch (error) {
            throw error instanceof SecurityProfileError
                ? error : new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
            if (temporaryPath) {
                try {
                    this.fs.unlinkSync(temporaryPath);
                } catch (error) {}
            }
        }
    }

    _ensureSafeDirectory(directory) {
        const parent = this.path.dirname(directory);
        try {
            this.fs.mkdirSync(parent, {recursive: true, mode: 0o700});
            const parentStats = this.fs.lstatSync(parent);
            if (parentStats.isSymbolicLink() || !parentStats.isDirectory()
                || !this._ownedByUser(parentStats) || (parentStats.mode & 0o022) !== 0) {
                throw new Error("unsafe security configuration parent");
            }
            try {
                this.fs.mkdirSync(directory, {mode: 0o700});
            } catch (error) {
                if (!error || error.code !== "EEXIST") throw error;
            }
            const stats = this.fs.lstatSync(directory);
            if (stats.isSymbolicLink() || !stats.isDirectory()
                || !this._ownedByUser(stats) || (stats.mode & 0o022) !== 0) {
                throw new Error("unsafe security configuration directory");
            }
        } catch (error) {
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }
    }

    _assertTargetUnchanged(expectedSnapshot) {
        let current;
        try {
            const stats = this.fs.lstatSync(this.storePath);
            if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1
                || !this._ownedByUser(stats) || (stats.mode & 0o077) !== 0) {
                throw new Error("unsafe security profile store");
            }
            current = this._snapshot(stats);
        } catch (error) {
            if (error && error.code === "ENOENT") current = null;
            else throw error;
        }
        if (!this._sameSnapshot(current, expectedSnapshot)) {
            throw new SecurityProfileError("SECURITY PROFILE STORE REFUSED");
        }
    }

    _ownedByUser(stats) {
        return this.uid === null || typeof stats.uid !== "number" || stats.uid === this.uid;
    }

    _snapshot(stats) {
        return {dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs};
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
            descriptor = this.fs.openSync(directory, constants.O_RDONLY);
            this.fs.fsyncSync(descriptor);
        } catch (error) {
            if (!error || !["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }
}

class SecurityProfileService {
    constructor(opts = {}) {
        this.store = opts.store || new SecurityProfileStore(opts);
    }

    get() {
        const stored = this.store.read();
        const profile = stored ? stored.profile : "NORMAL";
        return {
            profile,
            source: stored ? "CONFIG" : "DEFAULT",
            updatedAt: stored ? stored.updatedAt : null,
            policy: clone(SECURITY_PROFILES[profile])
        };
    }

    set(profileValue) {
        const stored = this.store.write(profileValue);
        return {
            profile: stored.profile,
            source: "CONFIG",
            updatedAt: stored.updatedAt,
            policy: clone(SECURITY_PROFILES[stored.profile])
        };
    }

    list() {
        return SECURITY_PROFILE_IDS.map(profile => clone(SECURITY_PROFILES[profile]));
    }
}

module.exports = {
    MAX_PROFILE_STORE_BYTES,
    SECURITY_PROFILE_IDS,
    SECURITY_PROFILES,
    SecurityProfileError,
    SecurityProfileService,
    SecurityProfileStore,
    defaultSecurityProfilePath,
    normalizeSecurityProfile,
    parseSecurityProfileContent
};
