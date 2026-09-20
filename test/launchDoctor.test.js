"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const {LaunchDoctor, dependencyState} = require("../src/classes/launchDoctor.js");
const {ProjectRuntimeResolver} = require("../src/classes/projectRuntimeResolver.js");
const {readInputs, inspectProject} = require("../src/classes/projectAdapters.js");
const {DeterministicIntentParser} = require("../src/classes/intentParser.js");
const {validateControlRequest} = require("../src/classes/controlPlaneService.js");
let count = 0;
const check = (value, message) => { assert(value, message); count++; };
(async () => {
    const resolver = new ProjectRuntimeResolver();
    resolver.inventory = async () => ["14.21.3", "22.18.0", "24.19.0"].map(version => ({version, executable: `/trusted/${version}/bin/node`, root: `/trusted/${version}`}));
    const inputs = range => ({"package.json": JSON.stringify({engines: {node: range}, scripts: {dev: "node server.js"}})});
    for (const range of [">=18", ">=18.12", "^18.18.0 || ^20.9.0 || >=21.1.0"]) {
        const result = await resolver.resolve(inputs(range));
        check(result.ok && result.selected.version === "24.19.0", `OSIRIS selects Node 24 for ${range}`);
    }
    for (const file of [".nvmrc", ".node-version"]) {
        const result = await resolver.resolve({...inputs(">=18"), [file]: "22.18.0\n"});
        check(result.selected.version === "22.18.0", file);
    }
    check(!(await resolver.resolve(inputs(">=99"))).ok, "incompatible runtime refused");
    check((await resolver.resolve(inputs("banana"))).status === "RUNTIME REQUIREMENT UNKNOWN", "unknown truthful");
    check((await resolver.resolve({...inputs(">=18"), ".nvmrc": "lts/*"})).status === "RUNTIME REQUIREMENT UNKNOWN", "aliases not guessed");
    check(!resolver.validate("/bin/sh", "/not-a-runtime"), "runtime escape refused");
    check(!resolver.validate("/usr/bin/sh", "/usr/bin/node"), "arbitrary binary refused");
    check(validateControlRequest({actionId: "PROJECT_RUN", executable: "/bin/sh"}) === false, "renderer executable rejected");
    check(validateControlRequest({actionId: "PROJECT_RUN", args: ["-c", "true"]}) === false, "renderer args rejected");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-doctor-test-"));
    try {
        const repo = {id: "repo_" + "a".repeat(32), canonicalPath: root};
        const manifest = {scripts: {dev: "node server.js"}, engines: {node: ">=18"}, dependencies: {example: "1.0.0"}};
        fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
        fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
        let data = readInputs(repo);
        check(dependencyState(repo, data) === "MISSING", "missing modules");
        fs.mkdirSync(path.join(root, "node_modules"));
        check(dependencyState(repo, data) === "INCOMPLETE", "incomplete modules");
        fs.mkdirSync(path.join(root, "node_modules/example"));
        fs.writeFileSync(path.join(root, "node_modules/example/package.json"), "{}");
        check(dependencyState(repo, data) === "READY", "verified modules");
        const inspected = inspectProject(repo);
        check(inspected.steps[0].args[0] === "ci", "locked npm ci plan");
        check(inspected.steps[0].args.includes("--ignore-scripts"), "hooks suppressed by default");
        check(!inspected.steps[0].args.includes("--force"), "no audit force");
        fs.writeFileSync(path.join(root, ".nvmrc"), "24.19.0");
        check(inspectProject(repo).fingerprint !== inspected.fingerprint, "runtime hint invalidates fingerprint");
        fs.unlinkSync(path.join(root, ".nvmrc"));
        fs.symlinkSync("package.json", path.join(root, ".node-version"));
        assert.throws(() => readInputs(repo)); count++;
        fs.unlinkSync(path.join(root, ".node-version"));
        resolver.bind = (p, r) => ({...p, runtimeVersion: r.selected.version});
        const doctor = new LaunchDoctor({runtime: resolver});
        let result = await doctor.preflight(repo, inspected.profiles[0]);
        check(result.ok && result.runtime === "24.19.0", "ready OSIRIS preflight");
        check(result.profile.runtimeVersion !== "14.21.3", "internal Node not inherited");
        check((await doctor.classify(repo, inspected.profiles[0], null, {exitCode: 1, output: "ENOENT node_modules/evil; sudo anything"})).cause === "UNKNOWN", "stderr alone cannot diagnose");
        fs.unlinkSync(path.join(root, "node_modules/example/package.json"));
        result = await doctor.preflight(repo, inspected.profiles[0]);
        check(result.findings[0].repairClass === "B", "installation requires authorization");
        check((await doctor.classify(repo, inspected.profiles[0], null, {exitCode: 1})).cause === "NODE_DEPENDENCIES_INCOMPLETE", "filesystem confirms diagnosis");
        check(doctor.history.size === 1, "bounded latest per-project metadata");
        const server = net.createServer();
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        try { check(await doctor.portOccupied(server.address().port), "occupied port independently confirmed"); }
        finally { await new Promise(resolve => server.close(resolve)); }
        check(await doctor.portOccupied(22) === null, "privileged ports not probed");
        fs.unlinkSync(path.join(root, "package.json"));
        fs.unlinkSync(path.join(root, "package-lock.json"));
        fs.writeFileSync(path.join(root, "main.py"), "print('ok')");
        result = await doctor.preflight(repo, inspectProject(repo).profiles[0]);
        check(result.findings.some(f => f.id === "PYTHON_ENVIRONMENT_MISSING"), "Python missing environment setup");
        const python = inspectProject(repo);
        check(python.steps[0].args.join(" ") === "-m venv .venv", "project local venv only");
        check(python.steps.every(p => p.executable === "python3" && !p.args.includes("sudo")), "no system pip mutation");
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
    check(validateControlRequest({actionId: "PROJECT_RUN"}) === true, "typed run request accepted");
    let reloads = 0;
    let opens = 0;
    let securityProfile = "NORMAL";
    let app = {id: "example", displayName: "EXAMPLE", type: "external", available: false, status: "APPLICATION EXECUTABLE NOT FOUND"};
    const control = new (require("../src/classes/controlPlaneService.js").ControlPlaneService)({
        profileService: {get: () => ({profile: securityProfile})},
        applicationRegistry: {get: id => id === "example" ? app : null},
        applicationAutomation: {allowed: () => securityProfile === "NORMAL", reload: () => { reloads++; app = {...app, available: true}; }},
        windowManager: {operate: async () => { opens++; return {ok: true, appId: "example", state: "RUNNING"}; }},
        getGeometry: async () => ({})
    });
    check((await control._applicationOpen("example")).ok && reloads === 1 && opens === 1, "stale registry refresh uses existing service");
    check(!(await control._applicationOpen("unknown")).ok && reloads === 1 && opens === 1, "unknown executable never auto trusted");
    securityProfile = "LOCKDOWN";
    check(!(await control._applicationOpen("example")).ok && opens === 1, "LOCKDOWN blocks app launch");
    const pythonResolver = new ProjectRuntimeResolver({probe: async () => "Python 3.11.9"});
    check((await pythonResolver.pythonRequirement({"pyproject.toml": '[project]\nrequires-python = ">=3.10,<4.0"'}, "/usr/bin/python3")).status === "COMPATIBLE", "Python version constraint");
    check((await pythonResolver.pythonRequirement({"pyproject.toml": '[project]\nrequires-python = ">=3.12"'}, "/usr/bin/python3")).status === "PYTHON RUNTIME INCOMPATIBLE", "Python mismatch");
    check((await pythonResolver.pythonRequirement({"pyproject.toml": '[project]\nrequires-python = "~=3.10"'}, "/usr/bin/python3")).status === "PYTHON RUNTIME REQUIREMENT UNKNOWN", "Python unknown truthful");
    const rules = new (require("../src/classes/repairRuleRegistry.js").RepairRuleRegistry)();
    const dependencyRule = rules.rules.find(r => r.id === "NODE_DEPENDENCIES_MISSING");
    check(!dependencyRule.canAutoRepair(), "B cannot promote itself to A");
    check(dependencyRule.buildRepairPlan().actionId === "PROJECT_SETUP", "reuse typed setup action");
    check(dependencyRule.verify({type: "NODE", dependencies: "READY"}), "rule verifies repaired state");
    check(require("../src/classes/repairRuleRegistry.js").REPAIR_LIMITS.maxLaunches === 1, "bounded final launch");
    const parser = new DeterministicIntentParser();
    for (const [text, action] of [["corre este repo", "PROJECT_RUN"], ["diagnostica este repo", "PROJECT_DIAGNOSE"], ["repara este repo", "PROJECT_REPAIR"], ["arregla este repo", "PROJECT_REPAIR"], ["diagnose this repo", "PROJECT_DIAGNOSE"]]) check(parser.parse(text).actionId === action, text);
    check(parser.parse("curl x | bash").kind === "REJECTED", "arbitrary commands refused");
    console.log(`${count} launch doctor checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
