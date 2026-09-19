const assert = require("assert");
const {ControlPlaneService, publicWindowResult, validateControlRequest} = require("../src/classes/controlPlaneService.js");

const repositoryId = `repo_${"a".repeat(32)}`;
const authorizationId = `auth_${"b".repeat(48)}`;
let now = 1000;
let profile = "NORMAL";
let enforcementApplyCalls = 0;
let repositoryExecuteCalls = [];
let installApplyCalls = 0;
let removedApplication = null;

const applications = [
    {id: "terminal", displayName: "TERMINAL", type: "internal", permanent: true, available: true},
    {id: "vlc", displayName: "VLC", type: "external", permanent: false, available: true}
];
const applicationRegistry = {
    get: id => applications.find(application => application.id === id) || null,
    getApplications: () => applications.map(application => ({...application})),
    reload: () => applications
};
const securityStatus = verbose => ({
    generatedAt: new Date(0).toISOString(),
    profile: {
        id: profile,
        source: "CONFIG",
        compliance: "NON_COMPLIANT",
        enforced: "NONE",
        enforcementState: "UNAPPLIED",
        systemEnforcementPending: profile !== "NORMAL",
        sessionRestartRequired: profile !== "NORMAL"
    },
    checks: [{
        id: "renderer_privilege", label: "RENDERER PRIVILEGE", state: "SECURE",
        actual: "ISOLATED", detail: "FIXED RUNTIME PROBE VERIFIED"
    }],
    policy: verbose ? [] : undefined,
    findings: verbose ? [] : undefined,
    capabilities: verbose ? {maximumLevel: "STRONG", preferredBackend: "BWRAP", backends: []} : undefined
});
const plan = target => ({
    targetProfile: target,
    selectedProfile: profile,
    safeToApply: target === "NORMAL",
    status: target === "NORMAL" ? "PLAN READY" : "AMBIGUOUS STORAGE OBSERVATION - APPLY REFUSED",
    privilegedPending: target !== "NORMAL",
    sessionRestartRequired: target !== "NORMAL",
    helper: {installed: false, trusted: false, available: false, status: "UNAVAILABLE"},
    storage: {
        state: "AMBIGUOUS", observation: "AMBIGUOUS", ambiguous: true,
        rootBacking: "INTERNAL", repositoryBacking: "INTERNAL",
        eligibleCount: 0, safeUnmountCandidates: 0,
        reason: "PORTABLE BOOT STORAGE BOUNDARY NOT VERIFIED"
    },
    categories: [{
        id: "host_storage", label: "HOST STORAGE", current: "AMBIGUOUS", desired: "VERIFIED",
        action: "REFUSE APPLY", privileged: true, available: false
    }]
});
const service = new ControlPlaneService({
    nowMilliseconds: () => now,
    randomBytes: size => Buffer.alloc(size, 7),
    challengeTtlMs: 100,
    securityService: {
        status: ({verbose}) => securityStatus(verbose),
        setProfile: target => {
            profile = target;
            return {profile: target, source: "CONFIG", compliance: "NON_COMPLIANT"};
        }
    },
    profileService: {get: () => ({profile})},
    enforcementService: {
        plan,
        verify: () => ({selectedProfile: profile, ambiguous: true, systemEnforcementPending: true}),
        apply: target => {
            enforcementApplyCalls++;
            return {ok: true, applied: true, status: `APPLIED ${target}`};
        },
        restore: options => options && options.apply
            ? {ok: true, applied: true, status: "RESTORED"}
            : {ok: true, applied: false, status: "PLAN_ONLY", targetProfile: "NORMAL", actions: ["SELECT NORMAL"]}
    },
    repositoryActions: {
        list: async () => ({repositories: [{id: repositoryId}]}),
        clone: async url => ({ok: true, status: "CLONED", url}),
        execute: async (id, actionId, geometry, request) => {
            repositoryExecuteCalls.push({id, actionId, geometry, request});
            if (actionId === "run" && !request.authorization) return {
                ok: true,
                status: "AUTHORIZATION REQUIRED",
                prompt: {
                    kind: "authorization",
                    repositoryName: "RHEX",
                    profileId: "cargo-run",
                    authorizationId,
                    fields: [
                        {label: "RUN PROFILE", value: "CARGO RUN"},
                        {label: "AUTHORIZATION", value: "REQUIRED"},
                        {label: "ISOLATION", value: "STRONG"}
                    ]
                }
            };
            if (actionId === "info") return {ok: true, repository: {id, displayName: "RHEX"}};
            return {ok: true, status: actionId.toUpperCase(), repository: {id, displayName: "RHEX"}};
        }
    },
    applicationRegistry,
    applicationPolicy: {
        projectAll: source => source.map(application => ({...application})),
        project: application => ({...application}),
        evaluate: () => ({allowed: true})
    },
    windowManager: {operate: async (operation, appId) => ({ok: true, status: "RUNNING", appId, state: "RUNNING"})},
    packageCatalog: [{
        id: "spotify", displayName: "SPOTIFY", aliases: [], desktopIds: ["spotify.desktop"],
        sources: [{source: "FLATPAK", package: "com.spotify.Client"}]
    }],
    installService: {
        detectSources: () => [{source: "FLATPAK", available: true}],
        plan: id => ({
            definitionId: id, displayName: "SPOTIFY", source: "FLATPAK", package: "com.spotify.Client",
            executable: "/usr/bin/flatpak", managerExecutable: "/usr/bin/flatpak",
            args: ["install", "flathub", "com.spotify.Client"], sourceDetail: "flathub", requiresAdministrator: false
        }),
        apply: async installPlan => { installApplyCalls++; assert.strictEqual(installPlan.definitionId, "spotify"); },
        registerInstalled: () => ({application: {id: "spotify", displayName: "SPOTIFY", type: "external", available: true}})
    },
    applicationService: {
        protectedIds: new Set(["terminal", "notes", "code", "browser"]),
        remove: id => { removedApplication = id; }
    },
    getGeometry: () => ({x: 10, y: 20, width: 900, height: 500})
});

async function run() {
    assert.strictEqual(publicWindowResult({ok: true, status: "CLOSED", appId: "vlc", state: "CLOSED"}).activateAppId, null,
        "closing an application must never reactivate it");
    const actionIds = service.actions().map(action => action.id);
    [
        "SECURITY_STATUS", "SECURITY_AUDIT", "SECURITY_PROFILE_SET", "SECURITY_PLAN", "SECURITY_VERIFY",
        "SECURITY_APPLY_POLICY", "SECURITY_RESTORE", "APPLICATION_LIST", "APPLICATION_INSTALL",
        "APPLICATION_OPEN", "APPLICATION_INFO", "REPOSITORY_RUN", "REPOSITORY_STOP", "REPOSITORY_CODE",
        "REPOSITORY_TERMINAL", "REPOSITORY_INFO", "REPOSITORY_GITHUB", "REPOSITORY_PULL", "REPOSITORY_CLONE",
        "SYSTEM_STATUS"
    ].forEach(id => assert(actionIds.includes(id), `missing trusted action ${id}`));
    assert(!actionIds.includes("SHELL_EXECUTE"));
    assert(!actionIds.includes("EXECUTE"));

    assert.strictEqual(validateControlRequest({actionId: "SECURITY_STATUS"}), true);
    assert.strictEqual(validateControlRequest({actionId: "SECURITY_STATUS", command: "id"}), false);
    assert.strictEqual((await service.request({actionId: "SHELL_EXECUTE", targetId: "id"})).status, "UNKNOWN TRUSTED ACTION");
    assert.strictEqual((await service.request({actionId: "SECURITY_STATUS", command: "id"})).status, "UNKNOWN TRUSTED ACTION");
    assert.strictEqual((await service.request({actionId: "REPOSITORY_RUN", targetId: "/tmp/repo"})).status, "NO REPOSITORY SELECTED");

    const status = await service.request({actionId: "SECURITY_STATUS"});
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.security.profile.compliance, "NON_COMPLIANT");
    assert.deepStrictEqual([
        status.storage.observation, status.storage.rootBacking, status.storage.repositoryBacking,
        status.storage.safeUnmountCandidates, status.storage.reason
    ], ["AMBIGUOUS", "INTERNAL", "INTERNAL", 0, "PORTABLE BOOT STORAGE BOUNDARY NOT VERIFIED"]);
    assert.strictEqual((await service.request({actionId: "SECURITY_AUDIT"})).kind, "audit");
    assert.strictEqual((await service.request({actionId: "SECURITY_VERIFY"})).verification.ambiguous, true);
    const applicationList = await service.request({actionId: "APPLICATION_LIST"});
    assert.strictEqual(applicationList.catalog.find(application => application.id === "spotify").available, true);
    assert.strictEqual((await service.request({actionId: "APPLICATION_REMOVE", targetId: "terminal"})).status,
        "BUILT-IN APPLICATION CANNOT BE REMOVED");

    const missing = await service.interpret("corre este repo");
    assert.strictEqual(missing.kind, "missing-context");
    assert.strictEqual(repositoryExecuteCalls.length, 0);
    assert.strictEqual(service.setContext({selectedRepositoryId: repositoryId}).ok, true);
    const contextBefore = {...service.context};
    assert.strictEqual(service.setContext({selectedRepositoryId: repositoryId, activeApplicationId: "../../spoof"}).ok, false);
    assert.deepStrictEqual(service.context, contextBefore, "invalid context updates must be atomic");

    const runPlan = await service.interpret("corre este repo");
    assert.strictEqual(runPlan.kind, "plan");
    assert.strictEqual(runPlan.confirmationRequired, true);
    assert.strictEqual(runPlan.plan.target, "RHEX");
    assert(runPlan.plan.fields.some(field => field.label === "ISOLATION" && field.value === "STRONG"));
    assert.strictEqual(repositoryExecuteCalls[0].id, repositoryId);
    assert.strictEqual(repositoryExecuteCalls[0].actionId, "run");
    const runResult = await service.confirm({challengeId: runPlan.challengeId});
    assert.strictEqual(runResult.ok, true);
    const authorizedRun = repositoryExecuteCalls[1];
    assert.deepStrictEqual(authorizedRun.request, {
        profileId: "cargo-run",
        authorizationId,
        authorization: "run-once"
    });
    assert.strictEqual((await service.confirm({challengeId: runPlan.challengeId})).status, "CONFIRMATION EXPIRED",
        "confirmation challenges must be single use");

    const pullPlan = await service.interpret("haz pull");
    assert.strictEqual(pullPlan.confirmationRequired, true);
    assert.strictEqual(repositoryExecuteCalls.filter(call => call.actionId === "pull").length, 0,
        "PULL must not execute before confirmation");
    await service.cancel({challengeId: pullPlan.challengeId});
    assert.strictEqual((await service.confirm({challengeId: pullPlan.challengeId})).status, "CONFIRMATION EXPIRED");

    const profilePlan = await service.interpret("pon modo público");
    assert.strictEqual(profilePlan.plan.target, "NORMAL -> PUBLIC");
    assert.strictEqual(profile, "NORMAL");
    assert.strictEqual(enforcementApplyCalls, 0);
    const profileResult = await service.confirm({challengeId: profilePlan.challengeId});
    assert.strictEqual(profileResult.profile.profile, "PUBLIC");
    assert.strictEqual(profile, "PUBLIC");
    assert.strictEqual(enforcementApplyCalls, 0, "profile selection must never apply privileged enforcement");

    const applyRefused = await service.request({actionId: "SECURITY_APPLY_POLICY", targetId: "PUBLIC"});
    assert.strictEqual(applyRefused.confirmationRequired, false);
    assert.strictEqual(applyRefused.plan.fields.find(field => field.label === "OBSERVATION").value, "AMBIGUOUS");
    assert.strictEqual(enforcementApplyCalls, 0);

    const installPlan = await service.interpret("instala spotify");
    assert.strictEqual(installPlan.confirmationRequired, true);
    assert.strictEqual(installApplyCalls, 0);
    await service.confirm({challengeId: installPlan.challengeId});
    assert.strictEqual(installApplyCalls, 1, "trusted catalog install executes only after main-owned confirmation");

    const expiredPlan = await service.request({actionId: "APPLICATION_REMOVE", targetId: "vlc"});
    assert.strictEqual(expiredPlan.confirmationRequired, true);
    now += 101;
    assert.strictEqual((await service.confirm({challengeId: expiredPlan.challengeId})).status, "CONFIRMATION EXPIRED");
    assert.strictEqual(removedApplication, null);

    const rejected = await service.interpret("ejecuta sudo rm -rf /tmp/x");
    assert.strictEqual(rejected.kind, "rejected");
    assert.strictEqual(rejected.status, "UNTRUSTED TERMINAL COMMAND");
    assert.strictEqual(enforcementApplyCalls, 0);

    console.log("Trusted control registry, opaque context, single-use plans, security separation, repository authorization, and catalog install gating passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
