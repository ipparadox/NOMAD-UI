const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
    ApplicationRegistry,
    executableExists,
    normalizeWindowMatchers,
    validateArgs,
    validateExecutable
} = require("../classes/applicationRegistry.js");
const {DesktopEntryDiscovery, validDesktopId} = require("../classes/desktopEntryDiscovery.js");
const {
    MANAGED_APPLICATIONS,
    PROTECTED_APPLICATION_IDS,
    normalizeApplicationId
} = require("../classes/managedApplications.js");
const {CliError} = require("./errors.js");
const {RegistryStore} = require("./registryStore.js");

const LOOKUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SYSTEM_HELPER_PATTERN = /(?:^|[._+-])(autostart|daemon|helper|panel-applet|policykit|polkit|service)(?:[._+-]|$)/i;
const WINDOW_MATCHER_FIELDS = ["wmClass", "wmInstance", "windowMatchers"];

function validateApplicationLookup(value) {
    if (typeof value !== "string" || !value || value !== value.trim()
        || value.length > 255 || CONTROL_CHARACTERS.test(value) || !LOOKUP_PATTERN.test(value)) {
        throw new CliError("APPLICATION IDENTIFIER INVALID");
    }
    if (value.toLowerCase().endsWith(".desktop") && !validDesktopId(value)) {
        throw new CliError("DESKTOP ID INVALID");
    }
    return value;
}

function deriveApplicationId(desktopId) {
    if (!validDesktopId(desktopId)) throw new CliError("DESKTOP ID INVALID");
    let id = desktopId.slice(0, -".desktop".length).toLowerCase().replace(/\+/g, "-");
    id = id.replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
    if (!id) throw new CliError("APPLICATION ID COULD NOT BE DERIVED");
    if (id.length > 64) {
        const digest = crypto.createHash("sha256").update(desktopId).digest("hex").slice(0, 10);
        id = `${id.slice(0, 53)}-${digest}`;
    }
    if (!normalizeApplicationId(id)) throw new CliError("APPLICATION ID COULD NOT BE DERIVED");
    return id;
}

function displayNameFor(entry, id) {
    const compact = String(entry.name || "").replace(/\s+/g, " ").trim().toUpperCase();
    return (compact || id.toUpperCase()).slice(0, 32).trim();
}

function identifierStem(value) {
    return value.toLowerCase().endsWith(".desktop") ? value.slice(0, -".desktop".length) : value;
}

function lookupSlug(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._+-]+/g, "-").replace(/^-+|-+$/g, "");
}

function isSystemHelper(entry, pathModule = path) {
    if (entry.terminal) return true;
    const executableName = entry.executable ? pathModule.basename(entry.executable) : "";
    return SYSTEM_HELPER_PATTERN.test(entry.desktopId || "") || SYSTEM_HELPER_PATTERN.test(executableName);
}

function addExecutableIdentity(identities, value) {
    if (typeof value !== "string" || !value.trim()) return;
    identities.add(value.trim().toLowerCase());
}

function trustedApplicationIdentity(candidate, definition, pathModule = path) {
    if (!definition || typeof definition !== "object") throw new CliError("TRUSTED APPLICATION METADATA INVALID");
    const canonicalId = normalizeApplicationId(definition.id);
    if (!canonicalId) throw new CliError("TRUSTED APPLICATION METADATA INVALID");

    const ids = new Set([canonicalId]);
    const desktopIds = new Set();
    const executableNames = new Set();
    addExecutableIdentity(executableNames, canonicalId);

    (definition.aliases || []).forEach(alias => {
        const normalized = normalizeApplicationId(alias);
        if (normalized) ids.add(normalized);
        addExecutableIdentity(executableNames, alias);
    });
    (definition.desktopIds || []).forEach(desktopId => {
        if (!validDesktopId(desktopId)) throw new CliError("TRUSTED APPLICATION METADATA INVALID");
        desktopIds.add(desktopId.toLowerCase());
        ids.add(deriveApplicationId(desktopId));
        addExecutableIdentity(executableNames, identifierStem(desktopId));
    });
    (definition.sources || []).forEach(source => addExecutableIdentity(executableNames, source && source.package));

    const candidateId = candidate && normalizeApplicationId(candidate.id);
    const candidateDesktopId = candidate && validDesktopId(candidate.desktopId)
        ? candidate.desktopId.toLowerCase()
        : "";
    const candidateExecutable = candidate && typeof candidate.executable === "string"
        ? pathModule.basename(candidate.executable).toLowerCase()
        : "";
    if (!candidateId || (!desktopIds.has(candidateDesktopId) && !ids.has(candidateId)
        && !executableNames.has(candidateExecutable))) {
        throw new CliError(`APPLICATION REGISTRATION CONFLICT: ${canonicalId}\nINSTALLED APPLICATION DOES NOT MATCH TRUSTED PACKAGE METADATA`);
    }

    ids.add(candidateId);
    if (candidateDesktopId) desktopIds.add(candidateDesktopId);
    if (candidateExecutable) executableNames.add(candidateExecutable);
    return {canonicalId, ids, desktopIds, executableNames};
}

function applicationEntryFromCandidate(candidate, preferences = {}) {
    const application = {
        id: preferences.id || candidate.id,
        displayName: typeof preferences.displayName === "string" ? preferences.displayName : candidate.displayName,
        type: "external",
        desktopId: candidate.desktopId,
        executable: candidate.executable,
        args: candidate.args.slice(),
        launcherOrder: preferences.launcherOrder
    };
    if (candidate.startupWMClass) application.wmClass = [candidate.startupWMClass];
    return application;
}

function preserveWindowMatcherFields(source, target) {
    WINDOW_MATCHER_FIELDS.forEach(field => {
        if (!Object.prototype.hasOwnProperty.call(source, field)) return;
        target[field] = JSON.parse(JSON.stringify(source[field]));
    });
    return target;
}

function candidateFromDesktopEntry(entry, opts = {}) {
    const pathModule = opts.path || path;
    const exists = opts.executableExists || (() => true);
    const id = deriveApplicationId(entry.desktopId);
    let executable = entry.executable;
    let args = entry.args || [];
    let status = "MANAGEABLE";
    let reason = "";

    try {
        if (!entry.name) throw new Error("NAME NOT AVAILABLE");
        executable = validateExecutable(executable, pathModule);
        args = validateArgs(args);
        if (!exists(executable)) throw new Error("EXECUTABLE NOT AVAILABLE");
        if (entry.startupWMClass) {
            if (entry.startupWMClass.length > 256 || CONTROL_CHARACTERS.test(entry.startupWMClass)) {
                throw new Error("STARTUP WM CLASS INVALID");
            }
        } else {
            status = "NEEDS WM_CLASS";
        }
    } catch (error) {
        status = "UNSUPPORTED";
        reason = error.message.toUpperCase();
    }

    return {
        id,
        name: entry.name || id,
        displayName: displayNameFor(entry, id),
        desktopId: entry.desktopId,
        executable: executable || "",
        args: Array.isArray(args) ? args.slice() : [],
        startupWMClass: entry.startupWMClass || "",
        status,
        reason,
        path: entry.path
    };
}

function candidateScore(candidate, identifier) {
    const wanted = identifier.toLowerCase();
    const desktopId = candidate.desktopId.toLowerCase();
    const desktopStem = identifierStem(desktopId);
    const executableName = path.basename(candidate.executable || "").toLowerCase();
    if (wanted === desktopId) return 100;
    if (wanted === candidate.id) return 90;
    if (wanted === desktopStem) return 80;
    if (wanted === executableName) return 70;
    if (wanted === lookupSlug(candidate.name)) return 60;
    return 0;
}

function resolveCandidate(candidates, identifier) {
    const validated = validateApplicationLookup(identifier);
    const matches = candidates
        .map(candidate => ({candidate, score: candidateScore(candidate, validated)}))
        .filter(match => match.score > 0)
        .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
    if (!matches.length) throw new CliError(`APPLICATION NOT FOUND: ${validated}`);
    const best = matches.filter(match => match.score === matches[0].score);
    if (best.length > 1) {
        throw new CliError(`APPLICATION IDENTIFIER AMBIGUOUS: ${validated}\nMATCHES: ${best.map(match => match.candidate.desktopId).join(", ")}`);
    }
    return best[0].candidate;
}

class ApplicationService {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.env = opts.env || process.env;
        this.home = opts.home;
        this.log = opts.log || (() => {});
        this.discovery = opts.discovery || new DesktopEntryDiscovery({
            directories: opts.applicationDirectories,
            env: this.env,
            home: this.home,
            log: this.log
        });
        this.executableExists = opts.executableExists || (applicationExecutable => executableExists(applicationExecutable, {
            fs: this.fs,
            path: this.path,
            env: this.env
        }));
        this.store = opts.store || new RegistryStore({
            fs: this.fs,
            path: this.path,
            registryPath: opts.registryPath,
            discovery: this.discovery,
            executableExists: this.executableExists,
            env: this.env,
            home: this.home,
            log: this.log
        });
        this.registryPath = this.store.registryPath;
        this.protectedIds = new Set(PROTECTED_APPLICATION_IDS);
    }

    scan() {
        const result = this.discovery.scan();
        const candidates = result.entries
            .filter(entry => !entry.hidden && !entry.noDisplay && entry.type === "Application")
            .filter(entry => !isSystemHelper(entry, this.path))
            .map(entry => candidateFromDesktopEntry(entry, {
                path: this.path,
                executableExists: this.executableExists
            }))
            .sort((left, right) => {
                const priority = {MANAGEABLE: 0, "NEEDS WM_CLASS": 1, UNSUPPORTED: 2};
                return priority[left.status] - priority[right.status] || left.displayName.localeCompare(right.displayName)
                    || left.desktopId.localeCompare(right.desktopId);
            });
        return {candidates, errors: result.errors};
    }

    findCandidate(identifier) {
        return resolveCandidate(this.scan().candidates, identifier);
    }

    findInstalledCandidate(definition) {
        const candidates = this.scan().candidates.filter(candidate => candidate.status !== "UNSUPPORTED");
        const desktopIds = new Set((definition.desktopIds || []).map(value => value.toLowerCase()));
        const exact = candidates.find(candidate => desktopIds.has(candidate.desktopId.toLowerCase()));
        if (exact) return exact;

        const identifiers = [definition.id].concat(definition.aliases || []);
        for (let index = 0; index < identifiers.length; index++) {
            try {
                return resolveCandidate(candidates, identifiers[index]);
            } catch (error) {
                if (!(error instanceof CliError) || !error.message.startsWith("APPLICATION NOT FOUND")) throw error;
            }
        }
        return null;
    }

    add(identifier) {
        const validated = validateApplicationLookup(identifier);
        if (this._protectedLookup(validated)) throw new CliError(`PROTECTED APPLICATION CANNOT BE OVERRIDDEN: ${validated}`);
        return this.addCandidate(resolveCandidate(this.scan().candidates, validated));
    }

    addCandidate(candidate) {
        this._assertCandidateCanBeRegistered(candidate);

        let alreadyRegistered = false;
        let registeredId = candidate.id;
        const update = this.store.update(applications => {
            const sameDesktop = applications.find(entry => entry.desktopId
                && entry.desktopId.toLowerCase() === candidate.desktopId.toLowerCase());
            if (sameDesktop) {
                alreadyRegistered = true;
                registeredId = normalizeApplicationId(sameDesktop.id);
                return applications;
            }
            const sameId = applications.find(entry => normalizeApplicationId(entry.id) === candidate.id);
            if (sameId) {
                throw new CliError(`APPLICATION ID CONFLICT: ${candidate.id}`);
            }

            const highestOrder = applications.reduce((maximum, entry) => {
                return Number.isInteger(entry.launcherOrder) ? Math.max(maximum, entry.launcherOrder) : maximum;
            }, 99);
            applications.push(applicationEntryFromCandidate(candidate, {launcherOrder: highestOrder + 1}));
            return applications;
        });

        const normalized = update.normalizedApplications.find(application => application.id === registeredId);
        return {
            application: normalized,
            candidate,
            alreadyRegistered,
            changed: update.changed,
            registryPath: this.registryPath
        };
    }

    reconcileInstalledCandidate(candidate, definition) {
        this._assertCandidateCanBeRegistered(candidate);
        const identity = trustedApplicationIdentity(candidate, definition, this.path);
        if (this.protectedIds.has(identity.canonicalId)) {
            throw new CliError(`PROTECTED APPLICATION CANNOT BE OVERRIDDEN: ${identity.canonicalId}`);
        }

        let alreadyRegistered = false;
        let reconciled = false;
        let registeredId = candidate.id;
        const update = this.store.update(applications => {
            const matches = [];
            applications.forEach((entry, index) => {
                const entryId = normalizeApplicationId(entry.id);
                const desktopId = typeof entry.desktopId === "string" ? entry.desktopId.toLowerCase() : "";
                if (identity.ids.has(entryId) || identity.desktopIds.has(desktopId)) matches.push(index);
            });
            if (matches.length > 1) {
                throw new CliError(`APPLICATION REGISTRATION CONFLICT: ${identity.canonicalId}\nMULTIPLE USER ENTRIES MATCH TRUSTED APPLICATION METADATA`);
            }

            if (!matches.length) {
                const highestOrder = applications.reduce((maximum, entry) => {
                    return Number.isInteger(entry.launcherOrder) ? Math.max(maximum, entry.launcherOrder) : maximum;
                }, 99);
                applications.push(applicationEntryFromCandidate(candidate, {launcherOrder: highestOrder + 1}));
                return applications;
            }

            const index = matches[0];
            const existing = applications[index];
            const existingId = normalizeApplicationId(existing.id);
            const existingDesktopId = typeof existing.desktopId === "string" ? existing.desktopId.toLowerCase() : "";
            const existingExecutable = typeof existing.executable === "string"
                ? this.path.basename(existing.executable).toLowerCase()
                : "";
            if ((existingDesktopId && !identity.desktopIds.has(existingDesktopId))
                || (existingExecutable && !identity.executableNames.has(existingExecutable) && !existingDesktopId)) {
                throw new CliError(`APPLICATION ID CONFLICT: ${existingId}\nEXISTING USER ENTRY DOES NOT MATCH TRUSTED APPLICATION METADATA`);
            }

            alreadyRegistered = true;
            registeredId = existingId;
            const replacement = applicationEntryFromCandidate(candidate, {
                id: existingId,
                displayName: existing.displayName,
                launcherOrder: Number.isInteger(existing.launcherOrder) ? existing.launcherOrder : 100 + index
            });
            if (!candidate.startupWMClass && normalizeWindowMatchers(existing).length) {
                preserveWindowMatcherFields(existing, replacement);
            }
            if (JSON.stringify(existing) !== JSON.stringify(replacement)) {
                applications[index] = replacement;
                reconciled = true;
            }
            return applications;
        });

        const normalized = update.normalizedApplications.find(application => application.id === registeredId);
        return {
            application: normalized,
            candidate,
            alreadyRegistered,
            reconciled,
            changed: update.changed,
            registryPath: this.registryPath
        };
    }

    remove(identifier) {
        const validated = validateApplicationLookup(identifier);
        if (this._protectedLookup(validated)) throw new CliError(`BUILT-IN APPLICATION CANNOT BE REMOVED: ${validated}`);

        let removed = null;
        const update = this.store.update(applications => {
            const index = this._resolveUserEntryIndex(applications, validated);
            if (index < 0) throw new CliError(`USER APPLICATION NOT FOUND: ${validated}`);
            removed = applications[index];
            applications.splice(index, 1);
            return applications;
        });
        return {application: removed, changed: update.changed, registryPath: this.registryPath};
    }

    list() {
        this.store.read();
        const registry = this._runtimeRegistry();
        return registry.getApplications().map(application => Object.assign(application, {
            source: this.protectedIds.has(application.id) ? "BUILTIN" : "USER"
        }));
    }

    info(identifier) {
        const validated = validateApplicationLookup(identifier);
        const applications = this.list();
        const matches = applications.filter(application => {
            if (application.id === validated.toLowerCase()) return true;
            return application.desktopId && (application.desktopId.toLowerCase() === validated.toLowerCase()
                || identifierStem(application.desktopId.toLowerCase()) === validated.toLowerCase());
        });
        if (!matches.length) throw new CliError(`APPLICATION NOT REGISTERED: ${validated}`);
        if (matches.length > 1) throw new CliError(`APPLICATION IDENTIFIER AMBIGUOUS: ${validated}`);
        return matches[0];
    }

    prepareWindowClassLearning(identifier) {
        const validated = validateApplicationLookup(identifier);
        if (this._protectedLookup(validated)) {
            throw new CliError(`WINDOW CLASS LEARNING IS NOT ALLOWED FOR BUILT-IN APPLICATION: ${validated}`);
        }

        const stored = this.store.read();
        const index = this._resolveUserEntryIndex(stored.applications, validated);
        if (index < 0) throw new CliError(`USER APPLICATION NOT FOUND: ${validated}`);
        const application = stored.normalizedApplications[index];
        const registryEntry = stored.applications[index];
        if (!application || this.protectedIds.has(application.id)) {
            throw new CliError(`WINDOW CLASS LEARNING IS NOT ALLOWED FOR BUILT-IN APPLICATION: ${validated}`);
        }
        if (application.windowMatchers.length) {
            throw new CliError(`WINDOW MATCHER ALREADY AVAILABLE: ${application.id}\nREGISTRY NOT CHANGED`);
        }
        const storedLaunchDefinition = Object.prototype.hasOwnProperty.call(registryEntry, "executable")
            && Object.prototype.hasOwnProperty.call(registryEntry, "args")
            && registryEntry.executable === application.executable
            && JSON.stringify(registryEntry.args) === JSON.stringify(application.args);
        if (!storedLaunchDefinition || !application.executable || !this.executableExists(application.executable)
            || application.status !== "WM_CLASS NOT AVAILABLE") {
            throw new CliError(`APPLICATION DOES NOT HAVE A TRUSTED LEARNABLE EXECUTABLE: ${application.id}\nREGISTRY NOT CHANGED`);
        }

        return {
            id: application.id,
            application,
            executable: application.executable,
            args: application.args.slice(),
            registryEntrySnapshot: JSON.stringify(registryEntry)
        };
    }

    storeLearnedWindowMatcher(target, matcher) {
        if (!target || typeof target !== "object" || this.protectedIds.has(target.id)) {
            throw new CliError("WINDOW CLASS LEARNING TARGET INVALID\nREGISTRY NOT CHANGED");
        }
        const normalizedMatchers = normalizeWindowMatchers({windowMatchers: [matcher]});
        if (normalizedMatchers.length !== 1
            || normalizedMatchers[0].className !== matcher.className
            || normalizedMatchers[0].instance !== matcher.instance) {
            throw new CliError("LEARNED WINDOW CLASS IS INVALID\nREGISTRY NOT CHANGED");
        }

        const update = this.store.update(applications => {
            const index = this._resolveUserEntryIndex(applications, target.id);
            if (index < 0 || JSON.stringify(applications[index]) !== target.registryEntrySnapshot) {
                throw new CliError("APPLICATION REGISTRY CHANGED DURING WINDOW CLASS LEARNING\nREGISTRY NOT CHANGED");
            }

            const existing = applications[index];
            const current = this.store.validator.validateUserEntry(existing, 100 + index);
            if (current.windowMatchers.length) {
                throw new CliError(`WINDOW MATCHER ALREADY AVAILABLE: ${target.id}\nREGISTRY NOT CHANGED`);
            }
            if (current.executable !== target.executable
                || JSON.stringify(current.args) !== JSON.stringify(target.args)
                || current.status !== "WM_CLASS NOT AVAILABLE") {
                throw new CliError("APPLICATION REGISTRY CHANGED DURING WINDOW CLASS LEARNING\nREGISTRY NOT CHANGED");
            }

            const replacement = Object.assign({}, existing, {
                windowMatchers: [{
                    className: matcher.className,
                    instance: matcher.instance
                }]
            });
            const learned = this.store.validator.validateUserEntry(replacement, 100 + index);
            if (learned.available === false) {
                throw new CliError(`LEARNED WINDOW CLASS DID NOT MAKE APPLICATION AVAILABLE: ${learned.status}\nREGISTRY NOT CHANGED`);
            }
            applications[index] = replacement;
            return applications;
        });

        const revalidated = this._runtimeRegistry().get(target.id);
        if (!revalidated || revalidated.available === false) {
            throw new CliError(`WINDOW CLASS LEARNED BUT APPLICATION REMAINS UNAVAILABLE: ${revalidated ? revalidated.status : "APPLICATION NOT FOUND"}`);
        }
        return {
            application: revalidated,
            changed: update.changed,
            registryPath: this.registryPath
        };
    }

    reload() {
        const stored = this.store.read();
        const applications = this._runtimeRegistry().getApplications();
        return {applications, userApplicationCount: stored.applications.length};
    }

    _runtimeRegistry() {
        const registry = new ApplicationRegistry({
            fs: this.fs,
            path: this.path,
            registryPath: this.registryPath,
            discovery: this.discovery,
            executableExists: this.executableExists,
            env: this.env,
            home: this.home,
            log: this.log
        });
        registry.reload();
        return registry;
    }

    _assertCandidateCanBeRegistered(candidate) {
        if (!candidate || candidate.status === "UNSUPPORTED") {
            const reason = candidate && candidate.reason ? `: ${candidate.reason}` : "";
            throw new CliError(`APPLICATION CANNOT BE SAFELY REGISTERED${reason}`);
        }
        if (this.protectedIds.has(candidate.id)) {
            throw new CliError(`PROTECTED APPLICATION CANNOT BE OVERRIDDEN: ${candidate.id}`);
        }
        const builtIn = MANAGED_APPLICATIONS.find(application => application.executable
            && this.path.basename(application.executable) === this.path.basename(candidate.executable));
        if (builtIn) {
            throw new CliError(`APPLICATION ALREADY PROVIDED BY BUILT-IN: ${builtIn.id}`);
        }
    }

    _protectedLookup(identifier) {
        const lower = identifier.toLowerCase();
        const stem = identifierStem(lower);
        return this.protectedIds.has(lower) || this.protectedIds.has(stem);
    }

    _resolveUserEntryIndex(applications, identifier) {
        const lower = identifier.toLowerCase();
        const matches = [];
        applications.forEach((entry, index) => {
            const desktopId = String(entry.desktopId || "").toLowerCase();
            if (String(entry.id).toLowerCase() === lower) matches.push({index, score: 100});
            else if (desktopId === lower) matches.push({index, score: 90});
            else if (desktopId && identifierStem(desktopId) === lower) matches.push({index, score: 80});
        });
        if (!matches.length) return -1;
        matches.sort((left, right) => right.score - left.score);
        if (matches.length > 1 && matches[0].score === matches[1].score) {
            throw new CliError(`APPLICATION IDENTIFIER AMBIGUOUS: ${identifier}`);
        }
        return matches[0].index;
    }
}

module.exports = {
    ApplicationService,
    candidateFromDesktopEntry,
    deriveApplicationId,
    isSystemHelper,
    resolveCandidate,
    validateApplicationLookup
};
