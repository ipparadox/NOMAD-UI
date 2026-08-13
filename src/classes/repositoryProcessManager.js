const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawn} = require("child_process");
const {
    RepositoryIsolationError,
    RepositoryIsolationService,
    buildRepositoryRunEnvironment
} = require("./repositoryIsolationService.js");

const REPOSITORY_ID_PATTERN = /^repo_[a-f0-9]{32}$/;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ACTIVE_STATES = new Set(["STARTING", "RUNNING", "STOPPING"]);
const BLOCKED_EXECUTABLES = new Set([
    "sh", "bash", "dash", "zsh", "ksh", "csh", "tcsh", "fish",
    "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh",
    "sudo", "su", "pkexec", "env"
]);

class RepositoryProcessError extends Error {
    constructor(status) {
        super(status);
        this.name = "RepositoryProcessError";
        this.status = status;
    }
}

function defaultRepositoryStateRoot(home = os.homedir()) {
    return path.join(home, ".local", "state", "nomad", "repositories");
}

function resolveTrustedExecutable(executable, opts = {}) {
    const fsModule = opts.fs || fs;
    const pathModule = opts.path || path;
    const platform = opts.platform || process.platform;
    const environment = opts.env || process.env;
    if (typeof executable !== "string" || !executable || executable.includes("\0")) return null;

    let candidates;
    if (pathModule.isAbsolute(executable)) {
        candidates = [executable];
    } else {
        if (!/^[A-Za-z0-9][A-Za-z0-9._+@%-]*$/.test(executable)) return null;
        const extensions = platform === "win32"
            ? String(environment.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
            : [""];
        candidates = [];
        String(environment.PATH || "").split(pathModule.delimiter).forEach(directory => {
            if (!directory || !pathModule.isAbsolute(directory)) return;
            if (platform === "win32" && pathModule.extname(executable)) {
                candidates.push(pathModule.join(directory, executable));
            } else {
                extensions.forEach(extension => candidates.push(pathModule.join(directory, `${executable}${extension}`)));
            }
        });
    }

    for (const candidate of candidates) {
        try {
            const canonical = fsModule.realpathSync(candidate);
            const stats = fsModule.statSync(canonical);
            if (!stats.isFile()) continue;
            if (platform !== "win32") fsModule.accessSync(canonical, (fsModule.constants || fs.constants).X_OK);
            return canonical;
        } catch (error) {}
    }
    return null;
}

function publicRepositorySnapshot(repository) {
    const source = repository && repository.public ? repository.public : {};
    return {
        id: repository.id,
        displayName: typeof source.displayName === "string" ? source.displayName.slice(0, 255) : "REPOSITORY",
        relativePath: typeof source.relativePath === "string" ? source.relativePath.slice(0, 255) : "REPOSITORY",
        branch: typeof source.branch === "string" ? source.branch.slice(0, 160) : "UNKNOWN",
        dirty: source.dirty === true,
        status: source.status === "MODIFIED" ? "MODIFIED" : "CLEAN",
        modifiedFileCount: Number.isSafeInteger(source.modifiedFileCount) && source.modifiedFileCount >= 0
            ? source.modifiedFileCount : 0,
        remoteAvailable: source.remoteAvailable === true,
        remoteProvider: ["GITHUB", "OTHER", "NONE"].includes(source.remoteProvider) ? source.remoteProvider : "NONE",
        repositoryAvailable: true
    };
}

class RepositoryProcessManager {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.spawn = opts.spawn || spawn;
        this.kill = opts.kill || process.kill.bind(process);
        this.isTargetAlive = opts.isTargetAlive || (target => {
            try {
                process.kill(target, 0);
                return true;
            } catch (error) {
                return !error || error.code !== "ESRCH";
            }
        });
        this.platform = opts.platform || process.platform;
        this.environment = opts.env || process.env;
        this.stateRoot = opts.stateRoot || defaultRepositoryStateRoot(opts.home);
        this.isolationService = opts.isolationService || new RepositoryIsolationService({
            fs: this.fs,
            path: this.path,
            platform: this.platform,
            env: this.environment,
            home: opts.home
        });
        this.getSecurityProfile = typeof opts.getSecurityProfile === "function"
            ? opts.getSecurityProfile : (() => "NORMAL");
        this.resolveExecutable = opts.resolveExecutable || (executable => resolveTrustedExecutable(executable, {
            fs: this.fs,
            path: this.path,
            platform: this.platform,
            env: this.environment
        }));
        this.now = opts.now || (() => new Date());
        this.setTimer = opts.setTimeout || setTimeout;
        this.clearTimer = opts.clearTimeout || clearTimeout;
        this.gracePeriodMs = Number.isSafeInteger(opts.gracePeriodMs) ? opts.gracePeriodMs : 5000;
        this.killWaitMs = Number.isSafeInteger(opts.killWaitMs) ? opts.killWaitMs : 1000;
        this.groupCheckMs = Number.isSafeInteger(opts.groupCheckMs) ? opts.groupCheckMs : 50;
        this.log = opts.log || (() => {});
        this.onState = typeof opts.onState === "function" ? opts.onState : (() => {});
        this.records = new Map();
    }

    start(repository, profile) {
        const existing = this.records.get(repository && repository.id);
        if (existing && ACTIVE_STATES.has(existing.state)) {
            if (!repository || existing.executionIdentity !== repository.executionIdentity) {
                throw new RepositoryProcessError("REPOSITORY IDENTITY CONFLICT");
            }
            return {ok: true, status: existing.state, duplicate: true, process: this.getStatus(existing.repositoryId)};
        }

        this._validateRepository(repository);
        this._validateProfile(profile);
        const executable = this.resolveExecutable(profile.executable);
        if (!executable || !this.path.isAbsolute(executable)) {
            throw new RepositoryProcessError("RUN EXECUTABLE NOT FOUND");
        }
        const canonicalExecutable = this.fs.realpathSync(executable);
        if (this._containsPath(repository.canonicalPath, canonicalExecutable)) {
            throw new RepositoryProcessError("RUN EXECUTABLE REFUSED");
        }

        let securityProfile;
        let isolation;
        try {
            const selectedProfile = this.getSecurityProfile();
            securityProfile = typeof selectedProfile === "string"
                ? selectedProfile : (selectedProfile && selectedProfile.profile);
            isolation = this.isolationService.prepareExecution({
                repository,
                profile,
                executable: canonicalExecutable,
                args: profile.args.slice(),
                securityProfile
            });
        } catch (error) {
            if (error instanceof RepositoryIsolationError) throw new RepositoryProcessError(error.status);
            throw new RepositoryProcessError("SECURITY PROFILE UNAVAILABLE\nEXECUTION BLOCKED");
        }
        if (!isolation || !isolation.allowed) {
            throw new RepositoryProcessError(isolation && isolation.status
                ? isolation.status : "EXECUTION BLOCKED\nISOLATION REQUIREMENT NOT MET");
        }

        let log;
        try {
            log = this._openLog(repository.id);
        } catch (error) {
            this.isolationService.cleanup(isolation);
            throw error;
        }
        const options = {
            cwd: isolation.cwd,
            env: isolation.env,
            shell: false,
            detached: this.platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", log.descriptor, log.descriptor]
        };

        let child;
        try {
            this._validateRepository(repository);
            child = this.spawn(isolation.executable, isolation.args.slice(), options);
        } catch (error) {
            this._closeDescriptor(log.descriptor);
            this.isolationService.cleanup(isolation);
            throw error instanceof RepositoryProcessError ? error : new RepositoryProcessError("REPOSITORY RUN FAILED");
        }
        this._closeDescriptor(log.descriptor);
        if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0
            || typeof child.once !== "function") {
            if (child && typeof child.once === "function") {
                child.once("error", () => this.log("warn", "REPOSITORY RUN PROCESS START FAILED"));
            }
            this.isolationService.cleanup(isolation);
            throw new RepositoryProcessError("REPOSITORY RUN FAILED");
        }

        const record = {
            repositoryId: repository.id,
            repositoryIdentity: repository.repositoryIdentity || null,
            executionIdentity: repository.executionIdentity || null,
            repositoryPath: repository.canonicalPath,
            repository: publicRepositorySnapshot(repository),
            profileId: profile.profileId,
            displayName: profile.displayName,
            executable: profile.executable,
            resolvedExecutable: canonicalExecutable,
            args: profile.args.slice(),
            securityProfile: isolation.securityProfile,
            isolationLevel: isolation.level,
            isolationBackend: isolation.backend,
            isolationReason: isolation.reason,
            isolation,
            pid: child.pid,
            processGroupId: options.detached ? child.pid : null,
            logPath: log.path,
            child,
            leaderExited: false,
            finalState: null,
            state: "STARTING",
            startedAt: this.now().toISOString(),
            exitedAt: null,
            exitCode: null,
            signal: null,
            finished: false,
            stopPromise: null,
            resolveStop: null,
            termTimer: null,
            killTimer: null,
            groupCheckTimer: null
        };
        this.records.set(record.repositoryId, record);
        child.once("error", error => this._onError(record, error));
        child.once("exit", (code, signal) => this._onExit(record, code, signal));
        record.state = "RUNNING";
        this._emitState(record);
        return {ok: true, status: "RUNNING", duplicate: false, process: this.getStatus(record.repositoryId)};
    }

    stop(repositoryId) {
        const record = this.records.get(repositoryId);
        if (!record || !ACTIVE_STATES.has(record.state)) {
            return Promise.resolve({ok: false, status: "PROCESS NOT RUNNING"});
        }
        if (record.stopPromise) return record.stopPromise;
        if (!this._validSignalRecord(record)) {
            return Promise.resolve({ok: false, status: "PROCESS IDENTITY INVALID"});
        }

        record.state = "STOPPING";
        this._emitState(record);
        record.stopPromise = new Promise(resolve => {
            record.resolveStop = resolve;
        });
        const stopPromise = record.stopPromise;
        try {
            this._signal(record, "SIGTERM");
        } catch (error) {
            if (error && error.code === "ESRCH") {
                this._finish(record, "STOPPED", null, "SIGTERM");
            } else {
                this._resolveStop(record, {ok: false, status: "PROCESS STOP FAILED", process: this.getStatus(repositoryId)});
            }
            return stopPromise;
        }

        record.termTimer = this.setTimer(() => {
            record.termTimer = null;
            if (record.state !== "STOPPING") return;
            if (!this._validSignalRecord(record)) {
                if (record.leaderExited && !this._targetAlive(record)) {
                    this._finish(record, record.finalState || "STOPPED", record.exitCode, record.signal);
                }
                return;
            }
            try {
                this._signal(record, "SIGKILL");
            } catch (error) {
                if (error && error.code === "ESRCH") {
                    this._finish(record, "STOPPED", null, "SIGKILL");
                    return;
                }
                this._resolveStop(record, {
                    ok: false,
                    status: "PROCESS STOP FAILED",
                    process: this.getStatus(repositoryId)
                });
                return;
            }
            record.killTimer = this.setTimer(() => {
                record.killTimer = null;
                if (record.state !== "STOPPING") return;
                if (record.leaderExited && !this._targetAlive(record)) {
                    this._finish(record, record.finalState || "STOPPED", record.exitCode, record.signal || "SIGKILL");
                    return;
                }
                if (record.groupCheckTimer) this.clearTimer(record.groupCheckTimer);
                record.groupCheckTimer = null;
                this._resolveStop(record, {
                    ok: false,
                    status: "PROCESS STOP TIMEOUT",
                    process: this.getStatus(repositoryId)
                });
            }, this.killWaitMs);
        }, this.gracePeriodMs);
        return stopPromise;
    }

    async stopAll() {
        const stops = [];
        this.records.forEach(record => {
            if (ACTIVE_STATES.has(record.state)) stops.push(this.stop(record.repositoryId));
        });
        return Promise.all(stops);
    }

    terminateAll() {
        this.records.forEach(record => {
            if (!ACTIVE_STATES.has(record.state) || !this._validSignalRecord(record)) return;
            record.state = "STOPPING";
            try {
                this._signal(record, "SIGTERM");
            } catch (error) {}
        });
    }

    getStatus(repositoryId) {
        const record = this.records.get(repositoryId);
        if (!record) return null;
        return {
            repositoryId: record.repositoryId,
            profileId: record.profileId,
            displayName: record.displayName,
            state: record.state,
            startedAt: record.startedAt,
            exitedAt: record.exitedAt,
            exitCode: record.exitCode,
            signal: record.signal,
            securityProfile: record.securityProfile,
            isolationLevel: record.isolationLevel,
            isolationBackend: record.isolationBackend
        };
    }

    getActiveRepositorySnapshots() {
        const snapshots = [];
        this.records.forEach(record => {
            if (!ACTIVE_STATES.has(record.state)) return;
            snapshots.push(Object.assign({}, record.repository, {repositoryAvailable: false}));
        });
        return snapshots;
    }

    getRepositorySnapshot(repositoryId) {
        const record = this.records.get(repositoryId);
        return record ? Object.assign({}, record.repository) : null;
    }

    isActive(repositoryId) {
        const record = this.records.get(repositoryId);
        return Boolean(record && ACTIVE_STATES.has(record.state));
    }

    matchesRepository(repository) {
        const record = repository && this.records.get(repository.id);
        if (!record) return true;
        return record.executionIdentity === repository.executionIdentity;
    }

    hasActive() {
        for (const record of this.records.values()) {
            if (ACTIVE_STATES.has(record.state)) return true;
        }
        return false;
    }

    getExecutionSecurityStatus() {
        try {
            const selectedProfile = this.getSecurityProfile();
            const profile = typeof selectedProfile === "string"
                ? selectedProfile : (selectedProfile && selectedProfile.profile);
            return this.isolationService.evaluatePolicy(profile);
        } catch (error) {
            return {
                allowed: false,
                securityProfile: "UNKNOWN",
                requiredLevel: "UNKNOWN",
                availableLevel: "UNAVAILABLE",
                level: "UNAVAILABLE",
                backend: "UNAVAILABLE",
                reason: "SECURITY PROFILE UNAVAILABLE",
                status: "EXECUTION BLOCKED\nSECURITY PROFILE UNAVAILABLE"
            };
        }
    }

    _validateRepository(repository) {
        if (!repository || !REPOSITORY_ID_PATTERN.test(repository.id || "")
            || typeof repository.canonicalPath !== "string" || !this.path.isAbsolute(repository.canonicalPath)) {
            throw new RepositoryProcessError("REPOSITORY NOT FOUND");
        }
        try {
            const canonical = this.fs.realpathSync(repository.canonicalPath);
            const stats = this.fs.statSync(canonical);
            if (canonical !== repository.canonicalPath || !stats.isDirectory()) throw new Error("repository changed");
            if (typeof repository.directoryDevice !== "undefined"
                && String(stats.dev) !== String(repository.directoryDevice)) throw new Error("repository changed");
            if (typeof repository.directoryInode !== "undefined"
                && String(stats.ino) !== String(repository.directoryInode)) throw new Error("repository changed");
        } catch (error) {
            throw new RepositoryProcessError("REPOSITORY NOT FOUND");
        }
    }

    _validateProfile(profile) {
        if (!profile || !PROFILE_ID_PATTERN.test(profile.profileId || "")
            || typeof profile.displayName !== "string" || !profile.displayName
            || typeof profile.executable !== "string" || !profile.executable
            || !Array.isArray(profile.args) || profile.args.length > 32
            || profile.workingDirectory !== ".") {
            throw new RepositoryProcessError("RUN PROFILE INVALID");
        }
        if (BLOCKED_EXECUTABLES.has(this.path.basename(profile.executable).toLowerCase())) {
            throw new RepositoryProcessError("RUN PROFILE INVALID");
        }
        if (profile.args.some(argument => typeof argument !== "string" || argument.length > 4096 || argument.includes("\0"))) {
            throw new RepositoryProcessError("RUN PROFILE INVALID");
        }
    }

    _openLog(repositoryId) {
        if (!REPOSITORY_ID_PATTERN.test(repositoryId || "") || !this.path.isAbsolute(this.stateRoot)) {
            throw new RepositoryProcessError("RUN LOG UNAVAILABLE");
        }
        const repositoryDirectory = this.path.join(this.stateRoot, repositoryId);
        const logPath = this.path.join(repositoryDirectory, "run.log");
        if (this.path.dirname(repositoryDirectory) !== this.stateRoot || this.path.dirname(logPath) !== repositoryDirectory) {
            throw new RepositoryProcessError("RUN LOG UNAVAILABLE");
        }
        let descriptor;
        let existingLogStats = null;
        try {
            this.fs.mkdirSync(this.stateRoot, {recursive: true, mode: 0o700});
            const rootStats = this.fs.lstatSync(this.stateRoot);
            if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("unsafe state root");
            try {
                this.fs.mkdirSync(repositoryDirectory, {mode: 0o700});
            } catch (error) {
                if (!error || error.code !== "EEXIST") throw error;
            }
            const repositoryStats = this.fs.lstatSync(repositoryDirectory);
            if (repositoryStats.isSymbolicLink() || !repositoryStats.isDirectory()) throw new Error("unsafe log directory");
            try {
                existingLogStats = this.fs.lstatSync(logPath);
                if (existingLogStats.isSymbolicLink() || !existingLogStats.isFile() || existingLogStats.nlink !== 1) {
                    throw new Error("unsafe run log");
                }
            } catch (error) {
                if (!error || error.code !== "ENOENT") throw error;
            }
            const constants = this.fs.constants || fs.constants;
            const noFollow = constants.O_NOFOLLOW || 0;
            descriptor = this.fs.openSync(
                logPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow,
                0o600
            );
            const openedLogStats = this.fs.fstatSync(descriptor);
            if (!openedLogStats.isFile() || openedLogStats.nlink !== 1
                || (existingLogStats && (openedLogStats.dev !== existingLogStats.dev
                    || openedLogStats.ino !== existingLogStats.ino))) {
                throw new Error("run log changed while opening");
            }
            this.fs.fchmodSync(descriptor, 0o600);
            const result = {descriptor, path: logPath};
            descriptor = undefined;
            return result;
        } catch (error) {
            if (typeof descriptor === "number") {
                try {
                    this.fs.closeSync(descriptor);
                } catch (closeError) {}
            }
            throw error instanceof RepositoryProcessError ? error : new RepositoryProcessError("RUN LOG UNAVAILABLE");
        }
    }

    _containsPath(parent, candidate) {
        const relative = this.path.relative(parent, candidate);
        return relative === "" || (!relative.startsWith("..") && !this.path.isAbsolute(relative));
    }

    _closeDescriptor(descriptor) {
        try {
            this.fs.closeSync(descriptor);
        } catch (error) {
            this.log("warn", "REPOSITORY RUN LOG DESCRIPTOR CLOSE FAILED");
        }
    }

    _validSignalRecord(record) {
        if (!record || this.records.get(record.repositoryId) !== record || record.finished) return false;
        if (record.leaderExited) return Boolean(record.processGroupId && this._targetAlive(record));
        if (!record.child || record.child.pid !== record.pid || !Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
        if (typeof record.child.exitCode !== "undefined" && record.child.exitCode !== null) return false;
        return ACTIVE_STATES.has(record.state);
    }

    _signal(record, signal) {
        if (!this._validSignalRecord(record)) {
            const error = new Error("managed process identity changed");
            error.code = "ESRCH";
            throw error;
        }
        if (record.isolation && record.isolation.controller) {
            if (!this.isolationService.signal(record.isolation.controller, signal)) {
                const error = new Error("isolation controller refused signal");
                error.code = "EIO";
                throw error;
            }
            return;
        }
        const target = record.processGroupId ? -record.processGroupId : record.pid;
        this.kill(target, signal);
    }

    _targetAlive(record) {
        const target = record.processGroupId ? -record.processGroupId : record.pid;
        try {
            return this.isTargetAlive(target) === true;
        } catch (error) {
            return true;
        }
    }

    _onError(record, error) {
        if (record.finished) return;
        this.log("warn", "REPOSITORY RUN PROCESS ERROR");
        this._finish(record, record.state === "STOPPING" ? "STOPPED" : "FAILED", null, null);
    }

    _onExit(record, code, signal) {
        if (record.finished) return;
        const stopped = record.state === "STOPPING" || (code === 0 && !signal);
        record.leaderExited = true;
        record.exitCode = Number.isInteger(code) ? code : null;
        record.signal = signal || null;
        record.finalState = stopped ? "STOPPED" : "FAILED";
        if (record.processGroupId && this._targetAlive(record)) {
            this._scheduleGroupCheck(record);
            if (record.state !== "STOPPING") this.stop(record.repositoryId);
            return;
        }
        this._finish(record, record.finalState, record.exitCode, record.signal);
    }

    _finish(record, state, code, signal) {
        record.finished = true;
        record.state = state;
        record.exitedAt = this.now().toISOString();
        record.exitCode = code;
        record.signal = signal;
        if (record.termTimer) this.clearTimer(record.termTimer);
        if (record.killTimer) this.clearTimer(record.killTimer);
        if (record.groupCheckTimer) this.clearTimer(record.groupCheckTimer);
        record.termTimer = null;
        record.killTimer = null;
        record.groupCheckTimer = null;
        this.isolationService.cleanup(record.isolation);
        this._emitState(record);
        this._resolveStop(record, {ok: true, status: state, process: this.getStatus(record.repositoryId)});
    }

    _emitState(record) {
        try {
            this.onState(this.getStatus(record.repositoryId));
        } catch (error) {}
    }

    _scheduleGroupCheck(record) {
        if (record.groupCheckTimer || record.finished) return;
        record.groupCheckTimer = this.setTimer(() => {
            record.groupCheckTimer = null;
            if (record.finished || !record.leaderExited) return;
            if (!this._targetAlive(record)) {
                this._finish(record, record.finalState || "STOPPED", record.exitCode, record.signal);
                return;
            }
            this._scheduleGroupCheck(record);
        }, this.groupCheckMs);
    }

    _resolveStop(record, result) {
        const resolve = record.resolveStop;
        record.resolveStop = null;
        record.stopPromise = null;
        if (resolve) resolve(result);
    }
}

module.exports = {
    ACTIVE_STATES,
    RepositoryProcessError,
    RepositoryProcessManager,
    buildRepositoryRunEnvironment,
    defaultRepositoryStateRoot,
    resolveTrustedExecutable
};
