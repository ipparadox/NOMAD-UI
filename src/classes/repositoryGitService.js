const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const which = require("which");

const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const DEFAULT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_UPDATE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REMOTE_LENGTH = 512;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const IN_PROGRESS_PATHS = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
    "BISECT_LOG"
];

class RepositoryGitError extends Error {
    constructor(status) {
        super(status);
        this.name = "RepositoryGitError";
        this.status = status;
    }
}

function containsControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}

function normalizeGithubParts(owner, repository) {
    if (typeof owner !== "string" || typeof repository !== "string") return null;
    if (repository.toLowerCase().endsWith(".git")) repository = repository.slice(0, -4);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repository)
        || repository === "." || repository === ".." || repository.endsWith(".")
        || WINDOWS_RESERVED_NAME.test(repository)) return null;
    return {
        owner,
        repository,
        canonicalUrl: `https://github.com/${owner}/${repository}`,
        identity: `github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`
    };
}

function parseGithubRepository(value) {
    if (typeof value !== "string") return null;
    const remote = value.trim();
    if (!remote || remote.length > MAX_REMOTE_LENGTH || containsControlCharacters(remote)) return null;

    const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(remote);
    if (ssh) return normalizeGithubParts(ssh[1], ssh[2]);

    const authority = /^https:\/\/([^/]+)\//i.exec(remote);
    if (!authority || authority[1].toLowerCase() !== "github.com") return null;

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

function normalizeGithubRemote(value) {
    const parsed = parseGithubRepository(value);
    return parsed ? parsed.canonicalUrl : null;
}

function isNormalizedGithubUrl(value) {
    return typeof value === "string" && normalizeGithubRemote(value) === value;
}

function canonicalCollisionKey(value) {
    return String(value).normalize("NFKC").toLowerCase();
}

function isSafeRef(value, prefix) {
    return typeof value === "string" && value.startsWith(prefix) && value.length <= 320
        && !containsControlCharacters(value) && !value.includes("..") && !value.includes("@{")
        && !value.includes("//") && !/[\\ ~^:?*\[]/.test(value)
        && !value.endsWith("/") && !value.endsWith(".");
}

function resolveGitExecutable(candidate, fsModule = fs, pathModule = path) {
    const requested = typeof candidate === "string" && candidate ? candidate : "git";
    const located = pathModule.isAbsolute(requested) ? requested : which.sync(requested);
    const canonical = fsModule.realpathSync(located);
    if (!fsModule.statSync(canonical).isFile()) throw new Error("Git executable is not a file");
    return canonical;
}

function cleanGitEnvironment(source, nullDevice, gitExecPath, network) {
    const environment = {};
    Object.keys(source || process.env).forEach(key => {
        if (/^(?:GIT_|GCM_)/i.test(key) || key === "SSH_ASKPASS" || key === "SVN_SSH") return;
        environment[key] = (source || process.env)[key];
    });
    Object.assign(environment, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
        LC_ALL: "C",
        PAGER: "cat"
    });
    if (gitExecPath) environment.GIT_EXEC_PATH = gitExecPath;
    if (network) environment.GIT_ALLOW_PROTOCOL = "https";
    return environment;
}

class RepositoryGitExecutor {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.execFile = opts.execFile || childProcess.execFile;
        this.spawnProcess = opts.spawn || childProcess.spawn;
        this.execFileSync = opts.execFileSync || childProcess.execFileSync;
        this.sourceEnvironment = opts.env || process.env;
        this.log = opts.log || (() => {});
        this.nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
        this.gitExecutable = null;
        this.gitExecPath = null;
        try {
            const resolver = opts.resolveGitExecutable || resolveGitExecutable;
            this.gitExecutable = resolver(opts.gitExecutable || "git", this.fs, this.path);
        } catch (error) {
            this.log("warn", "TRUSTED GIT EXECUTABLE NOT AVAILABLE");
            return;
        }
        try {
            const execution = this.execFileSync(this.gitExecutable, ["--exec-path"], {
                encoding: "utf8",
                windowsHide: true,
                shell: false,
                env: cleanGitEnvironment(this.sourceEnvironment, this.nullDevice, null, false)
            });
            const rawExecPath = String(execution || "").trim();
            if (rawExecPath && this.path.isAbsolute(rawExecPath)) {
                const canonicalExecPath = this.fs.realpathSync(rawExecPath);
                if (this.fs.statSync(canonicalExecPath).isDirectory()) this.gitExecPath = canonicalExecPath;
            }
        } catch (error) {
            const rawExecPath = error && typeof error.stdout === "string" ? error.stdout.trim() : "";
            try {
                if (rawExecPath && this.path.isAbsolute(rawExecPath)) {
                    const canonicalExecPath = this.fs.realpathSync(rawExecPath);
                    if (this.fs.statSync(canonicalExecPath).isDirectory()) this.gitExecPath = canonicalExecPath;
                }
            } catch (pathError) {
                this.gitExecPath = null;
            }
        }
    }

    available() {
        return Boolean(this.gitExecutable);
    }

    _configArguments(overrides, network) {
        const configs = [
            ["core.fsmonitor", "false"],
            ["core.hooksPath", this.nullDevice],
            ["diff.external", ""],
            ["interactive.diffFilter", ""],
            ["credential.helper", ""],
            ["credential.interactive", "never"],
            ["core.askPass", ""],
            ["gc.auto", "0"],
            ["maintenance.auto", "false"],
            ["submodule.recurse", "false"],
            ["fetch.recurseSubmodules", "false"],
            ["fetch.writeCommitGraph", "false"]
        ];
        if (network) {
            configs.push(
                ["protocol.allow", "never"],
                ["protocol.https.allow", "always"],
                ["protocol.file.allow", "never"],
                ["http.sslVerify", "true"],
                ["http.cookieFile", ""],
                ["http.saveCookies", "false"]
            );
        }
        (overrides || []).forEach(entry => {
            if (!Array.isArray(entry) || entry.length !== 2
                || typeof entry[0] !== "string" || !entry[0] || entry[0].length > 512
                || containsControlCharacters(entry[0]) || typeof entry[1] !== "string"
                || entry[1].length > 4096 || entry[1].includes("\0")) {
                throw new RepositoryGitError("GIT CONFIGURATION REFUSED");
            }
            configs.push(entry);
        });
        const args = ["--no-pager"];
        configs.forEach(([key, value]) => args.push("-c", `${key}=${value}`));
        return args;
    }

    invocation(repositoryPath, args, opts = {}) {
        if (!this.available()) throw new RepositoryGitError("GIT UNAVAILABLE");
        if (!Array.isArray(args) || args.some(argument => typeof argument !== "string" || argument.includes("\0"))) {
            throw new RepositoryGitError("GIT OPERATION REFUSED");
        }
        if (repositoryPath !== null && (typeof repositoryPath !== "string" || !this.path.isAbsolute(repositoryPath))) {
            throw new RepositoryGitError("REPOSITORY NOT FOUND");
        }
        const commandArgs = this._configArguments(opts.configOverrides, opts.network === true);
        if (repositoryPath !== null) commandArgs.push("-C", repositoryPath);
        commandArgs.push(...args);
        return {
            executable: this.gitExecutable,
            args: commandArgs,
            options: {
                cwd: opts.cwd,
                env: cleanGitEnvironment(
                    this.sourceEnvironment,
                    this.nullDevice,
                    this.gitExecPath,
                    opts.network === true
                ),
                windowsHide: true,
                shell: false
            }
        };
    }

    execute(repositoryPath, args, opts = {}) {
        let invocation;
        try {
            invocation = this.invocation(repositoryPath, args, opts);
        } catch (error) {
            return Promise.resolve({
                ok: false,
                exitCode: null,
                stdout: "",
                stderr: "",
                status: error instanceof RepositoryGitError ? error.status : "GIT OPERATION REFUSED"
            });
        }
        const options = Object.assign({}, invocation.options, {
            encoding: "utf8",
            timeout: Number.isSafeInteger(opts.timeout) ? opts.timeout : 3000,
            maxBuffer: Number.isSafeInteger(opts.maxBuffer) ? opts.maxBuffer : MAX_GIT_OUTPUT
        });
        return new Promise(resolve => {
            try {
                this.execFile(invocation.executable, invocation.args, options, (error, stdout, stderr) => {
                    resolve({
                        ok: !error,
                        exitCode: error && Number.isInteger(error.code) ? error.code : (error ? null : 0),
                        stdout: typeof stdout === "string" ? stdout : "",
                        stderr: typeof stderr === "string" ? stderr : "",
                        timedOut: Boolean(error && (error.killed || error.code === "ETIMEDOUT")),
                        status: error ? "GIT OPERATION FAILED" : null
                    });
                });
            } catch (error) {
                resolve({ok: false, exitCode: null, stdout: "", stderr: "", status: "GIT OPERATION FAILED"});
            }
        });
    }

    spawn(repositoryPath, args, opts = {}) {
        const invocation = this.invocation(repositoryPath, args, opts);
        const options = Object.assign({}, invocation.options, {
            detached: opts.detached === true,
            stdio: opts.stdio || ["ignore", "ignore", "pipe"]
        });
        return {
            child: this.spawnProcess(invocation.executable, invocation.args, options),
            invocation: {executable: invocation.executable, args: invocation.args, options}
        };
    }
}

function parseNullValues(output) {
    return String(output || "").split("\0").map(value => value.replace(/[\r\n]+$/, "")).filter(Boolean);
}

function authenticationFailure(stderr) {
    return /authentication failed|could not read username|terminal prompts disabled|repository not found|http basic: access denied/i.test(stderr || "");
}

function updateFailure(status, state) {
    return {ok: false, status, state};
}

class RepositoryGitService {
    constructor(opts = {}) {
        if (!opts.repositoryService) throw new TypeError("Repository Git service requires a RepositoryService");
        this.repositoryService = opts.repositoryService;
        this.executor = opts.executor || this.repositoryService.gitExecutor;
        if (!this.executor) throw new TypeError("Repository Git service requires a hardened Git executor");
        this.fs = opts.fs || this.repositoryService.fs || fs;
        this.path = opts.path || this.repositoryService.path || path;
        this.cloneTimeoutMs = Number.isSafeInteger(opts.cloneTimeoutMs)
            ? opts.cloneTimeoutMs : DEFAULT_CLONE_TIMEOUT_MS;
        this.updateTimeoutMs = Number.isSafeInteger(opts.updateTimeoutMs)
            ? opts.updateTimeoutMs : DEFAULT_UPDATE_TIMEOUT_MS;
        this.cancelGraceMs = Number.isSafeInteger(opts.cancelGraceMs) ? opts.cancelGraceMs : 2000;
        this.detachedClone = typeof opts.detachedClone === "boolean"
            ? opts.detachedClone : process.platform !== "win32";
        this.onState = typeof opts.onState === "function" ? opts.onState : (() => {});
        this.log = opts.log || (() => {});
        this.activeClone = null;
        this.activeUpdates = new Set();
    }

    hasActiveClone() {
        return Boolean(this.activeClone);
    }

    isUpdating(repositoryId) {
        return this.activeUpdates.has(repositoryId);
    }

    _emit(state) {
        try {
            this.onState(Object.assign({}, state));
        } catch (error) {
            this.log("warn", "REPOSITORY GIT STATE DELIVERY FAILED");
        }
    }

    _rootSnapshot() {
        let canonicalRoot;
        let stats;
        try {
            canonicalRoot = this.repositoryService.resolveCanonicalRoot();
            stats = this.fs.statSync(canonicalRoot);
            if (!stats.isDirectory()) throw new Error("not a directory");
        } catch (error) {
            throw new RepositoryGitError("REPOSITORY ROOT NOT FOUND");
        }
        return {canonicalRoot, device: String(stats.dev), inode: String(stats.ino)};
    }

    _sameRoot(snapshot) {
        try {
            const current = this._rootSnapshot();
            return current.canonicalRoot === snapshot.canonicalRoot
                && current.device === snapshot.device && current.inode === snapshot.inode;
        } catch (error) {
            return false;
        }
    }

    _reserveDestination(parsed) {
        const root = this._rootSnapshot();
        const collisionKey = canonicalCollisionKey(parsed.repository);
        let children;
        try {
            children = this.fs.readdirSync(root.canonicalRoot);
        } catch (error) {
            throw new RepositoryGitError("REPOSITORY ROOT NOT FOUND");
        }
        if (children.some(child => canonicalCollisionKey(child) === collisionKey)) {
            throw new RepositoryGitError("REPOSITORY ALREADY EXISTS");
        }
        const destination = this.path.join(root.canonicalRoot, parsed.repository);
        if (this.path.dirname(destination) !== root.canonicalRoot
            || this.path.basename(destination) !== parsed.repository) {
            throw new RepositoryGitError("CLONE DESTINATION REFUSED");
        }
        let created = false;
        let reservedIdentity = null;
        try {
            this.fs.mkdirSync(destination, {mode: 0o700});
            created = true;
            const entry = this.fs.lstatSync(destination);
            const stats = this.fs.statSync(destination);
            if (entry.isSymbolicLink() || !stats.isDirectory()
                || this.fs.realpathSync(destination) !== destination) throw new Error("unsafe destination");
            reservedIdentity = {device: String(stats.dev), inode: String(stats.ino)};
            let descriptor = null;
            let cloneTarget = destination;
            if (process.platform === "linux") {
                descriptor = this.fs.openSync(
                    destination,
                    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
                );
                const descriptorStats = this.fs.fstatSync(descriptor);
                if (String(descriptorStats.dev) !== String(stats.dev)
                    || String(descriptorStats.ino) !== String(stats.ino)) {
                    this.fs.closeSync(descriptor);
                    throw new Error("destination changed");
                }
                cloneTarget = "/proc/self/fd/3";
            }
            return {
                root,
                destination,
                descriptor,
                cloneTarget,
                childName: parsed.repository,
                device: String(stats.dev),
                inode: String(stats.ino)
            };
        } catch (error) {
            if (error && error.code === "EEXIST") throw new RepositoryGitError("REPOSITORY ALREADY EXISTS");
            if (created) {
                try {
                    const entry = this.fs.lstatSync(destination);
                    const stats = this.fs.statSync(destination);
                    if (reservedIdentity && !entry.isSymbolicLink() && stats.isDirectory()
                        && String(stats.dev) === reservedIdentity.device
                        && String(stats.ino) === reservedIdentity.inode
                        && this.fs.realpathSync(destination) === destination) {
                        this.fs.rmdirSync(destination);
                    }
                } catch (cleanupError) {
                    this.log("warn", "CLONE DESTINATION RESERVATION CLEANUP FAILED");
                }
            }
            throw new RepositoryGitError("CLONE DESTINATION REFUSED");
        }
    }

    _closeReservationDescriptor(reservation) {
        if (!reservation || !Number.isInteger(reservation.descriptor)) return;
        const descriptor = reservation.descriptor;
        reservation.descriptor = null;
        try {
            this.fs.closeSync(descriptor);
        } catch (error) {
            this.log("warn", "CLONE DESTINATION DESCRIPTOR CLOSE FAILED");
        }
    }

    _verifyReservation(reservation) {
        if (!this._verifyReservationIdentity(reservation)) return false;
        try {
            const collisionKey = canonicalCollisionKey(reservation.childName);
            const collisions = this.fs.readdirSync(reservation.root.canonicalRoot)
                .filter(child => canonicalCollisionKey(child) === collisionKey);
            return collisions.length === 1 && collisions[0] === reservation.childName;
        } catch (error) {
            return false;
        }
    }

    _verifyReservationIdentity(reservation) {
        if (!reservation || !this._sameRoot(reservation.root)) return false;
        try {
            const entry = this.fs.lstatSync(reservation.destination);
            const stats = this.fs.statSync(reservation.destination);
            return !entry.isSymbolicLink() && stats.isDirectory()
                && String(stats.dev) === reservation.device && String(stats.ino) === reservation.inode
                && this.fs.realpathSync(reservation.destination) === reservation.destination
                && this.path.dirname(reservation.destination) === reservation.root.canonicalRoot;
        } catch (error) {
            return false;
        }
    }

    _verifyStandaloneGitDirectory(reservation) {
        if (!this._verifyReservation(reservation)) return false;
        try {
            const gitDirectory = this.path.join(reservation.destination, ".git");
            const entry = this.fs.lstatSync(gitDirectory);
            return entry.isDirectory() && !entry.isSymbolicLink()
                && this.fs.realpathSync(gitDirectory) === gitDirectory;
        } catch (error) {
            return false;
        }
    }

    _cleanupReservation(reservation) {
        if (!this._verifyReservationIdentity(reservation)) return false;
        try {
            this.fs.rmSync(reservation.destination, {recursive: true, force: false, maxRetries: 2});
            return true;
        } catch (error) {
            this.log("warn", "PARTIAL REPOSITORY CLEANUP FAILED");
            return false;
        }
    }

    _sanitizeProgress(value, reservation) {
        let sanitized = String(value || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
            .replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
            .replace(/\b(authorization|password|token|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
            .trim();
        [reservation.destination, reservation.root.canonicalRoot, reservation.cloneTarget].forEach(secret => {
            if (secret) sanitized = sanitized.split(secret).join(reservation.childName);
        });
        return sanitized.slice(-160);
    }

    async _setCanonicalCloneRemote(reservation, canonicalUrl) {
        if (!Number.isInteger(reservation.descriptor)) {
            return this.executor.execute(reservation.destination, ["remote", "set-url", "origin", canonicalUrl]);
        }
        let spawned;
        try {
            spawned = this.executor.spawn("/proc/self/fd/3", [
                "remote", "set-url", "origin", canonicalUrl
            ], {
                detached: false,
                stdio: ["ignore", "ignore", "pipe", reservation.descriptor]
            });
        } catch (error) {
            return {ok: false};
        }
        return new Promise(resolve => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled) return;
                try {
                    spawned.child.kill("SIGKILL");
                } catch (error) {
                    // Close/error will report failure when available.
                }
            }, 3000);
            const finish = ok => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ok});
            };
            spawned.child.once("error", () => finish(false));
            spawned.child.once("close", code => finish(code === 0));
        });
    }

    clone(candidate) {
        if (this.activeClone) return Promise.resolve({ok: false, status: "CLONE ALREADY IN PROGRESS"});
        const parsed = parseGithubRepository(candidate);
        if (!parsed) return Promise.resolve({ok: false, status: "INVALID GITHUB REPOSITORY URL"});

        let reservation;
        let spawned;
        try {
            reservation = this._reserveDestination(parsed);
            if (!this._verifyReservation(reservation)) {
                throw new RepositoryGitError("CLONE DESTINATION REFUSED");
            }
            spawned = this.executor.spawn(null, [
                "clone",
                "--progress",
                "--no-local",
                "--no-hardlinks",
                "--no-recurse-submodules",
                "--origin", "origin",
                "--",
                parsed.canonicalUrl,
                reservation.cloneTarget
            ], {
                cwd: reservation.root.canonicalRoot,
                detached: this.detachedClone,
                network: true,
                stdio: Number.isInteger(reservation.descriptor)
                    ? ["ignore", "ignore", "pipe", reservation.descriptor]
                    : ["ignore", "ignore", "pipe"]
            });
        } catch (error) {
            if (reservation) {
                this._closeReservationDescriptor(reservation);
                this._cleanupReservation(reservation);
            }
            const status = error instanceof RepositoryGitError ? error.status : "CLONE FAILED";
            return Promise.resolve({ok: false, status});
        }

        const child = spawned.child;
        const record = {
            child,
            parsed,
            reservation,
            stderr: "",
            progress: "",
            cancelled: false,
            timedOut: false,
            settled: false,
            timeout: null,
            killTimeout: null,
            completion: null
        };
        this.activeClone = record;
        this._emit({operation: "clone", state: "CLONING", repository: parsed.repository, progress: ""});

        record.completion = new Promise(resolve => {
            const finish = async (code, spawnError) => {
                if (record.settled) return;
                record.settled = true;
                clearTimeout(record.timeout);
                clearTimeout(record.killTimeout);

                let result;
                if (record.cancelled) {
                    this._closeReservationDescriptor(reservation);
                    this._cleanupReservation(reservation);
                    await this.repositoryService.refresh();
                    result = {ok: false, status: "CLONE CANCELLED"};
                } else if (record.timedOut) {
                    this._closeReservationDescriptor(reservation);
                    this._cleanupReservation(reservation);
                    await this.repositoryService.refresh();
                    result = {ok: false, status: "CLONE TIMED OUT"};
                } else if (spawnError || code !== 0) {
                    this._closeReservationDescriptor(reservation);
                    this._cleanupReservation(reservation);
                    await this.repositoryService.refresh();
                    result = {
                        ok: false,
                        status: authenticationFailure(record.stderr)
                            ? "AUTHENTICATION REQUIRED\nUSE EXISTING GIT CREDENTIAL CONFIGURATION"
                            : "CLONE FAILED"
                    };
                } else if (!this._verifyReservation(reservation)) {
                    this._closeReservationDescriptor(reservation);
                    await this.repositoryService.refresh();
                    result = {ok: false, status: "CLONE DESTINATION REFUSED"};
                } else if (!this._verifyStandaloneGitDirectory(reservation)) {
                    this._closeReservationDescriptor(reservation);
                    this._cleanupReservation(reservation);
                    await this.repositoryService.refresh();
                    result = {ok: false, status: "CLONED REPOSITORY VALIDATION FAILED"};
                } else {
                    const canonicalRemote = await this._setCanonicalCloneRemote(reservation, parsed.canonicalUrl);
                    const reservationStillValid = this._verifyReservation(reservation);
                    const gitDirectoryStillValid = this._verifyStandaloneGitDirectory(reservation);
                    this._closeReservationDescriptor(reservation);
                    if (record.cancelled) {
                        this._cleanupReservation(reservation);
                        await this.repositoryService.refresh();
                        result = {ok: false, status: "CLONE CANCELLED"};
                    } else {
                        const listing = canonicalRemote.ok && reservationStillValid && gitDirectoryStillValid
                            ? await this.repositoryService.refresh() : {repositories: []};
                        const repository = listing.repositories.find(item => item.displayName === reservation.childName);
                        const internal = repository && this.repositoryService.repositories.get(repository.id);
                        const finalReservationValid = this._verifyReservation(reservation);
                        if (!canonicalRemote.ok || !reservationStillValid || !gitDirectoryStillValid
                            || !finalReservationValid || !this._verifyStandaloneGitDirectory(reservation)
                            || !repository || !internal || internal.childName !== reservation.childName
                            || internal.canonicalPath !== reservation.destination
                            || internal.directoryDevice !== reservation.device || internal.directoryInode !== reservation.inode
                            || internal.public.githubUrl !== parsed.canonicalUrl) {
                            this._cleanupReservation(reservation);
                            await this.repositoryService.refresh();
                            result = {ok: false, status: "CLONED REPOSITORY VALIDATION FAILED"};
                        } else {
                            result = {
                                ok: true,
                                status: "CLONE COMPLETE\nREPOSITORY REGISTERED",
                                repositoryId: repository.id
                            };
                        }
                    }
                }

                if (this.activeClone === record) this.activeClone = null;
                this._emit({
                    operation: "clone",
                    state: result.ok ? "COMPLETE" : "FAILED",
                    repository: parsed.repository,
                    status: result.status,
                    progress: record.progress
                });
                resolve(result);
            };

            if (child.stderr && typeof child.stderr.on === "function") {
                child.stderr.on("data", chunk => {
                    record.stderr = `${record.stderr}${String(chunk)}`.slice(-65536);
                    record.progress = this._sanitizeProgress(chunk, reservation);
                    if (record.progress) this._emit({
                        operation: "clone",
                        state: "CLONING",
                        repository: parsed.repository,
                        progress: record.progress
                    });
                });
            }
            child.once("error", error => finish(null, error));
            child.once("close", code => finish(code, null));
            record.timeout = setTimeout(() => {
                if (record.settled) return;
                record.timedOut = true;
                this._signalClone(record, "SIGTERM");
                record.killTimeout = setTimeout(() => this._signalClone(record, "SIGKILL"), this.cancelGraceMs);
            }, this.cloneTimeoutMs);
        });
        return record.completion;
    }

    _signalClone(record, signal) {
        if (!record || record.settled || !record.child) return false;
        const pid = record.child.pid;
        try {
            if (process.platform !== "win32" && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
                process.kill(-pid, signal);
            } else if (typeof record.child.kill === "function") {
                record.child.kill(signal);
            } else return false;
            return true;
        } catch (error) {
            try {
                return typeof record.child.kill === "function" ? record.child.kill(signal) : false;
            } catch (fallbackError) {
                return false;
            }
        }
    }

    async cancelClone(force = false) {
        const record = this.activeClone;
        if (!record) return {ok: false, status: "NO CLONE IN PROGRESS"};
        record.cancelled = true;
        this._signalClone(record, force ? "SIGKILL" : "SIGTERM");
        if (!force) {
            clearTimeout(record.killTimeout);
            record.killTimeout = setTimeout(() => this._signalClone(record, "SIGKILL"), this.cancelGraceMs);
        }
        return record.completion;
    }

    async _configValues(repositoryPath, key) {
        const result = await this.executor.execute(repositoryPath, [
            "config", "--includes", "--null", "--get-all", key
        ]);
        if (!result.ok && result.exitCode !== 1) return null;
        return result.ok ? parseNullValues(result.stdout) : [];
    }

    async _operationInProgress(repositoryPath) {
        const result = await this.executor.execute(repositoryPath, ["rev-parse", "--absolute-git-dir"]);
        if (!result.ok) return null;
        const gitDirectory = result.stdout.trim();
        if (!gitDirectory || !this.path.isAbsolute(gitDirectory) || gitDirectory.includes("\0")) return null;
        const checks = IN_PROGRESS_PATHS.map(marker => {
            try {
                return this.fs.existsSync(this.path.join(gitDirectory, marker));
            } catch (error) {
                return null;
            }
        });
        if (checks.some(value => value === null)) return null;
        return {inProgress: checks.some(value => value === true), gitDirectory};
    }

    async _dangerousNetworkConfiguration(repositoryPath) {
        const result = await this.executor.execute(repositoryPath, [
            "config", "--includes", "--show-scope", "--null", "--name-only", "--get-regexp",
            "^(url\\..*\\.(insteadof|pushinsteadof)|http\\.|credential\\.|core\\.(askpass|sshcommand)|remote\\..*\\.(uploadpack|receivepack)|branch\\..*\\.mergeoptions|merge\\..*\\.driver|protocol\\.)"
        ]);
        if (!result.ok && result.exitCode !== 1) return null;
        if (!result.ok) return false;
        const scopedKeys = parseNullValues(result.stdout);
        if (scopedKeys.length % 2 !== 0) return null;
        for (let index = 0; index < scopedKeys.length; index += 2) {
            if (scopedKeys[index] !== "command") return true;
        }
        return false;
    }

    async inspectUpdate(record) {
        if (!record || typeof record.canonicalPath !== "string") {
            return updateFailure("REPOSITORY NOT FOUND", "UNAVAILABLE");
        }
        const repositoryPath = record.canonicalPath;
        const filterOverrides = await this.repositoryService._filterOverrides(repositoryPath);
        if (filterOverrides === null) return updateFailure("REPOSITORY STATUS UNAVAILABLE", "UNAVAILABLE");

        const [operationState, statusResult, branchResult, headResult, topLevelResult, dangerousConfiguration] = await Promise.all([
            this._operationInProgress(repositoryPath),
            this.executor.execute(repositoryPath, [
                "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"
            ], {configOverrides: filterOverrides}),
            this.executor.execute(repositoryPath, ["symbolic-ref", "--short", "-q", "HEAD"]),
            this.executor.execute(repositoryPath, ["rev-parse", "--verify", "HEAD"]),
            this.executor.execute(repositoryPath, ["rev-parse", "--show-toplevel"]),
            this._dangerousNetworkConfiguration(repositoryPath)
        ]);
        if (operationState === null || dangerousConfiguration === null || !statusResult.ok
            || !headResult.ok || !topLevelResult.ok) {
            return updateFailure("REPOSITORY STATUS UNAVAILABLE", "UNAVAILABLE");
        }
        try {
            if (this.fs.realpathSync(topLevelResult.stdout.trim()) !== repositoryPath) {
                return updateFailure("REPOSITORY WORKTREE UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
            }
            const gitEntry = this.path.join(repositoryPath, ".git");
            if (!this.fs.lstatSync(gitEntry).isDirectory()
                || this.fs.realpathSync(gitEntry) !== this.fs.realpathSync(operationState.gitDirectory)) {
                return updateFailure("REPOSITORY GIT DIRECTORY UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
            }
        } catch (error) {
            return updateFailure("REPOSITORY WORKTREE UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
        }
        if (operationState.inProgress) {
            return updateFailure("REPOSITORY OPERATION IN PROGRESS\nUPDATE ABORTED", "UNAVAILABLE");
        }
        if (this.repositoryService._statusEntryCount(statusResult.stdout) > 0) {
            return updateFailure("LOCAL CHANGES DETECTED\nUPDATE ABORTED", "DIRTY");
        }
        if (!branchResult.ok) return updateFailure("DETACHED HEAD\nUPDATE ABORTED", "UNAVAILABLE");
        const branch = branchResult.stdout.replace(/[\r\n]+$/, "");
        const head = headResult.stdout.trim().toLowerCase();
        if (!branch || branch.length > 255 || containsControlCharacters(branch) || !HASH_PATTERN.test(head)) {
            return updateFailure("REPOSITORY STATUS UNAVAILABLE", "UNAVAILABLE");
        }

        const upstreamResult = await this.executor.execute(repositoryPath, [
            "for-each-ref",
            "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
            `refs/heads/${branch}`
        ]);
        if (!upstreamResult.ok) return updateFailure("REPOSITORY STATUS UNAVAILABLE", "UNAVAILABLE");
        const upstreamParts = upstreamResult.stdout.replace(/[\r\n]+$/, "").split("\0");
        if (upstreamParts.length < 4 || !upstreamParts[1] || !upstreamParts[2] || !upstreamParts[3]) {
            return updateFailure("NO UPSTREAM\nUPDATE ABORTED", "NO UPSTREAM");
        }
        const [branchRef, upstream, remoteName, remoteRef] = upstreamParts;
        if (branchRef !== `refs/heads/${branch}` || !SAFE_REMOTE_NAME.test(remoteName)
            || remoteName === "." || !isSafeRef(remoteRef, "refs/heads/")) {
            return updateFailure("REMOTE IDENTITY UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
        }
        const trackingResult = await this.executor.execute(repositoryPath, [
            "rev-parse", "--symbolic-full-name", "@{upstream}"
        ]);
        if (!trackingResult.ok) return updateFailure("NO UPSTREAM\nUPDATE ABORTED", "NO UPSTREAM");
        const trackingRef = trackingResult.stdout.trim();
        if (!isSafeRef(trackingRef, `refs/remotes/${remoteName}/`)) {
            return updateFailure("REMOTE IDENTITY UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
        }
        if (dangerousConfiguration) {
            return updateFailure("REMOTE CONFIGURATION UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
        }

        const [originUrls, upstreamUrls] = await Promise.all([
            this._configValues(repositoryPath, "remote.origin.url"),
            remoteName === "origin" ? Promise.resolve(null)
                : this._configValues(repositoryPath, `remote.${remoteName}.url`)
        ]);
        if (originUrls === null || (upstreamUrls === null && remoteName !== "origin")) {
            return updateFailure("REMOTE IDENTITY UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
        }
        const selectedUpstreamUrls = remoteName === "origin" ? originUrls : upstreamUrls;
        if (originUrls.length !== 1 || selectedUpstreamUrls.length !== 1) {
            return updateFailure("REMOTE IDENTITY AMBIGUOUS\nUPDATE ABORTED", "UNAVAILABLE");
        }
        const originIdentity = parseGithubRepository(originUrls[0]);
        const upstreamIdentity = parseGithubRepository(selectedUpstreamUrls[0]);
        if (!originIdentity || !upstreamIdentity) {
            return updateFailure("REMOTE IDENTITY UNSAFE\nUPDATE ABORTED", "UNAVAILABLE");
        }

        return {
            ok: true,
            status: "PULL",
            state: "PULL",
            branch,
            head,
            upstream,
            remoteName,
            remoteRef,
            trackingRef,
            remoteUrl: upstreamIdentity.canonicalUrl,
            remoteIdentity: upstreamIdentity.identity,
            originIdentity: originIdentity.identity,
            filterOverrides,
            repositoryIdentity: record.repositoryIdentity
        };
    }

    _samePreflight(before, after) {
        return before.ok && after.ok && before.branch === after.branch && before.head === after.head
            && before.upstream === after.upstream && before.remoteName === after.remoteName
            && before.remoteRef === after.remoteRef && before.trackingRef === after.trackingRef
            && before.remoteUrl === after.remoteUrl && before.remoteIdentity === after.remoteIdentity
            && before.originIdentity === after.originIdentity
            && JSON.stringify(before.filterOverrides) === JSON.stringify(after.filterOverrides)
            && before.repositoryIdentity === after.repositoryIdentity;
    }

    async pull(record) {
        if (!record || typeof record.id !== "string") return {ok: false, status: "REPOSITORY NOT FOUND"};
        if (this.activeUpdates.has(record.id)) return {ok: false, status: "UPDATE ALREADY IN PROGRESS"};
        this.activeUpdates.add(record.id);
        let completed = false;
        this._emit({operation: "pull", state: "UPDATING", repositoryId: record.id});
        try {
            const verified = await this.repositoryService.resolveRepository(record.id, {refreshMetadata: true});
            const before = await this.inspectUpdate(verified);
            if (!before.ok) return {ok: false, status: before.status};

            const fetchResult = await this.executor.execute(verified.canonicalPath, [
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--",
                before.remoteUrl,
                `${before.remoteRef}:${before.trackingRef}`
            ], {
                configOverrides: before.filterOverrides,
                network: true,
                timeout: this.updateTimeoutMs
            });
            if (!fetchResult.ok) {
                return {
                    ok: false,
                    status: authenticationFailure(fetchResult.stderr)
                        ? "AUTHENTICATION REQUIRED\nUSE EXISTING GIT CREDENTIAL CONFIGURATION"
                        : (/non-fast-forward|would clobber existing tag|rejected/i.test(fetchResult.stderr)
                            ? "UPDATE REQUIRES MANUAL RESOLUTION" : "UPDATE FAILED")
                };
            }

            const current = await this.repositoryService.resolveRepository(record.id, {refreshMetadata: true});
            const afterFetch = await this.inspectUpdate(current);
            if (!this._samePreflight(before, afterFetch)) {
                return {ok: false, status: "REPOSITORY CHANGED DURING UPDATE\nUPDATE ABORTED"};
            }
            const upstreamHashResult = await this.executor.execute(current.canonicalPath, [
                "rev-parse", "--verify", afterFetch.trackingRef
            ]);
            if (!upstreamHashResult.ok || !HASH_PATTERN.test(upstreamHashResult.stdout.trim().toLowerCase())) {
                return {ok: false, status: "UPDATE FAILED"};
            }
            const upstreamHash = upstreamHashResult.stdout.trim().toLowerCase();
            let status = "ALREADY UP TO DATE";

            if (afterFetch.head !== upstreamHash) {
                const fastForward = await this.executor.execute(current.canonicalPath, [
                    "merge-base", "--is-ancestor", "HEAD", upstreamHash
                ]);
                if (fastForward.ok) {
                    const finalCheck = await this.inspectUpdate(current);
                    if (!this._samePreflight(afterFetch, finalCheck)) {
                        return {ok: false, status: "REPOSITORY CHANGED DURING UPDATE\nUPDATE ABORTED"};
                    }
                    const mergeResult = await this.executor.execute(current.canonicalPath, [
                        "merge", "--ff-only", "--no-edit", "--no-stat", upstreamHash
                    ], {
                        configOverrides: afterFetch.filterOverrides.concat([
                            ["merge.autoStash", "false"],
                            ["rerere.enabled", "false"]
                        ]),
                        timeout: this.updateTimeoutMs
                    });
                    if (!mergeResult.ok) {
                        return {ok: false, status: "UPDATE REQUIRES MANUAL RESOLUTION"};
                    }
                    status = "UPDATE COMPLETE";
                } else {
                    const localAhead = await this.executor.execute(current.canonicalPath, [
                        "merge-base", "--is-ancestor", upstreamHash, "HEAD"
                    ]);
                    if (!localAhead.ok) {
                        return {ok: false, status: "UPDATE REQUIRES MANUAL RESOLUTION"};
                    }
                }
            }

            const refreshed = await this.repositoryService.resolveRepository(record.id, {refreshMetadata: true});
            completed = true;
            return {ok: true, status, repositoryId: refreshed.id};
        } catch (error) {
            return {
                ok: false,
                status: error instanceof RepositoryGitError || (error && typeof error.status === "string")
                    ? error.status : "UPDATE FAILED"
            };
        } finally {
            this.activeUpdates.delete(record.id);
            this._emit({operation: "pull", state: completed ? "COMPLETE" : "FAILED", repositoryId: record.id});
        }
    }
}

module.exports = {
    DEFAULT_CLONE_TIMEOUT_MS,
    DEFAULT_UPDATE_TIMEOUT_MS,
    RepositoryGitError,
    RepositoryGitExecutor,
    RepositoryGitService,
    authenticationFailure,
    canonicalCollisionKey,
    isNormalizedGithubUrl,
    normalizeGithubRemote,
    parseGithubRepository,
    resolveGitExecutable
};
