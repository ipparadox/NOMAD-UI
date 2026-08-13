const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {spawnSync} = require("child_process");
const {SECURITY_PROFILES, normalizeSecurityProfile} = require("./securityProfileService.js");

const ISOLATION_LEVELS = Object.freeze(["UNAVAILABLE", "NONE", "PARTIAL", "STRONG"]);
const ISOLATION_RANK = Object.freeze({UNAVAILABLE: -1, NONE: 0, PARTIAL: 1, STRONG: 2});
const SAFE_ENVIRONMENT_KEYS = new Set([
    "PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
    "SYSTEMROOT", "SystemRoot", "WINDIR", "PATHEXT"
]);
const SAFE_ENVIRONMENT_OVERRIDE_KEYS = new Set([
    "PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
    "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
    "SYSTEMROOT", "SystemRoot", "WINDIR", "PATHEXT"
]);
const SYSTEMD_HARDENING_PROPERTIES = Object.freeze([
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectSystem=strict",
    "ProtectHome=tmpfs",
    "ProtectControlGroups=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "RestrictRealtime=yes",
    "RestrictNamespaces=yes",
    "SystemCallArchitectures=native",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "UMask=0077",
    "KillMode=control-group",
    "TimeoutStopSec=5s",
    "InaccessiblePaths=-/run/user -/media -/mnt -/run/media"
]);

class RepositoryIsolationError extends Error {
    constructor(status) {
        super(status);
        this.name = "RepositoryIsolationError";
        this.status = status;
    }
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function validEnvironmentValue(value) {
    return typeof value === "string" && value.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSensitiveEnvironmentKey(key) {
    if (typeof key !== "string") return false;
    const upper = key.toUpperCase();
    if ([
        "SSH_AUTH_SOCK", "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "DATABASE_URL",
        "KUBECONFIG", "DOCKER_AUTH_CONFIG", "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH",
        "NODE_DEBUG", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "RUBYOPT", "PERL5OPT",
        "ELECTRON_RUN_AS_NODE", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND",
        "NPM_CONFIG_USERCONFIG"
    ].includes(upper)) return true;
    return /^(AWS|AZURE|GOOGLE|GCP|VAULT|NPM|YARN|PIP|NVM|CARGO|SSH|GCM|GIT_CONFIG)_/.test(upper)
        || /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|ACCESS_KEY)(_|$)/.test(upper)
        || /^(LD_|DYLD_)/.test(upper);
}

function buildRepositoryRunEnvironment(source = process.env, overrides = {}) {
    const environment = {};
    Object.keys(source || {}).forEach(key => {
        if (!SAFE_ENVIRONMENT_KEYS.has(key) && !/^LC_[A-Z0-9_]+$/.test(key)) return;
        if (!validEnvironmentValue(source[key])) return;
        environment[key] = source[key];
    });
    Object.keys(overrides || {}).forEach(key => {
        if ((!SAFE_ENVIRONMENT_OVERRIDE_KEYS.has(key) && !/^LC_[A-Z0-9_]+$/.test(key))
            || !validEnvironmentValue(overrides[key])) return;
        environment[key] = overrides[key];
    });
    return environment;
}

function resolveExecutable(executable, opts = {}) {
    const fsModule = opts.fs || fs;
    const pathModule = opts.path || path;
    const environment = opts.env || process.env;
    const platform = opts.platform || process.platform;
    if (typeof executable !== "string" || !executable || executable.includes("\0")) return null;
    if (pathModule.isAbsolute(executable)) {
        try {
            const canonical = fsModule.realpathSync(executable);
            const stats = fsModule.statSync(canonical);
            if (!stats.isFile()) return null;
            if (platform !== "win32") fsModule.accessSync(canonical, (fsModule.constants || fs.constants).X_OK);
            return canonical;
        } catch (error) {
            return null;
        }
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._+@%-]*$/.test(executable)) return null;
    const extensions = platform === "win32"
        ? String(environment.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
    for (const directory of String(environment.PATH || "").split(pathModule.delimiter)) {
        if (!directory || !pathModule.isAbsolute(directory)) continue;
        for (const extension of extensions) {
            const candidate = pathModule.join(directory, `${executable}${extension}`);
            const resolved = resolveExecutable(candidate, opts);
            if (resolved) return resolved;
        }
    }
    return null;
}

function levelAtLeast(actual, required) {
    return Object.prototype.hasOwnProperty.call(ISOLATION_RANK, actual)
        && Object.prototype.hasOwnProperty.call(ISOLATION_RANK, required)
        && ISOLATION_RANK[actual] >= ISOLATION_RANK[required];
}

function escapeSystemdPath(value) {
    if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) return null;
    let output = "";
    for (const byte of Buffer.from(value, "utf8")) {
        const character = String.fromCharCode(byte);
        if (/[A-Za-z0-9/_.-]/.test(character)) output += character;
        else output += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
    return output;
}

class RepositoryIsolationService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.os = opts.os || os;
        this.platform = opts.platform || process.platform;
        this.environment = opts.env || process.env;
        this.home = opts.home || this.os.homedir();
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
        this.spawnSync = opts.spawnSync || spawnSync;
        this.randomBytes = opts.randomBytes || crypto.randomBytes;
        this.probeBackend = typeof opts.probeBackend === "function" ? opts.probeBackend : null;
        this.resolveExecutable = opts.resolveExecutable || (executable => resolveExecutable(executable, {
            fs: this.fs,
            path: this.path,
            env: this.environment,
            platform: this.platform
        }));
        this.runtimeRoot = opts.runtimeRoot || this.path.join(this.os.tmpdir(), "nomad-repository-runtime");
        this.capabilityCache = null;
    }

    capabilities(force = false) {
        if (this.capabilityCache && !force) return clone(this.capabilityCache);
        const backends = [];
        if (this.platform === "linux") {
            backends.push(this._detectBubblewrap());
            backends.push(this._detectSystemdUser());
        } else {
            backends.push({
                id: "BUBBLEWRAP",
                level: "STRONG",
                available: false,
                reason: "LINUX-ONLY BACKEND"
            });
            backends.push({
                id: "SYSTEMD_USER",
                level: "PARTIAL",
                available: false,
                reason: "LINUX-ONLY BACKEND"
            });
        }
        backends.push({
            id: "DIRECT",
            level: "NONE",
            available: true,
            reason: "SUPERVISED DIRECT EXECUTION; NO FILESYSTEM SANDBOX"
        });
        const available = backends.filter(backend => backend.available)
            .sort((left, right) => ISOLATION_RANK[right.level] - ISOLATION_RANK[left.level]);
        this.capabilityCache = {
            maximumLevel: available.length ? available[0].level : "UNAVAILABLE",
            preferredBackend: available.length ? available[0].id : "UNAVAILABLE",
            backends
        };
        return clone(this.capabilityCache);
    }

    evaluatePolicy(profileValue) {
        const profileId = normalizeSecurityProfile(profileValue);
        const policy = profileId ? SECURITY_PROFILES[profileId] : null;
        if (!policy) return this._blocked("UNKNOWN", "SECURITY PROFILE UNAVAILABLE");
        const capabilities = this.capabilities();
        if (policy.repositoryExecution === "DISABLED") {
            return this._blocked(profileId, "LOCKDOWN POLICY DISABLES REPOSITORY EXECUTION", {
                requiredLevel: policy.minimumRepositoryIsolation,
                availableLevel: capabilities.maximumLevel
            });
        }
        const suitable = capabilities.backends.filter(backend => backend.available
            && levelAtLeast(backend.level, policy.minimumRepositoryIsolation))
            .sort((left, right) => ISOLATION_RANK[right.level] - ISOLATION_RANK[left.level]);
        if (!suitable.length) return this._blocked(profileId, "ISOLATION REQUIREMENT NOT MET", {
            requiredLevel: policy.minimumRepositoryIsolation,
            availableLevel: capabilities.maximumLevel
        });
        return {
            allowed: true,
            securityProfile: profileId,
            requiredLevel: policy.minimumRepositoryIsolation,
            availableLevel: capabilities.maximumLevel,
            level: suitable[0].level,
            backend: suitable[0].id,
            reason: suitable[0].reason,
            status: "EXECUTION PERMITTED"
        };
    }

    prepareExecution(spec) {
        const profileId = normalizeSecurityProfile(spec && spec.securityProfile);
        const policy = profileId ? SECURITY_PROFILES[profileId] : null;
        if (!policy) return this._blocked("UNKNOWN", "SECURITY PROFILE UNAVAILABLE");
        const evaluation = this.evaluatePolicy(profileId);
        if (!evaluation.allowed) return evaluation;
        this._validateExecutionSpec(spec);
        const capabilities = this.capabilities();
        const suitable = capabilities.backends.filter(backend => backend.available
            && levelAtLeast(backend.level, policy.minimumRepositoryIsolation))
            .sort((left, right) => ISOLATION_RANK[right.level] - ISOLATION_RANK[left.level]);
        if (!suitable.length) {
            return this._blocked(profileId, "ISOLATION REQUIREMENT NOT MET", {
                requiredLevel: policy.minimumRepositoryIsolation,
                availableLevel: capabilities.maximumLevel
            });
        }
        const backend = suitable[0];
        if (backend.id === "BUBBLEWRAP") return this._bubblewrapPlan(spec, profileId, backend);
        if (backend.id === "SYSTEMD_USER") return this._systemdPlan(spec, profileId, backend);
        return this._directPlan(spec, profileId, backend);
    }

    signal(controller, signal) {
        if (!controller || controller.kind !== "SYSTEMD_USER") return false;
        if (!/^nomad-repository-[a-f0-9-]+\.service$/.test(controller.unitName || "")
            || !["SIGTERM", "SIGKILL"].includes(signal)) return false;
        const result = this.spawnSync(controller.systemctl, [
            "--user", "kill", "--kill-whom=all", `--signal=${signal}`, controller.unitName
        ], {
            encoding: "utf8",
            env: this._controllerEnvironment(),
            shell: false,
            timeout: 5000,
            windowsHide: true
        });
        return Boolean(result && result.status === 0);
    }

    cleanup(plan) {
        if (!plan || typeof plan.runtimeDirectory !== "string") return;
        const relative = this.path.relative(this.runtimeRoot, plan.runtimeDirectory);
        if (!relative || relative.startsWith("..") || this.path.isAbsolute(relative)
            || !/^repo_[a-f0-9]{32}-[A-Za-z0-9_-]+$/.test(relative)) return;
        try {
            const rootStats = this.fs.lstatSync(this.runtimeRoot);
            const runtimeStats = this.fs.lstatSync(plan.runtimeDirectory);
            if (rootStats.isSymbolicLink() || !rootStats.isDirectory()
                || runtimeStats.isSymbolicLink() || !runtimeStats.isDirectory()
                || !this._ownedByUser(rootStats) || !this._ownedByUser(runtimeStats)
                || (rootStats.mode & 0o077) !== 0 || (runtimeStats.mode & 0o077) !== 0) return;
            this.fs.rmSync(plan.runtimeDirectory, {recursive: true, force: true});
        } catch (error) {}
    }

    _detectBubblewrap() {
        const executable = this.resolveExecutable("bwrap");
        if (!executable) return {
            id: "BUBBLEWRAP", level: "STRONG", available: false, reason: "BUBBLEWRAP NOT AVAILABLE"
        };
        const trueExecutable = this.resolveExecutable("true") || "/usr/bin/true";
        const probeDirectory = this.path.resolve(process.cwd());
        const context = {executable, trueExecutable, probeDirectory};
        const available = this._probe("BUBBLEWRAP", context, () => {
            const result = this.spawnSync(executable, this._bubblewrapArguments(
                probeDirectory, trueExecutable, [], buildRepositoryRunEnvironment(this.environment, {
                    HOME: "/tmp", TMPDIR: "/tmp", XDG_CONFIG_HOME: "/tmp/config",
                    XDG_CACHE_HOME: "/tmp/cache", XDG_DATA_HOME: "/tmp/data"
                })
            ), {
                encoding: "utf8",
                env: buildRepositoryRunEnvironment(this.environment),
                shell: false,
                timeout: 5000,
                windowsHide: true
            });
            return Boolean(result && result.status === 0);
        });
        return {
            id: "BUBBLEWRAP",
            level: "STRONG",
            available,
            reason: available
                ? "BUBBLEWRAP FILESYSTEM AND PROCESS NAMESPACES VERIFIED; NETWORK SHARED BY POLICY"
                : "BUBBLEWRAP POLICY PROBE FAILED"
        };
    }

    _detectSystemdUser() {
        const executable = this.resolveExecutable("systemd-run");
        const systemctl = this.resolveExecutable("systemctl");
        const envExecutable = this.resolveExecutable("env");
        const trueExecutable = this.resolveExecutable("true") || "/usr/bin/true";
        if (!executable || !systemctl || !envExecutable) return {
            id: "SYSTEMD_USER", level: "PARTIAL", available: false,
            reason: "SYSTEMD USER SANDBOX TOOLS NOT AVAILABLE"
        };
        const probeDirectory = this.path.resolve(process.cwd());
        const context = {executable, systemctl, envExecutable, trueExecutable, probeDirectory};
        const available = this._probe("SYSTEMD_USER", context, () => {
            const unitName = `nomad-repository-probe-${this.randomBytes(6).toString("hex")}.service`;
            const args = this._systemdArguments({
                unitName,
                repositoryPath: probeDirectory,
                envExecutable,
                executable: trueExecutable,
                args: [],
                environment: buildRepositoryRunEnvironment(this.environment, {
                    HOME: "/tmp", TMPDIR: "/tmp", XDG_CONFIG_HOME: "/tmp/config",
                    XDG_CACHE_HOME: "/tmp/cache", XDG_DATA_HOME: "/tmp/data"
                })
            });
            const result = this.spawnSync(executable, args, {
                encoding: "utf8",
                env: this._controllerEnvironment(),
                shell: false,
                timeout: 10000,
                windowsHide: true
            });
            return Boolean(result && result.status === 0);
        });
        return {
            id: "SYSTEMD_USER",
            level: "PARTIAL",
            available,
            reason: available
                ? "SYSTEMD USER HARDENING POLICY VERIFIED; NETWORK SHARED BY POLICY"
                : "SYSTEMD USER HARDENING POLICY PROBE FAILED"
        };
    }

    _probe(id, context, fallback) {
        try {
            if (this.probeBackend) return this.probeBackend(id, clone(context)) === true;
            return fallback() === true;
        } catch (error) {
            return false;
        }
    }

    _bubblewrapPlan(spec, profileId, backend) {
        const environment = buildRepositoryRunEnvironment(this.environment, {
            HOME: "/tmp", TMPDIR: "/tmp", XDG_CONFIG_HOME: "/tmp/config",
            XDG_CACHE_HOME: "/tmp/cache", XDG_DATA_HOME: "/tmp/data"
        });
        const bwrap = this.resolveExecutable("bwrap");
        if (!bwrap) return this._blocked(profileId, "ISOLATION BACKEND CHANGED");
        return {
            allowed: true,
            securityProfile: profileId,
            level: backend.level,
            backend: backend.id,
            reason: backend.reason,
            executable: bwrap,
            args: this._bubblewrapArguments(spec.repository.canonicalPath, spec.executable, spec.args, environment),
            cwd: "/",
            env: buildRepositoryRunEnvironment(this.environment),
            controller: null,
            runtimeDirectory: null
        };
    }

    _systemdPlan(spec, profileId, backend) {
        const systemdRun = this.resolveExecutable("systemd-run");
        const systemctl = this.resolveExecutable("systemctl");
        const envExecutable = this.resolveExecutable("env");
        if (!systemdRun || !systemctl || !envExecutable) {
            return this._blocked(profileId, "ISOLATION BACKEND CHANGED");
        }
        const unitName = `nomad-repository-${spec.repository.id.slice(5)}-${this.randomBytes(6).toString("hex")}.service`;
        const environment = buildRepositoryRunEnvironment(this.environment, {
            HOME: "/tmp", TMPDIR: "/tmp", XDG_CONFIG_HOME: "/tmp/config",
            XDG_CACHE_HOME: "/tmp/cache", XDG_DATA_HOME: "/tmp/data"
        });
        return {
            allowed: true,
            securityProfile: profileId,
            level: backend.level,
            backend: backend.id,
            reason: backend.reason,
            executable: systemdRun,
            args: this._systemdArguments({
                unitName,
                repositoryPath: spec.repository.canonicalPath,
                envExecutable,
                executable: spec.executable,
                args: spec.args,
                environment
            }),
            cwd: "/",
            env: this._controllerEnvironment(),
            controller: {kind: "SYSTEMD_USER", unitName, systemctl},
            runtimeDirectory: null
        };
    }

    _directPlan(spec, profileId, backend) {
        const runtimeDirectory = this._createRuntimeDirectory(spec.repository.id);
        const homeDirectory = this.path.join(runtimeDirectory, "home");
        const tempDirectory = this.path.join(runtimeDirectory, "tmp");
        const configDirectory = this.path.join(runtimeDirectory, "config");
        const cacheDirectory = this.path.join(runtimeDirectory, "cache");
        const dataDirectory = this.path.join(runtimeDirectory, "data");
        try {
            [homeDirectory, tempDirectory, configDirectory, cacheDirectory, dataDirectory].forEach(directory => {
                this.fs.mkdirSync(directory, {mode: 0o700});
            });
        } catch (error) {
            this.cleanup({runtimeDirectory});
            throw new RepositoryIsolationError("REPOSITORY RUNTIME UNAVAILABLE");
        }
        return {
            allowed: true,
            securityProfile: profileId,
            level: backend.level,
            backend: backend.id,
            reason: backend.reason,
            executable: spec.executable,
            args: spec.args.slice(),
            cwd: spec.repository.canonicalPath,
            env: buildRepositoryRunEnvironment(this.environment, {
                HOME: homeDirectory,
                TMPDIR: tempDirectory,
                XDG_CONFIG_HOME: configDirectory,
                XDG_CACHE_HOME: cacheDirectory,
                XDG_DATA_HOME: dataDirectory
            }),
            controller: null,
            runtimeDirectory
        };
    }

    _bubblewrapArguments(repositoryPath, executable, args, environment) {
        const output = [
            "--die-with-parent", "--new-session", "--unshare-all", "--share-net",
            "--tmpfs", "/"
        ];
        ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/run/systemd/resolve"].forEach(target => {
            try {
                if (this.fs.statSync(target).isDirectory()) output.push("--ro-bind", target, target);
            } catch (error) {}
        });
        output.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
        this._runtimeRoots(executable).forEach(runtimeRoot => {
            const parents = [];
            let current = this.path.dirname(runtimeRoot);
            while (current && current !== this.path.dirname(current) && current !== "/") {
                parents.unshift(current);
                current = this.path.dirname(current);
            }
            parents.forEach(parent => output.push("--dir", parent));
            output.push("--ro-bind", runtimeRoot, runtimeRoot);
        });
        output.push("--dir", "/workspace", "--bind", repositoryPath, "/workspace", "--chdir", "/workspace");
        output.push("--clearenv");
        Object.keys(environment).sort().forEach(key => output.push("--setenv", key, environment[key]));
        output.push("--cap-drop", "ALL", "--", executable);
        return output.concat(args);
    }

    _systemdArguments(spec) {
        const repositoryPropertyPath = escapeSystemdPath(spec.repositoryPath);
        if (!repositoryPropertyPath) throw new RepositoryIsolationError("REPOSITORY ISOLATION REQUEST INVALID");
        const args = [
            "--user", "--quiet", "--wait", "--collect", "--pipe", `--unit=${spec.unitName}`,
            `--working-directory=${spec.repositoryPath}`
        ];
        SYSTEMD_HARDENING_PROPERTIES.forEach(property => args.push(`--property=${property}`));
        args.push(`--property=BindPaths=${repositoryPropertyPath}`);
        args.push(`--property=ReadWritePaths=${repositoryPropertyPath}`);
        this._runtimeRoots(spec.executable).forEach(runtimeRoot => {
            const runtimePropertyPath = escapeSystemdPath(runtimeRoot);
            if (runtimePropertyPath) args.push(`--property=BindReadOnlyPaths=${runtimePropertyPath}`);
        });
        args.push("--", spec.envExecutable, "-i");
        Object.keys(spec.environment).sort().forEach(key => args.push(`${key}=${spec.environment[key]}`));
        args.push(spec.executable);
        return args.concat(spec.args);
    }

    _runtimeRoots(executable) {
        if (typeof executable !== "string" || !this.path.isAbsolute(executable)) return [];
        const relative = this.path.relative(this.home, executable);
        if (!relative || relative.startsWith("..") || this.path.isAbsolute(relative)) return [];
        const parts = relative.split(this.path.sep);
        if (parts.length >= 4 && parts[0] === ".nvm" && parts[1] === "versions" && parts[2] === "node") {
            return [this.path.join(this.home, parts[0], parts[1], parts[2], parts[3])];
        }
        return [this.path.dirname(executable)];
    }

    _controllerEnvironment() {
        const output = buildRepositoryRunEnvironment(this.environment);
        ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].forEach(key => {
            if (validEnvironmentValue(this.environment[key])) output[key] = this.environment[key];
        });
        return output;
    }

    _createRuntimeDirectory(repositoryId) {
        if (!/^repo_[a-f0-9]{32}$/.test(repositoryId || "") || !this.path.isAbsolute(this.runtimeRoot)) {
            throw new RepositoryIsolationError("REPOSITORY RUNTIME UNAVAILABLE");
        }
        try {
            this.fs.mkdirSync(this.runtimeRoot, {recursive: true, mode: 0o700});
            const stats = this.fs.lstatSync(this.runtimeRoot);
            if (stats.isSymbolicLink() || !stats.isDirectory() || !this._ownedByUser(stats)
                || (stats.mode & 0o077) !== 0) {
                throw new Error("unsafe repository runtime root");
            }
            return this.fs.mkdtempSync(this.path.join(this.runtimeRoot, `${repositoryId}-`));
        } catch (error) {
            throw new RepositoryIsolationError("REPOSITORY RUNTIME UNAVAILABLE");
        }
    }

    _blocked(profileId, reason, details = {}) {
        return {
            allowed: false,
            securityProfile: profileId,
            level: details.availableLevel || "UNAVAILABLE",
            backend: "UNAVAILABLE",
            requiredLevel: details.requiredLevel || (SECURITY_PROFILES[profileId]
                ? SECURITY_PROFILES[profileId].minimumRepositoryIsolation : "UNKNOWN"),
            reason,
            status: `EXECUTION BLOCKED\n${reason}`
        };
    }

    _ownedByUser(stats) {
        return this.uid === null || typeof stats.uid !== "number" || stats.uid === this.uid;
    }

    _validateExecutionSpec(spec) {
        if (!spec || !spec.repository || !/^repo_[a-f0-9]{32}$/.test(spec.repository.id || "")
            || typeof spec.repository.canonicalPath !== "string"
            || !this.path.isAbsolute(spec.repository.canonicalPath)
            || /[\u0000-\u001f\u007f]/.test(spec.repository.canonicalPath)
            || typeof spec.executable !== "string" || !this.path.isAbsolute(spec.executable)
            || /[\u0000-\u001f\u007f]/.test(spec.executable)
            || !Array.isArray(spec.args) || spec.args.length > 32
            || spec.args.some(argument => typeof argument !== "string" || argument.length > 4096 || argument.includes("\0"))) {
            throw new RepositoryIsolationError("REPOSITORY ISOLATION REQUEST INVALID");
        }
    }
}

module.exports = {
    ISOLATION_LEVELS,
    ISOLATION_RANK,
    RepositoryIsolationError,
    RepositoryIsolationService,
    SYSTEMD_HARDENING_PROPERTIES,
    buildRepositoryRunEnvironment,
    escapeSystemdPath,
    isSensitiveEnvironmentKey,
    levelAtLeast,
    resolveExecutable
};
