const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const {CliError} = require("./errors.js");
const {PACKAGE_CATALOG, resolvePackageDefinition} = require("./packageCatalog.js");

const FLATPAK_REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function findExecutablePath(command, opts = {}) {
    const fsModule = opts.fs || fs;
    const pathModule = opts.path || path;
    const mode = fsModule.constants ? fsModule.constants.X_OK : fs.constants.X_OK;
    const directories = opts.directories || ["/usr/sbin", "/usr/bin", "/sbin", "/bin"];
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    for (let index = 0; index < directories.length; index++) {
        const candidate = pathModule.resolve(directories[index], command);
        try {
            fsModule.accessSync(candidate, mode);
            const resolved = fsModule.realpathSync(candidate);
            const stats = fsModule.statSync(resolved);
            const userControlled = currentUid !== null && currentUid !== 0 && stats.uid === currentUid;
            if (stats.isFile() && !userControlled && (stats.mode & 0o022) === 0) return resolved;
        } catch (error) {}
    }
    return null;
}

function probeSucceeded(result, requireOutput = false) {
    if (result === true) return true;
    if (!result || result.error || result.status !== 0) return false;
    return !requireOutput || Boolean(String(result.stdout || "").trim());
}

function sameArguments(left, right) {
    return Array.isArray(left) && left.length === right.length
        && left.every((value, index) => value === right[index]);
}

class InstallService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.env = opts.env || process.env;
        this.applicationService = opts.applicationService;
        this.resolveTool = opts.resolveTool || (name => findExecutablePath(name, {
            fs: this.fs,
            path: this.path
        }));
        this.probe = opts.probe || ((executable, args, options) => childProcess.spawnSync(executable, args, options));
        this.spawn = opts.spawn || childProcess.spawn;
    }

    definition(identifier) {
        return resolvePackageDefinition(identifier);
    }

    detectSources() {
        const tools = this._tools();
        return [
            {source: "APT", available: Boolean(tools.aptGet && tools.aptCache)},
            {source: "SNAP", available: Boolean(tools.snap)},
            {source: "FLATPAK", available: Boolean(tools.flatpak)}
        ];
    }

    plan(identifier) {
        const definition = resolvePackageDefinition(identifier);
        const tools = this._tools();
        for (let index = 0; index < definition.sources.length; index++) {
            const metadata = definition.sources[index];
            const plan = this._planSource(definition, metadata, tools);
            if (plan) return Object.freeze(Object.assign(plan, {args: Object.freeze(plan.args.slice())}));
        }

        const detected = this.detectSources().filter(source => source.available).map(source => source.source);
        const suffix = detected.length ? detected.join(", ") : "NONE";
        throw new CliError(
            `NO SAFE CONFIGURED PACKAGE SOURCE FOR: ${definition.displayName}\n`
            + `DETECTED PACKAGE SYSTEMS: ${suffix}\n`
            + "NO REPOSITORY, KEY, SCRIPT, OR ARBITRARY PACKAGE COMMAND WAS ADDED"
        );
    }

    apply(plan) {
        this._validatePlan(plan);
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = this.spawn(plan.executable, plan.args.slice(), {
                    stdio: "inherit",
                    shell: false
                });
            } catch (error) {
                reject(new CliError(`INSTALL FAILED TO START: ${error.message}`));
                return;
            }
            child.once("error", error => reject(new CliError(`INSTALL FAILED TO START: ${error.message}`)));
            child.once("exit", (code, signal) => {
                if (code === 0) resolve({ok: true, code: 0});
                else reject(new CliError(`INSTALL FAILED: ${signal ? `SIGNAL ${signal}` : `EXIT ${code}`}`));
            });
        });
    }

    registerInstalled(definition) {
        if (!this.applicationService) throw new CliError("APPLICATION REGISTRATION SERVICE IS UNAVAILABLE");
        const trustedDefinition = resolvePackageDefinition(typeof definition === "string" ? definition : definition && definition.id);
        const candidate = this.applicationService.findInstalledCandidate(trustedDefinition);
        if (!candidate) return null;
        return this.applicationService.reconcileInstalledCandidate(candidate, trustedDefinition);
    }

    _tools() {
        return {
            sudo: this.resolveTool("sudo"),
            aptGet: this.resolveTool("apt-get"),
            aptCache: this.resolveTool("apt-cache"),
            snap: this.resolveTool("snap"),
            flatpak: this.resolveTool("flatpak")
        };
    }

    _planSource(definition, metadata, tools) {
        if (metadata.source === "APT") {
            if (!tools.sudo || !tools.aptGet || !tools.aptCache) return null;
            const result = this._probe(tools.aptCache, ["--no-all-versions", "show", metadata.package]);
            if (!probeSucceeded(result, true)) return null;
            return {
                definitionId: definition.id,
                displayName: definition.displayName,
                source: "APT",
                package: metadata.package,
                executable: tools.sudo,
                managerExecutable: tools.aptGet,
                args: [tools.aptGet, "install", "--", metadata.package],
                requiresAdministrator: true
            };
        }

        if (metadata.source === "SNAP") {
            if (!tools.sudo || !tools.snap) return null;
            const result = this._probe(tools.snap, ["info", metadata.package]);
            if (!probeSucceeded(result, true)) return null;
            return {
                definitionId: definition.id,
                displayName: definition.displayName,
                source: "SNAP",
                package: metadata.package,
                executable: tools.sudo,
                managerExecutable: tools.snap,
                args: [tools.snap, "install", metadata.package],
                requiresAdministrator: true
            };
        }

        if (metadata.source === "FLATPAK") {
            if (!tools.flatpak) return null;
            const remotesResult = this._probe(tools.flatpak, ["remotes", "--columns=name"]);
            if (!probeSucceeded(remotesResult, true)) return null;
            const remotes = String(remotesResult.stdout).split(/\r?\n/).map(remote => remote.trim())
                .filter(remote => FLATPAK_REMOTE_PATTERN.test(remote));
            for (let index = 0; index < remotes.length; index++) {
                const remote = remotes[index];
                const infoResult = this._probe(tools.flatpak, ["remote-info", remote, metadata.package]);
                if (!probeSucceeded(infoResult)) continue;
                return {
                    definitionId: definition.id,
                    displayName: definition.displayName,
                    source: "FLATPAK",
                    sourceDetail: remote,
                    package: metadata.package,
                    executable: tools.flatpak,
                    managerExecutable: tools.flatpak,
                    args: ["install", remote, metadata.package],
                    requiresAdministrator: false
                };
            }
        }
        return null;
    }

    _probe(executable, args) {
        return this.probe(executable, args.slice(), {
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            shell: false,
            timeout: 10000,
            windowsHide: true
        });
    }

    _validatePlan(plan) {
        if (!plan || typeof plan !== "object" || !this.path.isAbsolute(plan.executable)
            || !this.path.isAbsolute(plan.managerExecutable)) {
            throw new CliError("INSTALL PLAN INVALID");
        }
        const definition = PACKAGE_CATALOG.find(application => application.id === plan.definitionId);
        const metadata = definition && definition.sources.find(source => source.source === plan.source && source.package === plan.package);
        if (!metadata) throw new CliError("INSTALL PLAN IS NOT IN THE TRUSTED PACKAGE CATALOG");

        let expected;
        if (plan.source === "APT") {
            if (this.path.basename(plan.executable) !== "sudo" || this.path.basename(plan.managerExecutable) !== "apt-get") {
                throw new CliError("INSTALL PLAN EXECUTABLE INVALID");
            }
            expected = [plan.managerExecutable, "install", "--", plan.package];
        } else if (plan.source === "SNAP") {
            if (this.path.basename(plan.executable) !== "sudo" || this.path.basename(plan.managerExecutable) !== "snap") {
                throw new CliError("INSTALL PLAN EXECUTABLE INVALID");
            }
            expected = [plan.managerExecutable, "install", plan.package];
        } else if (plan.source === "FLATPAK") {
            if (this.path.basename(plan.executable) !== "flatpak" || plan.executable !== plan.managerExecutable
                || !FLATPAK_REMOTE_PATTERN.test(plan.sourceDetail || "")) {
                throw new CliError("INSTALL PLAN EXECUTABLE INVALID");
            }
            expected = ["install", plan.sourceDetail, plan.package];
        } else {
            throw new CliError("INSTALL PLAN SOURCE INVALID");
        }
        if (!sameArguments(plan.args, expected)) throw new CliError("INSTALL PLAN ARGUMENTS INVALID");
    }
}

module.exports = {InstallService, findExecutablePath};
