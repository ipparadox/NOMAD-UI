"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const {execFile} = require("child_process");
// Already shipped transitively with NOMAD. Fail closed if a distribution omits it.
let semver;
try { semver = require("semver"); } catch (_) {}
const inside = (root, file) => file.startsWith(root + path.sep);
class ProjectRuntimeResolver {
    constructor(options = {}) {
        this.home = options.home || os.homedir();
        this.probe = options.probe || (file => new Promise(resolve => execFile(file, ["--version"], {
            shell: false, timeout: 2000, maxBuffer: 1024, env: {PATH: "/usr/bin:/bin", HOME: "/tmp"}
        }, (error, stdout) => resolve(error ? null : stdout.trim().replace(/^v/, "")))));
    }
    privateUserGroup(gid) {
        try {
            const user = os.userInfo();
            if (gid !== user.gid) return false;
            const groups = fs.readFileSync("/etc/group", "utf8").split("\n").map(line => line.split(":"));
            const group = groups.find(fields => Number(fields[2]) === gid);
            if (!group || group[3].split(",").filter(Boolean).some(name => name !== user.username)) return false;
            return !fs.readFileSync("/etc/passwd", "utf8").split("\n").map(line => line.split(":"))
                .some(fields => Number(fields[3]) === gid && fields[0] !== user.username);
        } catch (_) { return false; }
    }
    validate(file, root) {
        try {
            if (fs.realpathSync(root) !== root || !inside(root, file)) return false;
            const canonical = fs.realpathSync(file);
            if (!inside(root, canonical)) return false;
            let current = canonical;
            while (current !== path.dirname(current)) {
                const stat = fs.lstatSync(current);
                if (stat.isSymbolicLink() || (stat.mode & 0o002) || ((stat.mode & 0o020) && (stat.uid !== process.getuid() || !this.privateUserGroup(stat.gid))) || ![0, process.getuid ? process.getuid() : 0].includes(stat.uid)) return false;
                current = path.dirname(current);
            }
            const stat = fs.statSync(canonical);
            fs.accessSync(canonical, fs.constants.X_OK);
            return stat.isFile();
        } catch (_) { return false; }
    }
    identity(file) {
        const stat = fs.statSync(file);
        return [fs.realpathSync(file), stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    }
    async inventory() {
        const roots = ["/usr", "/usr/local"];
        const nvm = path.join(this.home, ".nvm/versions/node");
        try { fs.readdirSync(nvm).filter(v => /^v\d+\.\d+\.\d+$/.test(v)).slice(0, 32).forEach(v => roots.push(path.join(nvm, v))); } catch (_) {}
        const found = await Promise.all(roots.map(async root => {
            const executable = path.join(root, "bin/node");
            if (!this.validate(executable, root)) return null;
            const identity = this.identity(executable);
            const version = await this.probe(executable);
            if (identity !== this.identity(executable)) return null;
            return semver && semver.valid(version) && !semver.prerelease(version) ? {root, executable, version, identity} : null;
        }));
        return found.filter(Boolean);
    }
    async resolve(inputs) {
        let manifest;
        try { manifest = JSON.parse(inputs["package.json"]); } catch (_) { return {ok: false, status: "RUNTIME REQUIREMENT UNKNOWN"}; }
        const requirements = [manifest.engines && manifest.engines.node, inputs[".nvmrc"], inputs[".node-version"]].filter(v => v !== undefined).map(v => typeof v === "string" ? v.trim() : null);
        if (!semver || requirements.some(v => !v || v.length > 256 || !semver.validRange(v))) return {ok: false, status: "RUNTIME REQUIREMENT UNKNOWN"};
        const inventory = await this.inventory();
        const compatible = inventory.filter(r => requirements.every(v => semver.satisfies(r.version, v)));
        // Prefer the newest installed even-major stable release, then newest stable.
        compatible.sort((a, b) => (semver.major(a.version) % 2 - semver.major(b.version) % 2) || semver.rcompare(a.version, b.version));
        if (!compatible.length) return {ok: false, status: "COMPATIBLE NODE RUNTIME NOT INSTALLED", inventory};
        return {ok: true, status: "RUNTIME READY", selected: compatible[0], required: requirements.join(" AND ") || "UNSPECIFIED", inventory};
    }
    async pythonRequirement(inputs, executable) {
        const projectSection = /(?:^|\n)\[project\]\s*\n([\s\S]*?)(?=\n\[|$)/.exec(inputs["pyproject.toml"] || "");
        const lines = projectSection ? projectSection[1].split("\n").filter(line => /^\s*requires-python\s*=/.test(line)) : [];
        if (!lines.length) return {status: "UNSPECIFIED"};
        const match = lines.length === 1 && /^\s*requires-python\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/.exec(lines[0]);
        if (!match || !semver || !/^(?:[<>=!]{1,2}\s*\d+\.\d+(?:\.\d+)?)(?:\s*,\s*[<>=!]{1,2}\s*\d+\.\d+(?:\.\d+)?)*$/.test(match[1]) || match[1].includes("!")) return {status: "PYTHON RUNTIME REQUIREMENT UNKNOWN"};
        const range = match[1].replace(/==/g, "=").replace(/,/g, " ");
        if (!semver.validRange(range)) return {status: "PYTHON RUNTIME REQUIREMENT UNKNOWN"};
        const reported = await this.probe(executable);
        const version = reported && /^Python (\d+\.\d+\.\d+)$/.exec(reported);
        if (!version) return {status: "PYTHON RUNTIME REQUIREMENT UNKNOWN"};
        return {status: semver.satisfies(version[1], range) ? "COMPATIBLE" : "PYTHON RUNTIME INCOMPATIBLE", version: version[1]};
    }
    bind(profile, runtime) {
        const selected = runtime.selected;
        if (!selected || !this.validate(selected.executable, selected.root) || selected.identity !== this.identity(selected.executable)) throw new Error("RUNTIME IDENTITY CHANGED");
        const manager = profile.executable;
        const cli = path.join(selected.root, "bin", manager);
        if (!["npm", "pnpm", "yarn"].includes(manager) || !this.validate(cli, selected.root)) throw new Error("PACKAGE MANAGER NOT AVAILABLE IN SELECTED RUNTIME");
        const expected = {npm: "lib/node_modules/npm/bin/npm-cli.js", pnpm: "lib/node_modules/pnpm/bin/pnpm.cjs", yarn: "lib/node_modules/yarn/bin/yarn.js"};
        if (fs.realpathSync(cli) !== path.join(selected.root, expected[manager])) throw new Error("PACKAGE MANAGER IDENTITY UNKNOWN / MANUAL SETUP REQUIRED");
        return {...profile, executable: selected.executable, args: [fs.realpathSync(cli), ...profile.args], runtimeBin: path.dirname(selected.executable), runtimeVersion: selected.version};
    }
}
module.exports = {ProjectRuntimeResolver};
