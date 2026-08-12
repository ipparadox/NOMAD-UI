const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_DESKTOP_FILE_BYTES = 1024 * 1024;
const MAX_EXEC_TOKENS = 128;
const DESKTOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}\.desktop$/;
const EXEC_FIELD_CODES = new Set(["f", "F", "u", "U", "i", "c", "k", "d", "D", "n", "N", "v", "m"]);

function defaultApplicationDirectories(opts = {}) {
    const env = opts.env || process.env;
    const home = opts.home || os.homedir();
    const userDataDir = env.XDG_DATA_HOME || path.join(home, ".local", "share");
    const systemDataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
        .split(path.delimiter)
        .filter(Boolean);
    return Array.from(new Set([userDataDir].concat(systemDataDirs).map(directory => path.join(directory, "applications"))));
}

function validDesktopId(desktopId) {
    return typeof desktopId === "string" && DESKTOP_ID_PATTERN.test(desktopId);
}

function parseDesktopBoolean(value) {
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function unescapeDesktopValue(value) {
    let result = "";
    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character !== "\\") {
            result += character;
            continue;
        }
        index++;
        if (index >= value.length) throw new Error("Invalid trailing desktop-entry escape");
        const escaped = value[index];
        if (escaped === "s") result += " ";
        else if (escaped === "n") result += "\n";
        else if (escaped === "t") result += "\t";
        else if (escaped === "r") result += "\r";
        else if (escaped === "\\") result += "\\";
        else result += escaped;
    }
    return result;
}

function tokenizeDesktopExec(execValue) {
    if (typeof execValue !== "string" || !execValue.trim()) throw new Error("Desktop Exec is empty");
    if (/\0|[\r\n]/.test(execValue)) throw new Error("Desktop Exec contains control characters");

    const tokens = [];
    let token = "";
    let tokenStarted = false;
    let quoted = false;

    for (let index = 0; index < execValue.length; index++) {
        const character = execValue[index];
        if (character === "\\") {
            index++;
            if (index >= execValue.length) throw new Error("Desktop Exec has a trailing escape");
            token += execValue[index];
            tokenStarted = true;
        } else if (character === "\"") {
            quoted = !quoted;
            tokenStarted = true;
        } else if (!quoted && /\s/.test(character)) {
            if (tokenStarted) {
                tokens.push(token);
                token = "";
                tokenStarted = false;
            }
        } else {
            token += character;
            tokenStarted = true;
        }
    }

    if (quoted) throw new Error("Desktop Exec contains an unterminated quote");
    if (tokenStarted) tokens.push(token);
    if (!tokens.length) throw new Error("Desktop Exec is empty");
    if (tokens.length > MAX_EXEC_TOKENS) throw new Error("Desktop Exec contains too many arguments");
    return tokens;
}

function stripExecFieldCodes(token) {
    let result = "";
    for (let index = 0; index < token.length; index++) {
        if (token[index] !== "%") {
            result += token[index];
            continue;
        }
        index++;
        if (index >= token.length) throw new Error("Desktop Exec contains an incomplete field code");
        const fieldCode = token[index];
        if (fieldCode === "%") {
            result += "%";
            continue;
        }
        if (!EXEC_FIELD_CODES.has(fieldCode)) throw new Error("Desktop Exec contains an unsupported field code");

        // NOMAD launches applications without a file/URL/icon context. Drop
        // the complete token so a construct such as --url=%u cannot become a
        // misleading empty option. No field value is ever shell-expanded.
        return null;
    }
    return result;
}

function parseDesktopExec(execValue) {
    const rawTokens = tokenizeDesktopExec(execValue);
    const executable = stripExecFieldCodes(rawTokens[0]);
    if (!executable) throw new Error("Desktop Exec does not contain a usable executable");

    const args = [];
    rawTokens.slice(1).forEach(token => {
        const sanitized = stripExecFieldCodes(token);
        if (sanitized !== null) args.push(sanitized);
    });
    return {executable, args};
}

function parseDesktopEntry(content, opts = {}) {
    if (Buffer.isBuffer(content)) content = content.toString("utf8");
    if (typeof content !== "string") throw new TypeError("Desktop entry must be text");
    if (Buffer.byteLength(content, "utf8") > MAX_DESKTOP_FILE_BYTES) throw new Error("Desktop entry is too large");
    if (content.includes("\0")) throw new Error("Desktop entry contains a null byte");

    const values = {};
    let section = "";
    content.split(/\r?\n/).forEach(rawLine => {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) return;
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
            section = sectionMatch[1];
            return;
        }
        if (section !== "Desktop Entry") return;
        const separator = rawLine.indexOf("=");
        if (separator <= 0) return;
        const key = rawLine.slice(0, separator).trim();
        if (!["Name", "Exec", "StartupWMClass", "NoDisplay", "Hidden", "Type", "Terminal"].includes(key)) return;
        const value = rawLine.slice(separator + 1);
        // Exec has its own quoting/escaping grammar and must reach the token
        // parser intact. Other desktop-entry strings use the generic escapes.
        values[key] = key === "Exec" ? value : unescapeDesktopValue(value);
    });

    const textFields = [values.Name, values.StartupWMClass].filter(value => typeof value === "string");
    if (textFields.some(value => /\0|[\r\n]/.test(value) || value.length > 512)) {
        throw new Error("Desktop entry metadata is invalid");
    }

    let launch = {executable: null, args: []};
    if (typeof values.Exec === "string" && values.Exec.trim()) launch = parseDesktopExec(values.Exec);

    return {
        desktopId: opts.desktopId || null,
        path: opts.path || null,
        name: values.Name ? values.Name.trim() : "",
        executable: launch.executable,
        args: launch.args,
        startupWMClass: values.StartupWMClass ? values.StartupWMClass.trim() : "",
        noDisplay: parseDesktopBoolean(values.NoDisplay),
        hidden: parseDesktopBoolean(values.Hidden),
        type: values.Type ? values.Type.trim() : "",
        terminal: parseDesktopBoolean(values.Terminal)
    };
}

class DesktopEntryDiscovery {
    constructor(opts = {}) {
        this.fs = opts.fs || fs;
        this.path = opts.path || path;
        this.directories = opts.directories || defaultApplicationDirectories(opts);
        this.log = opts.log || (() => {});
    }

    findById(desktopId) {
        if (!validDesktopId(desktopId)) return null;
        for (let index = 0; index < this.directories.length; index++) {
            const filePath = this.path.join(this.directories[index], desktopId);
            if (!this._isFile(filePath)) continue;
            try {
                return this.parseFile(filePath, desktopId);
            } catch (error) {
                this.log("warn", `DESKTOP ENTRY INVALID: ${desktopId}`);
                return null;
            }
        }
        return null;
    }

    parseFile(filePath, desktopId) {
        const stats = this.fs.statSync(filePath);
        if (!stats.isFile()) throw new Error("Desktop entry is not a file");
        if (stats.size > MAX_DESKTOP_FILE_BYTES) throw new Error("Desktop entry is too large");
        const content = this.fs.readFileSync(filePath, {encoding: "utf8"});
        return parseDesktopEntry(content, {desktopId, path: filePath});
    }

    scan() {
        const entries = [];
        const errors = [];
        const seen = new Set();
        this.directories.forEach(directory => {
            this._desktopFiles(directory).forEach(file => {
                if (seen.has(file.desktopId)) return;
                seen.add(file.desktopId);
                try {
                    entries.push(this.parseFile(file.path, file.desktopId));
                } catch (error) {
                    errors.push({desktopId: file.desktopId, path: file.path, error: error.message});
                    this.log("warn", `DESKTOP ENTRY INVALID: ${file.desktopId}`);
                }
            });
        });
        return {entries, errors};
    }

    discover() {
        return this.scan();
    }

    _desktopFiles(rootDirectory) {
        const files = [];
        const visit = (directory, relativeDirectory, depth) => {
            if (depth > 4) return;
            let dirents;
            try {
                dirents = this.fs.readdirSync(directory, {withFileTypes: true});
            } catch (error) {
                return;
            }
            dirents.forEach(dirent => {
                const filePath = this.path.join(directory, dirent.name);
                const relativePath = relativeDirectory
                    ? this.path.join(relativeDirectory, dirent.name)
                    : dirent.name;
                if (dirent.isDirectory()) {
                    visit(filePath, relativePath, depth + 1);
                } else if (dirent.isFile() && dirent.name.endsWith(".desktop")) {
                    const desktopId = relativePath.split(this.path.sep).join("-");
                    if (validDesktopId(desktopId)) files.push({desktopId, path: filePath});
                }
            });
        };
        visit(rootDirectory, "", 0);
        return files;
    }

    _isFile(filePath) {
        try {
            return this.fs.statSync(filePath).isFile();
        } catch (error) {
            return false;
        }
    }
}

module.exports = {
    DesktopEntryDiscovery,
    defaultApplicationDirectories,
    parseDesktopEntry,
    parseDesktopExec,
    tokenizeDesktopExec,
    validDesktopId
};
