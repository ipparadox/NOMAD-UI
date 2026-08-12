const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
const LOG_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const MAX_LOG_MESSAGE_LENGTH = 2048;

function defaultNomadLogPath(opts = {}) {
    const env = opts.env || process.env;
    const home = opts.home || env.HOME || os.homedir();
    const configuredState = typeof env.XDG_STATE_HOME === "string" && path.isAbsolute(env.XDG_STATE_HOME)
        ? env.XDG_STATE_HOME : null;
    const stateRoot = configuredState || path.join(home, ".local", "state");
    return path.join(stateRoot, "nomad", "session.log");
}

function sanitizeLogMessage(message) {
    const sanitized = String(message).replace(LOG_CONTROL_CHARACTERS, " ");
    return sanitized.length <= MAX_LOG_MESSAGE_LENGTH
        ? sanitized : `${sanitized.slice(0, MAX_LOG_MESSAGE_LENGTH - 3)}...`;
}

function createNomadLog(opts = {}) {
    const fsModule = opts.fs || fs;
    const logPath = opts.logPath || defaultNomadLogPath(opts);
    const directory = path.dirname(logPath);
    return (level, message) => {
        const normalizedLevel = LOG_LEVELS.has(level) ? level.toUpperCase() : "INFO";
        const line = `${new Date().toISOString()} NOMAD-CLI ${normalizedLevel} ${sanitizeLogMessage(message)}\n`;
        let descriptor;
        try {
            fsModule.mkdirSync(directory, {recursive: true, mode: 0o700});
            try {
                const stats = fsModule.lstatSync(logPath);
                if (stats.isSymbolicLink() || !stats.isFile()) return;
            } catch (error) {
                if (!error || error.code !== "ENOENT") return;
            }
            const constants = fsModule.constants || fs.constants;
            descriptor = fsModule.openSync(logPath,
                constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
            if (!fsModule.fstatSync(descriptor).isFile()) return;
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
