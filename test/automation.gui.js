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
    const manifest = {name: "nomad-automation-probe", version: "1.0.0", scripts: {dev: "node server.js", preinstall: "node forbidden.js"}};
    fs.writeFileSync(path.join(project, "package.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(project, "package-lock.json"), JSON.stringify({name: manifest.name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: {"": {name: manifest.name, version: "1.0.0"}}}));
    fs.writeFileSync(path.join(project, "server.js"), "require('fs').writeFileSync('RUN_MARKER','authorized'); setInterval(() => console.log('RUNNING'), 1000);\n");
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
    runModule.RepositoryRunProfileService = class extends RealRuns {
        constructor(opts) { super({...opts, trustStorePath: path.join(root, "run-trust.json")}); }
    };
    const repoModule = require("../src/classes/repositoryService.js");
    const RealRepositories = repoModule.RepositoryService;
    repoModule.RepositoryService = class extends RealRepositories {
        constructor(opts) { super({...opts, repositoryRoot: repositories}); }
        setRepositoryRoot() { return super.setRepositoryRoot(repositories); }
    };
    const desktops = path.join(root, "desktop-entries");
    fs.mkdirSync(desktops, {mode: 0o700});
    const applicationModule = require("../src/cli/applicationService.js");
    const RealApplications = applicationModule.ApplicationService;
    applicationModule.ApplicationService = class extends RealApplications {
        constructor(opts) { super({...opts, applicationDirectories: [desktops]}); }
    };
    return {project, desktops, getProfiles: () => profiles};
}
async function acceptance(read, until, probe) {
    const list = await read("window.nomad.control.request('PROJECT_LIST')");
    assert.strictEqual(list.projects.length, 1);
    const id = list.projects[0].repositoryId;
    assert.strictEqual(list.projects[0].type, "NODE");
    assert(!fs.existsSync(path.join(probe.project, "RUN_MARKER")));
    assert(!fs.existsSync(path.join(probe.project, "FORBIDDEN_MARKER")));
    await read(`window.nomadControlPlane.open('projects'); window.nomadControlPlane.setSelectedRepository('${id}', {displayName:'AUTOMATION PROBE'})`);
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
    const stopped = await read("window.nomad.assistant.interpret('para este repo')");
    assert(stopped.ok, stopped.status);
    const manifestPath = path.join(probe.project, "package.json");
    const changed = JSON.parse(fs.readFileSync(manifestPath));
    changed.scripts.preinstall = "node wait.js";
    fs.writeFileSync(manifestPath, JSON.stringify(changed));
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
