const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const {
    collectI3ClientLeaves,
    containsFocusedI3Node
} = require("../classes/i3WindowManager.class.js");
const {CliError} = require("./errors.js");

const DEFAULT_LEARNING_TIMEOUT_MS = 15000;
const MIN_LEARNING_TIMEOUT_MS = 3000;
const MAX_LEARNING_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_SETTLE_INTERVAL_MS = 2000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOW_TYPES = new Set([
    "unknown",
    "normal",
    "dialog",
    "utility",
    "toolbar",
    "splash",
    "menu",
    "dropdown_menu",
    "popup_menu",
    "tooltip",
    "notification"
]);
const AUXILIARY_WINDOW_TYPES = new Set([
    "dialog",
    "utility",
    "toolbar",
    "splash",
    "menu",
    "dropdown_menu",
    "popup_menu",
    "tooltip",
    "notification"
]);
const DIAGNOSTIC_MAX_LENGTH = 96;

function validateLearningTimeoutMs(value, fallback = DEFAULT_LEARNING_TIMEOUT_MS) {
    const timeout = typeof value === "undefined" ? fallback : value;
    if (!Number.isInteger(timeout) || timeout < MIN_LEARNING_TIMEOUT_MS || timeout > MAX_LEARNING_TIMEOUT_MS) {
        throw new CliError("WINDOW CLASS LEARNING TIMEOUT MUST BE BETWEEN 3 AND 30 SECONDS", 2);
    }
    return timeout;
}

function readI3Tree(opts = {}) {
    const execute = opts.execFile || childProcess.execFile;
    const env = opts.env || process.env;
    return new Promise((resolve, reject) => {
        execute("i3-msg", ["-t", "get_tree"], {
            encoding: "utf8",
            env,
            maxBuffer: 8 * 1024 * 1024,
            shell: false,
            timeout: 3000
        }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            try {
                const tree = JSON.parse(stdout);
                if (!tree || typeof tree !== "object" || Array.isArray(tree)) throw new Error("i3 returned an invalid tree");
                resolve(tree);
            } catch (parseError) {
                reject(parseError);
            }
        });
    });
}

function exactWindowProperty(value) {
    if (typeof value !== "string" || !value || value !== value.trim()
        || value.length > 256 || CONTROL_CHARACTERS.test(value)) return null;
    return value;
}

function exactWindowType(value) {
    if (typeof value !== "string") return null;
    const normalized = value.toLowerCase();
    return WINDOW_TYPES.has(normalized) ? normalized : null;
}

function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function clientLineage(context) {
    return context.ancestors.concat(context.node).slice().reverse();
}

function clientScopedLineage(context) {
    const lineage = clientLineage(context);
    const workspaceIndex = lineage.findIndex(node => node && node.type === "workspace");
    return workspaceIndex < 0 ? lineage : lineage.slice(0, workspaceIndex);
}

function clientKey(node) {
    if (Number.isSafeInteger(node.window) && node.window > 0) return `window:${node.window}`;
    if (Number.isSafeInteger(node.id) && node.id > 0) return `container:${node.id}`;
    return null;
}

function clientPid(context) {
    const owner = clientScopedLineage(context).find(node => positiveSafeInteger(node.pid));
    return owner ? owner.pid : null;
}

function clientWindowType(context) {
    const owner = clientScopedLineage(context).find(node => exactWindowType(node.window_type));
    return owner ? exactWindowType(owner.window_type) : null;
}

function clientFloating(context) {
    return clientScopedLineage(context).some(node => node && (node.type === "floating_con"
        || node.floating === "auto_on" || node.floating === "user_on"));
}

function clientFullscreen(context) {
    return clientScopedLineage(context).some(node => node
        && Number.isSafeInteger(node.fullscreen_mode) && node.fullscreen_mode > 0);
}

function clientDimensions(context) {
    const owner = clientScopedLineage(context).find(node => node && node.rect
        && Number.isSafeInteger(node.rect.width) && node.rect.width >= 0
        && Number.isSafeInteger(node.rect.height) && node.rect.height >= 0);
    return owner ? {width: owner.rect.width, height: owner.rect.height} : null;
}

function snapshotI3Clients(tree) {
    const clients = new Map();
    collectI3ClientLeaves(tree).forEach(context => {
        const key = clientKey(context.node);
        if (key) clients.set(key, context);
    });
    return clients;
}

function newI3WindowCandidates(tree, beforeKeys) {
    const candidates = [];
    snapshotI3Clients(tree).forEach((context, key) => {
        if (beforeKeys.has(key)) return;
        const properties = context.node.window_properties || {};
        const className = exactWindowProperty(properties.class);
        const instance = exactWindowProperty(properties.instance);
        if (!className || !instance) return;
        const transientFor = positiveSafeInteger(properties.transient_for);
        candidates.push({
            key,
            containerId: Number.isSafeInteger(context.node.id) ? context.node.id : null,
            windowId: Number.isSafeInteger(context.node.window) ? context.node.window : null,
            pid: clientPid(context),
            className,
            instance,
            windowType: clientWindowType(context),
            transientFor,
            transient: transientFor !== null,
            focused: containsFocusedI3Node(context.node)
                || context.ancestors.some(ancestor => ancestor && ancestor.focused === true),
            floating: clientFloating(context),
            fullscreen: clientFullscreen(context),
            dimensions: clientDimensions(context),
            hasWindowRole: exactWindowProperty(properties.window_role) !== null,
            hasTitle: exactWindowProperty(properties.title) !== null
        });
    });
    return candidates;
}

function parseX11WindowPid(content) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string") return null;
    const prefix = "_NET_WM_PID(CARDINAL) = ";
    const line = content.split(/\r?\n/).find(candidate => candidate.startsWith(prefix));
    if (!line) return null;
    const value = line.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(value)) return null;
    return positiveSafeInteger(Number(value));
}

function readX11WindowPid(windowId, opts = {}) {
    const validatedWindowId = positiveSafeInteger(windowId);
    if (!validatedWindowId) return Promise.resolve(null);
    const execute = opts.execFile || childProcess.execFile;
    const env = Object.assign({}, opts.env || process.env, {LC_ALL: "C"});
    return new Promise(resolve => {
        execute("xprop", ["-id", String(validatedWindowId), "_NET_WM_PID"], {
            encoding: "utf8",
            env,
            maxBuffer: 64 * 1024,
            shell: false,
            timeout: 1000
        }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            resolve(parseX11WindowPid(stdout));
        });
    });
}

function parseProcessStat(content) {
    const closeParen = typeof content === "string" ? content.lastIndexOf(")") : -1;
    if (closeParen < 0) return null;
    const fields = content.slice(closeParen + 1).trim().split(/\s+/);
    if (fields.length < 4) return null;
    const ppid = Number(fields[1]);
    const processGroup = Number(fields[2]);
    const session = Number(fields[3]);
    if (![ppid, processGroup, session].every(Number.isSafeInteger)) return null;
    return {ppid, processGroup, session};
}

function processCorrelationStatus(launchPid, candidatePid, opts = {}) {
    if (!Number.isSafeInteger(launchPid) || launchPid <= 0
        || !Number.isSafeInteger(candidatePid) || candidatePid <= 0) return null;
    if (candidatePid === launchPid) return true;

    const fsModule = opts.fs || fs;
    let currentPid = candidatePid;
    const visited = new Set();
    for (let depth = 0; depth < 64 && currentPid > 1 && !visited.has(currentPid); depth++) {
        visited.add(currentPid);
        let stat;
        try {
            stat = parseProcessStat(fsModule.readFileSync(`/proc/${currentPid}/stat`, "utf8"));
        } catch (error) {
            return null;
        }
        if (!stat) return null;
        if (stat.ppid === launchPid || stat.processGroup === launchPid || stat.session === launchPid) return true;
        currentPid = stat.ppid;
        if (currentPid === launchPid) return true;
    }
    return false;
}

function processBelongsToLaunch(launchPid, candidatePid, opts = {}) {
    return processCorrelationStatus(launchPid, candidatePid, opts) === true;
}

function applicationIdentityValues(target, pathModule = path) {
    const values = new Set();
    const add = value => {
        if (typeof value === "string" && value.trim()) values.add(value.trim().toLowerCase());
    };
    add(target.id);
    add(target.application && target.application.displayName);
    if (target.application && target.application.desktopId) {
        const desktopId = target.application.desktopId.toLowerCase();
        add(desktopId.endsWith(".desktop") ? desktopId.slice(0, -8) : desktopId);
    }
    if (target.executable) {
        const executableName = pathModule.basename(target.executable).toLowerCase();
        add(executableName);
        if (executableName.endsWith(".bin")) add(executableName.slice(0, -4));
    }
    return values;
}

function candidateMatchesApplicationIdentity(candidate, target, pathModule = path) {
    const identities = applicationIdentityValues(target, pathModule);
    return identities.has(candidate.className.toLowerCase()) || identities.has(candidate.instance.toLowerCase());
}

function sanitizeDiagnosticValue(value) {
    if (typeof value !== "string" || !value) return "NOT AVAILABLE";
    let output = "";
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint >= 0x20 && codePoint <= 0x7e) output += character;
        else if (codePoint <= 0xffff) output += `\\u${codePoint.toString(16).padStart(4, "0")}`;
        else output += `\\u{${codePoint.toString(16)}}`;
        if (output.length >= DIAGNOSTIC_MAX_LENGTH) {
            output = `${output.slice(0, DIAGNOSTIC_MAX_LENGTH - 3)}...`;
            break;
        }
    }
    return output;
}

function diagnosticBoolean(value, unknown = "UNKNOWN") {
    return value === true ? "YES" : value === false ? "NO" : unknown;
}

function candidateDiagnostic(candidate, index) {
    const dimensions = candidate.dimensions
        ? `${candidate.dimensions.width}x${candidate.dimensions.height}` : "NOT AVAILABLE";
    return [
        `CANDIDATE ${index + 1}`,
        `CLASS: ${sanitizeDiagnosticValue(candidate.className)}`,
        `INSTANCE: ${sanitizeDiagnosticValue(candidate.instance)}`,
        `PID MATCH: ${diagnosticBoolean(candidate.pidMatch)}`,
        `FOCUSED: ${diagnosticBoolean(candidate.focused, "NO")}`,
        `TRANSIENT: ${diagnosticBoolean(candidate.transient, "NO")}`,
        `WINDOW TYPE: ${candidate.windowType ? candidate.windowType.toUpperCase() : "NOT AVAILABLE"}`,
        `FLOATING: ${diagnosticBoolean(candidate.floating, "NO")}`,
        `FULLSCREEN: ${diagnosticBoolean(candidate.fullscreen, "NO")}`,
        `SIZE: ${dimensions}`
    ].join("\n");
}

function safeLog(log, level, message) {
    if (typeof log !== "function") return;
    try {
        log(level, message);
    } catch (error) {}
}

function candidateLogSummary(candidate, index) {
    return `WM_CLASS LEARNING CANDIDATE ${index + 1}: class=${sanitizeDiagnosticValue(candidate.className)}`
        + ` instance=${sanitizeDiagnosticValue(candidate.instance)}`
        + ` pidMatch=${diagnosticBoolean(candidate.pidMatch)}`
        + ` focused=${diagnosticBoolean(candidate.focused, "NO")}`
        + ` transient=${diagnosticBoolean(candidate.transient, "NO")}`
        + ` windowType=${candidate.windowType || "not-available"}`
        + ` floating=${diagnosticBoolean(candidate.floating, "NO")}`
        + ` fullscreen=${diagnosticBoolean(candidate.fullscreen, "NO")}`;
}

function ambiguousLearningError(candidates, reason, log) {
    candidates.forEach((candidate, index) => safeLog(log, "warn", candidateLogSummary(candidate, index)));
    safeLog(log, "warn", `WM_CLASS LEARNING SELECTION: ambiguous; reason=${reason}`);
    const diagnostics = candidates.map(candidateDiagnostic).join("\n\n");
    return new CliError(
        `WINDOW CLASS LEARNING AMBIGUOUS\nNEW WINDOW CANDIDATES: ${candidates.length}`
        + `\n\n${diagnostics}\n\nREGISTRY NOT CHANGED`
    );
}

function matcherKey(candidate) {
    return JSON.stringify([candidate.className, candidate.instance]);
}

function sharedMatcher(candidates) {
    if (!candidates.length) return false;
    const expected = matcherKey(candidates[0]);
    return candidates.every(candidate => matcherKey(candidate) === expected);
}

function transientOwnerCandidates(candidates) {
    const ownerWindowIds = new Set(candidates
        .map(candidate => candidate.transientFor)
        .filter(windowId => windowId !== null));
    return candidates.filter(candidate => candidate.windowId !== null
        && ownerWindowIds.has(candidate.windowId) && !candidate.transient);
}

function nonAuxiliaryCandidates(candidates) {
    return candidates.filter(candidate => !candidate.transient
        && !AUXILIARY_WINDOW_TYPES.has(candidate.windowType));
}

function selectionResult(candidates, reason, allCandidates, log) {
    const selected = candidates.find(candidate => candidate.focused) || candidates[0];
    allCandidates.forEach((candidate, index) => safeLog(log, "info", candidateLogSummary(candidate, index)));
    safeLog(log, "info", `WM_CLASS LEARNING SELECTION: class=${sanitizeDiagnosticValue(selected.className)}`
        + ` instance=${sanitizeDiagnosticValue(selected.instance)} reason=${reason}`);
    return selected;
}

function selectLearningCandidate(candidates, target, launchPid, opts = {}) {
    const correlate = opts.processCorrelator || processCorrelationStatus;
    const pathModule = opts.path || path;
    const log = opts.log;
    const annotated = candidates.map(candidate => {
        let pidMatch = candidate.pidMatch;
        if (pidMatch !== true && pidMatch !== false && candidate.pid !== null) {
            try {
                const correlation = correlate(launchPid, candidate.pid);
                pidMatch = correlation === true ? true : correlation === false ? false : null;
            } catch (error) {
                pidMatch = null;
            }
        }
        return Object.assign({}, candidate, {
            pidMatch,
            identityMatch: candidateMatchesApplicationIdentity(candidate, target, pathModule)
        });
    });
    const processMatches = annotated.filter(candidate => candidate.pidMatch === true);
    const identityMatches = annotated.filter(candidate => candidate.identityMatch);
    let eligible;
    let evidence;

    if (processMatches.length) {
        eligible = processMatches;
        evidence = "launched process or descendant";
    } else if (identityMatches.length) {
        eligible = identityMatches;
        evidence = "trusted application identity";
    } else if (annotated.length > 1) {
        throw ambiguousLearningError(annotated, "no candidate could be correlated to the trusted launch", log);
    } else {
        annotated.forEach((candidate, index) => safeLog(log, "warn", candidateLogSummary(candidate, index)));
        safeLog(log, "warn", "WM_CLASS LEARNING SELECTION: no candidate could be verified");
        throw new CliError("WINDOW CLASS LEARNING COULD NOT VERIFY THE APPLICATION WINDOW\nREGISTRY NOT CHANGED");
    }

    if (eligible.length === 1) {
        return selectionResult(eligible, `only candidate matched ${evidence}`, annotated, log);
    }
    if (sharedMatcher(eligible)) {
        return selectionResult(eligible, `all candidates matched ${evidence} and share one exact matcher`, annotated, log);
    }

    const owners = transientOwnerCandidates(eligible);
    if (owners.length && sharedMatcher(owners)) {
        return selectionResult(owners, "candidate owns the other application's transient window", annotated, log);
    }

    const topLevel = nonAuxiliaryCandidates(eligible);
    if (topLevel.length && topLevel.length < eligible.length && sharedMatcher(topLevel)) {
        return selectionResult(topLevel, "normal top-level candidate preferred over transient or auxiliary windows", annotated, log);
    }

    throw ambiguousLearningError(annotated,
        `multiple ${evidence} top-level candidates have different exact matchers`, log);
}

function candidateStabilitySignature(candidates) {
    return JSON.stringify(candidates.slice().sort((left, right) => left.key.localeCompare(right.key)).map(candidate => [
        candidate.key,
        candidate.className,
        candidate.instance,
        candidate.pid,
        candidate.pidMatch,
        candidate.transientFor,
        candidate.windowType
    ]));
}

class WindowClassLearningService {
    constructor(opts = {}) {
        if (!opts.applicationService) throw new TypeError("Window class learning requires an ApplicationService");
        this.applicationService = opts.applicationService;
        this.env = opts.env || process.env;
        this.path = opts.path || path;
        this.spawn = opts.learningSpawn || childProcess.spawn;
        this.getTree = opts.getTree || (() => readI3Tree({execFile: opts.execFile, env: this.env}));
        this.readWindowPid = opts.readWindowPid || (windowId => readX11WindowPid(windowId, {
            env: this.env,
            execFile: opts.xpropExecFile || opts.execFile
        }));
        this.processCorrelator = opts.processCorrelator || processCorrelationStatus;
        this.log = opts.log || this.applicationService.log || (() => {});
        this.now = opts.now || Date.now;
        this.sleep = opts.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.defaultTimeoutMs = validateLearningTimeoutMs(opts.defaultTimeoutMs);
        this.pollIntervalMs = Number.isInteger(opts.pollIntervalMs) && opts.pollIntervalMs > 0
            ? opts.pollIntervalMs
            : DEFAULT_POLL_INTERVAL_MS;
        this.settleIntervalMs = Number.isInteger(opts.settleIntervalMs) && opts.settleIntervalMs >= 0
            ? opts.settleIntervalMs
            : DEFAULT_SETTLE_INTERVAL_MS;
    }

    async learn(identifier, opts = {}) {
        if (!opts || typeof opts !== "object" || Array.isArray(opts)
            || Object.keys(opts).some(key => key !== "timeoutMs")) {
            throw new CliError("WINDOW CLASS LEARNING OPTIONS INVALID", 2);
        }
        const timeoutMs = validateLearningTimeoutMs(opts.timeoutMs, this.defaultTimeoutMs);
        const target = this.applicationService.prepareWindowClassLearning(identifier);
        if (typeof this.env.I3SOCK !== "string" || !this.env.I3SOCK.trim()) {
            throw new CliError("NOMAD SESSION REQUIRED FOR WINDOW CLASS LEARNING\nREGISTRY NOT CHANGED");
        }

        let beforeTree;
        try {
            beforeTree = await this.getTree();
        } catch (error) {
            throw new CliError("NOMAD SESSION REQUIRED FOR WINDOW CLASS LEARNING\nI3 WINDOW TREE NOT AVAILABLE\nREGISTRY NOT CHANGED");
        }
        const beforeKeys = new Set(snapshotI3Clients(beforeTree).keys());
        const launch = await this._launch(target);
        safeLog(this.log, "info", `WM_CLASS LEARNING START: application=${sanitizeDiagnosticValue(target.id)}`);
        const candidates = await this._observeNewWindows(beforeKeys, launch, timeoutMs);
        const selected = selectLearningCandidate(candidates, target, launch.pid, {
            path: this.path,
            processCorrelator: this.processCorrelator,
            log: this.log
        });
        const stored = this.applicationService.storeLearnedWindowMatcher(target, {
            className: selected.className,
            instance: selected.instance
        });
        return Object.assign({}, stored, {
            className: selected.className,
            instance: selected.instance,
            containerId: selected.containerId,
            windowId: selected.windowId,
            pid: selected.pid
        });
    }

    _launch(target) {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = this.spawn(target.executable, target.args.slice(), {
                    detached: true,
                    shell: false,
                    stdio: "ignore"
                });
            } catch (error) {
                reject(new CliError(`APPLICATION FAILED TO START: ${error.message}\nREGISTRY NOT CHANGED`));
                return;
            }
            if (!child || typeof child.once !== "function") {
                reject(new CliError("APPLICATION FAILED TO START\nREGISTRY NOT CHANGED"));
                return;
            }

            let settled = false;
            const launch = {pid: null, error: null};
            const onError = error => {
                launch.error = error;
                if (settled) return;
                settled = true;
                child.removeListener("spawn", onSpawn);
                reject(new CliError(`APPLICATION FAILED TO START: ${error.message}\nREGISTRY NOT CHANGED`));
            };
            const onSpawn = () => {
                if (settled) return;
                settled = true;
                child.removeListener("error", onError);
                if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
                    reject(new CliError("APPLICATION FAILED TO START: PROCESS ID NOT AVAILABLE\nREGISTRY NOT CHANGED"));
                    return;
                }
                launch.pid = child.pid;
                child.once("error", error => { launch.error = error; });
                if (typeof child.unref === "function") child.unref();
                resolve(launch);
            };
            child.once("error", onError);
            child.once("spawn", onSpawn);
        });
    }

    async _enrichCandidate(candidate, launchPid, previous) {
        let pid = candidate.pid;
        let pidLookupAttempted = Boolean(previous && previous.pidLookupAttempted);
        if (!pid && previous && previous.pid) pid = previous.pid;
        if (!pid && !pidLookupAttempted && candidate.windowId) {
            pidLookupAttempted = true;
            try {
                pid = positiveSafeInteger(await this.readWindowPid(candidate.windowId));
            } catch (error) {
                pid = null;
            }
        }

        let pidMatch = previous && previous.pidMatch === true ? true : null;
        if (pidMatch !== true && pid) {
            try {
                const correlation = this.processCorrelator(launchPid, pid);
                pidMatch = correlation === true ? true : correlation === false ? false : null;
            } catch (error) {
                pidMatch = null;
            }
        }
        return Object.assign({}, candidate, {pid, pidMatch, pidLookupAttempted});
    }

    async _observeNewWindows(beforeKeys, launch, timeoutMs) {
        const deadline = this.now() + timeoutMs;
        const history = new Map();
        let activeCandidates = [];
        let stableSince = null;
        let stableSignature = null;
        let observedAny = false;

        while (this.now() <= deadline) {
            if (launch.error) {
                throw new CliError(`APPLICATION FAILED TO START: ${launch.error.message}\nREGISTRY NOT CHANGED`);
            }
            let tree;
            try {
                tree = await this.getTree();
            } catch (error) {
                throw new CliError("I3 WINDOW TREE BECAME UNAVAILABLE DURING WINDOW CLASS LEARNING\nREGISTRY NOT CHANGED");
            }

            const rawCandidates = newI3WindowCandidates(tree, beforeKeys);
            if (rawCandidates.length) observedAny = true;
            activeCandidates = await Promise.all(rawCandidates.map(candidate => {
                return this._enrichCandidate(candidate, launch.pid, history.get(candidate.key));
            }));
            activeCandidates.forEach(candidate => history.set(candidate.key, candidate));

            const now = this.now();
            const signature = candidateStabilitySignature(activeCandidates);
            if (signature !== stableSignature) {
                stableSignature = signature;
                stableSince = now;
            }
            if (activeCandidates.length && stableSince !== null
                && now - stableSince >= this.settleIntervalMs) {
                return activeCandidates;
            }

            const remaining = deadline - this.now();
            if (remaining <= 0) break;
            await this.sleep(Math.min(this.pollIntervalMs, remaining));
        }

        if (!observedAny) {
            throw new CliError("NO NEW APPLICATION WINDOW DETECTED BEFORE TIMEOUT\nREGISTRY NOT CHANGED");
        }
        throw new CliError("WINDOW CLASS LEARNING TIMED OUT BEFORE WINDOW IDENTITY STABILIZED\nREGISTRY NOT CHANGED");
    }
}

module.exports = {
    DEFAULT_LEARNING_TIMEOUT_MS,
    MAX_LEARNING_TIMEOUT_MS,
    MIN_LEARNING_TIMEOUT_MS,
    WindowClassLearningService,
    applicationIdentityValues,
    candidateMatchesApplicationIdentity,
    candidateStabilitySignature,
    newI3WindowCandidates,
    parseProcessStat,
    parseX11WindowPid,
    processBelongsToLaunch,
    processCorrelationStatus,
    readI3Tree,
    readX11WindowPid,
    sanitizeDiagnosticValue,
    selectLearningCandidate,
    snapshotI3Clients,
    validateLearningTimeoutMs
};
