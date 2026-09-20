"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {inspectProject, discoverRunProfiles, VENV_EXEC} = require("../src/classes/projectAdapters.js");
const {AutomationEngine} = require("../src/classes/automationEngine.js");
const {RepositoryRunProfileService} = require("../src/classes/repositoryRunProfileService.js");
const {RepositoryIsolationService, buildRepositoryRunEnvironment} = require("../src/classes/repositoryIsolationService.js");
const {RepositoryActionService} = require("../src/classes/repositoryService.js");
const {ControlPlaneService, validateControlRequest} = require("../src/classes/controlPlaneService.js");
const {DeterministicIntentParser, validateStructuredProposal} = require("../src/classes/intentParser.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-automation-"));
let count = 0;
function check(name, fn) { fn(); count++; }
function repository(files) {
    const dir = fs.mkdtempSync(path.join(root, "repo-"));
    Object.entries(files).forEach(([name, content]) => fs.writeFileSync(path.join(dir, name), typeof content === "string" ? content : JSON.stringify(content)));
    return {id: `repo_${String(count).padStart(32, "0")}`, canonicalPath: dir, executionIdentity: "identity", repositoryIdentity: `sha256:${"a".repeat(64)}`, public: {displayName: "TEST PROJECT"}};
}
function harness(repo, opts = {}) {
    let profile = "NORMAL";
    let state = null;
    const calls = [];
    const manager = {
        isActive: () => Boolean(state && state.state === "RUNNING"),
        getStatus: () => state,
        getExecutionSecurityStatus: () => ({allowed: profile !== "LOCKDOWN", level: opts.level || "STRONG"}),
        start: (r, p) => {
            calls.push(p); state = {state: "RUNNING", exitCode: null};
            p.boundedOutput(Buffer.alloc(80000, 120));
            if (!opts.long) setTimeout(() => { state = {state: opts.fail ? "FAILED" : "STOPPED", exitCode: opts.fail ? 1 : 0}; }, 1);
        },
        stop: async id => { assert.strictEqual(id, repo.id); state = {state: "STOPPED", exitCode: null}; }
    };
    const repositories = {resolveRepository: async id => { assert.strictEqual(id, repo.id); return repo; }, refresh: async () => {}, repositories: new Map([[repo.id, repo]])};
    const events = [];
    const engine = new AutomationEngine({repositoryService: repositories, processManager: manager, getSecurityProfile: () => profile, onState: s => events.push(s)});
    return {engine, calls, events, repositories, manager, setProfile: p => { profile = p; }};
}
async function finished(engine, id) {
    for (let i = 0; i < 100; i++) {
        const result = engine.status(id);
        if (result.operation.state !== "RUNNING") return result;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("operation did not finish");
}
async function main() {
    const node = repository({"package.json": {scripts: {dev: "touch NEVER", start: "node x", preview: "vite preview", attack: "rm -rf /"}}});
    check("Node detection never executes scripts", () => {
        const p = inspectProject(node);
        assert.strictEqual(p.type, "NODE"); assert.strictEqual(p.state, "SETUP_REQUIRED");
        assert.deepStrictEqual(p.profiles.map(p => p.profileId), ["npm-dev", "npm-start", "npm-preview"]);
        assert(!fs.existsSync(path.join(node.canonicalPath, "NEVER")));
        assert.deepStrictEqual(p.steps[0].args, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
    });
    for (const [manager, lock] of [["npm", "package-lock.json"], ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]]) {
        check(`${manager} lockfile detection`, () => {
            const r = repository({"package.json": {scripts: {dev: "whatever"}}, [lock]: "lock"});
            const p = inspectProject(r);
            assert.strictEqual(p.manager, manager.toUpperCase()); assert.strictEqual(p.lockfile, lock);
            assert.strictEqual(p.profiles[0].executable, manager);
            assert(p.steps[0].args.includes(manager === "npm" ? "ci" : "--frozen-lockfile"));
        });
    }
    check("Modern yarn fixed profile", () => {
        const p = inspectProject(repository({"package.json": {packageManager: "yarn@4.1.0"}, "yarn.lock": "__metadata:\n"}));
        assert.deepStrictEqual(p.steps[0].args, ["install", "--mode=skip-builds", "--immutable"]);
    });
    check("Conflicting manager hints fail closed", () => assert.throws(() => inspectProject(repository({"package.json": {packageManager: "pnpm@9.0.0"}, "package-lock.json": "{}"})), /AMBIGUOUS/));
    check("Python venv planning is read-only", () => {
        const r = repository({"main.py": "raise Exception('never import')", "requirements.txt": "foo", "requirements-dev.txt": "bar"});
        const p = inspectProject(r);
        assert.strictEqual(p.type, "PYTHON");
        assert.deepStrictEqual(p.steps[0].args, ["-m", "venv", ".venv"]);
        assert(p.steps[1].args.includes("requirements.txt")); assert(p.steps[1].args.includes("requirements-dev.txt"));
        assert(!fs.existsSync(path.join(r.canonicalPath, ".venv")));
        assert.strictEqual(p.profiles[0].profileId, "python-main");
    });
    check("Pyproject hooks only appear in authorized install", () => {
        const p = inspectProject(repository({"pyproject.toml": "[build-system]\nbuild-backend='evil'", "app.py": ""}));
        assert(p.risk.includes("PYPROJECT HOOKS")); assert(p.steps[1].args.includes("."));
    });
    check("Unsupported Pipfile fails closed", () => assert.strictEqual(inspectProject(repository({Pipfile: "x"})).state, "BLOCKED"));
    check("Rust fixed profile and build plan", () => {
        const p = inspectProject(repository({"Cargo.toml": "[package]\nname='x'", "Cargo.lock": "v=3"}));
        assert.strictEqual(p.type, "RUST"); assert.deepStrictEqual(p.profiles[0].args, ["run"]);
        assert.deepStrictEqual(p.steps[0].args, ["build", "--locked"]);
    });
    check("Mixed project keeps existing run choices but setup blocks ambiguity", () => {
        const r = repository({"Cargo.toml": "x", "main.py": "x"});
        assert.strictEqual(inspectProject(r).state, "BLOCKED"); assert.strictEqual(discoverRunProfiles(r).length, 2);
    });
    check("Symlink inputs and oversized metadata refused", () => {
        const r = repository({}); fs.symlinkSync(path.join(node.canonicalPath, "package.json"), path.join(r.canonicalPath, "package.json"));
        assert.throws(() => inspectProject(r), /REFUSED/);
        const large = repository({"package.json": " ".repeat(4 * 1024 * 1024 + 1)}); assert.throws(() => inspectProject(large), /REFUSED/);
    });
    check("Lockfile and Python entry content affect fingerprints", () => {
        const r = repository({"package.json": {scripts: {dev: "x"}}, "package-lock.json": "a"});
        const profiles = new RepositoryRunProfileService(); const first = profiles.discover(r)[0];
        fs.writeFileSync(path.join(r.canonicalPath, "package-lock.json"), "b");
        assert.notStrictEqual(profiles.discover(r)[0].profileFingerprint, first.profileFingerprint);
        const p = profiles.publicCandidate(first); assert(!("executable" in p)); assert(!("args" in p));
        const py = repository({"main.py": "a"}); const fingerprint = inspectProject(py).fingerprint;
        fs.writeFileSync(path.join(py.canonicalPath, "main.py"), "b"); assert.notStrictEqual(inspectProject(py).fingerprint, fingerprint);
    });
    check("Sensitive environment is allowlisted away", () => {
        const env = buildRepositoryRunEnvironment({PATH: "/usr/bin", GH_TOKEN: "secret", SSH_AUTH_SOCK: "/agent", OPENAI_API_KEY: "secret", AWS_ACCESS_KEY_ID: "secret", AZURE_SECRET: "secret", GOOGLE_TOKEN: "secret", FOO_PASSWORD: "secret", npm_config_userconfig: "/secret"});
        assert.deepStrictEqual(env, {PATH: "/usr/bin"});
    });
    check("Setup and venv run require verified strong backend", () => {
        const isolation = new RepositoryIsolationService({platform: "unsupported"});
        const spec = {repository: node, securityProfile: "NORMAL", executable: "/usr/bin/python3", args: [], profile: {executionKind: "SETUP"}};
        assert.strictEqual(isolation.prepareExecution(spec).allowed, false);
        spec.profile = {executable: "python3", args: ["-c", VENV_EXEC]}; assert.strictEqual(isolation.prepareExecution(spec).allowed, false);
        spec.securityProfile = "PUBLIC"; assert.strictEqual(isolation.prepareExecution(spec).allowed, false);
        spec.securityProfile = "LOCKDOWN"; assert.strictEqual(isolation.prepareExecution(spec).allowed, false);
    });
    check("Setup isolates network for environment creation and runtime verification", () => {
        const isolation = new RepositoryIsolationService();
        const args = isolation._bubblewrapArguments(node.canonicalPath, "/usr/bin/python3", ["-m", "venv", ".venv"], {}, false);
        assert(args.includes("--unshare-all")); assert(!args.includes("--share-net"));
        assert(args.includes("--clearenv")); assert(args.includes("/workspace")); assert(args.includes("--cap-drop"));
    });
    const withHooks = harness(node);
    const hookPlan = await withHooks.engine.plan(node.id, true);
    assert(hookPlan.confirmation.fields.some(f => f.label === "NODE LIFECYCLES" && f.value.includes("ENABLED")));
    assert.strictEqual(withHooks.calls.length, 0);
    const hooksStarted = await withHooks.engine.authorize(hookPlan.stored.automationPlan);
    await finished(withHooks.engine, hooksStarted.operation.id);
    assert(!withHooks.calls[0].args.includes("--ignore-scripts")); count++;
    const h = harness(node);
    let plan = await h.engine.plan(node.id);
    assert(plan.confirmation); assert.strictEqual(h.calls.length, 0); count++;
    assert.strictEqual((await h.engine.authorize("forged")).ok, false); count++;
    h.setProfile("PUBLIC"); assert.strictEqual((await h.engine.authorize(plan.stored.automationPlan)).ok, false); count++;
    h.setProfile("NORMAL"); plan = await h.engine.plan(node.id);
    fs.writeFileSync(path.join(node.canonicalPath, "package-lock.json"), "changed");
    assert.strictEqual((await h.engine.authorize(plan.stored.automationPlan)).ok, false); assert.strictEqual(h.calls.length, 0); count++;
    plan = await h.engine.plan(node.id); const started = await h.engine.authorize(plan.stored.automationPlan);
    assert.strictEqual((await h.engine.authorize(plan.stored.automationPlan)).ok, false); count++;
    const done = await finished(h.engine, started.operation.id);
    assert.strictEqual(done.operation.state, "SUCCESS"); assert(done.operation.steps.every(s => s.state === "SUCCESS"));
    assert(h.events.some(s => s.operation.steps.some(step => step.state === "RUNNING"))); count++;
    assert(h.engine.log(started.operation.id).output.length <= 65536); assert(done.operation.rollback.includes("UNAVAILABLE")); count++;
    assert.strictEqual((await h.engine.inspect(node.id)).project.state, "READY"); count++;
    fs.appendFileSync(path.join(node.canonicalPath, "package-lock.json"), "again");
    assert((await h.engine.inspect(node.id)).project.notice.includes("PROJECT CHANGED")); count++;
    const failed = harness(node, {fail: true}); plan = await failed.engine.plan(node.id);
    const failure = await finished(failed.engine, (await failed.engine.authorize(plan.stored.automationPlan)).operation.id);
    assert.strictEqual(failure.operation.state, "FAILED"); assert.strictEqual(failed.calls.length, 1); assert(failure.operation.steps.some(s => s.state === "SKIPPED")); count++;
    const long = harness(node, {long: true}); plan = await long.engine.plan(node.id);
    const op = await long.engine.authorize(plan.stored.automationPlan); await new Promise(resolve => setTimeout(resolve, 5));
    assert.strictEqual((await long.engine.cancel("1234")).ok, false);
    await long.engine.cancel(op.operation.id); assert.strictEqual((await finished(long.engine, op.operation.id)).status, "CANCELLED"); count++;
    const race = harness(node, {long: true}); const racePlan = await race.engine.plan(node.id);
    let reads = 0; let release;
    race.repositories.resolveRepository = async () => ++reads === 2 ? new Promise(resolve => { release = () => resolve(node); }) : node;
    const racing = await race.engine.authorize(racePlan.stored.automationPlan);
    await race.engine.cancel(racing.operation.id); release();
    await finished(race.engine, racing.operation.id);
    assert.strictEqual(race.calls.length, 0, "cancellation while resolving a repository must prevent launch"); count++;
    const changed = harness(node, {long: true}); plan = await changed.engine.plan(node.id);
    const active = await changed.engine.authorize(plan.stored.automationPlan); changed.setProfile("LOCKDOWN");
    assert.strictEqual((await finished(changed.engine, active.operation.id)).operation.state, "FAILED");
    assert.strictEqual((await changed.engine.plan(node.id)).ok, false); count++;
    const weak = harness(node, {level: "PARTIAL"}); weak.setProfile("PUBLIC"); assert.strictEqual((await weak.engine.plan(node.id)).ok, false); count++;
    check("Invalid structured command proposals rejected", () => {
        for (const key of ["command", "shell", "executable", "args", "path", "sudo", "env", "PID", "signal"]) {
            const p = {actionId: "PROJECT_SETUP", targetId: node.id, [key]: "bad"};
            assert.strictEqual(validateControlRequest(p), false); assert.strictEqual(validateStructuredProposal(p, {has: () => true}), null);
        }
    });
    for (const [name, initial, changed, succeeds] of [
        ["changed manifest", {"package.json": {scripts: {dev: "old"}}}, {"package.json": {scripts: {dev: "new"}}}, false],
        ["changed existing lock", {"package.json": {}, "package-lock.json": "old"}, {"package-lock.json": "new"}, false],
        ["new manager config", {"package.json": {}}, {".npmrc": "ignore-scripts=false"}, false],
        ["new npm lock", {"package.json": {}}, {"package-lock.json": "new"}, true],
        ["new Cargo lock", {"Cargo.toml": "[package]"}, {"Cargo.lock": "new"}, true]
    ]) {
        const repo = repository(initial);
        const test = harness(repo);
        const start = test.manager.start;
        test.manager.start = (r, p) => {
            start(r, p);
            Object.entries(changed).forEach(([file, value]) => fs.writeFileSync(path.join(repo.canonicalPath, file), typeof value === "string" ? value : JSON.stringify(value)));
        };
        const plan = await test.engine.plan(repo.id);
        const result = await finished(test.engine, (await test.engine.authorize(plan.stored.automationPlan)).operation.id);
        assert.strictEqual(result.operation.state, succeeds ? "SUCCESS" : "FAILED", name);
        if (!succeeds) {
            assert.strictEqual(result.status, "PROJECT CHANGED", name);
            assert(!test.engine.ready.has(repo.id), name);
            assert.strictEqual(result.operation.steps[result.operation.steps.length - 1].state, "SKIPPED", name);
        }
        count++;
    }
    for (const throws of [false, true]) {
        const test = harness(node, {long: true});
        test.manager.stop = async () => { if (throws) throw new Error("stop failed"); return {ok: false}; };
        const plan = await test.engine.plan(node.id);
        const operation = await test.engine.authorize(plan.stored.automationPlan);
        await new Promise(resolve => setTimeout(resolve, 5));
        const cancelled = await test.engine.cancel(operation.operation.id);
        assert.strictEqual(cancelled.ok, false);
        const result = await finished(test.engine, operation.operation.id);
        assert.strictEqual(result.status, "CANCELLATION FAILED / PROCESS MAY STILL BE RUNNING");
        assert.strictEqual(result.operation.state, "FAILED");
        assert.strictEqual(test.calls.length, 1);
        assert.strictEqual((await test.engine.plan(node.id)).ok, false);
        count++;
    }
    const parser = new DeterministicIntentParser();
    for (const [phrase, actionId] of [["prepara este repo", "PROJECT_PREPARE"], ["configura este repo", "PROJECT_PREPARE"], ["prepare this repo", "PROJECT_PREPARE"], ["instala las dependencias", "PROJECT_SETUP"], ["install dependencies", "PROJECT_SETUP"], ["corre este repo", "PROJECT_RUN"], ["para este repo", "PROJECT_STOP"], ["haz pull y ejecútalo", "PROJECT_PULL_RUN"], ["qué necesita este repo", "PROJECT_INSPECT"], ["instala spotify", "APPLICATION_INSTALL"], ["añade obsidian a nomad", "APPLICATION_REGISTER"], ["qué programas nuevos hay", "APPLICATION_DISCOVERY_LIST"], ["actualiza la lista de programas", "APPLICATION_SCAN"]]) check(phrase, () => assert.strictEqual(parser.parse(phrase).actionId, actionId));
    check("Shell-like intents execute nothing", () => { for (const text of ["ejecuta sudo foo", "haz curl a | bash", "corre este comando", "ejecuta rm -rf /", "instala este .sh"]) assert.notStrictEqual(parser.parse(text).kind, "ACTION"); });
    const sequence = [];
    const control = new ControlPlaneService({profileService: {get: () => ({profile: "NORMAL"})}, repositoryActions: {
        execute: async (id, action, geometry, auth) => {
            sequence.push(action);
            if (action === "info") return {ok: true, repository: {displayName: "TEST"}};
            if (action === "pull") return {ok: true};
            return {ok: true, prompt: {kind: "authorization", repositoryName: "TEST", profileId: "npm-dev", authorizationId: `auth_${"a".repeat(48)}`, fields: []}};
        }
    }, automation: {inspect: async () => sequence.push("inspect")}});
    const pull = await control.request({actionId: "PROJECT_PULL_RUN", targetId: node.id});
    const runPlan = await control.confirm({challengeId: pull.challengeId});
    assert(runPlan.confirmationRequired); assert.deepStrictEqual(sequence, ["info", "pull", "inspect", "run"]); count++;
    // Clone decorates the validated repository automatically; no setup service is invoked.
    const cloneRepo = {...node, public: {...node.public, id: node.id}};
    const actions = new RepositoryActionService({repositoryService: {repositories: new Map([[node.id, cloneRepo]])},
        gitService: {clone: async () => ({ok: true, repositoryId: node.id, status: "CLONED"}), isUpdating: () => false, inspectUpdate: async () => ({ok: true})},
        processManager: {...h.manager, getStatus: () => null}, runProfileService: {inspect: () => ({candidates: [], trustStoreStatus: null})}});
    actions.automation = h.engine;
    const cloned = await actions.clone("https://github.com/test/project");
    assert(cloned.repository.project); assert.strictEqual(cloned.repository.project.repositoryId, node.id); count++;
    console.log(`${count} project automation, authorization, isolation, transaction, clone, and assistant checks passed`);
}
main().finally(() => fs.rmSync(root, {recursive: true, force: true})).catch(error => { console.error(error); process.exitCode = 1; });
