"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const {RepairRuleRegistry} = require("./repairRuleRegistry.js");
const {readInputs, inspectProject} = require("./projectAdapters.js");
const {ProjectRuntimeResolver} = require("./projectRuntimeResolver.js");
const {resolveTrustedExecutable} = require("./repositoryProcessManager.js");
function dependencyState(repository, inputs) {
    let manifest;
    try { manifest = JSON.parse(inputs["package.json"]); } catch (_) { return "UNKNOWN"; }
    if (!Object.keys({...manifest.dependencies, ...manifest.devDependencies}).length) return "READY";
    const root = path.join(repository.canonicalPath, "node_modules");
    try {
        if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) return "UNKNOWN";
    } catch (error) { return error.code === "ENOENT" ? "MISSING" : "UNKNOWN"; }
    try {
        const required = {...manifest.dependencies, ...manifest.devDependencies};
        for (const name of Object.keys(required)) {
            if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || [".", ".."].includes(name)) return "UNKNOWN";
            const file = path.join(root, name, "package.json");
            const canonical = fs.realpathSync(file);
            if (!canonical.startsWith(root + path.sep) || !fs.statSync(file).isFile()) return "INCOMPLETE";
        }
        return "READY";
    } catch (error) { return error.code === "ENOENT" ? "INCOMPLETE" : "UNKNOWN"; }
}
class LaunchDoctor {
    constructor(options = {}) {
        this.runtime = options.runtime || new ProjectRuntimeResolver(options);
        this.history = new Map();
        this.rules = new RepairRuleRegistry();
    }
    async preflight(repository, candidate, automation) {
        const started = Date.now();
        const inputs = readInputs(repository);
        const project = inspectProject(repository);
        const facts = {candidate, type: project.type, blocked: project.blocked};
        let runtime = null;
        let profile = candidate;
        let dependencies = "UNKNOWN";
        if (project.type === "NODE") {
            runtime = await this.runtime.resolve(inputs);
            facts.runtime = runtime;
            if (runtime.ok && candidate) {
                try { profile = this.runtime.bind(candidate, runtime); }
                catch (error) { facts.executableFailure = error.message; }
            }
            dependencies = dependencyState(repository, inputs);
            facts.dependencies = dependencies;
            const script = candidate && JSON.parse(inputs["package.json"]).scripts[candidate.source.reference];
            if (process.platform !== "win32" && typeof script === "string" && /^(?:cmd\.exe|powershell\.exe|[\w.-]+\.exe)(?:\s|$)/i.test(script.trim())) facts.platformConflict = true;
        } else if (["PYTHON", "RUST"].includes(project.type)) {
            const executable = project.type === "PYTHON" ? "python3" : "cargo";
            const resolved = resolveTrustedExecutable(executable);
            if (!resolved) facts.executableFailure = project.type === "RUST" ? "CARGO MISSING / RUST TOOLCHAIN REQUIRED" : "PYTHON RUNTIME MISSING";
            if (project.type === "PYTHON" && resolved) {
                const requirement = await this.runtime.pythonRequirement(inputs, resolved);
                if (!["UNSPECIFIED", "COMPATIBLE"].includes(requirement.status)) facts.pythonRuntimeFailure = requirement.status;
            }
            const inspected = automation ? automation.inspectRecord(repository) : project;
            let environmentMissing = false;
            if (project.type === "PYTHON") {
                try { environmentMissing = !fs.lstatSync(path.join(repository.canonicalPath, ".venv")).isDirectory() || fs.realpathSync(path.join(repository.canonicalPath, ".venv")) !== path.join(repository.canonicalPath, ".venv") || !fs.statSync(path.join(repository.canonicalPath, ".venv/bin/python")).isFile(); }
                catch (_) { environmentMissing = true; }
            }
            facts.environmentMissing = environmentMissing;
            facts.setupRequired = inspected.state !== "READY" && !environmentMissing;
        }
        const findings = this.rules.diagnose(facts);
        const result = {ok: findings.length === 0, status: findings.length ? findings.map(f => f.status).join(" / ") : "PREFLIGHT READY", findings, fingerprint: project.fingerprint, type: project.type, dependencies, runtime: runtime && runtime.selected ? runtime.selected.version : "UNKNOWN", elapsedMs: Date.now() - started};
        const previous = this.history.get(repository.id);
        result.issuesResolved = previous && previous.fingerprint === result.fingerprint && result.ok
            ? previous.findings.length + (previous.issuesResolved || 0) : 0;
        this.history.set(repository.id, result);
        while (this.history.size > 64) this.history.delete(this.history.keys().next().value);
        return {...result, profile};
    }
    async classify(repository, candidate, automation, failure) {
        const checked = await this.preflight(repository, candidate, automation);
        // Output is evidence only; never commands. State must independently confirm cause.
        let cause = checked.findings.length ? checked.findings[0].id : "UNKNOWN";
        if (cause === "UNKNOWN" && /EADDRINUSE/.test(String(failure.output || ""))) {
            const port = /(?:port[:= ]+|:)([1-9][0-9]{3,4})\b/i.exec(String(failure.output || ""));
            if (port && await this.portOccupied(Number(port[1])) === true) cause = "PORT_CONFLICT";
        }
        return {cause, exitCode: failure.exitCode, status: `PROCESS FAILED / CAUSE ${cause} / MANUAL REVIEW REQUIRED`};
    }
    async portOccupied(port) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
        return new Promise(resolve => {
            const server = net.createServer();
            server.once("error", error => resolve(error.code === "EADDRINUSE" ? true : null));
            server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
        });
    }
}
module.exports = {LaunchDoctor, dependencyState};
