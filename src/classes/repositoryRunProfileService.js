const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPOSITORY_ID_PATTERN = /^repo_[a-f0-9]{32}$/;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_TRUST_STORE_BYTES = 1024 * 1024;
const MAX_TRUSTED_PROFILES = 512;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_ARGS = 32;
const MAX_ARGUMENT_LENGTH = 4096;
const TRUST_STORE_ROOT_KEYS = new Set(["version", "profiles"]);
const TRUSTED_PROFILE_KEYS = new Set([
    "repositoryId", "repositoryIdentity", "profileId", "displayName", "executable", "args",
    "workingDirectory", "port", "browserBehavior", "trustMode", "source", "sourceFingerprint",
    "profileFingerprint", "approvedAt"
]);
const TRUSTED_SOURCE_KEYS = new Set(["kind", "reference"]);

class RepositoryRunError extends Error {
    constructor(status) {
        super(status);
        this.name = "RepositoryRunError";
        this.status = status;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function containsControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}

function fingerprint(value) {
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function defaultRepositoryTrustPath(home = os.homedir()) {
    return path.join(home, ".config", "nomad", "repository-runs.json");
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function validString(value, maximum, pattern = null) {
    return typeof value === "string" && value.length > 0 && value.length <= maximum
        && !containsControlCharacters(value) && (!pattern || pattern.test(value));
}

function normalizeArgs(value) {
    if (!Array.isArray(value) || value.length > MAX_ARGS) throw new Error("profile args are invalid");
    return value.map(argument => {
        if (typeof argument !== "string" || argument.length > MAX_ARGUMENT_LENGTH || argument.includes("\0")) {
            throw new Error("profile args are invalid");
        }
        return argument;
    });
}

function validateTrustedProfile(value) {
    if (!isPlainObject(value) || Object.keys(value).some(key => !TRUSTED_PROFILE_KEYS.has(key))) {
        throw new Error("trusted profile is invalid");
    }
    if (!REPOSITORY_ID_PATTERN.test(value.repositoryId || "")) throw new Error("repository ID is invalid");
    if (!FINGERPRINT_PATTERN.test(value.repositoryIdentity || "")) throw new Error("repository identity is invalid");
    if (!PROFILE_ID_PATTERN.test(value.profileId || "")) throw new Error("profile ID is invalid");
    if (!validString(value.displayName, 64)) throw new Error("profile display name is invalid");
    if (!validString(value.executable, 512, /^[A-Za-z0-9][A-Za-z0-9._+@%/-]*$/)) {
        throw new Error("profile executable is invalid");
    }
    const args = normalizeArgs(value.args);
    if (value.workingDirectory !== ".") throw new Error("profile working directory is invalid");
    if (value.port !== null && (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535)) {
        throw new Error("profile port is invalid");
    }
    if (!["none", "localhost"].includes(value.browserBehavior)) throw new Error("profile browser behavior is invalid");
    if (value.trustMode !== "TRUST_PROFILE") throw new Error("profile trust mode is invalid");
    if (!isPlainObject(value.source) || Object.keys(value.source).some(key => !TRUSTED_SOURCE_KEYS.has(key))) {
        throw new Error("profile source is invalid");
    }
    if (!validString(value.source.kind, 64, /^[a-z][a-z0-9-]*$/)
        || !validString(value.source.reference, 255)) {
        throw new Error("profile source is invalid");
    }
    if (!FINGERPRINT_PATTERN.test(value.sourceFingerprint || "")
        || !FINGERPRINT_PATTERN.test(value.profileFingerprint || "")) {
        throw new Error("profile fingerprint is invalid");
    }
    if (typeof value.approvedAt !== "string" || !Number.isFinite(Date.parse(value.approvedAt))) {
        throw new Error("profile approval time is invalid");
    }
    return {
        repositoryId: value.repositoryId,
        repositoryIdentity: value.repositoryIdentity,
        profileId: value.profileId,
        displayName: value.displayName,
        executable: value.executable,
        args,
        workingDirectory: ".",
        port: value.port,
        browserBehavior: value.browserBehavior,
        trustMode: "TRUST_PROFILE",
        source: {kind: value.source.kind, reference: value.source.reference},
        sourceFingerprint: value.sourceFingerprint,
        profileFingerprint: value.profileFingerprint,
        approvedAt: new Date(value.approvedAt).toISOString()
    };
}

function parseRepositoryTrustContent(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TRUST_STORE_BYTES) {
        throw new Error("repository run trust store is too large");
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        throw new Error("repository run trust store is not valid JSON");
    }
    if (!isPlainObject(parsed) || Object.keys(parsed).some(key => !TRUST_STORE_ROOT_KEYS.has(key))
        || parsed.version !== 1 || !Array.isArray(parsed.profiles)
        || parsed.profiles.length > MAX_TRUSTED_PROFILES) {
        throw new Error("repository run trust store root is invalid");
    }
    const seen = new Set();
    const profiles = parsed.profiles.map(validateTrustedProfile);
    profiles.forEach(profile => {
        const key = `${profile.repositoryId}\0${profile.profileId}`;
        if (seen.has(key)) throw new Error("repository run trust store contains duplicate profiles");
        seen.add(key);
    });
    return profiles;
}

class RepositoryRunTrustStore {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.trustStorePath = opts.trustStorePath || defaultRepositoryTrustPath(opts.home);
        this.randomBytes = opts.randomBytes || crypto.randomBytes;
    }

    read() {
        const file = this._readFile();
        if (!file) return {profiles: [], snapshot: null};
        try {
            return {profiles: parseRepositoryTrustContent(file.content), snapshot: file.snapshot};
        } catch (error) {
            throw new RepositoryRunError("RUN TRUST STORE INVALID");
        }
    }

    upsert(profile) {
        let current;
        try {
            current = this.read();
        } catch (error) {
            throw error instanceof RepositoryRunError ? error : new RepositoryRunError("RUN TRUST STORE REFUSED");
        }
        const normalized = validateTrustedProfile(profile);
        const profiles = current.profiles.filter(item => (
            item.repositoryId !== normalized.repositoryId || item.profileId !== normalized.profileId
        ));
        profiles.push(normalized);
        profiles.sort((left, right) => (
            left.repositoryId.localeCompare(right.repositoryId) || left.profileId.localeCompare(right.profileId)
        ));
        this._atomicWrite(profiles, current.snapshot);
        return clone(normalized);
    }

    _readFile() {
        let stats;
        try {
            stats = this.fs.lstatSync(this.trustStorePath);
        } catch (error) {
            if (error && error.code === "ENOENT") return null;
            throw new RepositoryRunError("RUN TRUST STORE REFUSED");
        }
        if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_TRUST_STORE_BYTES) {
            throw new RepositoryRunError("RUN TRUST STORE REFUSED");
        }

        const constants = this.fs.constants || fs.constants;
        const noFollow = constants.O_NOFOLLOW || 0;
        let descriptor;
        try {
            descriptor = this.fs.openSync(this.trustStorePath, constants.O_RDONLY | noFollow);
            const openedStats = this.fs.fstatSync(descriptor);
            if (!openedStats.isFile() || openedStats.dev !== stats.dev || openedStats.ino !== stats.ino
                || openedStats.size > MAX_TRUST_STORE_BYTES) {
                throw new Error("repository run trust store changed while opening");
            }
            const buffer = Buffer.alloc(openedStats.size);
            let offset = 0;
            while (offset < buffer.length) {
                const bytesRead = this.fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
                if (!bytesRead) break;
                offset += bytesRead;
            }
            return {content: buffer.subarray(0, offset).toString("utf8"), snapshot: this._snapshot(openedStats)};
        } catch (error) {
            throw new RepositoryRunError("RUN TRUST STORE REFUSED");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }

    _atomicWrite(profiles, expectedSnapshot) {
        const document = `${JSON.stringify({version: 1, profiles}, null, 4)}\n`;
        try {
            parseRepositoryTrustContent(document);
        } catch (error) {
            throw new RepositoryRunError("RUN TRUST STORE REFUSED");
        }

        const directory = this.path.dirname(this.trustStorePath);
        let descriptor;
        let temporaryPath;
        try {
            this.fs.mkdirSync(directory, {recursive: true, mode: 0o700});
            const directoryStats = this.fs.lstatSync(directory);
            if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
                throw new Error("unsafe repository run trust directory");
            }
            this._assertTargetUnchanged(expectedSnapshot);
            temporaryPath = this.path.join(
                directory,
                `.repository-runs.json.tmp-${process.pid}-${this.randomBytes(12).toString("hex")}`
            );
            const constants = this.fs.constants || fs.constants;
            const noFollow = constants.O_NOFOLLOW || 0;
            descriptor = this.fs.openSync(
                temporaryPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
                0o600
            );
            this.fs.fchmodSync(descriptor, 0o600);
            this.fs.writeFileSync(descriptor, document, {encoding: "utf8"});
            this.fs.fsyncSync(descriptor);
            this.fs.closeSync(descriptor);
            descriptor = undefined;
            this._assertTargetUnchanged(expectedSnapshot);
            this.fs.renameSync(temporaryPath, this.trustStorePath);
            temporaryPath = null;
            this._syncDirectory(directory);
        } catch (error) {
            throw error instanceof RepositoryRunError ? error : new RepositoryRunError("RUN TRUST STORE REFUSED");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
            if (temporaryPath) {
                try {
                    this.fs.unlinkSync(temporaryPath);
                } catch (error) {}
            }
        }
    }

    _assertTargetUnchanged(expectedSnapshot) {
        let current;
        try {
            const stats = this.fs.lstatSync(this.trustStorePath);
            if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("unsafe repository run trust store");
            current = this._snapshot(stats);
        } catch (error) {
            if (error && error.code === "ENOENT") current = null;
            else throw error;
        }
        if (!this._sameSnapshot(current, expectedSnapshot)) {
            throw new RepositoryRunError("RUN TRUST STORE REFUSED");
        }
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

class RepositoryRunProfileService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.now = opts.now || (() => new Date());
        this.trustStore = opts.trustStore || new RepositoryRunTrustStore(opts);
    }

    discover(repository) {
        if (!repository || !REPOSITORY_ID_PATTERN.test(repository.id || "")
            || typeof repository.canonicalPath !== "string" || !this.path.isAbsolute(repository.canonicalPath)) {
            return [];
        }
        const candidates = [];
        const packageContent = this._readTopLevelFile(repository.canonicalPath, "package.json", MAX_PACKAGE_JSON_BYTES);
        if (packageContent !== null) {
            let manifest;
            try {
                manifest = JSON.parse(packageContent);
            } catch (error) {
                manifest = null;
            }
            const scripts = isPlainObject(manifest) && isPlainObject(manifest.scripts) ? manifest.scripts : null;
            if (scripts) {
                ["dev", "start", "serve"].forEach(scriptName => {
                    if (!Object.prototype.hasOwnProperty.call(scripts, scriptName)) return;
                    const script = scripts[scriptName];
                    if (typeof script !== "string" || !script.trim() || script.length > 65536) return;
                    const lifecycle = {};
                    [`pre${scriptName}`, scriptName, `post${scriptName}`].forEach(name => {
                        if (Object.prototype.hasOwnProperty.call(scripts, name) && typeof scripts[name] === "string") {
                            lifecycle[name] = scripts[name];
                        }
                    });
                    candidates.push(this._candidate({
                        profileId: `npm-${scriptName}`,
                        displayName: `NPM ${scriptName.toUpperCase()}`,
                        commandLabel: `npm run ${scriptName}`,
                        executable: "npm",
                        args: ["run", scriptName],
                        source: {kind: "package-json-script", reference: scriptName},
                        sourceDefinition: {kind: "package-json-script", scriptName, lifecycle}
                    }));
                });
            }
        }

        [["main.py", "python-main", "PYTHON MAIN"], ["app.py", "python-app", "PYTHON APP"]].forEach(spec => {
            if (!this._isSafeTopLevelFile(repository.canonicalPath, spec[0])) return;
            candidates.push(this._candidate({
                profileId: spec[1],
                displayName: spec[2],
                commandLabel: `python3 ${spec[0]}`,
                executable: "python3",
                args: [spec[0]],
                source: {kind: "python-entrypoint", reference: spec[0]},
                sourceDefinition: {kind: "python-entrypoint", relativePath: spec[0]}
            }));
        });
        return candidates;
    }

    inspect(repository) {
        const candidates = this.discover(repository);
        let profiles = [];
        let trustStoreStatus = null;
        try {
            profiles = this.trustStore.read().profiles;
        } catch (error) {
            trustStoreStatus = error instanceof RepositoryRunError ? error.status : "RUN TRUST STORE REFUSED";
        }
        const inspected = candidates.map(candidate => {
            const trusted = profiles.find(profile => (
                profile.repositoryId === repository.id && profile.profileId === candidate.profileId
            ));
            let authorizationState = "UNAPPROVED";
            if (trusted) {
                authorizationState = this._matches(repository, candidate, trusted) ? "APPROVED" : "CHANGED";
            }
            return Object.assign({}, candidate, {authorizationState});
        });
        return {candidates: inspected, trustStoreStatus};
    }

    approve(repository, candidate) {
        if (!repository || !FINGERPRINT_PATTERN.test(repository.repositoryIdentity || "")) {
            throw new RepositoryRunError("REPOSITORY IDENTITY UNAVAILABLE");
        }
        const trusted = {
            repositoryId: repository.id,
            repositoryIdentity: repository.repositoryIdentity,
            profileId: candidate.profileId,
            displayName: candidate.displayName,
            executable: candidate.executable,
            args: candidate.args.slice(),
            workingDirectory: candidate.workingDirectory,
            port: candidate.port,
            browserBehavior: candidate.browserBehavior,
            trustMode: "TRUST_PROFILE",
            source: clone(candidate.source),
            sourceFingerprint: candidate.sourceFingerprint,
            profileFingerprint: candidate.profileFingerprint,
            approvedAt: this.now().toISOString()
        };
        return this.trustStore.upsert(trusted);
    }

    publicCandidate(candidate) {
        return {
            profileId: candidate.profileId,
            displayName: candidate.displayName,
            commandLabel: candidate.commandLabel,
            executable: candidate.executable,
            args: candidate.args.slice(),
            port: candidate.port,
            browserBehavior: candidate.browserBehavior,
            authorizationState: candidate.authorizationState || "UNAPPROVED"
        };
    }

    _matches(repository, candidate, trusted) {
        if (!repository.repositoryIdentity || trusted.repositoryIdentity !== repository.repositoryIdentity) return false;
        return trusted.profileFingerprint === candidate.profileFingerprint
            && trusted.sourceFingerprint === candidate.sourceFingerprint
            && trusted.displayName === candidate.displayName
            && trusted.executable === candidate.executable
            && trusted.workingDirectory === candidate.workingDirectory
            && trusted.port === candidate.port
            && trusted.browserBehavior === candidate.browserBehavior
            && JSON.stringify(trusted.args) === JSON.stringify(candidate.args)
            && JSON.stringify(trusted.source) === JSON.stringify(candidate.source);
    }

    _candidate(spec) {
        const sourceFingerprint = fingerprint(spec.sourceDefinition);
        const candidate = {
            profileId: spec.profileId,
            displayName: spec.displayName,
            commandLabel: spec.commandLabel,
            executable: spec.executable,
            args: normalizeArgs(spec.args),
            workingDirectory: ".",
            port: null,
            browserBehavior: "none",
            trustMode: "EXPLICIT",
            source: clone(spec.source),
            sourceFingerprint
        };
        candidate.profileFingerprint = fingerprint({
            version: 1,
            profileId: candidate.profileId,
            executable: candidate.executable,
            args: candidate.args,
            workingDirectory: candidate.workingDirectory,
            port: candidate.port,
            browserBehavior: candidate.browserBehavior,
            source: candidate.source,
            sourceFingerprint: candidate.sourceFingerprint
        });
        return candidate;
    }

    _isSafeTopLevelFile(repositoryPath, fileName) {
        const candidatePath = this.path.join(repositoryPath, fileName);
        if (this.path.dirname(candidatePath) !== repositoryPath) return false;
        try {
            const stats = this.fs.lstatSync(candidatePath);
            return stats.isFile() && !stats.isSymbolicLink() && this.fs.realpathSync(candidatePath) === candidatePath;
        } catch (error) {
            return false;
        }
    }

    _readTopLevelFile(repositoryPath, fileName, maximumBytes) {
        if (!this._isSafeTopLevelFile(repositoryPath, fileName)) return null;
        const candidatePath = this.path.join(repositoryPath, fileName);
        const constants = this.fs.constants || fs.constants;
        const noFollow = constants.O_NOFOLLOW || 0;
        let descriptor;
        try {
            const before = this.fs.lstatSync(candidatePath);
            descriptor = this.fs.openSync(candidatePath, constants.O_RDONLY | noFollow);
            const opened = this.fs.fstatSync(descriptor);
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
                || opened.size > maximumBytes) return null;
            const buffer = Buffer.alloc(opened.size);
            let offset = 0;
            while (offset < buffer.length) {
                const bytesRead = this.fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
                if (!bytesRead) break;
                offset += bytesRead;
            }
            return buffer.subarray(0, offset).toString("utf8");
        } catch (error) {
            return null;
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }
}

module.exports = {
    PROFILE_ID_PATTERN,
    RepositoryRunError,
    RepositoryRunProfileService,
    RepositoryRunTrustStore,
    defaultRepositoryTrustPath,
    fingerprint,
    parseRepositoryTrustContent,
    validateTrustedProfile
};
