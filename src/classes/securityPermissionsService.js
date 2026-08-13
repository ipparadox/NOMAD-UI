const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultPermissionRoots(home = os.homedir(), environment = process.env, pathModule = path) {
    const configBase = typeof environment.XDG_CONFIG_HOME === "string" && pathModule.isAbsolute(environment.XDG_CONFIG_HOME)
        ? environment.XDG_CONFIG_HOME : pathModule.join(home, ".config");
    const stateBase = typeof environment.XDG_STATE_HOME === "string" && pathModule.isAbsolute(environment.XDG_STATE_HOME)
        ? environment.XDG_STATE_HOME : pathModule.join(home, ".local", "state");
    return {
        configRoot: pathModule.join(configBase, "nomad"),
        uiConfigRoot: pathModule.join(configBase, "eDEX-UI"),
        stateRoot: pathModule.join(stateBase, "nomad")
    };
}

function knownPermissionSpecs(opts = {}) {
    const pathModule = opts.path || path;
    const roots = Object.assign(defaultPermissionRoots(opts.home, opts.env, pathModule), opts.roots || {});
    return [
        {id: "nomad_config_directory", label: "NOMAD CONFIG DIRECTORY", path: roots.configRoot, root: roots.configRoot, type: "directory", mode: 0o700},
        {id: "security_profile_store", label: "SECURITY PROFILE STORE", path: pathModule.join(roots.configRoot, "security.json"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "session_env", label: "SESSION ENV", path: pathModule.join(roots.configRoot, "session.env"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "cli_marker", label: "CLI OWNERSHIP MARKER", path: pathModule.join(roots.configRoot, ".cli-v0.4-d-installed"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "session_marker", label: "SESSION OWNERSHIP MARKER", path: pathModule.join(roots.configRoot, ".session-v0.3-a-installed"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "i3_config", label: "NOMAD I3 CONFIG", path: pathModule.join(roots.configRoot, "i3", "config"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "repository_trust_store", label: "REPOSITORY TRUST STORE", path: pathModule.join(roots.configRoot, "repository-runs.json"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "application_registry", label: "APPLICATION REGISTRY", path: pathModule.join(roots.configRoot, "apps.json"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "enforcement_state", label: "SECURITY ENFORCEMENT STATE", path: pathModule.join(roots.configRoot, "enforcement-state.json"), root: roots.configRoot, type: "file", mode: 0o600},
        {id: "nomad_ui_config_directory", label: "NOMAD UI CONFIG DIRECTORY", path: roots.uiConfigRoot, root: roots.uiConfigRoot, type: "directory", mode: 0o700},
        {id: "settings", label: "NOMAD SETTINGS", path: pathModule.join(roots.uiConfigRoot, "settings.json"), root: roots.uiConfigRoot, type: "file", mode: 0o600},
        {id: "shortcuts", label: "NOMAD SHORTCUTS", path: pathModule.join(roots.uiConfigRoot, "shortcuts.json"), root: roots.uiConfigRoot, type: "file", mode: 0o600},
        {id: "window_state", label: "NOMAD WINDOW STATE", path: pathModule.join(roots.uiConfigRoot, "lastWindowState.json"), root: roots.uiConfigRoot, type: "file", mode: 0o600},
        {id: "version_log", label: "NOMAD VERSION LOG", path: pathModule.join(roots.uiConfigRoot, "versions_log.json"), root: roots.uiConfigRoot, type: "file", mode: 0o600},
        {id: "nomad_state_directory", label: "NOMAD STATE DIRECTORY", path: roots.stateRoot, root: roots.stateRoot, type: "directory", mode: 0o700},
        {id: "session_log", label: "SESSION LOG", path: pathModule.join(roots.stateRoot, "session.log"), root: roots.stateRoot, type: "file", mode: 0o600},
        {id: "ui_log", label: "UI LOG", path: pathModule.join(roots.stateRoot, "ui.log"), root: roots.stateRoot, type: "file", mode: 0o600}
    ];
}

function octal(mode) {
    return (mode & 0o777).toString(8).padStart(4, "0");
}

class SecurityPermissionsService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.environment = opts.env || process.env;
        this.home = opts.home || os.homedir();
        this.uid = Object.prototype.hasOwnProperty.call(opts, "uid")
            ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
        this.specs = opts.specs || knownPermissionSpecs({
            path: this.path,
            home: this.home,
            env: this.environment,
            roots: opts.roots
        });
    }

    inspect(verbose = false) {
        const resources = this.specs.map(spec => this._inspect(spec, verbose));
        return {
            version: 1,
            secure: resources.every(resource => ["VERIFIED", "NOT_PRESENT"].includes(resource.status)),
            findingCount: resources.filter(resource => !["VERIFIED", "NOT_PRESENT"].includes(resource.status)).length,
            repairCount: resources.filter(resource => resource.repairable).length,
            resources
        };
    }

    repair(opts = {}) {
        const apply = opts.apply === true;
        const authorized = opts.authorized === true;
        const before = this.inspect(opts.verbose === true);
        const actions = before.resources.filter(resource => resource.repairable).map(resource => {
            const spec = this.specs.find(candidate => candidate.id === resource.id);
            return {
                id: resource.id,
                label: resource.label,
                currentMode: resource.actualMode,
                desiredMode: resource.desiredMode,
                path: spec ? spec.path : null
            };
        });
        if (!apply) return {ok: true, applied: false, status: "PLAN_ONLY", actions, before};
        if (!authorized) return {ok: false, applied: false, status: "EXPLICIT AUTHORIZATION REQUIRED", actions, before};
        const repaired = [];
        for (const action of actions) {
            const spec = this.specs.find(candidate => candidate.id === action.id);
            if (!spec) return {ok: false, applied: true, status: "KNOWN RESOURCE CHANGED", repaired};
            const inspected = this._inspect(spec, true);
            if (!inspected.repairable || inspected.actualMode !== action.currentMode) {
                return {ok: false, applied: true, status: "RESOURCE IDENTITY CHANGED", repaired};
            }
            try {
                this._chmodKnown(spec);
                repaired.push(spec.id);
            } catch (error) {
                return {ok: false, applied: true, status: "PERMISSION REPAIR REFUSED", repaired};
            }
        }
        const after = this.inspect(opts.verbose === true);
        return {
            ok: after.secure,
            applied: true,
            status: after.secure ? "PERMISSIONS VERIFIED" : "PERMISSION REPAIR PARTIAL",
            repaired,
            actions,
            before,
            after
        };
    }

    _inspect(spec, verbose) {
        const result = {
            id: spec.id,
            label: spec.label,
            desiredMode: octal(spec.mode),
            actualMode: null,
            status: "UNKNOWN",
            repairable: false
        };
        if (verbose) result.path = spec.path;
        if (!this._knownPath(spec)) {
            result.status = "PATH_REFUSED";
            return result;
        }
        let stats;
        try {
            stats = this.fs.lstatSync(spec.path);
        } catch (error) {
            result.status = error && error.code === "ENOENT" ? "NOT_PRESENT" : "INSPECTION_FAILED";
            return result;
        }
        result.actualMode = octal(stats.mode);
        if (stats.isSymbolicLink()) {
            result.status = "SYMLINK_REJECTED";
            return result;
        }
        const correctType = spec.type === "directory" ? stats.isDirectory() : stats.isFile();
        if (!correctType) {
            result.status = "TYPE_REJECTED";
            return result;
        }
        if (spec.type === "file" && stats.nlink !== 1) {
            result.status = "HARDLINK_REJECTED";
            return result;
        }
        if (this.uid !== null && typeof stats.uid === "number" && stats.uid !== this.uid) {
            result.status = "OWNER_REJECTED";
            return result;
        }
        try {
            if (this.fs.realpathSync(spec.path) !== this.path.resolve(spec.path)) {
                result.status = "CANONICAL_PATH_REJECTED";
                return result;
            }
        } catch (error) {
            result.status = "CANONICAL_PATH_REJECTED";
            return result;
        }
        if ((stats.mode & 0o777) === spec.mode) {
            result.status = "VERIFIED";
            return result;
        }
        result.status = "MODE_CHANGE_REQUIRED";
        result.repairable = true;
        return result;
    }

    _knownPath(spec) {
        if (!spec || typeof spec.path !== "string" || typeof spec.root !== "string"
            || !this.path.isAbsolute(spec.path) || !this.path.isAbsolute(spec.root)) return false;
        const normalizedPath = this.path.resolve(spec.path);
        const normalizedRoot = this.path.resolve(spec.root);
        const relative = this.path.relative(normalizedRoot, normalizedPath);
        return normalizedPath === spec.path && normalizedRoot === spec.root
            && (relative === "" || (!relative.startsWith("..") && !this.path.isAbsolute(relative)))
            && this.specs.some(candidate => candidate.id === spec.id && candidate.path === spec.path);
    }

    _chmodKnown(spec) {
        if (!this._knownPath(spec)) throw new Error("unknown resource");
        const before = this.fs.lstatSync(spec.path);
        if (before.isSymbolicLink() || (spec.type === "directory" ? !before.isDirectory() : !before.isFile())
            || (spec.type === "file" && before.nlink !== 1)
            || (this.uid !== null && typeof before.uid === "number" && before.uid !== this.uid)
            || this.fs.realpathSync(spec.path) !== this.path.resolve(spec.path)) throw new Error("unsafe resource");
        const constants = this.fs.constants || fs.constants;
        const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (spec.type === "directory" ? (constants.O_DIRECTORY || 0) : 0);
        let descriptor;
        try {
            descriptor = this.fs.openSync(spec.path, flags);
            const opened = this.fs.fstatSync(descriptor);
            if (opened.dev !== before.dev || opened.ino !== before.ino
                || (spec.type === "directory" ? !opened.isDirectory() : !opened.isFile())
                || (spec.type === "file" && opened.nlink !== 1)
                || (this.uid !== null && typeof opened.uid === "number" && opened.uid !== this.uid)) {
                throw new Error("resource changed");
            }
            this.fs.fchmodSync(descriptor, spec.mode);
            const after = this.fs.fstatSync(descriptor);
            if ((after.mode & 0o777) !== spec.mode) throw new Error("chmod verification failed");
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }
}

module.exports = {
    SecurityPermissionsService,
    defaultPermissionRoots,
    knownPermissionSpecs,
    octal
};
