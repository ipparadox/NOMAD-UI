const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
    ApplicationRegistry,
    defaultRegistryPath,
    parseApplicationRegistryContent
} = require("../classes/applicationRegistry.js");
const {CliError} = require("./errors.js");

function cloneEntries(entries) {
    return entries.map(entry => JSON.parse(JSON.stringify(entry)));
}

class RegistryStore {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.registryPath = opts.registryPath || defaultRegistryPath(opts.home);
        this.validator = opts.validator || new ApplicationRegistry({
            registryPath: this.registryPath,
            discovery: opts.discovery,
            executableExists: opts.executableExists,
            env: opts.env,
            home: opts.home,
            log: opts.log
        });
    }

    read() {
        const file = this._readFile();
        if (!file) {
            return {
                applications: [],
                normalizedApplications: [],
                snapshot: null
            };
        }

        let applications;
        try {
            applications = parseApplicationRegistryContent(file.content);
        } catch (error) {
            throw new CliError(`REGISTRY INVALID: ${error.message}\nPRESERVED: ${this.registryPath}`);
        }

        const normalizedApplications = this._validateEntries(applications);
        return {
            applications: cloneEntries(applications),
            normalizedApplications,
            snapshot: file.snapshot
        };
    }

    update(mutator) {
        if (typeof mutator !== "function") throw new TypeError("Registry update requires a mutator");
        const current = this.read();
        const working = cloneEntries(current.applications);
        const proposed = mutator(working);
        if (!Array.isArray(proposed)) throw new TypeError("Registry mutator must return an application array");

        const normalizedApplications = this._validateEntries(proposed);
        const changed = JSON.stringify(current.applications) !== JSON.stringify(proposed);
        if (changed) this._atomicWrite(proposed, current.snapshot);
        return {
            applications: cloneEntries(proposed),
            normalizedApplications,
            changed
        };
    }

    _validateEntries(entries) {
        const seen = new Set();
        return entries.map((entry, index) => {
            let normalized;
            try {
                normalized = this.validator.validateUserEntry(entry, 100 + index);
            } catch (error) {
                throw new CliError(`REGISTRY INVALID: application ${index + 1}: ${error.message}\nPRESERVED: ${this.registryPath}`);
            }
            if (seen.has(normalized.id)) {
                throw new CliError(`REGISTRY INVALID: duplicate application ID ${normalized.id}\nPRESERVED: ${this.registryPath}`);
            }
            seen.add(normalized.id);
            return normalized;
        });
    }

    _readFile() {
        let stats;
        try {
            stats = this.fs.lstatSync(this.registryPath);
        } catch (error) {
            if (error && error.code === "ENOENT") return null;
            throw new CliError(`REGISTRY READ FAILED: ${error.message}`);
        }

        if (stats.isSymbolicLink()) throw new CliError(`REGISTRY REFUSED: apps.json must not be a symbolic link\nPRESERVED: ${this.registryPath}`);
        if (!stats.isFile()) throw new CliError(`REGISTRY REFUSED: apps.json is not a regular file\nPRESERVED: ${this.registryPath}`);

        const constants = this.fs.constants || fs.constants;
        const noFollow = constants.O_NOFOLLOW || 0;
        let descriptor;
        try {
            descriptor = this.fs.openSync(this.registryPath, constants.O_RDONLY | noFollow);
            const openedStats = this.fs.fstatSync(descriptor);
            if (!openedStats.isFile() || openedStats.dev !== stats.dev || openedStats.ino !== stats.ino) {
                throw new Error("apps.json changed while it was being opened");
            }
            const content = this.fs.readFileSync(descriptor, {encoding: "utf8"});
            return {content, snapshot: this._snapshot(openedStats)};
        } catch (error) {
            throw new CliError(`REGISTRY READ FAILED: ${error.message}\nPRESERVED: ${this.registryPath}`);
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }

    _atomicWrite(applications, expectedSnapshot) {
        const document = `${JSON.stringify({version: 1, applications}, null, 4)}\n`;
        try {
            parseApplicationRegistryContent(document);
        } catch (error) {
            throw new CliError(`REGISTRY WRITE REFUSED: ${error.message}`);
        }

        const directory = this.path.dirname(this.registryPath);
        this.fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        const directoryStats = this.fs.lstatSync(directory);
        if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
            throw new CliError(`REGISTRY WRITE REFUSED: ${directory} is not a safe directory`);
        }

        this._assertTargetUnchanged(expectedSnapshot);

        const suffix = crypto.randomBytes(12).toString("hex");
        const temporaryPath = this.path.join(directory, `.apps.json.tmp-${process.pid}-${suffix}`);
        const constants = this.fs.constants || fs.constants;
        const noFollow = constants.O_NOFOLLOW || 0;
        let descriptor;
        let temporaryExists = false;
        try {
            descriptor = this.fs.openSync(
                temporaryPath,
                constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
                0o600
            );
            temporaryExists = true;
            this.fs.fchmodSync(descriptor, 0o600);
            this.fs.writeFileSync(descriptor, document, {encoding: "utf8"});
            this.fs.fsyncSync(descriptor);
            this.fs.closeSync(descriptor);
            descriptor = undefined;

            this._assertTargetUnchanged(expectedSnapshot);
            this.fs.renameSync(temporaryPath, this.registryPath);
            temporaryExists = false;
            this._syncDirectory(directory);
        } catch (error) {
            throw error instanceof CliError ? error : new CliError(`REGISTRY WRITE FAILED: ${error.message}`);
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
            if (temporaryExists) {
                try {
                    this.fs.unlinkSync(temporaryPath);
                } catch (error) {}
            }
        }
    }

    _assertTargetUnchanged(expectedSnapshot) {
        let current;
        try {
            const stats = this.fs.lstatSync(this.registryPath);
            if (stats.isSymbolicLink() || !stats.isFile()) throw new CliError("REGISTRY WRITE REFUSED: apps.json is no longer a regular file");
            current = this._snapshot(stats);
        } catch (error) {
            if (error && error.code === "ENOENT") current = null;
            else throw error;
        }

        if (!this._sameSnapshot(current, expectedSnapshot)) {
            throw new CliError("REGISTRY WRITE REFUSED: apps.json changed during the update; no data was overwritten");
        }
    }

    _snapshot(stats) {
        return {
            dev: stats.dev,
            ino: stats.ino,
            size: stats.size,
            mtimeMs: stats.mtimeMs
        };
    }

    _sameSnapshot(left, right) {
        if (!left || !right) return left === right;
        return left.dev === right.dev && left.ino === right.ino
            && left.size === right.size && left.mtimeMs === right.mtimeMs;
    }

    _syncDirectory(directory) {
        const constants = this.fs.constants || fs.constants;
        let descriptor;
        try {
            descriptor = this.fs.openSync(directory, constants.O_RDONLY);
            this.fs.fsyncSync(descriptor);
        } catch (error) {
            if (!error || !["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
        } finally {
            if (typeof descriptor === "number") this.fs.closeSync(descriptor);
        }
    }
}

module.exports = {RegistryStore};
