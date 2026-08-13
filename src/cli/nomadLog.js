const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const LOG_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const MAX_LOG_MESSAGE_LENGTH = 2048;

function defaultNomadLogPath(opts = {}) {
    const env = opts.env || process.env;
    const home = opts.home || env.HOME || os.homedir();
    const restrictedSession = ["PUBLIC", "LOCKDOWN"].includes(env.NOMAD_SESSION_PROFILE)
        && env.NOMAD_EPHEMERAL_ACTIVE === "1"
        && typeof env.XDG_RUNTIME_DIR === "string" && path.isAbsolute(env.XDG_RUNTIME_DIR);
    const expectedVolatileLogRoot = restrictedSession
        ? path.join(env.XDG_RUNTIME_DIR, "nomad", "log") : null;
    if (expectedVolatileLogRoot && env.NOMAD_LOG_ROOT === expectedVolatileLogRoot) {
        return path.join(expectedVolatileLogRoot, "session.log");
    }
    const configuredState = typeof env.XDG_STATE_HOME === "string" && path.isAbsolute(env.XDG_STATE_HOME)
        ? env.XDG_STATE_HOME : null;
    const stateRoot = configuredState || path.join(home, ".local", "state");
    return path.join(stateRoot, "nomad", "session.log");
}

function sanitizeLogMessage(message) {
    const sanitized = String(message).replace(LOG_CONTROL_CHARACTERS, " ")
        .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/ig, "$1[REDACTED]")
        .replace(/((?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\s*[=:]\s*)[^\s,;]+/ig, "$1[REDACTED]")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/ig, "$1[REDACTED]@");
    return sanitized.length <= MAX_LOG_MESSAGE_LENGTH
        ? sanitized : `${sanitized.slice(0, MAX_LOG_MESSAGE_LENGTH - 3)}...`;
}

function createNomadLog(opts = {}) {
    const fsModule = opts.fs || fs;
    const logPath = opts.logPath || defaultNomadLogPath(opts);
    const directory = path.dirname(logPath);
    const uid = Object.prototype.hasOwnProperty.call(opts, "uid")
        ? opts.uid : (typeof process.getuid === "function" ? process.getuid() : null);
    return (level, message) => {
        const normalizedLevel = LOG_LEVELS.has(level) ? level.toUpperCase() : "INFO";
        const line = `${new Date().toISOString()} NOMAD-CLI ${normalizedLevel} ${sanitizeLogMessage(message)}\n`;
        let descriptor;
        try {
            fsModule.mkdirSync(directory, {recursive: true, mode: 0o700});
            const directoryStats = fsModule.lstatSync(directory);
            if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()
                || (uid !== null && typeof directoryStats.uid === "number" && directoryStats.uid !== uid)
                || (directoryStats.mode & 0o077) !== 0 || fsModule.realpathSync(directory) !== path.resolve(directory)) return;
            let before = null;
            try {
                before = fsModule.lstatSync(logPath);
                if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1
                    || (uid !== null && typeof before.uid === "number" && before.uid !== uid)
                    || (before.mode & 0o077) !== 0) return;
            } catch (error) {
                if (!error || error.code !== "ENOENT") return;
            }
            const constants = fsModule.constants || fs.constants;
            descriptor = fsModule.openSync(logPath,
                constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
            const opened = fsModule.fstatSync(descriptor);
            if (!opened.isFile() || opened.nlink !== 1
                || (uid !== null && typeof opened.uid === "number" && opened.uid !== uid)
                || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) return;
            fsModule.fchmodSync(descriptor, 0o600);
            fsModule.writeSync(descriptor, line, null, "utf8");
        } catch (error) {
            // Logging must never make a safe CLI operation fail.
        } finally {
            if (typeof descriptor === "number") {
                try {
                    fsModule.closeSync(descriptor);
                } catch (error) {}
            }
        }
    };
}

module.exports = {
    createNomadLog,
    defaultNomadLogPath,
    sanitizeLogMessage
};
