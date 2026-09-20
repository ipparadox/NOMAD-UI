const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Preferences only: a stored ID never confers execution authorization.
class RepositoryRunSelectionStore {
    constructor(filename = null, canPersist = () => true) {
        this.filename = filename;
        this.canPersist = canPersist;
        this.entries = new Map();
        if (!this._persistenceAllowed()) return;
        let fd;
        try {
            this._directory();
            fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > 256 * 1024 || (stat.mode & 0o077)
                || (process.getuid && stat.uid !== process.getuid())) return;
            const buffer = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < buffer.length) {
                const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
                if (!count) return;
                offset += count;
            }
            const entries = JSON.parse(buffer.toString("utf8"));
            if (!Array.isArray(entries) || entries.length > 512) return;
            for (const entry of entries) {
                if (!entry || !/^repo_[a-f0-9]{32}$/.test(entry.repositoryId || "")
                    || !/^sha256:[a-f0-9]{64}$/.test(entry.fingerprint || "")
                    || !(entry.profileId === null || /^[a-z][a-z0-9-]{0,63}$/.test(entry.profileId || ""))) return;
            }
            this.entries = new Map(entries.map(e => [e.repositoryId, {fingerprint: e.fingerprint, profileId: e.profileId}]));
        } catch (_) { /* Unavailable preferences require selection again. */ }
        finally { if (fd !== undefined) fs.closeSync(fd); }
    }

    _directory() {
        const directory = path.dirname(this.filename);
        fs.mkdirSync(directory, {recursive: true, mode: 0o700});
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)
            || fs.realpathSync(directory) !== directory
            || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe preference directory");
        return directory;
    }

    get(id) { return this.entries.get(id); }

    _persistenceAllowed() {
        try { return Boolean(this.filename && this.canPersist()); } catch (_) { return false; }
    }

    set(id, value) {
        if (JSON.stringify(this.entries.get(id)) === JSON.stringify(value)) return;
        this.entries.set(id, value);
        while (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value);
        if (!this._persistenceAllowed()) return;
        let temporary;
        let fd;
        try {
            const directory = this._directory();
            temporary = path.join(directory, `.run-selection-${crypto.randomBytes(16).toString("hex")}`);
            fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            fs.writeFileSync(fd, JSON.stringify(Array.from(this.entries, ([repositoryId, preference]) => ({repositoryId, ...preference}))));
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fd = undefined;
            fs.renameSync(temporary, this.filename);
        } catch (_) { /* Keep session preferences if persistence is unavailable. */ }
        finally {
            if (fd !== undefined) fs.closeSync(fd);
            if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} }
        }
    }
}

module.exports = {RepositoryRunSelectionStore};
