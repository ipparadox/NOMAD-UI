const assert = require("assert");
const path = require("path");
const {
    RepositoryActionService,
    handleRepositoryRequest
} = require("../src/classes/repositoryService.js");

async function run() {
    const repository = {
        id: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        canonicalPath: "/trusted/repositories/project",
        repositoryIdentity: `sha256:${"1".repeat(64)}`,
        executionIdentity: `sha256:${"2".repeat(64)}`,
        public: {
            id: "repo_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            displayName: "PROJECT",
            relativePath: "project",
            branch: "main",
            dirty: false,
            status: "CLEAN",
            modifiedFileCount: 0,
            remoteAvailable: false,
            remoteProvider: "NONE",
            remote: "NONE",
            upstream: "NONE",
            ahead: 0,
            behind: 0
        }
    };
    const candidate = {
        profileId: "npm-start",
        displayName: "NPM START",
        commandLabel: "npm run start",
        executable: "npm",
        args: ["run", "start"],
        workingDirectory: ".",
        authorizationState: "APPROVED"
    };
    let security = {
        allowed: false,
        securityProfile: "PUBLIC",
        requiredLevel: "PARTIAL",
        availableLevel: "NONE",
        level: "NONE",
        backend: "DIRECT",
        reason: "ISOLATION REQUIREMENT NOT MET",
        status: "EXECUTION BLOCKED\nISOLATION REQUIREMENT NOT MET"
    };
    const starts = [];
    let processRecord = null;
    const processManager = {
        getExecutionSecurityStatus: () => Object.assign({}, security),
        start: (trustedRepository, profile) => {
            starts.push({trustedRepository, profile});
            processRecord = {
                repositoryId: trustedRepository.id,
                profileId: profile.profileId,
                displayName: profile.displayName,
                state: "RUNNING",
                startedAt: "2026-08-13T12:00:00.000Z",
                exitedAt: null,
                exitCode: null,
                signal: null,
                securityProfile: security.securityProfile,
                isolationLevel: security.level,
                isolationBackend: security.backend
            };
            return {ok: true, status: "RUNNING", duplicate: false, process: processRecord};
        },
        stop: async () => ({ok: true, status: "STOPPED"}),
        isActive: () => Boolean(processRecord && processRecord.state === "RUNNING"),
        matchesRepository: () => true,
        getStatus: () => processRecord,
        getRepositorySnapshot: () => repository.public,
        getActiveRepositorySnapshots: () => []
    };
    const repositoryService = {
        home: "/home/test",
        path,
        repositories: new Map([[repository.id, repository]]),
        resolveRepository: async () => repository,
        refresh: async () => ({repositories: [repository.public], status: null})
    };
    const runProfileService = {
        inspect: () => ({candidates: [Object.assign({}, candidate)], trustStoreStatus: null}),
        approve: () => { throw new Error("already approved"); }
    };
    const gitService = {
        isUpdating: () => false,
        inspectUpdate: async () => ({ok: false, state: "UNAVAILABLE"}),
        clone: async () => ({ok: false, status: "UNAVAILABLE"}),
        cancelClone: () => ({ok: false, status: "UNAVAILABLE"}),
        pull: async () => ({ok: false, status: "UNAVAILABLE"})
    };
    const actions = new RepositoryActionService({
        repositoryService,
        runProfileService,
        processManager,
        gitService
    });

    const publicBlocked = await handleRepositoryRequest(actions, {
        operation: "action",
        repositoryId: repository.id,
        actionId: "run"
    });
    assert.deepStrictEqual(publicBlocked, {
        ok: false,
        status: "EXECUTION BLOCKED\nISOLATION REQUIREMENT NOT MET"
    });
    assert.strictEqual(starts.length, 0, "approved profiles must not bypass PUBLIC isolation policy");

    for (const injected of [
        {isolationBackend: "DIRECT"},
        {sandboxArgs: ["--bind", "/", "/"]},
        {securityProfile: "NORMAL"},
        {executable: "/tmp/renderer-controlled"}
    ]) {
        const rejected = await handleRepositoryRequest(actions, Object.assign({
            operation: "action", repositoryId: repository.id, actionId: "run"
        }, injected));
        assert.deepStrictEqual(rejected, {ok: false, status: "INVALID REQUEST"});
    }

    security = {
        allowed: true,
        securityProfile: "NORMAL",
        requiredLevel: "NONE",
        availableLevel: "NONE",
        level: "NONE",
        backend: "DIRECT",
        reason: "SUPERVISED DIRECT EXECUTION; NO FILESYSTEM SANDBOX",
        status: "EXECUTION PERMITTED"
    };
    const normal = await handleRepositoryRequest(actions, {
        operation: "action", repositoryId: repository.id, actionId: "run"
    });
    assert.strictEqual(normal.ok, true);
    assert.strictEqual(normal.status, "RUNNING");
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(normal.repository.executionSecurity.securityProfile, "NORMAL");
    assert.strictEqual(normal.repository.executionSecurity.level, "NONE");
    assert.strictEqual(normal.repository.executionSecurity.authorization, "TRUSTED");

    processRecord = null;
    security = {
        allowed: false,
        securityProfile: "LOCKDOWN",
        requiredLevel: "STRONG",
        availableLevel: "STRONG",
        level: "STRONG",
        backend: "BUBBLEWRAP",
        reason: "LOCKDOWN POLICY DISABLES REPOSITORY EXECUTION",
        status: "EXECUTION BLOCKED\nLOCKDOWN POLICY DISABLES REPOSITORY EXECUTION"
    };
    const lockdownBlocked = await handleRepositoryRequest(actions, {
        operation: "action", repositoryId: repository.id, actionId: "run"
    });
    assert.deepStrictEqual(lockdownBlocked, {
        ok: false,
        status: "EXECUTION BLOCKED\nLOCKDOWN POLICY DISABLES REPOSITORY EXECUTION"
    });
    assert.strictEqual(starts.length, 1);

    console.log("Repository authorization remains orthogonal to PUBLIC/LOCKDOWN isolation and renderer requests cannot select sandbox controls passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
