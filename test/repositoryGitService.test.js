const assert = require("assert");
const {EventEmitter} = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {PassThrough} = require("stream");
const {execFile, spawn} = require("child_process");
const {
    RepositoryActionService,
    RepositoryGitService,
    RepositoryService,
    handleRepositoryRequest
} = require("../src/classes/repositoryService.js");
const {
    parseGithubRepository
} = require("../src/classes/repositoryGitService.js");
const {RepositoryProcessManager} = require("../src/classes/repositoryProcessManager.js");
const {
    RepositoryRunProfileService,
    RepositoryRunTrustStore
} = require("../src/classes/repositoryRunProfileService.js");
const {RepositoryCliService} = require("../src/cli/repositoryCliService.js");

function runFile(executable, args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(executable, args, Object.assign({encoding: "utf8", shell: false}, options), (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
            } else resolve(stdout);
        });
    });
}

function git(repositoryPath, args) {
    return runFile("git", ["-C", repositoryPath].concat(args));
}

async function initializeRemote(temporaryRoot) {
    const seed = path.join(temporaryRoot, "seed");
    const bare = path.join(temporaryRoot, "remote.git");
    fs.mkdirSync(seed);
    await runFile("git", ["init", "-q", "-b", "main", seed]);
    await git(seed, ["config", "user.name", "NOMAD Tests"]);
    await git(seed, ["config", "user.email", "nomad@example.invalid"]);
    fs.writeFileSync(path.join(seed, "README.md"), "INITIAL\n");
    fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({
        scripts: {dev: "node one.js"}
    }, null, 2));
    await git(seed, ["add", "README.md", "package.json"]);
    await git(seed, ["commit", "-q", "-m", "initial"]);
    await runFile("git", ["clone", "-q", "--bare", seed, bare]);
    return bare;
}

async function publisherClone(temporaryRoot, bare) {
    const publisher = path.join(temporaryRoot, "publisher");
    await runFile("git", ["clone", "-q", bare, publisher]);
    await git(publisher, ["config", "user.name", "NOMAD Tests"]);
    await git(publisher, ["config", "user.email", "nomad@example.invalid"]);
    return publisher;
}

async function commitAndPush(publisher, fileName, content, message) {
    fs.writeFileSync(path.join(publisher, fileName), content);
    await git(publisher, ["add", fileName]);
    await git(publisher, ["commit", "-q", "-m", message]);
    await git(publisher, ["push", "-q", "origin", "main"]);
}

function transportHarness(remoteMap) {
    const calls = [];
    const translate = (args, options) => {
        let translated = args.slice();
        let environment = options.env;
        const networkCommand = translated.includes("clone") ? "clone" : (translated.includes("fetch") ? "fetch" : null);
        if (networkCommand) {
            const commandIndex = translated.indexOf(networkCommand);
            translated.splice(commandIndex, 0, "-c", "protocol.file.allow=always");
            translated = translated.map(argument => remoteMap.get(argument) || argument);
            environment = Object.assign({}, environment, {GIT_ALLOW_PROTOCOL: "file"});
        }
        return {args: translated, options: Object.assign({}, options, {env: environment})};
    };
    return {
        calls,
        execFile: (executable, args, options, callback) => {
            calls.push({kind: "execFile", executable, args: args.slice(), options});
            const translated = translate(args, options);
            return execFile(executable, translated.args, translated.options, callback);
        },
        spawn: (executable, args, options) => {
            calls.push({kind: "spawn", executable, args: args.slice(), options});
            const translated = translate(args, options);
            return spawn(executable, translated.args, translated.options);
        }
    };
}

function fakeProcessManager(stateRoot) {
    return new RepositoryProcessManager({stateRoot});
}

async function run() {
    const https = parseGithubRepository("https://github.com/OpenAI/example.git");
    const ssh = parseGithubRepository("git@github.com:OpenAI/example.git");
    assert.strictEqual(https.canonicalUrl, "https://github.com/OpenAI/example");
    assert.strictEqual(https.identity, "github.com/openai/example");
    assert.deepStrictEqual(ssh, https);
    [
        "http://github.com/owner/repo",
        "https://gitlab.com/owner/repo",
        "https://github.com.evil.invalid/owner/repo",
        "https://user:secret@github.com/owner/repo",
        "https://github.com:443/owner/repo",
        "https://github.com/owner/repo?token=x",
        "https://github.com/owner/repo#fragment",
        "https://github.com/owner/repo/extra",
        "https://github.com/owner/../repo",
        "https://github.com/owner/%2e%2e",
        "git@evil.invalid:owner/repo.git",
        "ssh://git@github.com/owner/repo.git",
        "git://github.com/owner/repo.git",
        "file:///tmp/repo",
        "../repo",
        "/tmp/repo",
        "$(touch /tmp/owned)",
        "https://github.com/owner/repo;touch-owned"
    ].forEach(candidate => assert.strictEqual(parseGithubRepository(candidate), null, candidate));

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-repository-git-"));
    try {
        const repositoryRoot = path.join(temporaryRoot, "Repositories");
        const bare = await initializeRemote(temporaryRoot);
        const canonicalUrl = "https://github.com/owner/cloned";
        const remoteMap = new Map([
            [canonicalUrl, bare],
            ["https://github.com/owner/failure", path.join(temporaryRoot, "missing.git")],
            ["https://github.com/owner/cancelled", bare]
        ]);
        const transport = transportHarness(remoteMap);
        fs.mkdirSync(repositoryRoot);
        const repositoryService = new RepositoryService({
            repositoryRoot,
            execFile: transport.execFile,
            spawn: transport.spawn
        });
        const gitService = new RepositoryGitService({repositoryService});
        const trustStorePath = path.join(temporaryRoot, "config", "repository-runs.json");
        const runProfileService = new RepositoryRunProfileService({
            trustStore: new RepositoryRunTrustStore({trustStorePath})
        });
        const actions = new RepositoryActionService({
            repositoryService,
            gitService,
            runProfileService,
            processManager: fakeProcessManager(path.join(temporaryRoot, "process-state"))
        });

        const spawnCountBeforeInjection = transport.calls.filter(call => call.kind === "spawn").length;
        for (const injected of [
            {destination: path.join(temporaryRoot, "renderer-destination")},
            {gitExecutable: "/tmp/renderer-git"},
            {args: ["--upload-pack=/tmp/owned"]},
            {command: "git clone anything"},
            {pid: process.pid}
        ]) {
            const result = await handleRepositoryRequest(actions, Object.assign({
                operation: "clone",
                repositoryUrl: canonicalUrl
            }, injected));
            assert.strictEqual(result.status, "INVALID REQUEST");
        }
        assert.strictEqual(transport.calls.filter(call => call.kind === "spawn").length, spawnCountBeforeInjection);

        const cloned = await handleRepositoryRequest(actions, {
            operation: "clone",
            repositoryUrl: "git@github.com:owner/cloned.git"
        });
        assert.strictEqual(cloned.ok, true);
        assert.strictEqual(cloned.status, "CLONE COMPLETE\nREPOSITORY REGISTERED");
        assert.strictEqual(cloned.repository.displayName, "cloned");
        const cloneCall = transport.calls.find(call => call.kind === "spawn" && call.args.includes("clone"));
        assert(cloneCall, "clone must use the supervised spawn path");
        assert.strictEqual(cloneCall.options.shell, false);
        assert.strictEqual(cloneCall.args[cloneCall.args.length - 2], canonicalUrl);
        assert.strictEqual(cloneCall.args[cloneCall.args.length - 1],
            process.platform === "linux" ? "/proc/self/fd/3" : path.join(repositoryRoot, "cloned"));
        if (process.platform === "linux") assert(Number.isInteger(cloneCall.options.stdio[3]));
        assert.strictEqual(fs.realpathSync(path.join(repositoryRoot, "cloned")), path.join(repositoryRoot, "cloned"));
        assert(!cloneCall.args.some(argument => argument.includes("renderer-destination")));
        assert.strictEqual(path.basename(cloneCall.executable), "git");

        let listing = await repositoryService.refresh();
        assert.deepStrictEqual(listing.repositories.map(repository => repository.displayName), ["cloned"]);
        const repositoryId = listing.repositories[0].id;
        let internal = repositoryService.repositories.get(repositoryId);
        assert.strictEqual(internal.public.remote, canonicalUrl);
        assert.strictEqual(internal.public.upstream, "origin/main");
        assert.strictEqual(internal.public.ahead, 0);
        assert.strictEqual(internal.public.behind, 0);
        const repositoryCliService = new RepositoryCliService({
            repositoryService,
            repositoryGitService: gitService
        });
        const cliListing = await repositoryCliService.list();
        assert.strictEqual(cliListing.repositories[0].pullState, "PULL");
        const cliInfo = await repositoryCliService.info("cloned");
        assert.strictEqual(cliInfo.id, repositoryId);
        assert.strictEqual(cliInfo.remote, canonicalUrl);

        const existingSpawnCount = transport.calls.filter(call => call.kind === "spawn").length;
        assert.strictEqual((await gitService.clone(canonicalUrl)).status, "REPOSITORY ALREADY EXISTS");
        assert.strictEqual(transport.calls.filter(call => call.kind === "spawn").length, existingSpawnCount);

        fs.mkdirSync(path.join(repositoryRoot, "CaseRepo"));
        assert.strictEqual((await gitService.clone("https://github.com/owner/caserepo")).status, "REPOSITORY ALREADY EXISTS");
        const outside = path.join(temporaryRoot, "outside");
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(repositoryRoot, "linkrepo"), "dir");
        assert.strictEqual((await gitService.clone("https://github.com/owner/linkrepo")).status, "REPOSITORY ALREADY EXISTS");
        assert.deepStrictEqual(fs.readdirSync(outside), []);

        const failed = await gitService.clone("https://github.com/owner/failure");
        assert.strictEqual(failed.status, "CLONE FAILED");
        assert.strictEqual(fs.existsSync(path.join(repositoryRoot, "failure")), false, "failed clone must remove its reserved partial directory");
        listing = await repositoryService.refresh();
        assert(!listing.repositories.some(repository => repository.displayName === "failure"));

        const unsafeWorktree = path.join(repositoryRoot, "unsafe-worktree");
        const configuredOutsideWorktree = path.join(temporaryRoot, "configured-outside-worktree");
        fs.mkdirSync(configuredOutsideWorktree);
        await runFile("git", ["clone", "-q", bare, unsafeWorktree]);
        await git(unsafeWorktree, ["config", "core.worktree", configuredOutsideWorktree]);
        listing = await repositoryService.refresh();
        assert(!listing.repositories.some(repository => repository.displayName === "unsafe-worktree"),
            "a repository-configured worktree outside repositoryRoot must not be trusted");
        fs.rmSync(unsafeWorktree, {recursive: true, force: true});

        const invalidCancel = await handleRepositoryRequest(actions, {operation: "cancel-clone", pid: 1});
        assert.strictEqual(invalidCancel.status, "INVALID REQUEST");

        const actionListing = await actions.list();
        const actionRepository = actionListing.repositories.find(repository => repository.id === repositoryId);
        assert.deepStrictEqual(actionRepository.actions.map(action => action.id), [
            "code", "terminal", "info", "github", "run", "stop", "pull"
        ]);
        assert.strictEqual(actionRepository.actions.find(action => action.id === "pull").enabled, true);

        const publisher = await publisherClone(temporaryRoot, bare);
        const trustedInspection = runProfileService.inspect(internal);
        const trustedCandidate = trustedInspection.candidates.find(candidate => candidate.profileId === "npm-dev");
        assert(trustedCandidate);
        runProfileService.approve(internal, trustedCandidate);
        assert.strictEqual(runProfileService.inspect(internal).candidates[0].authorizationState, "APPROVED");

        const hookMarker = path.join(temporaryRoot, "hook-executed");
        const filterMarker = path.join(temporaryRoot, "filter-executed");
        const diffMarker = path.join(temporaryRoot, "diff-executed");
        const fsmonitorMarker = path.join(temporaryRoot, "fsmonitor-executed");
        const hookPath = path.join(internal.canonicalPath, ".git", "hooks", "post-merge");
        const filterScript = path.join(temporaryRoot, "hostile-filter.sh");
        const diffScript = path.join(temporaryRoot, "hostile-diff.sh");
        const fsmonitorScript = path.join(temporaryRoot, "hostile-fsmonitor.sh");
        fs.writeFileSync(hookPath, `#!/bin/sh\ntouch '${hookMarker}'\n`, {mode: 0o755});
        fs.writeFileSync(filterScript, `#!/bin/sh\ntouch '${filterMarker}'\ncat\n`, {mode: 0o755});
        fs.writeFileSync(diffScript, `#!/bin/sh\ntouch '${diffMarker}'\ncat\n`, {mode: 0o755});
        fs.writeFileSync(fsmonitorScript, `#!/bin/sh\ntouch '${fsmonitorMarker}'\nexit 1\n`, {mode: 0o755});
        fs.writeFileSync(path.join(internal.canonicalPath, ".git", "info", "attributes"),
            "README.md filter=nomad-hostile\npackage.json diff=nomad-hostile-diff\n");
        await git(internal.canonicalPath, ["config", "filter.nomad-hostile.clean", filterScript]);
        await git(internal.canonicalPath, ["config", "filter.nomad-hostile.smudge", filterScript]);
        await git(internal.canonicalPath, ["config", "filter.nomad-hostile.required", "true"]);
        await git(internal.canonicalPath, ["config", "diff.nomad-hostile-diff.textconv", diffScript]);
        await git(internal.canonicalPath, ["config", "diff.external", diffScript]);
        await git(internal.canonicalPath, ["config", "core.fsmonitor", fsmonitorScript]);

        await commitAndPush(publisher, "REMOTE.txt", "REMOTE UPDATE\n", "remote update");
        const updated = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId,
            actionId: "pull"
        });
        assert.strictEqual(updated.ok, true);
        assert.strictEqual(updated.status, "UPDATE COMPLETE");
        assert.strictEqual(fs.readFileSync(path.join(internal.canonicalPath, "REMOTE.txt"), "utf8"), "REMOTE UPDATE\n");
        assert.strictEqual(fs.existsSync(hookMarker), false, "post-merge hooks must be disabled");
        assert.strictEqual(fs.existsSync(filterMarker), false, "clean and smudge filters must be disabled");
        assert.strictEqual(fs.existsSync(diffMarker), false, "external diff and textconv commands must not execute");
        assert.strictEqual(fs.existsSync(fsmonitorMarker), false, "fsmonitor commands must be disabled");
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual(internal.public.status, "CLEAN");
        assert.strictEqual(internal.public.upstream, "origin/main");
        assert.strictEqual(internal.public.ahead, 0);
        assert.strictEqual(internal.public.behind, 0);
        assert.strictEqual(runProfileService.inspect(internal).candidates[0].authorizationState, "APPROVED",
            "an unchanged run profile must remain approved after a same-identity fast-forward");

        const readmePath = path.join(internal.canonicalPath, "README.md");
        fs.writeFileSync(readmePath, "LOCAL MODIFICATION\n");
        const dirtyHead = (await git(internal.canonicalPath, ["rev-parse", "HEAD"])).trim();
        const dirtyListing = await actions.list();
        const dirtyPullAction = dirtyListing.repositories[0].actions.find(action => action.id === "pull");
        assert.deepStrictEqual(dirtyPullAction, {id: "pull", label: "PULL", enabled: false, state: "DIRTY"});
        const dirty = await gitService.pull(internal);
        assert.strictEqual(dirty.status, "LOCAL CHANGES DETECTED\nUPDATE ABORTED");
        assert.strictEqual(fs.readFileSync(readmePath, "utf8"), "LOCAL MODIFICATION\n");
        assert.strictEqual((await git(internal.canonicalPath, ["rev-parse", "HEAD"])).trim(), dirtyHead);
        assert.strictEqual(fs.existsSync(filterMarker), false);
        await git(internal.canonicalPath, ["restore", "--", "README.md"]);

        await git(internal.canonicalPath, ["checkout", "-q", "--detach"]);
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual((await gitService.pull(internal)).status, "DETACHED HEAD\nUPDATE ABORTED");
        await git(internal.canonicalPath, ["checkout", "-q", "main"]);

        await git(internal.canonicalPath, ["branch", "--unset-upstream"]);
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual((await gitService.pull(internal)).status, "NO UPSTREAM\nUPDATE ABORTED");
        const noUpstreamListing = await actions.list();
        assert.strictEqual(noUpstreamListing.repositories[0].actions.find(action => action.id === "pull").state, "NO UPSTREAM");
        await git(internal.canonicalPath, ["branch", "--set-upstream-to=origin/main", "main"]);

        const mergeHeadPath = path.join(internal.canonicalPath, ".git", "MERGE_HEAD");
        fs.writeFileSync(mergeHeadPath, await git(internal.canonicalPath, ["rev-parse", "HEAD"]));
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual((await gitService.pull(internal)).status,
            "REPOSITORY OPERATION IN PROGRESS\nUPDATE ABORTED");
        fs.unlinkSync(mergeHeadPath);

        const credentialMarker = path.join(temporaryRoot, "credential-helper-executed");
        const credentialScript = path.join(temporaryRoot, "credential-helper.sh");
        fs.writeFileSync(credentialScript, `#!/bin/sh\ntouch '${credentialMarker}'\n`, {mode: 0o755});
        await git(internal.canonicalPath, ["config", "credential.helper", `!${credentialScript}`]);
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual((await gitService.pull(internal)).status, "REMOTE CONFIGURATION UNSAFE\nUPDATE ABORTED");
        assert.strictEqual(fs.existsSync(credentialMarker), false);
        await git(internal.canonicalPath, ["config", "--unset-all", "credential.helper"]);
        await git(internal.canonicalPath, ["config", "url.https://evil.invalid/.insteadOf", "https://github.com/"]);
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual((await gitService.pull(internal)).status, "REMOTE CONFIGURATION UNSAFE\nUPDATE ABORTED");
        await git(internal.canonicalPath, ["config", "--unset-all", "url.https://evil.invalid/.insteadOf"]);
        await git(internal.canonicalPath, ["config", "--add", "remote.origin.url", "https://github.com/owner/ambiguous"]);
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual((await gitService.pull(internal)).status, "REMOTE IDENTITY AMBIGUOUS\nUPDATE ABORTED");
        await git(internal.canonicalPath, ["config", "--unset-all", "remote.origin.url"]);
        await git(internal.canonicalPath, ["config", "remote.origin.url", canonicalUrl]);

        await commitAndPush(publisher, "package.json", JSON.stringify({
            scripts: {dev: "node changed.js"}
        }, null, 2), "change run profile");
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual((await gitService.pull(internal)).status, "UPDATE COMPLETE");
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        let changedCandidate = runProfileService.inspect(internal).candidates[0];
        assert.strictEqual(changedCandidate.authorizationState, "CHANGED",
            "new commits must not bypass run-profile fingerprints");
        runProfileService.approve(internal, changedCandidate);
        await git(internal.canonicalPath, ["remote", "set-url", "origin", "https://github.com/other/cloned"]);
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual(runProfileService.inspect(internal).candidates[0].authorizationState, "CHANGED",
            "changing remote identity must invalidate run trust");
        await git(internal.canonicalPath, ["remote", "set-url", "origin", canonicalUrl]);

        await git(internal.canonicalPath, ["config", "user.name", "NOMAD Tests"]);
        await git(internal.canonicalPath, ["config", "user.email", "nomad@example.invalid"]);
        fs.writeFileSync(path.join(internal.canonicalPath, "LOCAL.txt"), "LOCAL COMMIT\n");
        await git(internal.canonicalPath, ["add", "LOCAL.txt"]);
        await git(internal.canonicalPath, ["commit", "-q", "-m", "local divergence"]);
        await commitAndPush(publisher, "DIVERGED.txt", "REMOTE DIVERGENCE\n", "remote divergence");
        [hookMarker, filterMarker, diffMarker, fsmonitorMarker].forEach(marker => fs.rmSync(marker, {force: true}));
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        const divergentHead = (await git(internal.canonicalPath, ["rev-parse", "HEAD"])).trim();
        const divergent = await gitService.pull(internal);
        assert.strictEqual(divergent.status, "UPDATE REQUIRES MANUAL RESOLUTION");
        assert.strictEqual((await git(internal.canonicalPath, ["rev-parse", "HEAD"])).trim(), divergentHead);
        assert.strictEqual(fs.readFileSync(path.join(internal.canonicalPath, "LOCAL.txt"), "utf8"), "LOCAL COMMIT\n");
        assert.strictEqual(fs.existsSync(path.join(internal.canonicalPath, "DIVERGED.txt")), false,
            "a divergent update must not merge, reset, or replace the worktree");
        internal = await repositoryService.resolveRepository(repositoryId, {refreshMetadata: true});
        assert.strictEqual(internal.public.ahead, 1);
        assert.strictEqual(internal.public.behind, 1);
        const info = await handleRepositoryRequest(actions, {
            operation: "action", repositoryId, actionId: "info"
        });
        assert.strictEqual(info.repository.branch, "main");
        assert.strictEqual(info.repository.remote, canonicalUrl);
        assert.strictEqual(info.repository.upstream, "origin/main");
        assert.strictEqual(info.repository.ahead, 1);
        assert.strictEqual(info.repository.behind, 1);
        assert.strictEqual(fs.existsSync(hookMarker), false);
        assert.strictEqual(fs.existsSync(filterMarker), false);
        assert.strictEqual(fs.existsSync(diffMarker), false);
        assert.strictEqual(fs.existsSync(fsmonitorMarker), false);

        const cancelRoot = path.join(temporaryRoot, "CancelRepositories");
        fs.mkdirSync(cancelRoot);
        const killedSignals = [];
        const spawnOptions = [];
        const hangingSpawn = (executable, args, options) => {
            spawnOptions.push({executable, args, options});
            const child = new EventEmitter();
            child.stderr = new PassThrough();
            child.kill = signal => {
                killedSignals.push(signal);
                process.nextTick(() => child.emit("close", null));
                return true;
            };
            return child;
        };
        const cancelRepositoryService = new RepositoryService({
            repositoryRoot: cancelRoot,
            spawn: hangingSpawn
        });
        const cancelGitService = new RepositoryGitService({
            repositoryService: cancelRepositoryService,
            cancelGraceMs: 10
        });
        const clonePromise = cancelGitService.clone("https://github.com/owner/cancelled");
        assert.strictEqual(cancelGitService.hasActiveClone(), true);
        const cancelResult = await cancelGitService.cancelClone();
        const cloneResult = await clonePromise;
        assert.strictEqual(cancelResult.status, "CLONE CANCELLED");
        assert.strictEqual(cloneResult.status, "CLONE CANCELLED");
        assert.deepStrictEqual(killedSignals, ["SIGTERM"]);
        assert.strictEqual(spawnOptions[0].options.shell, false);
        assert.strictEqual(fs.existsSync(path.join(cancelRoot, "cancelled")), false);

        const authRoot = path.join(temporaryRoot, "AuthRepositories");
        fs.mkdirSync(authRoot);
        const authenticationSpawn = () => {
            const child = new EventEmitter();
            child.stderr = new PassThrough();
            process.nextTick(() => {
                child.stderr.write("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n");
                child.stderr.end();
                child.emit("close", 128);
            });
            return child;
        };
        const authRepositoryService = new RepositoryService({repositoryRoot: authRoot, spawn: authenticationSpawn});
        const authGitService = new RepositoryGitService({repositoryService: authRepositoryService});
        const authentication = await authGitService.clone("https://github.com/owner/private-repository");
        assert.strictEqual(authentication.status,
            "AUTHENTICATION REQUIRED\nUSE EXISTING GIT CREDENTIAL CONFIGURATION");
        assert.strictEqual(fs.existsSync(path.join(authRoot, "private-repository")), false);

        const raceRoot = path.join(temporaryRoot, "RaceRepositories");
        const raceOutside = path.join(temporaryRoot, "race-outside");
        const movedReservation = path.join(temporaryRoot, "moved-reservation");
        fs.mkdirSync(raceRoot);
        fs.mkdirSync(raceOutside);
        const swappingSpawn = (executable, args, options) => {
            const destination = path.join(raceRoot, "raced");
            fs.renameSync(destination, movedReservation);
            fs.symlinkSync(raceOutside, destination, "dir");
            const child = new EventEmitter();
            child.stderr = new PassThrough();
            process.nextTick(() => child.emit("close", 0));
            return child;
        };
        const raceRepositoryService = new RepositoryService({repositoryRoot: raceRoot, spawn: swappingSpawn});
        const raceGitService = new RepositoryGitService({repositoryService: raceRepositoryService});
        const raced = await raceGitService.clone("https://github.com/owner/raced");
        assert.strictEqual(raced.status, "CLONE DESTINATION REFUSED");
        assert.deepStrictEqual(fs.readdirSync(raceOutside), [], "a destination swap must not make NOMAD write outside repositoryRoot");
        assert.strictEqual((await raceRepositoryService.refresh()).repositories.length, 0,
            "a raced destination must never become a trusted repository entry");
        assert(transport.calls.every(call => call.options.shell === false),
            "every repository Git subprocess must use shell:false");

        console.log("Secure GitHub clone, supervised cancellation, fast-forward update, hostile Git config, metadata, and run trust tests passed");
    } finally {
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
