const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {execFile} = require("child_process");
const {
    RepositoryActionService,
    RepositoryService,
    handleRepositoryRequest,
    normalizeGithubRemote,
    terminalCommand
} = require("../src/classes/repositoryService.js");

function runFile(executable, args) {
    return new Promise((resolve, reject) => {
        execFile(executable, args, {encoding: "utf8", shell: false}, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

function git(repositoryPath, args) {
    return runFile("git", ["-C", repositoryPath].concat(args));
}

async function initializeRepository(repositoryPath, branch = "feat/v0.5-test") {
    fs.mkdirSync(repositoryPath, {recursive: true});
    await runFile("git", ["init", "-q", "-b", branch, repositoryPath]);
    await git(repositoryPath, ["config", "user.name", "NOMAD Tests"]);
    await git(repositoryPath, ["config", "user.email", "nomad@example.invalid"]);
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "NOMAD\n");
    await git(repositoryPath, ["add", "README.md"]);
    await git(repositoryPath, ["commit", "-q", "-m", "initial"]);
}

async function run() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-repository-service-"));
    try {
        const repositoryRoot = path.join(temporaryRoot, "Repositories");
        const outsideRoot = path.join(temporaryRoot, "outside");
        const safeRepository = path.join(repositoryRoot, "NOMAD-UI");
        const hostileRepository = path.join(repositoryRoot, "repo'; touch INJECTED; '");
        const outsideRepository = path.join(outsideRoot, "escape");
        fs.mkdirSync(repositoryRoot, {recursive: true});
        await initializeRepository(safeRepository);
        await initializeRepository(hostileRepository, "safe-branch");
        await initializeRepository(outsideRepository, "outside-branch");
        fs.symlinkSync(outsideRepository, path.join(repositoryRoot, "symlink-escape"), "dir");

        await git(safeRepository, ["remote", "add", "origin", "git@github.com:nomad-lab/NOMAD-UI.git"]);
        const service = new RepositoryService({repositoryRoot});
        const listing = await service.refresh();
        assert.strictEqual(listing.status, null);
        assert.deepStrictEqual(listing.repositories.map(repository => repository.displayName), ["NOMAD-UI", "repo'; touch INJECTED; '"]);
        assert(!listing.repositories.some(repository => repository.displayName === "symlink-escape"), "symlink escapes must not be discovered");

        const repository = listing.repositories.find(item => item.displayName === "NOMAD-UI");
        assert(/^repo_[a-f0-9]{32}$/.test(repository.id));
        assert.strictEqual(repository.relativePath, "NOMAD-UI");
        assert.strictEqual(repository.branch, "feat/v0.5-test");
        assert.strictEqual(repository.status, "CLEAN");
        assert.strictEqual(repository.dirty, false);
        assert.strictEqual(repository.modifiedFileCount, 0);
        assert.strictEqual(repository.remoteAvailable, true);
        assert.strictEqual(repository.remoteProvider, "GITHUB");
        assert.strictEqual(repository.githubUrl, "https://github.com/nomad-lab/NOMAD-UI");
        assert(!Object.prototype.hasOwnProperty.call(repository, "path"));
        assert(!JSON.stringify(repository).includes(temporaryRoot), "public metadata must not expose an absolute path");

        const filterMarker = path.join(outsideRoot, "filter-executed");
        const fsmonitorMarker = path.join(outsideRoot, "fsmonitor-executed");
        const filterScript = path.join(outsideRoot, "hostile-filter.sh");
        const fsmonitorScript = path.join(outsideRoot, "hostile-fsmonitor.sh");
        fs.writeFileSync(filterScript, `#!/bin/sh\ntouch '${filterMarker}'\ncat\n`, {mode: 0o755});
        fs.writeFileSync(fsmonitorScript, `#!/bin/sh\ntouch '${fsmonitorMarker}'\nexit 1\n`, {mode: 0o755});
        fs.writeFileSync(path.join(safeRepository, ".git", "info", "attributes"), "README.md filter=nomad-hostile\n");
        await git(safeRepository, ["config", "filter.nomad-hostile.clean", filterScript]);
        await git(safeRepository, ["config", "filter.nomad-hostile.required", "true"]);
        await git(safeRepository, ["config", "core.fsmonitor", fsmonitorScript]);
        fs.writeFileSync(path.join(safeRepository, "README.md"), "ALTER\n");
        const dirtyListing = await service.refresh();
        const dirtyRepository = dirtyListing.repositories.find(item => item.id === repository.id);
        assert.strictEqual(dirtyRepository.status, "MODIFIED");
        assert.strictEqual(dirtyRepository.dirty, true);
        assert.strictEqual(dirtyRepository.modifiedFileCount, 1);
        assert.strictEqual(fs.existsSync(filterMarker), false, "metadata must not execute repository-configured clean filters");
        assert.strictEqual(fs.existsSync(fsmonitorMarker), false, "metadata must not execute repository-configured fsmonitor hooks");

        const resolved = await service.resolveRepository(repository.id);
        assert.strictEqual(resolved.canonicalPath, fs.realpathSync(safeRepository));
        await assert.rejects(() => service.resolveRepository("../NOMAD-UI"), error => error.status === "REPOSITORY NOT FOUND");
        await assert.rejects(() => service.resolveRepository(safeRepository), error => error.status === "REPOSITORY NOT FOUND");
        await assert.rejects(() => service.resolveRepository("repo_ffffffffffffffffffffffffffffffff"), error => error.status === "REPOSITORY NOT FOUND");

        const hostilePublic = dirtyListing.repositories.find(item => item.displayName.startsWith("repo'"));
        const hostileResolved = await service.resolveRepository(hostilePublic.id);
        const command = terminalCommand(hostileResolved.canonicalPath, "/bin/bash");
        assert.strictEqual(command, `cd -- '${hostileResolved.canonicalPath.replace(/'/g, `'\\''`)}'`);
        assert(!command.includes("\n"));

        assert.strictEqual(normalizeGithubRemote("https://github.com/owner/repo.git"), "https://github.com/owner/repo");
        assert.strictEqual(normalizeGithubRemote("git@github.com:owner/repo.git"), "https://github.com/owner/repo");
        assert.strictEqual(normalizeGithubRemote("https://github.com/owner/repo"), "https://github.com/owner/repo");
        [
            "http://github.com/owner/repo.git",
            "https://github.com.evil.example/owner/repo.git",
            "https://user@github.com/owner/repo.git",
            "https://github.com/owner/repo/extra",
            "git@evil.example:owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
            "$(touch /tmp/owned)",
            "https://github.com/owner/repo.git?x=1"
        ].forEach(remote => assert.strictEqual(normalizeGithubRemote(remote), null, remote));

        const terminalWrites = [];
        const codeCalls = [];
        const browserCalls = [];
        const actions = new RepositoryActionService({
            repositoryService: service,
            shell: "/bin/bash",
            writeTerminal: commandValue => terminalWrites.push(commandValue),
            openCode: (repositoryPath, geometry) => {
                codeCalls.push({repositoryPath, geometry});
                return {ok: true, appId: "code", status: "RUNNING", running: true};
            },
            openBrowser: (githubUrl, geometry) => {
                browserCalls.push({githubUrl, geometry});
                return {ok: true, appId: "browser", status: "RUNNING", running: true};
            }
        });
        const actionListing = await actions.list();
        const listedRepository = actionListing.repositories.find(item => item.id === repository.id);
        assert.deepStrictEqual(listedRepository.actions.map(action => [action.id, action.enabled]), [
            ["code", true], ["terminal", true], ["info", true], ["github", true]
        ]);
        assert(!Object.prototype.hasOwnProperty.call(listedRepository, "githubUrl"));
        assert(!JSON.stringify(actionListing).includes(temporaryRoot));

        const geometry = {x: 10, y: 20, width: 800, height: 600};
        const terminalResult = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: hostilePublic.id,
            actionId: "terminal"
        });
        assert.strictEqual(terminalResult.activateAppId, "terminal");
        assert.strictEqual(terminalWrites.length, 1);
        assert(terminalWrites[0].startsWith("cd -- '"));

        const codeResult = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "code",
            geometry
        });
        assert.strictEqual(codeResult.activateAppId, "code");
        assert.deepStrictEqual(codeCalls, [{repositoryPath: fs.realpathSync(safeRepository), geometry}]);

        const githubResult = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "github",
            geometry
        });
        assert.strictEqual(githubResult.activateAppId, "browser");
        assert.deepStrictEqual(browserCalls, [{githubUrl: "https://github.com/nomad-lab/NOMAD-UI", geometry}]);

        const infoResult = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "info"
        });
        assert.strictEqual(infoResult.actionId, "info");
        assert.strictEqual(infoResult.repository.status, "MODIFIED");
        assert(!JSON.stringify(infoResult).includes(temporaryRoot));

        const injectionRequest = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "code",
            geometry,
            path: "/tmp/renderer-controlled"
        });
        assert.strictEqual(injectionRequest.status, "INVALID REQUEST");
        assert.strictEqual(codeCalls.length, 1, "renderer paths must never reach CODE");
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: safeRepository,
            actionId: "terminal"
        })).status, "INVALID REQUEST");
        assert.strictEqual((await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: "../NOMAD-UI",
            actionId: "terminal"
        })).status, "INVALID REQUEST");

        await git(safeRepository, ["remote", "set-url", "origin", "https://example.com/owner/repo.git"]);
        const nonGithubListing = await actions.list();
        const nonGithubRepository = nonGithubListing.repositories.find(item => item.id === repository.id);
        assert.strictEqual(nonGithubRepository.remoteProvider, "OTHER");
        assert.strictEqual(nonGithubRepository.actions.find(action => action.id === "github").enabled, false);
        const githubUnavailable = await handleRepositoryRequest(actions, {
            operation: "action",
            repositoryId: repository.id,
            actionId: "github",
            geometry
        });
        assert.strictEqual(githubUnavailable.status, "ACTION UNAVAILABLE");
        assert.strictEqual(browserCalls.length, 1);

        const symlinkSwap = path.join(outsideRoot, "moved-safe");
        fs.renameSync(safeRepository, symlinkSwap);
        fs.symlinkSync(symlinkSwap, safeRepository, "dir");
        await assert.rejects(() => service.resolveRepository(repository.id), error => error.status === "REPOSITORY NOT FOUND");
        assert.strictEqual(service.repositories.has(repository.id), false, "disappeared/escaped repositories must be removed from the trusted model");

        console.log("Repository service trust boundary, metadata, actions, and GitHub normalization passed");
    } finally {
        fs.rmSync(temporaryRoot, {recursive: true, force: true});
    }
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
