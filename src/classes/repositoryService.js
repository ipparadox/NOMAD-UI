const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFile} = require("child_process");

const REPOSITORY_ID_PATTERN = /^repo_[a-f0-9]{32}$/;
const ACTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const MAX_FILTER_CONFIG_KEYS = 128;

const REPOSITORY_ACTIONS = Object.freeze([
    Object.freeze({id: "code", label: "CODE"}),
    Object.freeze({id: "terminal", label: "TERMINAL"}),
    Object.freeze({id: "info", label: "INFO"}),
    Object.freeze({id: "github", label: "GITHUB"})
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

function normalizeGithubParts(owner, repository) {
    if (repository.toLowerCase().endsWith(".git")) repository = repository.slice(0, -4);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repository) || repository === "." || repository === "..") return null;
    return `https://github.com/${owner}/${repository}`;
}

function normalizeGithubRemote(value) {
    if (typeof value !== "string") return null;
    const remote = value.trim();
    if (!remote || remote.length > 512 || /[\u0000-\u001f\u007f]/.test(remote)) return null;

    const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(remote);
    if (ssh) return normalizeGithubParts(ssh[1], ssh[2]);

    let parsed;
    try {
        parsed = new URL(remote);
    } catch (error) {
        return null;
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
    if (parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const match = /^\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
    if (!match) return null;
    return normalizeGithubParts(match[1], match[2]);
}

function isNormalizedGithubUrl(value) {
    return typeof value === "string" && normalizeGithubRemote(value) === value;
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
        this.execFile = opts.execFile || execFile;
        this.gitExecutable = opts.gitExecutable || "git";
        this.log = opts.log || (() => {});
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

    async refresh() {
        let canonicalRoot;
        let children;
        try {
            const configuredRoot = this.path.resolve(expandHome(this.repositoryRoot, this.home));
            canonicalRoot = this.fs.realpathSync(configuredRoot);
            if (!this.fs.statSync(canonicalRoot).isDirectory()) throw new RepositoryError("REPOSITORY ROOT NOT FOUND");
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
        try {
            canonicalPath = this.fs.realpathSync(candidatePath);
            if (this.path.dirname(canonicalPath) !== canonicalRoot) return null;
            if (!this.fs.statSync(canonicalPath).isDirectory()) return null;
            const gitEntry = this.fs.lstatSync(this.path.join(canonicalPath, ".git"));
            if (!gitEntry.isDirectory() && !gitEntry.isFile()) return null;
        } catch (error) {
            return null;
        }

        if (await this._git(canonicalPath, ["rev-parse", "--is-inside-work-tree"], true) !== "true") return null;
        const record = {
            id: repositoryId(canonicalRoot, childName),
            childName,
            canonicalPath,
            canonicalRoot,
            public: null
        };
        record.public = await this._metadata(record);
        return record;
    }

    async _verifyRecord(record) {
        let currentRoot;
        let canonicalPath;
        try {
            currentRoot = this.fs.realpathSync(this.path.resolve(expandHome(this.repositoryRoot, this.home)));
            if (currentRoot !== record.canonicalRoot || currentRoot !== this.canonicalRoot) return null;
            const candidatePath = this.path.join(currentRoot, record.childName);
            canonicalPath = this.fs.realpathSync(candidatePath);
            if (canonicalPath !== record.canonicalPath || this.path.dirname(canonicalPath) !== currentRoot) return null;
            if (!this.fs.statSync(canonicalPath).isDirectory()) return null;
            const gitEntry = this.fs.lstatSync(this.path.join(canonicalPath, ".git"));
            if (!gitEntry.isDirectory() && !gitEntry.isFile()) return null;
        } catch (error) {
            return null;
        }
        if (await this._git(canonicalPath, ["rev-parse", "--is-inside-work-tree"], true) !== "true") return null;
        return record;
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
        const originRemotePromise = this._git(record.canonicalPath, ["remote", "get-url", "origin"]);
        const filterOverrides = await filterOverridesPromise;
        const statusPromise = filterOverrides === null
            ? Promise.resolve(null)
            : this._git(
                record.canonicalPath,
                ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"],
                false,
                {configOverrides: filterOverrides}
            );
        const [branchName, detachedHead, statusOutput, remotesOutput, originRemote] = await Promise.all([
            branchPromise,
            detachedHeadPromise,
            statusPromise,
            remotesPromise,
            originRemotePromise
        ]);
        const statusEntries = statusOutput === null ? null : this._statusEntryCount(statusOutput);
        const remotes = (remotesOutput || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        const githubUrl = normalizeGithubRemote(originRemote);
        const remoteAvailable = remotes.length > 0;
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

    async _filterOverrides(repositoryPath) {
        const output = await this._git(
            repositoryPath,
            ["config", "--null", "--name-only", "--get-regexp", "^filter\\."],
            false,
            {acceptExitCodeOne: true}
        );
        if (output === null) return null;
        if (output === "") return [];
        if (output.length > 65536) return null;
        const keys = output.split("\0").filter(Boolean);
        if (keys.length > MAX_FILTER_CONFIG_KEYS) return null;

        const drivers = new Set();
        for (const key of keys) {
            if (key.length > 512 || /[\u0000-\u001f\u007f]/.test(key)) return null;
            const match = /^(filter\..+)\.(clean|smudge|process|required)$/i.exec(key);
            if (match) drivers.add(match[1]);
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
        return overrides;
    }

    _git(repositoryPath, args, exact = false, opts = {}) {
        return new Promise(resolve => {
            const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
            const commandArgs = [
                "--no-pager",
                "-c", "core.fsmonitor=false",
                "-c", `core.hooksPath=${nullDevice}`,
                "-c", "diff.external=",
                "-c", "interactive.diffFilter="
            ];
            (opts.configOverrides || []).forEach(([key, value]) => commandArgs.push("-c", `${key}=${value}`));
            commandArgs.push("-C", repositoryPath, ...args);
            const options = {
                encoding: "utf8",
                timeout: 3000,
                maxBuffer: MAX_GIT_OUTPUT,
                windowsHide: true,
                shell: false,
                env: Object.assign({}, process.env, {
                    GIT_OPTIONAL_LOCKS: "0",
                    GIT_PAGER: "cat",
                    GIT_TERMINAL_PROMPT: "0",
                    PAGER: "cat"
                })
            };
            try {
                this.execFile(this.gitExecutable, commandArgs, options, (error, stdout) => {
                    const acceptedNoMatch = error && opts.acceptExitCodeOne === true && error.code === 1;
                    if ((error && !acceptedNoMatch) || typeof stdout !== "string") {
                        resolve(null);
                        return;
                    }
                    const output = stdout.replace(/[\r\n]+$/, "");
                    resolve(exact ? output.trim() : output);
                });
            } catch (error) {
                this.log("warn", "REPOSITORY GIT OPERATION FAILED");
                resolve(null);
            }
        });
    }
}

class RepositoryActionService {
    constructor(opts = {}) {
        if (!opts.repositoryService) throw new TypeError("Repository actions require a RepositoryService");
        this.repositoryService = opts.repositoryService;
        this.shell = opts.shell || "bash";
        this.writeTerminal = typeof opts.writeTerminal === "function" ? opts.writeTerminal : null;
        this.openCode = typeof opts.openCode === "function" ? opts.openCode : null;
        this.openBrowser = typeof opts.openBrowser === "function" ? opts.openBrowser : null;
        this.applicationAvailable = typeof opts.applicationAvailable === "function" ? opts.applicationAvailable : (() => true);
        this.actions = new Map();
        this.registerAction(REPOSITORY_ACTIONS[0], context => this._code(context), () => Boolean(this.openCode) && this.applicationAvailable("code"));
        this.registerAction(REPOSITORY_ACTIONS[1], context => this._terminal(context), () => Boolean(this.writeTerminal));
        this.registerAction(REPOSITORY_ACTIONS[2], context => this._info(context), () => true);
        this.registerAction(REPOSITORY_ACTIONS[3], context => this._github(context), repository => (
            repository.public.remoteProvider === "GITHUB" && Boolean(this.openBrowser) && this.applicationAvailable("browser")
        ));
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
        return {
            ok: true,
            status: result.status,
            repositories: result.repositories.map(repository => this._decorate(repository))
        };
    }

    async execute(repositoryIdValue, actionId, geometry) {
        const action = this.actions.get(actionId);
        if (!action) return {ok: false, status: "ACTION NOT FOUND"};
        try {
            const repository = await this.repositoryService.resolveRepository(repositoryIdValue, {refreshMetadata: true});
            if (!action.isAvailable(repository)) return {ok: false, status: "ACTION UNAVAILABLE"};
            return await action.handler({repository, geometry});
        } catch (error) {
            return {
                ok: false,
                status: error instanceof RepositoryError ? error.status : "REPOSITORY ACTION FAILED"
            };
        }
    }

    _decorate(repository) {
        const internal = this.repositoryService.repositories.get(repository.id);
        const publicRepository = Object.assign({}, repository);
        delete publicRepository.githubUrl;
        publicRepository.actions = Array.from(this.actions.values()).map(action => ({
            id: action.definition.id,
            label: action.definition.label,
            enabled: Boolean(internal && action.isAvailable(internal))
        }));
        return publicRepository;
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
            repository: this._decorate(this._publicRepository(context.repository))
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
    if (request.operation !== "action") return {ok: false, status: "UNSUPPORTED OPERATION"};
    if (Object.keys(request).some(key => !["operation", "repositoryId", "actionId", "geometry"].includes(key))) {
        return {ok: false, status: "INVALID REQUEST"};
    }
    const repositoryIdValue = normalizeRepositoryId(request.repositoryId);
    if (!repositoryIdValue || !ACTION_ID_PATTERN.test(request.actionId || "")) return {ok: false, status: "INVALID REQUEST"};
    const requiresGeometry = request.actionId === "code" || request.actionId === "github";
    const geometry = typeof request.geometry === "undefined" ? null : normalizeGeometry(request.geometry);
    if ((requiresGeometry && !geometry) || (!requiresGeometry && typeof request.geometry !== "undefined") || (request.geometry && !geometry)) {
        return {ok: false, status: "INVALID REQUEST"};
    }
    return actions.execute(repositoryIdValue, request.actionId, geometry);
}

module.exports = {
    REPOSITORY_ACTIONS,
    RepositoryActionService,
    RepositoryError,
    RepositoryService,
    expandHome,
    handleRepositoryRequest,
    isNormalizedGithubUrl,
    normalizeGeometry,
    normalizeGithubRemote,
    normalizeRepositoryId,
    terminalCommand
};
