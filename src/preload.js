"use strict";

const {contextBridge, ipcRenderer} = require("electron");
const ISOLATED_RENDERER = process.argv.includes("--nomad-secure-renderer");

let preloadStage = "MODULE";
function reportPreloadDiagnostic(stage, error) {
    const description = error && error.message ? error.message : `${stage} COMPLETE`;
    try {
        ipcRenderer.send("nomad.renderer.preload-diagnostic", {
            stage,
            code: error && error.name ? String(error.name).slice(0, 64) : "OK",
            description: String(description).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512)
        });
    } catch (diagnosticError) {}
}

reportPreloadDiagnostic("START");

try {

const APP_OPERATION_SET = new Set(["get", "reload"]);
const REPOSITORY_ACTION_SET = new Set(["code", "terminal", "info", "github", "run", "stop", "pull"]);
const WINDOW_OPERATION_SET = new Set([
    "availability", "focusNomad", "launch", "focus", "restore", "minimize",
    "fullscreen", "unfullscreen", "close", "geometry"
]);
const LOG_LEVEL_SET = new Set(["info", "warn", "error", "debug", "note"]);
const REPOSITORY_PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const REPOSITORY_AUTHORIZATION_SET = new Set(["run-once", "trust-profile"]);
const CONTROL_ACTION_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const CONTROL_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const CHALLENGE_PATTERN = /^challenge_[a-f0-9]{48}$/;
const TERMINAL_EVENT_SET = new Set(["Renderer startup", "Resize"]);
const WINDOW_ACTION_SET = new Set(["focus", "minimize", "toggle-fullscreen", "restart", "quit", "toggle-devtools"]);
const CONFIG_DOCUMENT_SET = new Set(["settings", "shortcuts"]);
const SYSTEM_METHOD_SET = new Set([
    "battery", "chassis", "cpu", "cpuTemperature", "currentLoad", "mem",
    "networkInterfaces", "networkStats", "processes", "system"
]);

function plainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeGeometry(value) {
    return plainObject(value) && Object.keys(value).every(key => ["x", "y", "width", "height"].includes(key))
        && [value.x, value.y, value.width, value.height].every(Number.isFinite)
        && Math.abs(value.x) <= 100000 && Math.abs(value.y) <= 100000
        && value.width > 0 && value.height > 0 && value.width <= 100000 && value.height <= 100000;
}

function on(channel, callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

function validControlTarget(value) {
    return typeof value === "undefined" || (typeof value === "string" && value.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(value)
        && (CONTROL_TARGET_PATTERN.test(value) || /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)));
}

function systemRequest(method, targetId) {
    if (!SYSTEM_METHOD_SET.has(method) || (method !== "networkStats" && typeof targetId !== "undefined")
        || (method === "networkStats" && !/^iface_[a-f0-9]{24}$/.test(targetId || ""))) {
        return Promise.resolve({ok: false, status: "INVALID SYSTEM INFORMATION REQUEST"});
    }
    const request = {method};
    if (method === "networkStats") request.targetId = targetId;
    return ipcRenderer.invoke("nomad.system.query", request);
}

const api = {
    auth: Object.freeze({
        getSession: () => ipcRenderer.invoke("nomad.auth.session.get", {}),
        confirmSession: () => ipcRenderer.invoke("nomad.auth.session.confirm", {})
    }),
    applications: Object.freeze({
        request(operation) {
            if (!APP_OPERATION_SET.has(operation)) return Promise.resolve({ok: false, status: "INVALID REQUEST", applications: []});
            return ipcRenderer.invoke("application-registry-operation", {operation});
        }
    }),
    repositories: Object.freeze({
        refresh() {
            return ipcRenderer.invoke("repository-operation", {operation: "refresh"});
        },
        clone(repositoryUrl) {
            if (ISOLATED_RENDERER) {
                return Promise.resolve({ok: false, status: "USE NOMAD CONTROL PLANE"});
            }
            if (typeof repositoryUrl !== "string" || repositoryUrl.length > 2048 || /[\u0000-\u001f\u007f]/.test(repositoryUrl)) {
                return Promise.resolve({ok: false, status: "INVALID REQUEST"});
            }
            return ipcRenderer.invoke("repository-operation", {operation: "clone", repositoryUrl});
        },
        cancelClone() {
            return ipcRenderer.invoke("repository-operation", {operation: "cancel-clone"});
        },
        action(request) {
            if (!plainObject(request) || Object.keys(request).some(key => ![
                "repositoryId", "actionId", "geometry", "profileId", "authorizationId", "authorization"
            ].includes(key)) || !/^repo_[a-f0-9]{32}$/.test(request.repositoryId || "")
                || !REPOSITORY_ACTION_SET.has(request.actionId)) {
                return Promise.resolve({ok: false, status: "INVALID REQUEST"});
            }
            if (ISOLATED_RENDERER && request.actionId === "pull") {
                return Promise.resolve({ok: false, status: "USE NOMAD CONTROL PLANE"});
            }
            if (ISOLATED_RENDERER && typeof request.geometry !== "undefined") {
                return Promise.resolve({ok: false, status: "INVALID REQUEST"});
            }
            const geometryAction = ["code", "github"].includes(request.actionId);
            if ((!ISOLATED_RENDERER && geometryAction && !safeGeometry(request.geometry))
                || (!geometryAction && typeof request.geometry !== "undefined")) {
                return Promise.resolve({ok: false, status: "INVALID REQUEST"});
            }
            const runKeysPresent = ["profileId", "authorizationId", "authorization"]
                .some(key => Object.prototype.hasOwnProperty.call(request, key));
            if (request.actionId !== "run" && runKeysPresent) {
                return Promise.resolve({ok: false, status: "INVALID REQUEST"});
            }
            if (request.actionId === "run") {
                if (typeof request.profileId !== "undefined" && !REPOSITORY_PROFILE_PATTERN.test(request.profileId)) {
                    return Promise.resolve({ok: false, status: "INVALID REQUEST"});
                }
                if (typeof request.authorization !== "undefined") {
                    if (!REPOSITORY_AUTHORIZATION_SET.has(request.authorization)
                        || !REPOSITORY_PROFILE_PATTERN.test(request.profileId || "")
                        || !/^auth_[a-f0-9]{48}$/.test(request.authorizationId || "")) {
                        return Promise.resolve({ok: false, status: "INVALID REQUEST"});
                    }
                } else if (typeof request.authorizationId !== "undefined") {
                    return Promise.resolve({ok: false, status: "INVALID REQUEST"});
                }
            }
            const projected = Object.assign({}, request);
            if (ISOLATED_RENDERER) delete projected.geometry;
            return ipcRenderer.invoke("repository-operation", Object.assign({operation: "action"}, projected));
        },
        onProcessState(callback) { return on("repository-process-state", callback); },
        onGitState(callback) { return on("repository-git-state", callback); }
    }),
    security: Object.freeze({
        status(verbose = false) {
            if (typeof verbose !== "boolean") return Promise.resolve({ok: false, status: "INVALID REQUEST"});
            return ipcRenderer.invoke("security.status", {verbose});
        },
        profile() {
            return ipcRenderer.invoke("security.profile.get", {});
        }
    }),
    control: Object.freeze({
        request(actionId, targetId) {
            if (!CONTROL_ACTION_PATTERN.test(actionId || "") || !validControlTarget(targetId)) {
                return Promise.resolve({ok: false, status: "UNKNOWN TRUSTED ACTION"});
            }
            const request = {actionId};
            if (typeof targetId === "string") request.targetId = targetId;
            return ipcRenderer.invoke("nomad.control.request", request);
        },
        confirm(challengeId) {
            if (!CHALLENGE_PATTERN.test(challengeId || "")) return Promise.resolve({ok: false, status: "CONFIRMATION INVALID"});
            return ipcRenderer.invoke("nomad.control.confirm", {challengeId});
        },
        cancel(challengeId) {
            if (!CHALLENGE_PATTERN.test(challengeId || "")) return Promise.resolve({ok: false, status: "CONFIRMATION INVALID"});
            return ipcRenderer.invoke("nomad.control.cancel", {challengeId});
        },
        setContext(context) {
            if (!plainObject(context) || Object.keys(context).some(key => ![
                "selectedRepositoryId", "activeApplicationId", "currentWorkspace"
            ].includes(key))) return Promise.resolve({ok: false, status: "INVALID CONTEXT"});
            if (Object.prototype.hasOwnProperty.call(context, "selectedRepositoryId")
                && context.selectedRepositoryId !== null && !/^repo_[a-f0-9]{32}$/.test(context.selectedRepositoryId || "")) {
                return Promise.resolve({ok: false, status: "INVALID CONTEXT"});
            }
            if (["activeApplicationId", "currentWorkspace"].some(key => Object.prototype.hasOwnProperty.call(context, key)
                && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(context[key] || ""))) {
                return Promise.resolve({ok: false, status: "INVALID CONTEXT"});
            }
            return ipcRenderer.invoke("nomad.control.context", context);
        },
        onApplicationsChanged(callback) { return on("nomad.control.applications-changed", callback); }
    }),
    automation: Object.freeze({
        status(operationId) {
            if (typeof operationId !== "string" || !/^automation_[a-f0-9]{32}$/.test(operationId)) return Promise.resolve({ok: false, status: "AUTOMATION ID INVALID"});
            return ipcRenderer.invoke("nomad.automation.status", {operationId});
        },
        cancel(operationId) {
            if (typeof operationId !== "string" || !/^automation_[a-f0-9]{32}$/.test(operationId)) return Promise.resolve({ok: false, status: "AUTOMATION ID INVALID"});
            return ipcRenderer.invoke("nomad.automation.cancel", {operationId});
        },
        log(operationId) {
            if (typeof operationId !== "string" || !/^automation_[a-f0-9]{32}$/.test(operationId)) return Promise.resolve({ok: false, status: "AUTOMATION ID INVALID"});
            return ipcRenderer.invoke("nomad.automation.log", {operationId});
        },
        onState(callback) { return on("nomad.automation.state", callback); }
    }),
    assistant: Object.freeze({
        interpret(input) {
            if (typeof input !== "string" || input.length > 2048
                || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) {
                return Promise.resolve({ok: false, status: "INTENT INPUT INVALID"});
            }
            return ipcRenderer.invoke("nomad.assistant.interpret", {input});
        }
    }),
    windowManager: Object.freeze({
        operate(request) {
            if (!plainObject(request) || Object.keys(request).some(key => !["requestId", "operation", "appId"].includes(key))
                || !Number.isSafeInteger(request.requestId) || request.requestId < 0
                || !WINDOW_OPERATION_SET.has(request.operation)
                || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(request.appId || "")) return false;
            ipcRenderer.send("nomad.workspace.operate", request);
            return true;
        },
        snapshot() { return ipcRenderer.invoke("nomad.workspace.snapshot.get", {}); },
        onState(callback) { return on("window-manager-state", callback); },
        onGeometryChanged(callback) { return on("window-manager-geometry-changed", callback); }
    }),
    terminal: Object.freeze({
        connection(port) {
            if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
            if (ISOLATED_RENDERER) {
                return ipcRenderer.invoke("nomad.terminal.connection.get", {port}).then(result => {
                    if (!plainObject(result) || Object.keys(result).length !== 2 || result.port !== port
                        || !/^[a-f0-9]{64}$/.test(result.authToken || "")) return null;
                    return Object.freeze({port: result.port, authToken: result.authToken});
                });
            }
            const result = ipcRenderer.sendSync("nomad.terminal.connection", {port});
            if (!plainObject(result) || Object.keys(result).length !== 2 || result.port !== port
                || !/^[a-f0-9]{64}$/.test(result.authToken || "")) return null;
            return Object.freeze({port: result.port, authToken: result.authToken});
        },
        getForegroundState() {
            return ipcRenderer.invoke("terminal-operation", "terminal.getForegroundState");
        },
        stopForeground() {
            return ipcRenderer.invoke("terminal-operation", "terminal.stopForeground");
        },
        create() {
            return ipcRenderer.invoke("nomad.terminal.create", {});
        },
        sendClientEvent(port, type, cols, rows) {
            if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !TERMINAL_EVENT_SET.has(type)) return false;
            if (type === "Resize" && (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)
                || cols < 1 || cols > 1000 || rows < 1 || rows > 1000)) return false;
            ipcRenderer.send(`terminal_channel-${port}`, type, type === "Resize" ? String(cols).padStart(3, "0") : undefined,
                type === "Resize" ? String(rows).padStart(3, "0") : undefined);
            return true;
        },
        onClientState(port, callback) {
            if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof callback !== "function") return () => {};
            const channel = `terminal_channel-${port}`;
            const listener = (event, ...payload) => {
                if (!ISOLATED_RENDERER) {
                    callback(payload);
                    return;
                }
                if (payload[0] !== "New process") return;
                const processName = typeof payload[1] === "string"
                    ? payload[1].split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 128) : "";
                callback(["New process", processName]);
            };
            ipcRenderer.on(channel, listener);
            return () => ipcRenderer.removeListener(channel, listener);
        },
        onForegroundState(callback) { return on("terminal-foreground-state", callback); },
        readClipboard() { return ipcRenderer.invoke("nomad.terminal.clipboard-read", {}); }
    }),
    system: Object.freeze({
        battery: () => systemRequest("battery"),
        chassis: () => systemRequest("chassis"),
        cpu: () => systemRequest("cpu"),
        cpuTemperature: () => systemRequest("cpuTemperature"),
        currentLoad: () => systemRequest("currentLoad"),
        mem: () => systemRequest("mem"),
        networkInterfaces: () => systemRequest("networkInterfaces"),
        networkStats: interfaceId => systemRequest("networkStats", interfaceId),
        processes: () => systemRequest("processes"),
        system: () => systemRequest("system"),
        ping: () => ipcRenderer.invoke("nomad.system.ping", {}),
        getTelemetry: () => ipcRenderer.invoke("nomad.system.telemetry.get", {}),
        subscribeTelemetry: callback => on("nomad.system.telemetry", callback)
    }),
    network: Object.freeze({
        getTelemetry: () => ipcRenderer.invoke("nomad.network.telemetry.get", {}),
        subscribeTelemetry: callback => on("nomad.network.telemetry", callback)
    }),
    settings: Object.freeze({
        update(patch) {
            if (!plainObject(patch)) return Promise.resolve({ok: false, status: "INVALID SETTINGS"});
            return ipcRenderer.invoke("nomad.settings.update", patch);
        },
        selectTheme(themeId) {
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(themeId || "")) return Promise.resolve({ok: false, status: "INVALID THEME"});
            return ipcRenderer.invoke("nomad.settings.theme", {themeId});
        },
        selectKeyboard(keyboardId) {
            if (!/^[A-Za-z]{2}(?:-[A-Za-z0-9]{1,16}){1,2}$/.test(keyboardId || "")) return Promise.resolve({ok: false, status: "INVALID KEYBOARD"});
            return ipcRenderer.invoke("nomad.settings.keyboard", {keyboardId});
        },
        openDocument(documentId) {
            if (!CONFIG_DOCUMENT_SET.has(documentId)) return Promise.resolve({ok: false, status: "INVALID DOCUMENT"});
            return ipcRenderer.invoke("nomad.settings.open-document", {documentId});
        }
    }),
    runtime: Object.freeze({
        versions: Object.freeze({
            node: String(process.versions.node || ""),
            electron: String(process.versions.electron || ""),
            chrome: String(process.versions.chrome || "")
        }),
        bootstrap() {
            if (ISOLATED_RENDERER) return ipcRenderer.invoke("nomad.runtime.bootstrap.get", {});
            const result = ipcRenderer.sendSync("nomad.runtime.bootstrap", {});
            return plainObject(result) ? result : null;
        },
        windowAction(action) {
            if (!WINDOW_ACTION_SET.has(action)) return Promise.resolve({ok: false, status: "INVALID WINDOW ACTION"});
            return ipcRenderer.invoke("nomad.window.action", {action});
        },
        onResize(callback) { return on("nomad.window.resize", callback); },
        onLeaveFullscreen(callback) { return on("nomad.window.leave-fullscreen", callback); }
    }),
    log(level, message) {
        if (!LOG_LEVEL_SET.has(level) || typeof message !== "string") return false;
        ipcRenderer.send("log", level, message.slice(0, 1024));
        return true;
    }
};

Object.freeze(api);

preloadStage = "BRIDGE";
if (ISOLATED_RENDERER) contextBridge.exposeInMainWorld("nomad", api);
else window.nomad = api;
reportPreloadDiagnostic("BRIDGE");
preloadStage = "STATE";
ipcRenderer.send("nomad.renderer.preload-state", {
    contextIsolated: ISOLATED_RENDERER,
    bridgeVersion: 1
});
reportPreloadDiagnostic("COMPLETE");
} catch (error) {
    reportPreloadDiagnostic(preloadStage, error);
    throw error;
}
