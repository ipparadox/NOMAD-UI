const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    APPLICATION_TYPES,
    MANAGED_APPLICATIONS,
    PROTECTED_APPLICATION_IDS,
    normalizeApplicationId,
    publicApplications
} = require("./managedApplications.js");
const {DesktopEntryDiscovery, validDesktopId} = require("./desktopEntryDiscovery.js");

const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_APPLICATIONS = 256;
const MAX_ARGS = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_DISPLAY_NAME_LENGTH = 32;
const MAX_MATCHERS = 32;
const BLOCKED_EXECUTABLES = new Set([
    "sh", "bash", "dash", "zsh", "ksh", "csh", "tcsh", "fish", "env",
    "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "sudo", "su", "pkexec"
]);
const USER_ENTRY_KEYS = new Set([
    "id", "displayName", "type", "desktopId", "executable", "args",
    "wmClass", "wmInstance", "windowMatchers", "launcherOrder"
]);
const ROOT_KEYS = new Set(["version", "applications"]);

function defaultRegistryPath(home = os.homedir()) {
    return path.join(home, ".config", "nomad", "apps.json");
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseApplicationRegistryContent(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string") throw new TypeError("Application registry must be text");
    if (Buffer.byteLength(content, "utf8") > MAX_REGISTRY_BYTES) throw new Error("Application registry is too large");

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        throw new Error("Application registry is not valid JSON");
    }

    let entries;
    if (Array.isArray(parsed)) {
        entries = parsed;
    } else if (isPlainObject(parsed)) {
        if (Object.keys(parsed).some(key => !ROOT_KEYS.has(key)) || (typeof parsed.version !== "undefined" && parsed.version !== 1)) {
            throw new Error("Application registry root is invalid");
        }
        entries = parsed.applications;
    }

    if (!Array.isArray(entries) || entries.length > MAX_APPLICATIONS) {
        throw new Error("Application registry applications must be an array");
    }
    return entries;
}

function containsControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}

function validateDisplayName(value, fallbackId) {
    const displayName = typeof value === "undefined" ? fallbackId.toUpperCase() : value;
    if (typeof displayName !== "string") throw new Error("displayName must be a string");
    const normalized = displayName.trim().toUpperCase();
    if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH || containsControlCharacters(normalized)) {
        throw new Error("displayName is invalid");
    }
    return normalized;
}

function validateExecutable(value, pathModule = path) {
    if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512 || containsControlCharacters(value)) {
        throw new Error("executable is invalid");
    }

    if (pathModule.isAbsolute(value)) {
        if (pathModule.normalize(value) !== value || value === pathModule.parse(value).root) {
            throw new Error("executable path is invalid");
        }
        if (!/^[A-Za-z0-9/._+@% -]+$/.test(value)) throw new Error("executable path contains unsupported characters");
    } else if (!/^[A-Za-z0-9][A-Za-z0-9._+@%-]*$/.test(value)) {
        throw new Error("executable must be a command name or absolute path");
    }

    const executableName = pathModule.basename(value).toLowerCase();
    if (BLOCKED_EXECUTABLES.has(executableName)) throw new Error("command interpreters and privilege wrappers are not applications");
    return value;
}

function validateArgs(value) {
    if (typeof value === "undefined") return [];
    if (!Array.isArray(value) || value.length > MAX_ARGS) throw new Error("args must be an array of strings");
    return value.map(argument => {
        if (typeof argument !== "string" || argument.length > MAX_ARGUMENT_LENGTH || containsControlCharacters(argument)) {
            throw new Error("args must contain safe strings only");
        }
        return argument;
    });
}

function validateMatcherValue(value) {
    if (typeof value !== "string") throw new Error("WM_CLASS matchers must be strings");
    const normalized = value.trim();
    if (!normalized || normalized.length > 256 || containsControlCharacters(normalized)) {
        throw new Error("WM_CLASS matcher is invalid");
    }
    return normalized;
}

function validateMatcherList(value, fieldName) {
    if (typeof value === "undefined") return [];
    const values = typeof value === "string" ? [value] : value;
    if (!Array.isArray(values) || values.length > MAX_MATCHERS) throw new Error(`${fieldName} must be a string or string array`);
    return values.map(validateMatcherValue);
}

function normalizeWindowMatchers(entry, opts = {}) {
    const matchers = [];
    if (typeof entry.windowMatchers !== "undefined") {
        if (!Array.isArray(entry.windowMatchers) || entry.windowMatchers.length > MAX_MATCHERS) {
            throw new Error("windowMatchers must be an array");
        }
        entry.windowMatchers.forEach(matcher => {
            if (!isPlainObject(matcher)) throw new Error("windowMatchers entries must be objects");
            const keys = Object.keys(matcher);
            if (!keys.length || keys.some(key => !["class", "className", "instance"].includes(key))) {
                throw new Error("windowMatchers contains unsupported fields");
            }
            if (Object.prototype.hasOwnProperty.call(matcher, "class") && Object.prototype.hasOwnProperty.call(matcher, "className")) {
                throw new Error("windowMatchers class field is ambiguous");
            }
            const normalized = {};
            const classValue = Object.prototype.hasOwnProperty.call(matcher, "className") ? matcher.className : matcher.class;
            if (typeof classValue !== "undefined") normalized.className = validateMatcherValue(classValue);
            if (typeof matcher.instance !== "undefined") normalized.instance = validateMatcherValue(matcher.instance);
            if (!normalized.className && !normalized.instance) throw new Error("window matcher is empty");
            matchers.push(normalized);
        });
    }

    if (entry.windowMatch && opts.trusted) {
        matchers.push(...normalizeWindowMatchers({windowMatchers: [entry.windowMatch]}));
    }

    const classes = validateMatcherList(entry.wmClass, "wmClass");
    const instances = validateMatcherList(entry.wmInstance, "wmInstance");
    classes.forEach(className => matchers.push({className}));
    instances.forEach(instance => matchers.push({instance}));

    const seen = new Set();
    return matchers.filter(matcher => {
        const key = `${matcher.instance || ""}\0${matcher.className || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function executableExists(executable, opts = {}) {
    const fsModule = opts.fs || fs;
    const pathModule = opts.path || path;
    const env = opts.env || process.env;
    const mode = fsModule.constants ? fsModule.constants.X_OK : fs.constants.X_OK;
    const candidates = pathModule.isAbsolute(executable)
        ? [executable]
        : (env.PATH || "").split(pathModule.delimiter).filter(Boolean).map(directory => pathModule.join(directory, executable));

    return candidates.some(candidate => {
        try {
            fsModule.accessSync(candidate, mode);
            return fsModule.statSync(candidate).isFile();
        } catch (error) {
            return false;
        }
    });
}

function cloneApplication(application) {
    const cloned = Object.assign({}, application, {
        args: (application.args || []).slice(),
        windowMatchers: (application.windowMatchers || []).map(matcher => Object.assign({}, matcher))
    });
    if (application.desktopEntry) cloned.desktopEntry = Object.assign({}, application.desktopEntry);
    return cloned;
}

function handleApplicationRegistryRequest(registry, windowManager, request, applicationPolicy) {
    if (!request || !isPlainObject(request) || Object.keys(request).some(key => key !== "operation")) {
        return {ok: false, status: "INVALID REQUEST", applications: []};
    }
    if (request.operation === "reload") {
        registry.reload();
        if (windowManager) windowManager.setApplications(registry.getApplications());
    } else if (request.operation !== "get") {
        return {ok: false, status: "UNSUPPORTED OPERATION", applications: []};
    }
    return {
        ok: true,
        status: request.operation === "reload" ? "REGISTRY RELOADED" : "REGISTRY LOADED",
        generation: registry.generation,
        applications: applicationPolicy
            ? applicationPolicy.projectAll(registry.getApplications()) : registry.getPublicApplications()
    };
}

class ApplicationRegistry {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.env = opts.env || process.env;
        this.registryPath = opts.registryPath || defaultRegistryPath(opts.home);
        this.builtIns = opts.builtIns || MANAGED_APPLICATIONS;
        this.protectedIds = new Set(opts.protectedIds || PROTECTED_APPLICATION_IDS);
        this.log = opts.log || (() => {});
        this.discovery = opts.discovery || new DesktopEntryDiscovery({
            directories: opts.applicationDirectories,
            env: this.env,
            home: opts.home,
            log: this.log
        });
        this._executableExists = opts.executableExists || (executable => executableExists(executable, {
            fs: this.fs,
            path: this.path,
            env: this.env
        }));
        this.applications = [];
        this.generation = 0;
    }

    reload() {
        const builtIns = this.builtIns.map((entry, index) => this._normalize(entry, {
            trusted: true,
            launcherOrder: index
        }));
        const applications = builtIns.slice();
        const seen = new Set(applications.map(application => application.id));
        const entries = this._readUserEntries();

        entries.forEach((entry, index) => {
            try {
                const application = this._normalize(entry, {
                    trusted: false,
                    launcherOrder: 100 + index
                });
                if (this.protectedIds.has(application.id)) throw new Error("application ID is protected");
                if (seen.has(application.id)) throw new Error("application ID is duplicated");
                seen.add(application.id);
                applications.push(application);
            } catch (error) {
                this.log("warn", `REGISTRY ENTRY INVALID: ${index} (${error.message})`);
            }
        });

        this.applications = applications;
        this.generation++;
        return this.getApplications();
    }

    getApplications() {
        return this.applications.map(cloneApplication);
    }

    getPublicApplications() {
        return publicApplications(this.applications);
    }

    getExternalApplications() {
        return this.getApplications().filter(application => application.type === APPLICATION_TYPES.EXTERNAL);
    }

    get(appId) {
        const normalizedId = normalizeApplicationId(appId);
        const application = normalizedId && this.applications.find(item => item.id === normalizedId);
        return application ? cloneApplication(application) : null;
    }

    validateUserEntry(entry, launcherOrder = 100) {
        const application = this._normalize(entry, {
            trusted: false,
            launcherOrder
        });
        if (this.protectedIds.has(application.id)) throw new Error("application ID is protected");
        return application;
    }

    _readUserEntries() {
        let stats;
        try {
            stats = this.fs.statSync(this.registryPath);
        } catch (error) {
            if (error && error.code === "ENOENT") return [];
            this.log("warn", "REGISTRY ENTRY INVALID: apps.json could not be read");
            return [];
        }

        if (!stats.isFile() || stats.size > MAX_REGISTRY_BYTES) {
            this.log("warn", "REGISTRY ENTRY INVALID: apps.json is not a safe registry file");
            return [];
        }

        try {
            const content = this.fs.readFileSync(this.registryPath, {encoding: "utf8"});
            return parseApplicationRegistryContent(content);
        } catch (error) {
            this.log("warn", "REGISTRY ENTRY INVALID: apps.json is not valid JSON");
            return [];
        }
    }

    _normalize(entry, opts) {
        if (!isPlainObject(entry)) throw new Error("entry must be an object");
        if (!opts.trusted && Object.keys(entry).some(key => !USER_ENTRY_KEYS.has(key))) {
            throw new Error("entry contains unsupported fields");
        }

        const id = normalizeApplicationId(entry.id);
        if (!id) throw new Error("application ID is invalid");
        if (!opts.trusted && entry.type !== undefined && entry.type !== APPLICATION_TYPES.EXTERNAL) {
            throw new Error("user applications must be external");
        }
        const type = opts.trusted ? entry.type : APPLICATION_TYPES.EXTERNAL;
        if (![APPLICATION_TYPES.INTERNAL, APPLICATION_TYPES.EXTERNAL].includes(type)) throw new Error("application type is invalid");

        const order = typeof entry.launcherOrder === "undefined" ? opts.launcherOrder : entry.launcherOrder;
        if (!Number.isInteger(order) || order < -1000 || order > 100000) throw new Error("launcherOrder is invalid");

        const application = {
            id,
            displayName: validateDisplayName(entry.displayName, id),
            type,
            permanent: opts.trusted && entry.permanent === true,
            placeholder: opts.trusted && entry.placeholder === true,
            launcherOrder: order,
            available: true,
            status: ""
        };
        if (type === APPLICATION_TYPES.INTERNAL) return application;

        let desktopEntry = null;
        let desktopUnavailable = false;
        if (typeof entry.desktopId !== "undefined") {
            if (!validDesktopId(entry.desktopId)) throw new Error("desktopId is invalid");
            application.desktopId = entry.desktopId;
            desktopEntry = this.discovery.findById(entry.desktopId);
            if (!desktopEntry || desktopEntry.hidden || desktopEntry.type !== "Application") {
                desktopUnavailable = true;
                this.log("warn", `DESKTOP ENTRY NOT FOUND: ${id}`);
            }
        }

        let resolvedExecutable = entry.executable;
        let resolvedArgs = Object.prototype.hasOwnProperty.call(entry, "args") ? entry.args : undefined;
        if (!resolvedExecutable && desktopEntry) resolvedExecutable = desktopEntry.executable;
        if (typeof resolvedArgs === "undefined" && desktopEntry) resolvedArgs = desktopEntry.args;

        if (typeof entry.executable !== "undefined") resolvedExecutable = validateExecutable(entry.executable, this.path);
        else if (resolvedExecutable) {
            try {
                resolvedExecutable = validateExecutable(resolvedExecutable, this.path);
            } catch (error) {
                resolvedExecutable = null;
            }
        }
        const argsFromRegistry = Object.prototype.hasOwnProperty.call(entry, "args");
        if (argsFromRegistry) resolvedArgs = validateArgs(entry.args);
        else {
            try {
                resolvedArgs = validateArgs(resolvedArgs);
            } catch (error) {
                resolvedArgs = [];
                resolvedExecutable = null;
            }
        }

        let windowMatchers = normalizeWindowMatchers(entry, {trusted: opts.trusted});
        if (!windowMatchers.length && desktopEntry && desktopEntry.startupWMClass) {
            const startupWMClass = validateMatcherValue(desktopEntry.startupWMClass);
            windowMatchers = [{className: startupWMClass}, {instance: startupWMClass}];
        }

        application.executable = resolvedExecutable || null;
        application.args = resolvedArgs || [];
        application.windowMatchers = windowMatchers;
        if (desktopEntry) {
            application.desktopEntry = {
                name: desktopEntry.name,
                noDisplay: desktopEntry.noDisplay,
                terminal: desktopEntry.terminal,
                path: desktopEntry.path
            };
        }

        if (desktopUnavailable) {
            application.available = false;
            application.status = "DESKTOP ENTRY NOT FOUND";
        } else if (!application.executable || !this._executableExists(application.executable)) {
            application.available = false;
            application.status = "APPLICATION EXECUTABLE NOT FOUND";
            this.log("warn", `APPLICATION EXECUTABLE NOT FOUND: ${id}`);
        } else if (!application.windowMatchers.length) {
            application.available = false;
            application.status = "WM_CLASS NOT AVAILABLE";
            this.log("warn", `WM_CLASS NOT AVAILABLE: ${id}`);
        }
        return application;
    }
}

module.exports = {
    ApplicationRegistry,
    defaultRegistryPath,
    executableExists,
    handleApplicationRegistryRequest,
    normalizeWindowMatchers,
    parseApplicationRegistryContent,
    validateArgs,
    validateExecutable
};
