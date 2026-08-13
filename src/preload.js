"use strict";

const {contextBridge, ipcRenderer} = require("electron");

const APP_OPERATION_SET = new Set(["get", "reload"]);
const REPOSITORY_ACTION_SET = new Set(["code", "terminal", "info", "github", "run", "stop", "pull"]);
const WINDOW_OPERATION_SET = new Set([
    "availability", "focusNomad", "launch", "focus", "restore", "minimize",
    "fullscreen", "unfullscreen", "close", "geometry"
]);
const LOG_LEVEL_SET = new Set(["info", "warn", "error", "debug", "note"]);
const REPOSITORY_PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const REPOSITORY_AUTHORIZATION_SET = new Set(["run-once", "trust-profile"]);

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

const api = {
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
            if ((["code", "github"].includes(request.actionId) && !safeGeometry(request.geometry))
                || (!(["code", "github"].includes(request.actionId)) && typeof request.geometry !== "undefined")) {
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
            return ipcRenderer.invoke("repository-operation", Object.assign({operation: "action"}, request));
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
    windowManager: Object.freeze({
        send(request) {
            if (!plainObject(request) || !Number.isSafeInteger(request.requestId) || request.requestId < 0
                || !WINDOW_OPERATION_SET.has(request.operation)
                || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(request.appId || "")
                || (typeof request.geometry !== "undefined" && !safeGeometry(request.geometry))) return false;
            ipcRenderer.send("window-manager-operation", request);
            return true;
        },
        onState(callback) { return on("window-manager-state", callback); },
        onGeometryChanged(callback) { return on("window-manager-geometry-changed", callback); }
    }),
    terminal: Object.freeze({
        connection(port) {
            if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
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
        }
    }),
    runtime: Object.freeze({
        windowBounds() {
            const result = ipcRenderer.sendSync("nomad.runtime.window-bounds", {});
            return safeGeometry(result) ? result : {x: 0, y: 0, width: 1, height: 1};
        },
        versions: Object.freeze({
            node: String(process.versions.node || ""),
            electron: String(process.versions.electron || ""),
            chrome: String(process.versions.chrome || "")
        })
    }),
    log(level, message) {
        if (!LOG_LEVEL_SET.has(level) || typeof message !== "string") return false;
        ipcRenderer.send("log", level, message.slice(0, 1024));
        return true;
    }
};

Object.freeze(api);

if (process.contextIsolated) contextBridge.exposeInMainWorld("nomad", api);
else window.nomad = api;
