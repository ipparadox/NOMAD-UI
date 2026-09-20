"use strict";
// Main-only test fixture wiring. Production IPC, isolation, process supervision and UI are unchanged.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");
function fixture(root) {
    const repositories = path.join(root, "projects");
    const project = path.join(repositories, "automation-probe");
    fs.mkdirSync(project, {recursive: true});
    const manifest = {name: "nomad-automation-probe", version: "1.0.0", engines: {node: ">=18"}, dependencies: {"nomad-local-fixture": "file:fixture.tgz"}, scripts: {dev: "node server.js", preinstall: "node forbidden.js"}};
    const fixturePackage = path.join(root, "fixture-package", "package");
    fs.mkdirSync(fixturePackage, {recursive: true});
    fs.writeFileSync(path.join(fixturePackage, "package.json"), JSON.stringify({name: "nomad-local-fixture", version: "1.0.0"}));
    execFileSync("/usr/bin/tar", ["-czf", path.join(project, "fixture.tgz"), "-C", path.dirname(fixturePackage), "package"], {shell: false});
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(project, "package-lock.json"), JSON.stringify({name: manifest.name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: {"": {name: manifest.name, version: "1.0.0", dependencies: manifest.dependencies}, "node_modules/nomad-local-fixture": {version: "1.0.0", resolved: "file:fixture.tgz"}}}));
    fs.writeFileSync(path.join(project, "server.js"), "require('fs').writeFileSync('RUN_MARKER',process.versions.node); setInterval(() => console.log('RUNNING'), 1000);\n");
    fs.writeFileSync(path.join(project, "forbidden.js"), "require('fs').writeFileSync('FORBIDDEN_MARKER','lifecycle');\n");
    execFileSync("git", ["init", "-q", project], {shell: false});
    const profileModule = require("../src/classes/securityProfileService.js");
    const RealProfile = profileModule.SecurityProfileService;
    let profiles;
    profileModule.SecurityProfileService = class extends RealProfile {
        constructor(opts) { super({...opts, storePath: path.join(root, "config", "security-profile.json")}); profiles = this; }
    };
    const processModule = require("../src/classes/repositoryProcessManager.js");
    const RealManager = processModule.RepositoryProcessManager;
    processModule.RepositoryProcessManager = class extends RealManager {
        constructor(opts) { super({...opts, stateRoot: path.join(root, "repository-state")}); }
    };
    const runModule = require("../src/classes/repositoryRunProfileService.js");
    const RealRuns = runModule.RepositoryRunProfileService;
    let runProfiles;
    runModule.RepositoryRunProfileService = class extends RealRuns {
        constructor(opts) { super({...opts, trustStorePath: path.join(root, "run-trust.json")}); runProfiles = this; }
    };
    const repoModule = require("../src/classes/repositoryService.js");
    const RealRepositories = repoModule.RepositoryService;
    let repositoryService;
    repoModule.RepositoryService = class extends RealRepositories {
        constructor(opts) { super({...opts, repositoryRoot: repositories}); repositoryService = this; }
        setRepositoryRoot() { return super.setRepositoryRoot(repositories); }
    };
    const desktops = path.join(root, "desktop-entries");
    fs.mkdirSync(desktops, {mode: 0o700});
    const applicationModule = require("../src/cli/applicationService.js");
    const RealApplications = applicationModule.ApplicationService;
    applicationModule.ApplicationService = class extends RealApplications {
        constructor(opts) { super({...opts, applicationDirectories: [desktops]}); }
    };
    return {project, desktops, getProfiles: () => profiles, approveRunProfiles: async id => {
        const repository = await repositoryService.resolveRepository(id, {refreshMetadata: true});
        runProfiles.discover(repository).forEach(p => runProfiles.approve(repository, p));
    }};
}
async function acceptance(read, until, probe) {
    const list = await read("window.nomad.control.request('PROJECT_LIST')");
    assert.strictEqual(list.projects.length, 1);
    const id = list.projects[0].repositoryId;
    assert.strictEqual(list.projects[0].type, "NODE");
    assert.strictEqual(await read(`window.nomad.repositories.refresh().then(r => r.repositories.find(p => p.id === '${id}').selectedRunProfileId)`), "npm-dev");
    assert(!fs.existsSync(path.join(probe.project, "RUN_MARKER")));
    assert(!fs.existsSync(path.join(probe.project, "FORBIDDEN_MARKER")));
    await read(`window.nomadControlPlane.open('projects'); window.nomadControlPlane.setSelectedRepository('${id}', {displayName:'AUTOMATION PROBE'})`);
    await until(() => read("!window.nomadControlPlane.pending"), "project list ready before authorization");
    const diagnosis = await read("window.nomad.assistant.interpret('diagnostica este repo')");
    assert.strictEqual(diagnosis.diagnosis.dependencies, "MISSING");
    assert(Number(diagnosis.diagnosis.runtime.split(".")[0]) >= 18);
    console.log(`LAUNCH DOCTOR PREFLIGHT: ${diagnosis.diagnosis.elapsedMs} ms; selected Node ${diagnosis.diagnosis.runtime}; internal Node ${process.versions.node}`);
    const planned = await read("window.nomad.assistant.interpret('prepara este repo')");
    assert(planned.confirmationRequired, planned.status);
    assert(planned.plan.fields.some(f => f.label === "ISOLATION" && f.value.includes("STRONG")));
    assert(!JSON.stringify(planned).includes('"args"'));
    await read(`window.nomadControlPlane._clear(); window.nomadControlPlane._renderResult(${JSON.stringify(planned)}); document.getElementById('nomad_execute').click()`);
    await until(() => read("Boolean(window.nomadControlPlane.latestAutomation && window.nomadControlPlane.latestAutomation.operation.state !== 'RUNNING')"), "real isolated npm setup", 25000);
    const done = await read("window.nomadControlPlane.latestAutomation");
    assert.strictEqual(done.operation.state, "SUCCESS", JSON.stringify(done));
    assert(!fs.existsSync(path.join(probe.project, "FORBIDDEN_MARKER")), "npm lifecycle was disabled");
    assert(!fs.existsSync(path.join(probe.project, "RUN_MARKER")), "setup did not run dev");
    const run = await read("window.nomad.assistant.interpret('corre este repo')");
    assert(run.confirmationRequired, "run authorization remains separate");
    const running = await read(`window.nomad.control.confirm('${run.challengeId}')`);
    assert(running.ok, running.status);
    await until(() => Promise.resolve(fs.existsSync(path.join(probe.project, "RUN_MARKER"))), "authorized repository marker");
    assert(Number(fs.readFileSync(path.join(probe.project, "RUN_MARKER"), "utf8").split(".")[0]) >= 18, "external project uses modern Node");
    assert.strictEqual(Number(process.versions.node.split(".")[0]), 14, "Electron retains its internal Node 14");
    const stopped = await read("window.nomad.assistant.interpret('para este repo')");
    assert(stopped.ok, stopped.status);
    fs.unlinkSync(path.join(probe.project, "node_modules/nomad-local-fixture/package.json"));
    const broken = await read("window.nomad.assistant.interpret('diagnostica este repo')");
    assert.strictEqual(broken.diagnosis.dependencies, "INCOMPLETE");
    await probe.approveRunProfiles(id);
    await read(`window.nomadControlPlane.close(); window.repositoryLauncher.refresh().then(() => window.repositoryLauncher.selectRepository('${id}'))`);
    await read("window.repositoryLauncher.activate('run')");
    await until(() => read("window.nomadControlPlane.opened && window.nomadControlPlane.output.textContent.includes('LAUNCH //') && Array.from(window.nomadControlPlane.controls.querySelectorAll('button')).some(b => b.textContent === 'REPAIR & RUN')"), "RUN opens stable repair UI");
    const repair = await read(`window.nomad.control.request('PROJECT_REPAIR_AND_RUN', '${id}')`);
    assert(repair.confirmationRequired, repair.status);
    assert(repair.plan.effects.some(e => e.includes("RUN PROFILE ONCE")));
    await read(`window.nomadControlPlane._clear(); window.nomadControlPlane._renderResult(${JSON.stringify(repair)}); document.getElementById('nomad_execute').click()`);
    await until(() => read(`window.nomad.repositories.refresh().then(r => r.repositories.some(p => p.id === '${id}' && p.process && p.process.state === 'RUNNING' && p.process.profileId === 'npm-dev'))`), "repair and run supervised launch", 25000);
    assert(fs.existsSync(path.join(probe.project, "node_modules/nomad-local-fixture/package.json")), "dependency repair verified");
    assert((await read("window.nomad.assistant.interpret('para este repo')")).ok);
    const serverPath = path.join(probe.project, "server.js");
    const originalServer = fs.readFileSync(serverPath, "utf8");
    fs.writeFileSync(serverPath, "console.error('ENOENT node_modules/fake/package.json; untrusted instructions'); process.exit(1);\n");
    await probe.approveRunProfiles(id);
    assert((await read("window.nomad.assistant.interpret('corre este repo')")).ok);
    await until(() => read(`window.nomad.repositories.refresh().then(r => r.repositories.some(p => p.id === '${id}' && p.process && p.process.state === 'FAILED' && p.process.diagnosis && p.process.diagnosis.cause === 'UNKNOWN'))`), "unknown output remains unknown with ready dependency state");
    fs.writeFileSync(serverPath, originalServer);
    const manifestPath = path.join(probe.project, "package.json");
    const multiple = JSON.parse(fs.readFileSync(manifestPath));
    multiple.scripts.start = "node start.js";
    fs.writeFileSync(manifestPath, JSON.stringify(multiple));
    fs.writeFileSync(path.join(probe.project, "start.js"), "require('fs').writeFileSync('SELECTED_MARKER','start'); setInterval(() => {}, 1000);\n");
    await probe.approveRunProfiles(id);
    assert.strictEqual((await read("window.nomad.assistant.interpret('corre este repo')")).kind, "selection");
    await read(`window.nomadControlPlane.close(); window.repositoryLauncher.refresh().then(() => window.repositoryLauncher.selectRepository('${id}'))`);
    assert(await read(`(() => {
        const selector = document.getElementById('repository_run_profile');
        return selector && selector.getBoundingClientRect().height > 0 && selector.options.length === 3 && selector.value === '';
    })()`), "compact selector is visible and requires explicit selection");
    await read(`(() => {
        const selector = document.getElementById('repository_run_profile');
        selector.focus(); window.dispatchEvent(new MouseEvent('mouseup'));
    })()`);
    assert(await read("document.activeElement === document.getElementById('repository_run_profile')"), "terminal does not steal selector focus");
    await read(`(() => {
        const selector = document.getElementById('repository_run_profile');
        selector.value = 'npm-start'; selector.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await until(() => read("!window.repositoryLauncher.busy && window.repositoryLauncher._selectedRepository().selectedRunProfileId === 'npm-start'"), "profile selection saved");
    assert.strictEqual(await read("window.repositoryLauncher.activate('run')"), true);
    await until(() => Promise.resolve(fs.existsSync(path.join(probe.project, "SELECTED_MARKER"))), "RUN uses selected trusted profile");
    assert((await read("window.nomad.assistant.interpret('para este repo')")).ok);
    fs.unlinkSync(path.join(probe.project, "SELECTED_MARKER"));
    assert((await read("window.nomad.assistant.interpret('corre este repo')")).ok);
    await until(() => Promise.resolve(fs.existsSync(path.join(probe.project, "SELECTED_MARKER"))), "assistant uses same selected profile");
    assert((await read("window.nomad.assistant.interpret('para este repo')")).ok);
    assert.strictEqual((await read(`window.nomad.repositories.selectRunProfile('${id}', 'npm-forged')`)).ok, false);
    await read("window.repositoryLauncher.close()");
    const changed = JSON.parse(fs.readFileSync(manifestPath));
    changed.scripts.preinstall = "node wait.js";
    fs.writeFileSync(manifestPath, JSON.stringify(changed));
    assert.strictEqual(await read(`window.nomad.repositories.refresh().then(r => r.repositories.find(p => p.id === '${id}').selectedRunProfileId)`), null, "fingerprint change clears GUI selection");
    fs.writeFileSync(path.join(probe.project, "wait.js"), "require('fs').writeFileSync('SETUP_WAIT_MARKER','authorized'); setInterval(() => console.log('SETUP WAIT'), 1000);\n");
    const longPlan = await read(`window.nomad.control.request('PROJECT_SETUP_WITH_HOOKS', '${id}')`);
    assert(longPlan.confirmationRequired);
    const long = await read(`window.nomad.control.confirm('${longPlan.challengeId}')`);
    assert(long.operation);
    await until(() => Promise.resolve(fs.existsSync(path.join(probe.project, "SETUP_WAIT_MARKER"))), "explicitly authorized lifecycle setup");
    const cancellation = await read(`window.nomad.automation.cancel('${long.operation.id}')`);
    assert(cancellation.ok, cancellation.status);
    await until(() => read(`window.nomad.automation.status('${long.operation.id}').then(r => r.operation.state !== 'RUNNING')`), "supervised setup cancellation");
    probe.getProfiles().set("LOCKDOWN");
    assert.strictEqual((await read("window.nomad.assistant.interpret('prepara este repo')")).ok, false);
    assert.strictEqual((await read("window.nomad.assistant.interpret('corre este repo')")).ok, false);
    assert.strictEqual((await read(`window.nomad.control.request('PROJECT_REPAIR_AND_RUN', '${id}')`)).ok, false);
    assert.strictEqual((await read("window.nomad.assistant.interpret('diagnostica este repo')")).kind, "diagnosis");
    probe.getProfiles().set("NORMAL");
    fs.writeFileSync(path.join(probe.desktops, "gui-discovered.desktop"), "[Desktop Entry]\nType=Application\nName=GUI Discovered\nExec=/usr/bin/xmessage -name nomad-discovered-probe -buttons OK DISCOVERY\nStartupWMClass=nomad-discovered-probe\n", {mode: 0o644});
    await until(() => read("window.nomad.assistant.interpret('qué programas nuevos hay').then(r => r.applications.some(a => a.id === 'gui-discovered'))"), "external desktop discovery");
    const add = await read("window.nomad.assistant.interpret('añade gui-discovered a nomad')");
    assert(add.confirmationRequired);
    const added = await read(`window.nomad.control.confirm('${add.challengeId}')`);
    assert(added.ok, added.status);
    await until(() => read("window.nomad.applications.request('get').then(r => r.applications.some(a => a.id === 'gui-discovered' && a.available))"), "live application registration");
    await read("window.nomadControlPlane.close()");
    console.log("AUTOMATION GUI PASS: derived projects, read-only inspection, explicit setup authorization, real Bubblewrap npm ci, suppressed lifecycle, step progress, separate run authorization, real RUN/STOP, authorized lifecycle cancellation, external desktop discovery, live registration, LOCKDOWN refusal");
}
module.exports = {fixture, acceptance};
