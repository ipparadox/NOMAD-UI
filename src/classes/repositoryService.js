const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    RepositoryGitError,
    RepositoryGitExecutor,
    RepositoryGitService,
    isNormalizedGithubUrl,
    normalizeGithubRemote
} = require("./repositoryGitService.js");
const {
    PROFILE_ID_PATTERN,
    RepositoryRunError,
    RepositoryRunProfileService
} = require("./repositoryRunProfileService.js");
const {
    ACTIVE_STATES,
    RepositoryProcessError,
    RepositoryProcessManager
} = require("./repositoryProcessManager.js");

const REPOSITORY_ID_PATTERN = /^repo_[a-f0-9]{32}$/;
const ACTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FILTER_CONFIG_KEYS = 128;

const REPOSITORY_ACTIONS = Object.freeze([
    Object.freeze({id: "code", label: "CODE"}),
    Object.freeze({id: "terminal", label: "TERMINAL"}),
    Object.freeze({id: "info", label: "INFO"}),
    Object.freeze({id: "github", label: "GITHUB"}),
    Object.freeze({id: "run", label: "RUN"}),
    Object.freeze({id: "stop", label: "STOP"}),
    Object.freeze({id: "pull", label: "PULL"})
]);

class RepositoryError extends Error {
    constructor(status) {
        super(status);
        this.name = "RepositoryError";
        this.status = status;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function sanitizeText(value, fallback = "UNKNOWN", maxLength = 255) {
    if (typeof value !== "string") return fallback;
    const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, "?").trim().slice(0, maxLength);
    return sanitized || fallback;
}

function expandHome(value, home = os.homedir()) {
    if (value === "~") return home;
    if (typeof value === "string" && (value.startsWith("~/") || value.startsWith("~\\"))) {
        return path.join(home, value.slice(2));
    }
    return value;
}

function normalizeRepositoryId(value) {
    return typeof value === "string" && REPOSITORY_ID_PATTERN.test(value) ? value : null;
}

function repositoryId(root, childName) {
    const digest = crypto.createHash("sha256").update(root).update("\0").update(childName).digest("hex");
    return `repo_${digest.slice(0, 32)}`;
}

function terminalCommand(repositoryPath, shell, pathModule = path) {
    if (typeof repositoryPath !== "string" || !pathModule.isAbsolute(repositoryPath)) {
        throw new RepositoryError("REPOSITORY NOT FOUND");
    }
    const shellName = pathModule.basename(shell || "").toLowerCase();
    const literalPath = `'${repositoryPath.replace(/'/g, "''")}'`;
    if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(shellName)) {
        return `Set-Location -LiteralPath ${literalPath}`;
    }
    const posixPath = `'${repositoryPath.replace(/'/g, `'\\''`)}'`;
    return `cd -- ${posixPath}`;
}

function normalizeGeometry(value) {
    if (!isPlainObject(value)) return null;
    if (Object.keys(value).some(key => !["x", "y", "width", "height"].includes(key))) return null;
    if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) return null;
    if (Math.abs(value.x) > 100000 || Math.abs(value.y) > 100000) return null;
    if (value.width <= 0 || value.height <= 0 || value.width > 100000 || value.height > 100000) return null;
    return {x: value.x, y: value.y, width: value.width, height: value.height};
}

class RepositoryService {
    constructor(opts = {}) {
        this.home = opts.home || os.homedir();
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.log = opts.log || (() => {});
        this.gitExecutor = opts.gitExecutor || new RepositoryGitExecutor({
            fs: this.fs,
            path: this.path,
            execFile: opts.execFile,
            execFileSync: opts.execFileSync,
            spawn: opts.spawn,
            env: opts.env,
            gitExecutable: opts.gitExecutable,
            resolveGitExecutable: opts.resolveGitExecutable,
            log: this.log
        });
        this.gitExecutable = this.gitExecutor.gitExecutable;
        this.repositories = new Map();
        this.canonicalRoot = null;
        this.setRepositoryRoot(opts.repositoryRoot);
    }

    setRepositoryRoot(repositoryRoot) {
        if (typeof repositoryRoot !== "string" || !repositoryRoot.trim()) {
            throw new TypeError("Repository service requires repositoryRoot");
        }
        if (this.repositoryRoot === repositoryRoot) return false;
        this.repositoryRoot = repositoryRoot;
        this.repositories = new Map();
        this.canonicalRoot = null;
        return true;
    }

    resolveCanonicalRoot() {
        const configuredRoot = this.path.resolve(expandHome(this.repositoryRoot, this.home));
        const canonicalRoot = this.fs.realpathSync(configuredRoot);
        if (!this.fs.statSync(canonicalRoot).isDirectory()) throw new RepositoryError("REPOSITORY ROOT NOT FOUND");
        return canonicalRoot;
    }

    async refresh() {
        let canonicalRoot;
        let children;
        try {
            canonicalRoot = this.resolveCanonicalRoot();
            children = this.fs.readdirSync(canonicalRoot, {withFileTypes: true});
        } catch (error) {
            this.repositories = new Map();
            this.canonicalRoot = null;
            return {status: "REPOSITORY ROOT NOT FOUND", repositories: []};
        }

        const inspected = await Promise.all(children.map(child => this._inspectChild(canonicalRoot, child.name)));
        const records = inspected.filter(Boolean);
        records.sort((left, right) => left.public.displayName.localeCompare(right.public.displayName, undefined, {sensitivity: "base"}));
        this.repositories = new Map(records.map(record => [record.id, record]));
        this.canonicalRoot = canonicalRoot;
        return {
            status: records.length ? null : "NO REPOSITORIES DETECTED",
            repositories: records.map(record => this._publicRecord(record))
        };
    }

    async resolveRepository(id, opts = {}) {
        const normalizedId = normalizeRepositoryId(id);
        const record = normalizedId && this.repositories.get(normalizedId);
        if (!record) throw new RepositoryError("REPOSITORY NOT FOUND");

        const verified = await this._verifyRecord(record);
        if (!verified) {
            this.repositories.delete(record.id);
            throw new RepositoryError("REPOSITORY NOT FOUND");
        }
        if (opts.refreshMetadata) {
            verified.public = await this._metadata(verified);
            this.repositories.set(verified.id, verified);
        }
        return verified;
    }

    _publicRecord(record) {
        return Object.assign({}, record.public);
    }

    async _inspectChild(canonicalRoot, childName) {
        if (!this._validChildName(childName)) return null;
        const candidatePath = this.path.join(canonicalRoot, childName);
        let canonicalPath;
        let repositoryStats;
        try {
            canonicalPath = this.fs.realpathSync(candidatePath);
            if (this.path.dirname(canonicalPath) !== canonicalRoot) return null;
            repositoryStats = this.fs.statSync(canonicalPath);
            if (!repositoryStats.isDirectory()) return null;
            const gitEntry = this.fs.lstatSync(this.path.join(canonicalPath, ".git"));
            if (!gitEntry.isDirectory() && !gitEntry.isFile()) return null;
        } catch (error) {
            return null;
        }

        if (await this._git(canonicalPath, ["rev-parse", "--is-inside-work-tree"], true) !== "true"
            || !await this._isCanonicalWorkTree(canonicalPath)) return null;
        const record = {
            id: repositoryId(canonicalRoot, childName),
            childName,
            canonicalPath,
            canonicalRoot,
            directoryDevice: String(repositoryStats.dev),
            directoryInode: String(repositoryStats.ino),
            executionIdentity: this._identity([
                canonicalRoot,
                canonicalPath,
                String(repositoryStats.dev),
                String(repositoryStats.ino)
            ]),
            repositoryIdentity: null,
            public: null
        };
        record.public = await this._metadata(record);
        return record;
    }

    async _verifyRecord(record) {
        let currentRoot;
        let canonicalPath;
        let repositoryStats;
        try {
            currentRoot = this.fs.realpathSync(this.path.resolve(expandHome(this.repositoryRoot, this.home)));
            if (currentRoot !== record.canonicalRoot || currentRoot !== this.canonicalRoot) return null;
            const candidatePath = this.path.join(currentRoot, record.childName);
            canonicalPath = this.fs.realpathSync(candidatePath);
            if (canonicalPath !== record.canonicalPath || this.path.dirname(canonicalPath) !== currentRoot) return null;
            repositoryStats = this.fs.statSync(canonicalPath);
            if (!repositoryStats.isDirectory()) return null;
            if (String(repositoryStats.dev) !== record.directoryDevice
                || String(repositoryStats.ino) !== record.directoryInode) return null;
            const gitEntry = this.fs.lstatSync(this.path.join(canonicalPath, ".git"));
            if (!gitEntry.isDirectory() && !gitEntry.isFile()) return null;
        } catch (error) {
            return null;
        }
        if (await this._git(canonicalPath, ["rev-parse", "--is-inside-work-tree"], true) !== "true"
            || !await this._isCanonicalWorkTree(canonicalPath)) return null;
        return record;
    }

    async _isCanonicalWorkTree(canonicalPath) {
        const topLevel = await this._git(canonicalPath, ["rev-parse", "--show-toplevel"]);
        if (!topLevel || topLevel.includes("\0")) return false;
        try {
            return this.fs.realpathSync(topLevel) === canonicalPath;
        } catch (error) {
            return false;
        }
    }

    _validChildName(childName) {
        if (typeof childName !== "string" || !childName || childName === "." || childName === "..") return false;
        if (childName.includes("\0") || childName.includes("/") || childName.includes("\\")) return false;
        return this.path.basename(childName) === childName;
    }

    async _metadata(record) {
        const filterOverridesPromise = this._filterOverrides(record.canonicalPath);
        const branchPromise = this._git(record.canonicalPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
        const detachedHeadPromise = this._git(record.canonicalPath, ["rev-parse", "--short", "HEAD"]);
        const remotesPromise = this._git(record.canonicalPath, ["remote"]);
        const originRemotePromise = this._git(
            record.canonicalPath,
            ["config", "--includes", "--null", "--get-all", "remote.origin.url"],
            false,
            {acceptExitCodeOne: true}
        );
        const upstreamPromise = this._git(
            record.canonicalPath,
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]
        );
        const remoteIdentityPromise = this._git(
            record.canonicalPath,
            ["config", "--includes", "--null", "--get-regexp", "^remote\\..*\\.url$"],
            false,
            {acceptExitCodeOne: true}
        );
        const filterOverrides = await filterOverridesPromise;
        const statusPromise = filterOverrides === null
            ? Promise.resolve(null)
            : this._git(
                record.canonicalPath,
                ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"],
                false,
                {configOverrides: filterOverrides}
            );
        const [branchName, detachedHead, statusOutput, remotesOutput, originRemoteOutput, upstreamName, remoteIdentity] = await Promise.all([
            branchPromise,
            detachedHeadPromise,
            statusPromise,
            remotesPromise,
            originRemotePromise,
            upstreamPromise,
            remoteIdentityPromise
        ]);
        record.repositoryIdentity = remoteIdentity === null ? null : this._identity([
            record.executionIdentity,
            remoteIdentity
        ]);
        const statusEntries = statusOutput === null ? null : this._statusEntryCount(statusOutput);
        const remotes = (remotesOutput || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        const originRemotes = (originRemoteOutput || "").split("\0").filter(Boolean);
        const originRemote = originRemotes.length === 1 ? originRemotes[0] : null;
        const githubUrl = normalizeGithubRemote(originRemote);
        const remoteAvailable = remotes.length > 0;
        let ahead = null;
        let behind = null;
        if (upstreamName) {
            const counts = await this._git(record.canonicalPath, [
                "rev-list", "--left-right", "--count", "HEAD...@{upstream}"
            ], true);
            const match = /^(\d+)\s+(\d+)$/.exec(counts || "");
            if (match) {
                ahead = Number(match[1]);
                behind = Number(match[2]);
            }
        }
        const branch = branchName
            ? sanitizeText(branchName, "UNKNOWN", 160)
            : (detachedHead ? `DETACHED@${sanitizeText(detachedHead, "UNKNOWN", 40)}` : "UNKNOWN");
        const displayName = sanitizeText(record.childName, "REPOSITORY");
        return {
            id: record.id,
            displayName,
            relativePath: displayName,
            branch,
            dirty: statusEntries === null || statusEntries > 0,
            status: statusEntries === 0 ? "CLEAN" : "MODIFIED",
            modifiedFileCount: statusEntries === null ? 0 : statusEntries,
            remoteAvailable,
            remoteProvider: githubUrl ? "GITHUB" : (remoteAvailable ? "OTHER" : "NONE"),
            remote: githubUrl || (remoteAvailable ? "UNSUPPORTED" : "NONE"),
            upstream: upstreamName ? sanitizeText(upstreamName, "NONE", 255) : "NONE",
            ahead,
            behind,
            githubUrl
        };
    }

    _statusEntryCount(output) {
        if (!output) return 0;
        const entries = output.split("\0");
        let count = 0;
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (!entry) continue;
            count++;
            const status = entry.slice(0, 2);
            if (status.includes("R") || status.includes("C")) index++;
        }
        return count;
    }

    _identity(parts) {
        const digest = crypto.createHash("sha256");
        parts.forEach(part => digest.update(String(part)).update("\0"));
        return `sha256:${digest.digest("hex")}`;
    }

    async _filterOverrides(repositoryPath) {
        const output = await this._git(
            repositoryPath,
            ["config", "--includes", "--null", "--name-only", "--get-regexp", "^(filter\\.|diff\\.)"],
            false,
            {acceptExitCodeOne: true}
        );
        if (output === null) return null;
        if (output === "") return [];
        if (output.length > 65536) return null;
        const keys = output.split("\0").filter(Boolean);
        if (keys.length > MAX_FILTER_CONFIG_KEYS) return null;

        const drivers = new Set();
        const diffDrivers = new Set();
        for (const key of keys) {
            if (key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) return null;
            const match = /^(filter\..+)\.(clean|smudge|process|required)$/i.exec(key);
            if (match) {
                const driverName = match[1].slice("filter.".length);
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(driverName)) return null;
                drivers.add(match[1]);
            }
            const diffMatch = /^(diff\..+)\.(command|textconv|cachetextconv)$/i.exec(key);
            if (diffMatch) {
                const driverName = diffMatch[1].slice("diff.".length);
                if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(driverName)) return null;
                diffDrivers.add(diffMatch[1]);
            }
        }
        const overrides = [];
        drivers.forEach(driver => {
            overrides.push(
                [`${driver}.clean`, ""],
                [`${driver}.smudge`, ""],
                [`${driver}.process`, ""],
                [`${driver}.required`, "false"]
            );
        });
        diffDrivers.forEach(driver => {
            overrides.push(
                [`${driver}.command`, ""],
                [`${driver}.textconv`, ""],
                [`${driver}.cachetextconv`, "false"]
            );
        });
        return overrides;
    }

    _git(repositoryPath, args, exact = false, opts = {}) {
        return this.gitExecutor.execute(repositoryPath, args, {
            configOverrides: opts.configOverrides,
            timeout: opts.timeout
        }).then(result => {
            const acceptedNoMatch = !result.ok && opts.acceptExitCodeOne === true && result.exitCode === 1;
            if ((!result.ok && !acceptedNoMatch) || typeof result.stdout !== "string") return null;
            const output = result.stdout.replace(/[\r\n]+$/, "");
            return exact ? output.trim() : output;
        }).catch(() => {
            this.log("warn", "REPOSITORY GIT OPERATION FAILED");
            return null;
        });
    }
}

class RepositoryActionService {
    constructor(opts = {}) {
        if (!opts.repositoryService) throw new TypeError("Repository actions require a RepositoryService");
        this.repositoryService = opts.repositoryService;
        this.runProfileService = opts.runProfileService || new RepositoryRunProfileService({
            home: this.repositoryService.home
        });
        this.processManager = opts.processManager || new RepositoryProcessManager({
            home: this.repositoryService.home
        });
        this.gitService = opts.gitService || new RepositoryGitService({
            repositoryService: this.repositoryService,
            cloneTimeoutMs: opts.cloneTimeoutMs,
            updateTimeoutMs: opts.updateTimeoutMs,
            onState: opts.onGitState,
            log: opts.log
        });
        this.shell = opts.shell || "bash";
        this.writeTerminal = typeof opts.writeTerminal === "function" ? opts.writeTerminal : null;
        this.openCode = typeof opts.openCode === "function" ? opts.openCode : null;
        this.openBrowser = typeof opts.openBrowser === "function" ? opts.openBrowser : null;
        this.applicationAvailable = typeof opts.applicationAvailable === "function" ? opts.applicationAvailable : (() => true);
        this.randomBytes = opts.randomBytes || crypto.randomBytes;
        this.nowMilliseconds = opts.nowMilliseconds || Date.now;
        this.authorizationTtlMs = Number.isSafeInteger(opts.authorizationTtlMs) ? opts.authorizationTtlMs : 5 * 60 * 1000;
        this.pendingAuthorizations = new Map();
        this.actions = new Map();
        this.registerAction(REPOSITORY_ACTIONS[0], context => this._code(context), () => Boolean(this.openCode) && this.applicationAvailable("code"));
        this.registerAction(REPOSITORY_ACTIONS[1], context => this._terminal(context), () => Boolean(this.writeTerminal));
        this.registerAction(REPOSITORY_ACTIONS[2], context => this._info(context), () => true);
        this.registerAction(REPOSITORY_ACTIONS[3], context => this._github(context), repository => (
            repository.public.remoteProvider === "GITHUB" && Boolean(this.openBrowser) && this.applicationAvailable("browser")
        ));
        this.registerAction(REPOSITORY_ACTIONS[4], context => this._run(context), () => true);
        this.registerAction(REPOSITORY_ACTIONS[5], context => this._stop(context), () => true);
        this.registerAction(REPOSITORY_ACTIONS[6], context => this._pull(context), () => true);
    }

    registerAction(definition, handler, isAvailable = () => true) {
        if (!definition || !ACTION_ID_PATTERN.test(definition.id) || typeof definition.label !== "string") {
            throw new TypeError("Repository action definition is invalid");
        }
        if (typeof handler !== "function" || typeof isAvailable !== "function") {
            throw new TypeError("Repository action handler is invalid");
        }
        this.actions.set(definition.id, {
            definition: {id: definition.id, label: sanitizeText(definition.label, definition.id.toUpperCase(), 32)},
            handler,
            isAvailable
        });
    }

    async list() {
        const result = await this.repositoryService.refresh();
        const repositories = await Promise.all(result.repositories.map(repository => {
            const internal = this.repositoryService.repositories.get(repository.id);
            if (internal && this.processManager.isActive(repository.id)
                && !this.processManager.matchesRepository(internal)) {
                const snapshot = this.processManager.getRepositorySnapshot(repository.id);
                return this._decorate(snapshot, null);
            }
            return this._decorate(repository, internal);
        }));
        const listedIds = new Set(repositories.map(repository => repository.id));
        const missingActive = this.processManager.getActiveRepositorySnapshots()
            .filter(repository => !listedIds.has(repository.id));
        for (const repository of missingActive) repositories.push(await this._decorate(repository, null));
        repositories.sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, {sensitivity: "base"}));
        return {
            ok: true,
            status: repositories.length ? null : result.status,
            repositories
        };
    }

    async execute(repositoryIdValue, actionId, geometry, runRequest = {}) {
        const action = this.actions.get(actionId);
        if (!action) return {ok: false, status: "ACTION NOT FOUND"};
        try {
            if (actionId === "stop") return await this._stop({repositoryId: repositoryIdValue});
            const repository = await this.repositoryService.resolveRepository(repositoryIdValue, {refreshMetadata: true});
            if (actionId === "run") return await this._run({repository, runRequest});
            if (!action.isAvailable(repository)) return {ok: false, status: "ACTION UNAVAILABLE"};
            return await action.handler({repository, geometry});
        } catch (error) {
            return {
                ok: false,
                status: error instanceof RepositoryError || error instanceof RepositoryRunError
                    || error instanceof RepositoryProcessError || error instanceof RepositoryGitError
                    ? error.status : "REPOSITORY ACTION FAILED"
            };
        }
    }

    async _decorate(repository, internalRecord) {
        const internal = typeof internalRecord === "undefined"
            ? this.repositoryService.repositories.get(repository.id) : internalRecord;
        const publicRepository = Object.assign({}, repository);
        delete publicRepository.githubUrl;
        publicRepository.repositoryAvailable = Boolean(internal);
        const processStatus = this.processManager.getStatus(repository.id);
        const processActive = Boolean(processStatus && ACTIVE_STATES.has(processStatus.state));
        const runInspection = internal
            ? this.runProfileService.inspect(internal)
            : {candidates: [], trustStoreStatus: null};
        const executionSecurity = this._executionSecurity(processStatus);
        executionSecurity.authorization = runInspection.candidates.length
            && runInspection.candidates.every(candidate => candidate.authorizationState === "APPROVED")
            ? "TRUSTED" : "REQUIRED";
        let pullCapability = {ok: false, state: "UNAVAILABLE"};
        if (internal && this.gitService.isUpdating(repository.id)) {
            pullCapability = {ok: false, state: "UPDATING"};
        } else if (internal && !processActive) pullCapability = await this.gitService.inspectUpdate(internal);
        publicRepository.process = processStatus;
        publicRepository.executionSecurity = executionSecurity;
        publicRepository.actions = Array.from(this.actions.values()).map(action => {
            let enabled;
            let state = "";
            if (action.definition.id === "run") {
                enabled = !processActive && runInspection.candidates.length > 0 && executionSecurity.allowed;
                if (processActive) state = processStatus.state;
                else if (!executionSecurity.allowed) state = executionSecurity.securityProfile === "LOCKDOWN"
                    ? "LOCKDOWN" : "ISOLATION BLOCKED";
                else if (!runInspection.candidates.length) state = "NO PROFILE";
                else if (runInspection.candidates.some(candidate => candidate.authorizationState !== "APPROVED")) {
                    state = "AUTH REQUIRED";
                } else if (processStatus && ["STOPPED", "FAILED"].includes(processStatus.state)) {
                    state = processStatus.state;
                }
            } else if (action.definition.id === "stop") {
                enabled = processActive && processStatus.state !== "STOPPING";
                state = processActive ? processStatus.state : "UNAVAILABLE";
            } else if (action.definition.id === "pull") {
                enabled = Boolean(internal && !processActive && pullCapability.ok);
                state = enabled ? "" : (processActive ? "UNAVAILABLE" : pullCapability.state);
            } else {
                enabled = Boolean(internal && action.isAvailable(internal));
                if (!enabled) state = "UNAVAILABLE";
            }
            return {
                id: action.definition.id,
                label: action.definition.label,
                enabled,
                state
            };
        });
        return publicRepository;
    }

    async clone(repositoryUrl) {
        const result = await this.gitService.clone(repositoryUrl);
        if (!result.ok) return result;
        const internal = this.repositoryService.repositories.get(result.repositoryId);
        if (!internal) return {ok: false, status: "CLONED REPOSITORY VALIDATION FAILED"};
        return {
            ok: true,
            status: result.status,
            repository: await this._decorate(this._publicRepository(internal), internal)
        };
    }

    cancelClone() {
        return this.gitService.cancelClone();
    }

    _publicRepository(repository) {
        const publicRepository = Object.assign({}, repository.public);
        delete publicRepository.githubUrl;
        return publicRepository;
    }

    async _terminal(context) {
        const command = terminalCommand(context.repository.canonicalPath, this.shell, this.repositoryService.path);
        await Promise.resolve(this.writeTerminal(command));
        return {ok: true, status: "TERMINAL OPENED", actionId: "terminal", activateAppId: "terminal"};
    }

    async _code(context) {
        const result = await Promise.resolve(this.openCode(context.repository.canonicalPath, context.geometry));
        if (!result || !result.ok) return {ok: false, status: result && result.status ? result.status : "APPLICATION FAILED TO START"};
        return {
            ok: true,
            status: "CODE OPENED",
            actionId: "code",
            activateAppId: "code",
            application: this._publicApplicationResult(result, "code")
        };
    }

    async _info(context) {
        return {
            ok: true,
            status: "REPOSITORY INFO",
            actionId: "info",
            repository: await this._decorate(this._publicRepository(context.repository), context.repository)
        };
    }

    async _run(context) {
        const repository = context.repository;
        const request = context.runRequest || {};
        if (this.processManager.isActive(repository.id)) {
            if (!this.processManager.matchesRepository(repository)) {
                return {ok: false, status: "REPOSITORY IDENTITY CONFLICT"};
            }
            return {
                ok: true,
                status: this.processManager.getStatus(repository.id).state,
                actionId: "run",
                duplicate: true,
                repository: await this._decorate(this._publicRepository(repository), repository)
            };
        }

        const executionSecurity = this._executionSecurity();
        if (!executionSecurity.allowed) {
            return {ok: false, status: executionSecurity.status};
        }

        const inspection = this.runProfileService.inspect(repository);
        if (!inspection.candidates.length) return {ok: false, status: "NO SAFE RUN PROFILE DETECTED"};
        let candidate = null;
        if (request.profileId) {
            candidate = inspection.candidates.find(profile => profile.profileId === request.profileId) || null;
            if (!candidate) return {ok: false, status: "RUN PROFILE NOT FOUND"};
        } else if (inspection.candidates.length === 1) {
            candidate = inspection.candidates[0];
        }

        if (request.authorization) {
            if (!candidate || !request.authorizationId) return {ok: false, status: "AUTHORIZATION REQUIRED"};
            return this._authorizeAndRun(repository, candidate, inspection, request);
        }
        if (!candidate) {
            return {
                ok: true,
                status: "RUN PROFILE SELECTION REQUIRED",
                actionId: "run",
                prompt: this._profileSelectionPrompt(repository, inspection.candidates)
            };
        }
        if (candidate.authorizationState === "APPROVED") return this._launch(repository, candidate);
        return {
            ok: true,
            status: candidate.authorizationState === "CHANGED"
                ? "RUN PROFILE CHANGED\nAUTHORIZATION REQUIRED" : "AUTHORIZATION REQUIRED",
            actionId: "run",
            prompt: this._authorizationPrompt(repository, candidate, inspection)
        };
    }

    async _authorizeAndRun(repository, candidate, inspection, request) {
        this._pruneAuthorizations();
        const pending = this.pendingAuthorizations.get(request.authorizationId);
        this.pendingAuthorizations.delete(request.authorizationId);
        if (!pending || pending.repositoryId !== repository.id || pending.profileId !== candidate.profileId
            || pending.expiresAt < this.nowMilliseconds()) {
            return {ok: false, status: "AUTHORIZATION REQUIRED"};
        }
        if (pending.executionIdentity !== repository.executionIdentity
            || pending.repositoryIdentity !== repository.repositoryIdentity
            || pending.profileFingerprint !== candidate.profileFingerprint) {
            return {ok: false, status: "RUN PROFILE CHANGED\nAUTHORIZATION REQUIRED"};
        }
        const executionSecurity = this._executionSecurity();
        if (!executionSecurity.allowed) return {ok: false, status: executionSecurity.status};
        if (request.authorization === "trust-profile") this.runProfileService.approve(repository, candidate);
        else if (request.authorization !== "run-once") return {ok: false, status: "INVALID REQUEST"};
        return this._launch(repository, candidate);
    }

    async _launch(repository, candidate) {
        const result = this.processManager.start(repository, candidate);
        return {
            ok: result.ok,
            status: result.status,
            actionId: "run",
            duplicate: result.duplicate === true,
            repository: await this._decorate(this._publicRepository(repository), repository)
        };
    }

    async _stop(context) {
        const repositoryIdValue = context.repositoryId || (context.repository && context.repository.id);
        const snapshot = this.processManager.getRepositorySnapshot(repositoryIdValue);
        const result = await this.processManager.stop(repositoryIdValue);
        if (!result.ok) return result;
        const internal = this.repositoryService.repositories.get(repositoryIdValue) || null;
        const publicRepository = internal ? this._publicRepository(internal) : snapshot;
        return {
            ok: true,
            status: result.status,
            actionId: "stop",
            repository: publicRepository ? await this._decorate(publicRepository, internal) : null
        };
    }

    async _pull(context) {
        const repository = context.repository;
        if (this.processManager.isActive(repository.id)) {
            return {ok: false, status: "REPOSITORY PROCESS ACTIVE\nUPDATE ABORTED"};
        }
        const result = await this.gitService.pull(repository);
        if (!result.ok) return result;
        const refreshed = await this.repositoryService.resolveRepository(repository.id, {refreshMetadata: true});
        return {
            ok: true,
            status: result.status,
            actionId: "pull",
            repository: await this._decorate(this._publicRepository(refreshed), refreshed)
        };
    }

    _profileSelectionPrompt(repository, candidates) {
        return {
            kind: "profile-selection",
            title: "RUN PROFILE",
            repositoryName: repository.public.displayName,
            fields: [],
            warning: "",
            choices: candidates.map(candidate => ({
                id: candidate.profileId,
                label: candidate.commandLabel,
                enabled: true,
                state: candidate.authorizationState === "APPROVED" ? "TRUSTED"
                    : (candidate.authorizationState === "CHANGED" ? "CHANGED" : "")
            })).concat([{id: "cancel", label: "CANCEL", enabled: true, state: ""}])
        };
    }

    _authorizationPrompt(repository, candidate, inspection) {
        const authorizationId = `auth_${this.randomBytes(24).toString("hex")}`;
        this._pruneAuthorizations();
        this.pendingAuthorizations.set(authorizationId, {
            repositoryId: repository.id,
            profileId: candidate.profileId,
            executionIdentity: repository.executionIdentity,
            repositoryIdentity: repository.repositoryIdentity,
            profileFingerprint: candidate.profileFingerprint,
            expiresAt: this.nowMilliseconds() + this.authorizationTtlMs
        });
        while (this.pendingAuthorizations.size > 128) {
            this.pendingAuthorizations.delete(this.pendingAuthorizations.keys().next().value);
        }
        const trustEnabled = !inspection.trustStoreStatus && Boolean(repository.repositoryIdentity);
        const executionSecurity = this._executionSecurity();
        return {
            kind: "authorization",
            title: "REPOSITORY EXECUTION",
            repositoryName: repository.public.displayName,
            profileId: candidate.profileId,
            authorizationId,
            fields: [
                {label: "PROFILE", value: candidate.displayName},
                {label: "EXECUTABLE", value: candidate.executable},
                {label: "ARGUMENTS", value: candidate.args.join(" ") || "NONE"},
                {label: "SECURITY", value: executionSecurity.securityProfile},
                {label: "ISOLATION", value: executionSecurity.level}
            ],
            warning: candidate.authorizationState === "CHANGED"
                ? "RUN PROFILE CHANGED\nAUTHORIZATION REQUIRED\nREPOSITORY CODE WILL EXECUTE"
                : "REPOSITORY CODE WILL EXECUTE",
            choices: [
                {id: "run-once", label: "RUN ONCE", enabled: true, state: ""},
                {
                    id: "trust-profile",
                    label: "TRUST PROFILE",
                    enabled: trustEnabled,
                    state: trustEnabled ? "" : (inspection.trustStoreStatus || "IDENTITY UNAVAILABLE")
                },
                {id: "cancel", label: "CANCEL", enabled: true, state: ""}
            ]
        };
    }

    _pruneAuthorizations() {
        const now = this.nowMilliseconds();
        this.pendingAuthorizations.forEach((authorization, id) => {
            if (authorization.expiresAt < now) this.pendingAuthorizations.delete(id);
        });
    }

    _executionSecurity(processStatus = null) {
        let status;
        if (typeof this.processManager.getExecutionSecurityStatus === "function") {
            status = this.processManager.getExecutionSecurityStatus();
        }
        if (!status || typeof status !== "object") {
            status = {
                allowed: true,
                securityProfile: "NORMAL",
                requiredLevel: "NONE",
                availableLevel: "NONE",
                level: "NONE",
                backend: "DIRECT",
                reason: "SUPERVISED DIRECT EXECUTION; NO FILESYSTEM SANDBOX",
                status: "EXECUTION PERMITTED"
            };
        }
        const active = processStatus && ACTIVE_STATES.has(processStatus.state);
        return {
            allowed: status.allowed === true,
            securityProfile: active && ["NORMAL", "PUBLIC", "LOCKDOWN"].includes(processStatus.securityProfile)
                ? processStatus.securityProfile : (["NORMAL", "PUBLIC", "LOCKDOWN"].includes(status.securityProfile)
                    ? status.securityProfile : "UNKNOWN"),
            level: active && ["STRONG", "PARTIAL", "NONE"].includes(processStatus.isolationLevel)
                ? processStatus.isolationLevel : (["STRONG", "PARTIAL", "NONE", "UNAVAILABLE"].includes(status.level)
                    ? status.level : "UNAVAILABLE"),
            backend: active && typeof processStatus.isolationBackend === "string"
                ? sanitizeText(processStatus.isolationBackend, "UNAVAILABLE", 32)
                : sanitizeText(status.backend, "UNAVAILABLE", 32),
            requiredLevel: sanitizeText(status.requiredLevel, "UNKNOWN", 16),
            availableLevel: sanitizeText(status.availableLevel, "UNAVAILABLE", 16),
            reason: sanitizeText(status.reason, "ISOLATION STATUS UNAVAILABLE", 160),
            status: status.allowed === true ? "EXECUTION PERMITTED"
                : (status.securityProfile === "LOCKDOWN"
                    ? "EXECUTION BLOCKED\nLOCKDOWN POLICY DISABLES REPOSITORY EXECUTION"
                    : (status.securityProfile === "UNKNOWN"
                        ? "EXECUTION BLOCKED\nSECURITY PROFILE UNAVAILABLE"
                        : "EXECUTION BLOCKED\nISOLATION REQUIREMENT NOT MET"))
        };
    }

    async _github(context) {
        const githubUrl = context.repository.public.githubUrl;
        if (!isNormalizedGithubUrl(githubUrl)) return {ok: false, status: "ACTION UNAVAILABLE"};
        const result = await Promise.resolve(this.openBrowser(githubUrl, context.geometry));
        if (!result || !result.ok) return {ok: false, status: result && result.status ? result.status : "APPLICATION FAILED TO START"};
        return {
            ok: true,
            status: "GITHUB OPENED",
            actionId: "github",
            activateAppId: "browser",
            application: this._publicApplicationResult(result, "browser")
        };
    }

    _publicApplicationResult(result, appId) {
        const publicResult = {appId, status: sanitizeText(result.status || "RUNNING", "RUNNING", 64)};
        ["state", "running", "minimized", "fullscreen"].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(result, key)) publicResult[key] = result[key];
        });
        publicResult.state = "ACTIVE";
        publicResult.running = true;
        return publicResult;
    }
}

async function handleRepositoryRequest(actions, request) {
    if (!isPlainObject(request) || typeof request.operation !== "string") {
        return {ok: false, status: "INVALID REQUEST"};
    }
    if (request.operation === "list" || request.operation === "refresh") {
        if (Object.keys(request).some(key => key !== "operation")) return {ok: false, status: "INVALID REQUEST"};
        return actions.list();
    }
    if (request.operation === "clone") {
        if (Object.keys(request).some(key => !["operation", "repositoryUrl"].includes(key))
            || typeof request.repositoryUrl !== "string") return {ok: false, status: "INVALID REQUEST"};
        return actions.clone(request.repositoryUrl);
    }
    if (request.operation === "cancel-clone") {
        if (Object.keys(request).some(key => key !== "operation")) return {ok: false, status: "INVALID REQUEST"};
        return actions.cancelClone();
    }
    if (request.operation !== "action") return {ok: false, status: "UNSUPPORTED OPERATION"};
    const allowedKeys = [
        "operation", "repositoryId", "actionId", "geometry",
        "profileId", "authorizationId", "authorization"
    ];
    if (Object.keys(request).some(key => !allowedKeys.includes(key))) {
        return {ok: false, status: "INVALID REQUEST"};
    }
    const repositoryIdValue = normalizeRepositoryId(request.repositoryId);
    if (!repositoryIdValue || !ACTION_ID_PATTERN.test(request.actionId || "")) return {ok: false, status: "INVALID REQUEST"};
    const requiresGeometry = request.actionId === "code" || request.actionId === "github";
    const geometry = typeof request.geometry === "undefined" ? null : normalizeGeometry(request.geometry);
    if ((requiresGeometry && !geometry) || (!requiresGeometry && typeof request.geometry !== "undefined") || (request.geometry && !geometry)) {
        return {ok: false, status: "INVALID REQUEST"};
    }
    const runKeysPresent = ["profileId", "authorizationId", "authorization"]
        .some(key => Object.prototype.hasOwnProperty.call(request, key));
    if (request.actionId !== "run" && runKeysPresent) return {ok: false, status: "INVALID REQUEST"};
    const runRequest = {};
    if (request.actionId === "run") {
        if (typeof request.profileId !== "undefined") {
            if (!PROFILE_ID_PATTERN.test(request.profileId || "")) return {ok: false, status: "INVALID REQUEST"};
            runRequest.profileId = request.profileId;
        }
        if (typeof request.authorization !== "undefined") {
            if (!["run-once", "trust-profile"].includes(request.authorization)
                || !runRequest.profileId
                || typeof request.authorizationId !== "string"
                || !/^auth_[a-f0-9]{48}$/.test(request.authorizationId)) {
                return {ok: false, status: "INVALID REQUEST"};
            }
            runRequest.authorization = request.authorization;
            runRequest.authorizationId = request.authorizationId;
        } else if (typeof request.authorizationId !== "undefined") {
            return {ok: false, status: "INVALID REQUEST"};
        }
    }
    return actions.execute(repositoryIdValue, request.actionId, geometry, runRequest);
}

module.exports = {
    REPOSITORY_ACTIONS,
    RepositoryActionService,
    RepositoryError,
    RepositoryGitError,
    RepositoryGitExecutor,
    RepositoryGitService,
    RepositoryService,
    expandHome,
    handleRepositoryRequest,
    isNormalizedGithubUrl,
    normalizeGeometry,
    normalizeGithubRemote,
    normalizeRepositoryId,
    terminalCommand
};
