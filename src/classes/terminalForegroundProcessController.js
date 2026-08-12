const fs = require("fs");

const GET_FOREGROUND_STATE = "terminal.getForegroundState";
const STOP_FOREGROUND = "terminal.stopForeground";
const LIVE_PROCESS_STATES = new Set(["R", "S", "D", "T", "t", "K", "W", "P", "I"]);

function publicTerminalState(foregroundProcessRunning, ok = true) {
    return {
        ok: ok === true,
        foregroundProcessRunning: foregroundProcessRunning === true
    };
}

function parseLinuxProcStat(value) {
    if (typeof value !== "string") return null;
    const openingParenthesis = value.indexOf("(");
    const closingParenthesis = value.lastIndexOf(")");
    if (openingParenthesis <= 0 || closingParenthesis <= openingParenthesis) return null;

    const pid = Number(value.slice(0, openingParenthesis).trim());
    const fields = value.slice(closingParenthesis + 1).trim().split(/\s+/);
    if (!Number.isSafeInteger(pid) || pid <= 0 || fields.length < 20) return null;

    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const sessionId = Number(fields[3]);
    const ttyNumber = Number(fields[4]);
    const foregroundProcessGroupId = Number(fields[5]);
    if (![parentPid, processGroupId, sessionId, ttyNumber, foregroundProcessGroupId]
        .every(Number.isSafeInteger) || !/^\d+$/.test(fields[19])) return null;

    return {
        pid,
        state: fields[0],
        parentPid,
        processGroupId,
        sessionId,
        ttyNumber,
        foregroundProcessGroupId,
        startTime: fields[19]
    };
}

async function readLinuxProcessStat(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
        const value = await fs.promises.readFile(`/proc/${pid}/stat`, {encoding: "utf8"});
        return parseLinuxProcStat(value);
    } catch (error) {
        if (error && ["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return null;
        throw error;
    }
}

async function listLinuxProcessIds() {
    const entries = await fs.promises.readdir("/proc");
    return entries.filter(entry => /^[1-9][0-9]*$/.test(entry)).map(Number);
}

function sameForeground(left, right) {
    return Boolean(left && right
        && left.processGroupId === right.processGroupId
        && left.sessionId === right.sessionId
        && left.ttyNumber === right.ttyNumber);
}

class TerminalForegroundProcessController {
    constructor(opts = {}) {
        this.platform = opts.platform || process.platform;
        this.shellPid = opts.shellPid;
        this.readProcessStat = opts.readProcessStat || readLinuxProcessStat;
        this.listProcessIds = opts.listProcessIds || listLinuxProcessIds;
        this.kill = opts.kill || process.kill.bind(process);
        this.wait = opts.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.setInterval = opts.setInterval || setInterval;
        this.clearInterval = opts.clearInterval || clearInterval;
        this.pollIntervalMs = Number.isSafeInteger(opts.pollIntervalMs) ? opts.pollIntervalMs : 250;
        this.interruptGracePeriodMs = Number.isSafeInteger(opts.interruptGracePeriodMs)
            ? opts.interruptGracePeriodMs : 750;
        this.terminateGracePeriodMs = Number.isSafeInteger(opts.terminateGracePeriodMs)
            ? opts.terminateGracePeriodMs : 750;
        this.killSettlePeriodMs = Number.isSafeInteger(opts.killSettlePeriodMs)
            ? opts.killSettlePeriodMs : 250;
        this.log = typeof opts.log === "function" ? opts.log : (() => {});
        this.onState = typeof opts.onState === "function" ? opts.onState : (() => {});

        this.foregroundProcessRunning = false;
        this.shellIdentity = null;
        this._pollTimer = null;
        this._refreshPromise = null;
        this._stopPromise = null;
        this._destroyed = false;
    }

    getState() {
        return publicTerminalState(this.foregroundProcessRunning);
    }

    start() {
        if (this._destroyed || this._pollTimer || this.platform !== "linux") {
            return this.refresh();
        }
        this._pollTimer = this.setInterval(() => this.refresh().catch(error => {
            this.log("warn", `Terminal foreground state refresh failed: ${error.message}`);
        }), this.pollIntervalMs);
        if (this._pollTimer && typeof this._pollTimer.unref === "function") this._pollTimer.unref();
        return this.refresh();
    }

    destroy() {
        this._destroyed = true;
        if (this._pollTimer) this.clearInterval(this._pollTimer);
        this._pollTimer = null;
        this._setForegroundProcessRunning(false);
    }

    refresh() {
        if (this._refreshPromise) return this._refreshPromise;
        this._refreshPromise = this._readForeground().then(foreground => {
            this._setForegroundProcessRunning(Boolean(foreground));
            return this.getState();
        }).catch(error => {
            this._setForegroundProcessRunning(false);
            throw error;
        }).finally(() => {
            this._refreshPromise = null;
        });
        return this._refreshPromise;
    }

    stopForeground() {
        if (this._stopPromise) return this._stopPromise;
        this._stopPromise = this._stopForeground().finally(() => {
            this._stopPromise = null;
        });
        return this._stopPromise;
    }

    async _stopForeground() {
        if (this._destroyed || this.platform !== "linux") {
            this._setForegroundProcessRunning(false);
            return publicTerminalState(false, false);
        }

        let identity;
        try {
            identity = await this._captureForegroundIdentity();
        } catch (error) {
            this.log("warn", `Terminal foreground identity check failed: ${error.message}`);
            return publicTerminalState(this.foregroundProcessRunning, false);
        }
        if (!identity) {
            await this.refresh().catch(() => {});
            return publicTerminalState(this.foregroundProcessRunning);
        }

        const sequence = [
            ["SIGINT", this.interruptGracePeriodMs],
            ["SIGTERM", this.terminateGracePeriodMs],
            ["SIGKILL", this.killSettlePeriodMs]
        ];
        for (const [signal, gracePeriod] of sequence) {
            if (!(await this._identityIsStillForeground(identity))) {
                await this.refresh().catch(() => {});
                return publicTerminalState(this.foregroundProcessRunning);
            }
            try {
                await this.kill(-identity.processGroupId, signal);
            } catch (error) {
                if (!error || error.code !== "ESRCH") {
                    this.log("warn", `Terminal foreground signal failed: ${error && error.message ? error.message : error}`);
                    await this.refresh().catch(() => {});
                    return publicTerminalState(this.foregroundProcessRunning, false);
                }
            }
            await this.wait(gracePeriod);
        }

        await this.refresh().catch(() => {});
        return publicTerminalState(this.foregroundProcessRunning);
    }

    async _readShellStat() {
        if (this._destroyed || this.platform !== "linux"
            || !Number.isSafeInteger(this.shellPid) || this.shellPid <= 1) return null;
        const shell = await this.readProcessStat(this.shellPid);
        if (this._destroyed || !shell || shell.pid !== this.shellPid || !LIVE_PROCESS_STATES.has(shell.state)) return null;

        if (!this.shellIdentity) {
            // node-pty creates the shell as the PTY session and process-group leader.
            // Pin that immutable identity before trusting the TTY foreground group.
            if (shell.processGroupId !== this.shellPid || shell.sessionId !== this.shellPid || shell.ttyNumber === 0) {
                return null;
            }
            this.shellIdentity = {
                startTime: shell.startTime,
                processGroupId: shell.processGroupId,
                sessionId: shell.sessionId,
                ttyNumber: shell.ttyNumber
            };
        }

        if (shell.startTime !== this.shellIdentity.startTime
            || shell.processGroupId !== this.shellIdentity.processGroupId
            || shell.sessionId !== this.shellIdentity.sessionId
            || shell.ttyNumber !== this.shellIdentity.ttyNumber) return null;
        return shell;
    }

    async _readForeground() {
        const shell = await this._readShellStat();
        if (!shell) return null;
        const processGroupId = shell.foregroundProcessGroupId;
        if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1
            || processGroupId === this.shellPid
            || processGroupId === shell.processGroupId) return null;
        return {
            processGroupId,
            sessionId: shell.sessionId,
            ttyNumber: shell.ttyNumber
        };
    }

    async _captureForegroundIdentity() {
        const foreground = await this._readForeground();
        if (!foreground) return null;

        const members = [];
        const processIds = await this.listProcessIds();
        for (const pid of processIds) {
            if (!Number.isSafeInteger(pid) || pid <= 1 || pid === this.shellPid) continue;
            const member = await this.readProcessStat(pid);
            if (!member || !LIVE_PROCESS_STATES.has(member.state)
                || member.processGroupId !== foreground.processGroupId
                || member.sessionId !== foreground.sessionId
                || member.ttyNumber !== foreground.ttyNumber) continue;
            members.push({pid: member.pid, startTime: member.startTime});
        }
        if (!members.length || !sameForeground(foreground, await this._readForeground())) return null;
        return Object.assign({}, foreground, {members});
    }

    async _identityIsStillForeground(identity) {
        if (this._destroyed) return false;
        if (!sameForeground(identity, await this._readForeground())) return false;
        for (const expected of identity.members) {
            const member = await this.readProcessStat(expected.pid);
            if (member && LIVE_PROCESS_STATES.has(member.state)
                && member.startTime === expected.startTime
                && member.processGroupId === identity.processGroupId
                && member.sessionId === identity.sessionId
                && member.ttyNumber === identity.ttyNumber) return true;
        }
        return false;
    }

    _setForegroundProcessRunning(running) {
        const next = running === true;
        if (next === this.foregroundProcessRunning) return;
        this.foregroundProcessRunning = next;
        this.onState(this.getState());
    }
}

function validateTerminalOperationRequest(requestParts) {
    if (!Array.isArray(requestParts) || requestParts.length !== 1) return null;
    return [GET_FOREGROUND_STATE, STOP_FOREGROUND].includes(requestParts[0]) ? requestParts[0] : null;
}

async function handleTerminalOperation(terminal, requestParts) {
    const operation = validateTerminalOperationRequest(requestParts);
    if (!operation || !terminal) return publicTerminalState(false, false);
    try {
        let result;
        if (operation === GET_FOREGROUND_STATE && typeof terminal.getForegroundProcessState === "function") {
            result = await terminal.getForegroundProcessState();
        } else if (operation === STOP_FOREGROUND && typeof terminal.stopForeground === "function") {
            result = await terminal.stopForeground();
        } else {
            return publicTerminalState(false, false);
        }
        if (!result || typeof result.foregroundProcessRunning !== "boolean") {
            return publicTerminalState(false, false);
        }
        return publicTerminalState(
            result.foregroundProcessRunning,
            result.ok !== false
        );
    } catch (error) {
        return publicTerminalState(false, false);
    }
}

module.exports = {
    GET_FOREGROUND_STATE,
    STOP_FOREGROUND,
    TerminalForegroundProcessController,
    handleTerminalOperation,
    parseLinuxProcStat,
    publicTerminalState,
    validateTerminalOperationRequest
};
