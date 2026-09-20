"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const digest = value => `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const INPUTS = Object.freeze([".nvmrc", ".node-version", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".npmrc", ".yarnrc", ".yarnrc.yml", "pnpm-workspace.yaml", ".pnpmfile.cjs", ".cargo/config", ".cargo/config.toml", "pyproject.toml", "requirements.txt", "requirements-dev.txt", "Pipfile", "poetry.lock", "main.py", "app.py", "Cargo.toml", "Cargo.lock", "build.rs"]);
// Fixed, main-owned bootstrap: the sandbox path never comes from a caller.
const VENV_EXEC = "import os,sys; os.execv('/workspace/.venv/bin/python', ['python'] + sys.argv[1:])";
function readInputs(repository, io = fs) {
    const inputs = {};
    for (const name of INPUTS) {
        const filename = path.join(repository.canonicalPath, name);
        let fd;
        try {
            const before = io.lstatSync(filename);
            if (io.realpathSync(filename) !== filename || !before.isFile() || before.isSymbolicLink() || before.size > 4 * 1024 * 1024) throw new Error("PROJECT INPUT REFUSED");
            fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            const opened = io.fstatSync(fd);
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("PROJECT INPUT CHANGED");
            const buffer = Buffer.alloc(opened.size);
            let offset = 0;
            while (offset < buffer.length) {
                const count = io.readSync(fd, buffer, offset, buffer.length - offset, null);
                if (!count) throw new Error("PROJECT INPUT CHANGED");
                offset += count;
            }
            inputs[name] = buffer.toString("utf8");
        } catch (error) {
            if (error.code !== "ENOENT") throw new Error("PROJECT INPUT REFUSED");
        } finally { if (fd !== undefined) io.closeSync(fd); }
    }
    return inputs;
}
function directory(repository, name) {
    try { const s = fs.lstatSync(path.join(repository.canonicalPath, name)); return s.isDirectory() && !s.isSymbolicLink(); }
    catch (_) { return false; }
}
function step(type, executable, args) { return {type, executable, args, workingDirectory: ".", profileId: `setup-${type.toLowerCase().replace(/_/g, "-")}`, displayName: type.replace(/_/g, " "), executionKind: "SETUP", networkRequired: ["INSTALL_DEPENDENCIES", "BUILD_PROJECT"].includes(type)}; }
function run(profileId, executable, args, source) {
    const kind = executable === "cargo" ? "cargo-manifest" : executable === "python3" ? "python-entrypoint" : "package-json-script";
    return {profileId, displayName: profileId.replace(/-/g, " ").toUpperCase(), executable, args, source: {kind, reference: kind === "package-json-script" ? args[1] : source}};
}
class ProjectAdapter {
    fingerprintInputs(inputs) { return digest(inputs); }
    inspect(repository, inputs) {
        const setup = this.buildSetupPlan(repository, inputs);
        return {type: this.type, runtime: this.runtime, ...setup, profiles: this.buildRunProfiles(repository, inputs), fingerprint: this.fingerprintInputs(inputs), inputFingerprints: Object.fromEntries(Object.entries(inputs).map(([name, content]) => [name, digest(content)]))};
    }
    verifyReady() { return false; }
}
class NodeProjectAdapter extends ProjectAdapter {
    constructor() { super(); this.type = "NODE"; this.runtime = "NODE"; }
    detect(inputs) { return Object.prototype.hasOwnProperty.call(inputs, "package.json"); }
    metadata(inputs) {
        const manifest = JSON.parse(inputs["package.json"]);
        if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("PACKAGE MANIFEST INVALID");
        const locks = [["npm", "package-lock.json"], ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]].filter(([, file]) => inputs[file] !== undefined);
        const hint = typeof manifest.packageManager === "string" ? /^(npm|pnpm|yarn)@[^\s]+$/.exec(manifest.packageManager) : null;
        if (manifest.packageManager && !hint || locks.length > 1 || hint && locks.length && hint[1] !== locks[0][0]) throw new Error("PACKAGE MANAGER AMBIGUOUS OR UNSUPPORTED");
        return {manifest, manager: hint ? hint[1] : locks.length ? locks[0][0] : "npm", lockfile: locks.length ? locks[0][1] : "NONE"};
    }
    buildRunProfiles(repository, inputs) {
        const {manifest, manager} = this.metadata(inputs);
        return ["dev", "start", "serve", "preview"].filter(name => manifest.scripts && Object.prototype.hasOwnProperty.call(manifest.scripts, name) && typeof manifest.scripts[name] === "string" && manifest.scripts[name].trim())
            .map(name => run(`${manager}-${name}`, manager, ["run", name], "package.json"));
    }
    buildSetupPlan(repository, inputs) {
        const {manifest, manager, lockfile} = this.metadata(inputs);
        const modernYarn = manager === "yarn" && (/^yarn@(?:[2-9]|[1-9][0-9])\./.test(manifest.packageManager || "") || /^__metadata:/m.test(inputs["yarn.lock"] || ""));
        const args = modernYarn ? ["install", "--mode=skip-builds", ...(lockfile === "NONE" ? [] : ["--immutable"])] : manager === "npm" ? [lockfile === "NONE" ? "install" : "ci", "--ignore-scripts", "--no-audit", "--no-fund"]
            : ["install", "--ignore-scripts", ...(lockfile === "NONE" ? [] : ["--frozen-lockfile"])];
        const scripts = manifest.scripts && typeof manifest.scripts === "object" ? Object.keys(manifest.scripts).filter(n => /^(preinstall|install|postinstall|prepublish|preprepare|prepare|postprepare)$/.test(n)) : [];
        // Yarn plugins and pnpm configuration can execute before lifecycle suppression.
        return {manager: manager.toUpperCase(), lockfile, hooks: scripts.join(", ") || "NONE", steps: [step("INSTALL_DEPENDENCIES", manager, args)], risk: `REPOSITORY CODE MAY EXECUTE; LIFECYCLE SCRIPTS REQUESTED DISABLED. DECLARED: ${scripts.join(", ") || "NONE"}. MANAGER CONFIG/PLUGINS MAY EXECUTE. PROJECTS NEEDING INSTALL HOOKS MAY REQUIRE MANUAL SETUP.`, requiresSetup: !this.verifyReady(repository)};
    }
    verifyReady(repository) { return directory(repository, "node_modules"); }
}
class PythonProjectAdapter extends ProjectAdapter {
    constructor() { super(); this.type = "PYTHON"; this.runtime = "PYTHON3 / .venv"; }
    detect(inputs) { return ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "Pipfile", "poetry.lock", "main.py", "app.py"].some(n => inputs[n] !== undefined); }
    buildRunProfiles(repository, inputs) {
        return ["main.py", "app.py"].filter(n => inputs[n] !== undefined).map(n => run(`python-${n.slice(0, -3)}`, "python3", directory(repository, ".venv") ? ["-c", VENV_EXEC, n] : [n], n));
    }
    buildSetupPlan(repository, inputs) {
        const steps = [];
        steps.push(step("CREATE_ENVIRONMENT", "python3", ["-m", "venv", ".venv"]));
        const requirements = ["requirements.txt", "requirements-dev.txt"].filter(n => inputs[n] !== undefined);
        if (requirements.length) steps.push(step("INSTALL_DEPENDENCIES", "python3", ["-c", VENV_EXEC, "-m", "pip", "install", "--disable-pip-version-check", ...requirements.flatMap(n => ["-r", n])]));
        else if (inputs["pyproject.toml"] !== undefined) steps.push(step("INSTALL_DEPENDENCIES", "python3", ["-c", VENV_EXEC, "-m", "pip", "install", "--disable-pip-version-check", "."]));
        const unsupported = !requirements.length && (inputs.Pipfile !== undefined || inputs["poetry.lock"] !== undefined);
        steps.push(step("VERIFY_RUNTIME", "python3", ["-c", VENV_EXEC, "-m", "pip", "check"]));
        return {manager: "PYTHON VENV / PIP", lockfile: requirements.join(", ") || "NONE", steps, requiresSetup: true, blocked: unsupported ? "PIPFILE/POETRY SETUP NOT SUPPORTED" : null, risk: "PIP MAY EXECUTE DEPENDENCY BUILD BACKENDS AND PYPROJECT HOOKS; PROJECT-LOCAL .venv ONLY"};
    }
    verifyReady(repository) { return directory(repository, ".venv"); }
}
class RustProjectAdapter extends ProjectAdapter {
    constructor() { super(); this.type = "RUST"; this.runtime = "CARGO"; }
    detect(inputs) { return inputs["Cargo.toml"] !== undefined; }
    buildRunProfiles() { return [run("cargo-run", "cargo", ["run"], "Cargo.toml")]; }
    buildSetupPlan(repository, inputs) { return {manager: "CARGO", lockfile: inputs["Cargo.lock"] !== undefined ? "Cargo.lock" : "NONE", steps: [step("BUILD_PROJECT", "cargo", ["build", ...(inputs["Cargo.lock"] !== undefined ? ["--locked"] : [])])], requiresSetup: true, risk: "CARGO BUILDS MAY EXECUTE BUILD.RS, PROC MACROS, DEPENDENCIES AND CARGO CONFIGURED TOOLS"}; }
    verifyReady(repository) { return directory(repository, "target"); }
}
const adapters = [new NodeProjectAdapter(), new RustProjectAdapter(), new PythonProjectAdapter()];
function discoverRunProfiles(repository, io = fs) {
    const inputs = readInputs(repository, io);
    return adapters.filter(a => a.detect(inputs)).flatMap(a => a.buildRunProfiles(repository, inputs).map(p => ({...p, fingerprint: a.fingerprintInputs(inputs)})));
}
function inspectProject(repository, io = fs) {
    const inputs = readInputs(repository, io);
    const matches = adapters.filter(a => a.detect(inputs));
    if (!matches.length) return {type: "UNKNOWN", profiles: [], steps: [], state: "UNSUPPORTED", fingerprint: digest(inputs)};
    if (matches.length !== 1) return {type: "MIXED", profiles: [], steps: [], state: "BLOCKED", blocked: "MULTIPLE PROJECT TYPES REQUIRE MANUAL SELECTION", fingerprint: digest(inputs)};
    const result = matches[0].inspect(repository, inputs);
    result.state = result.blocked ? "BLOCKED" : result.requiresSetup ? "SETUP_REQUIRED" : result.profiles.length ? "READY" : "INSPECTED";
    return result;
}
module.exports = {ProjectAdapter, NodeProjectAdapter, PythonProjectAdapter, RustProjectAdapter, inspectProject, discoverRunProfiles, readInputs, digest, VENV_EXEC};
