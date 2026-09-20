"use strict";

const crypto = require("crypto");
const {publicApplication} = require("./managedApplications.js");
const {sanitizeSecurityStatus} = require("./securityService.js");
const {DeterministicIntentParser, validateStructuredProposal} = require("./intentParser.js");
const {TrustedActionRegistry} = require("./trustedActionRegistry.js");

const REPOSITORY_ID_PATTERN = /^repo_[a-f0-9]{32}$/;
const APPLICATION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROFILE_SET = new Set(["NORMAL", "PUBLIC", "LOCKDOWN"]);
const CHALLENGE_ID_PATTERN = /^challenge_[a-f0-9]{48}$/;
const MAX_CHALLENGES = 128;

function cleanText(value, fallback = "UNKNOWN", maximum = 160) {
    const normalized = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
    return (normalized || fallback).slice(0, maximum).toUpperCase();
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function publicWindowResult(result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return {ok: false, status: "APPLICATION ACTION FAILED"};
    return {
        ok: result.ok === true,
        status: cleanText(result.status, "APPLICATION ACTION FAILED"),
        appId: APPLICATION_ID_PATTERN.test(result.appId || "") ? result.appId : null,
        activateAppId: result.ok === true && result.state !== "CLOSED" && APPLICATION_ID_PATTERN.test(result.appId || "")
            ? result.appId : null,
        application: result.ok === true && APPLICATION_ID_PATTERN.test(result.appId || "") ? {
            id: result.appId,
            state: ["RUNNING", "ACTIVE", "HIDDEN", "CLOSED"].includes(result.state) ? result.state : "RUNNING",
            running: result.running !== false,
            minimized: result.minimized === true,
            fullscreen: result.fullscreen === true,
            status: cleanText(result.status, "RUNNING")
        } : null
    };
}

class ControlPlaneService {
    constructor(opts = {}) {
        this.securityService = opts.securityService;
        this.profileService = opts.profileService;
        this.enforcementService = opts.enforcementService;
        this.repositoryActions = opts.repositoryActions;
        this.applicationRegistry = opts.applicationRegistry;
        this.applicationPolicy = opts.applicationPolicy;
        this.windowManager = opts.windowManager;
        this.automation = opts.automation || null;
        this.applicationAutomation = opts.applicationAutomation || null;
        this.onProgress = opts.onProgress || (() => {});
        this.installService = opts.installService || null;
        this.applicationService = opts.applicationService || null;
        this.packageCatalog = Array.isArray(opts.packageCatalog) ? opts.packageCatalog.slice() : [];
        this.intentParser = opts.intentParser || new DeterministicIntentParser();
        this.intentProviders = Array.isArray(opts.intentProviders) ? opts.intentProviders.slice() : [];
        this.nowMilliseconds = opts.nowMilliseconds || Date.now;
        this.randomBytes = opts.randomBytes || crypto.randomBytes;
        this.challengeTtlMs = Number.isSafeInteger(opts.challengeTtlMs) ? opts.challengeTtlMs : 2 * 60 * 1000;
        this.getGeometry = typeof opts.getGeometry === "function" ? opts.getGeometry : (() => ({x: 0, y: 0, width: 960, height: 540}));
        this.onApplicationsChanged = typeof opts.onApplicationsChanged === "function" ? opts.onApplicationsChanged : (() => {});
        this.context = {selectedRepositoryId: null, activeApplicationId: "terminal", currentWorkspace: "terminal"};
        this.challenges = new Map();
        this.registry = opts.registry || new TrustedActionRegistry();
        if (!opts.registry) this._registerActions();
    }

    actions() {
        return this.registry.list();
    }

    setContext(request) {
        if (!request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).some(key => !["selectedRepositoryId", "activeApplicationId", "currentWorkspace"].includes(key))) {
            return {ok: false, status: "INVALID CONTEXT"};
        }
        if (["activeApplicationId", "currentWorkspace"].some(key => Object.prototype.hasOwnProperty.call(request, key)
            && !APPLICATION_ID_PATTERN.test(request[key] || ""))) return {ok: false, status: "INVALID CONTEXT"};
        if (Object.prototype.hasOwnProperty.call(request, "selectedRepositoryId")) {
            if (request.selectedRepositoryId !== null && !REPOSITORY_ID_PATTERN.test(request.selectedRepositoryId || "")) {
                return {ok: false, status: "INVALID CONTEXT"};
            }
            this.context.selectedRepositoryId = request.selectedRepositoryId;
        }
        ["activeApplicationId", "currentWorkspace"].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(request, key) && APPLICATION_ID_PATTERN.test(request[key] || "")) {
                this.context[key] = request[key];
            }
        });
        return {ok: true, status: "CONTEXT UPDATED"};
    }

    async request(request) {
        if (!request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).some(key => !["actionId", "targetId"].includes(key))
            || typeof request.actionId !== "string" || !this.registry.has(request.actionId)
            || (typeof request.targetId !== "undefined" && typeof request.targetId !== "string")) {
            return {ok: false, status: "UNKNOWN TRUSTED ACTION"};
        }
        return this._dispatch(request.actionId, request.targetId, "CONTROL");
    }

    async interpret(input) {
        const parsed = this.intentParser.parse(input);
        if (parsed.kind === "REJECTED") return {
            ok: false,
            kind: "rejected",
            status: "UNTRUSTED TERMINAL COMMAND",
            detail: "THIS REQUEST IS OUTSIDE THE NOMAD TRUSTED ACTION REGISTRY",
            terminalAvailable: true
        };
        if (parsed.kind === "INVALID") return {ok: false, kind: "invalid", status: parsed.status};
        if (parsed.kind === "ACTION") {
            let targetId = parsed.targetId;
            if (parsed.contextualTarget === "SELECTED_REPOSITORY") targetId = this.context.selectedRepositoryId;
            if (parsed.contextualTarget === "SELECTED_REPOSITORY" && !targetId) return {
                ok: false,
                kind: "missing-context",
                status: "NO REPOSITORY SELECTED",
                detail: "SELECT A REPOSITORY FIRST"
            };
            return this._dispatch(parsed.actionId, targetId, "ASSISTANT");
        }

        for (const provider of this.intentProviders) {
            if (!provider || typeof provider.propose !== "function") continue;
            let proposal = null;
            try { proposal = validateStructuredProposal(await provider.propose(input, clone(this.context)), this.registry); } catch (error) {}
            if (proposal) return this._dispatch(proposal.actionId, proposal.targetId, "PROVIDER");
        }
        return {ok: false, kind: "unknown", status: parsed.status || "UNKNOWN NOMAD INTENT", detail: "NO TRUSTED ACTION MATCHED"};
    }

    async confirm(request) {
        if (!request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).length !== 1 || !CHALLENGE_ID_PATTERN.test(request.challengeId || "")) {
            return {ok: false, status: "CONFIRMATION INVALID"};
        }
        this._pruneChallenges();
        const challenge = this.challenges.get(request.challengeId);
        this.challenges.delete(request.challengeId);
        if (!challenge || challenge.expiresAt <= this.nowMilliseconds()) return {ok: false, status: "CONFIRMATION EXPIRED"};
        if (challenge.securityProfile !== this._selectedProfile()) return {ok: false, status: "PROFILE CHANGED / REAUTHORIZE"};
        return this.registry.execute(challenge.actionId, {
            phase: "EXECUTE",
            targetId: challenge.targetId,
            stored: challenge.stored,
            context: clone(this.context)
        }).catch(() => ({ok: false, status: "TRUSTED ACTION REFUSED"}));
    }

    cancel(request) {
        if (!request || typeof request !== "object" || Array.isArray(request)
            || Object.keys(request).length !== 1 || !CHALLENGE_ID_PATTERN.test(request.challengeId || "")) {
            return {ok: false, status: "CONFIRMATION INVALID"};
        }
        const removed = this.challenges.delete(request.challengeId);
        return {ok: removed, status: removed ? "CANCELLED" : "CONFIRMATION EXPIRED"};
    }

    async _dispatch(actionId, targetId, source) {
        const definition = this.registry.describe(actionId);
        if (!definition || !this._targetValid(definition.targetKind, targetId, actionId)) {
            return {ok: false, status: definition && definition.targetKind === "REPOSITORY"
                ? "NO REPOSITORY SELECTED" : "TRUSTED ACTION TARGET INVALID"};
        }
        const context = {phase: "REQUEST", targetId, source, context: clone(this.context)};
        const result = await this.registry.execute(actionId, context).catch(() => ({ok: false, status: "TRUSTED ACTION REFUSED"}));
        if (!result || typeof result !== "object") return {ok: false, status: "TRUSTED ACTION FAILED"};
        if (result.confirmation) return this._challenge(actionId, targetId, definition, result.confirmation, result.stored);
        return result;
    }

    _challenge(actionId, targetId, definition, plan, stored) {
        if (!plan || plan.allowed === false) return {
            ok: false,
            kind: "plan",
            status: cleanText(plan && plan.status, "ACTION REFUSED"),
            plan: this._publicPlan(actionId, targetId, definition, plan),
            confirmationRequired: false
        };
        this._pruneChallenges();
        const challengeId = `challenge_${this.randomBytes(24).toString("hex")}`;
        this.challenges.set(challengeId, {
            actionId,
            targetId,
            stored: stored ? clone(stored) : null,
            securityProfile: this._selectedProfile(),
            expiresAt: this.nowMilliseconds() + this.challengeTtlMs
        });
        while (this.challenges.size > MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value);
        return {
            ok: true,
            kind: "plan",
            status: "CONFIRMATION REQUIRED",
            confirmationRequired: true,
            challengeId,
            expiresInMs: this.challengeTtlMs,
            plan: this._publicPlan(actionId, targetId, definition, plan)
        };
    }

    _publicPlan(actionId, targetId, definition, plan) {
        return {
            request: cleanText(plan.request, definition.label, 64),
            action: actionId,
            target: cleanText(plan.target, targetId || "NOMAD", 128),
            securityProfile: PROFILE_SET.has(plan.securityProfile) ? plan.securityProfile : this._selectedProfile(),
            privilege: cleanText(plan.privilege, definition.privilege, 64),
            effects: (Array.isArray(plan.effects) ? plan.effects : definition.effects)
                .filter(value => typeof value === "string").slice(0, 12).map(value => cleanText(value, "EFFECT", 160)),
            fields: (Array.isArray(plan.fields) ? plan.fields : []).slice(0, 16).map(field => ({
                label: cleanText(field && field.label, "FIELD", 32),
                value: cleanText(field && field.value, "UNKNOWN", 160)
            }))
        };
    }

    _registerActions() {
        const register = (id, label, risk, targetKind, privilege, effects, handler) => this.registry.register({
            id, label, risk, targetKind, privilege, effects, handler
        });
        register("SECURITY_STATUS", "SECURITY STATUS", "READ_ONLY", "NONE", "NONE", ["READ VERIFIED SECURITY OBSERVATIONS"],
            () => this._securityStatus(false));
        register("SECURITY_AUDIT", "SECURITY AUDIT", "READ_ONLY", "NONE", "NONE", ["READ VERIFIED FINDINGS"],
            () => this._securityStatus(true));
        register("SECURITY_PROFILE_SET", "SELECT SECURITY PROFILE", "PERSISTENT", "PROFILE", "USER", ["CHANGE USER-LEVEL POLICY GATES", "DO NOT APPLY PRIVILEGED ENFORCEMENT"],
            context => this._securityProfile(context));
        register("SECURITY_PLAN", "REVIEW SECURITY POLICY", "READ_ONLY", "PROFILE", "NONE", ["READ TRUSTED ENFORCEMENT PLAN"],
            context => this._securityPlan(context.targetId));
        register("SECURITY_VERIFY", "VERIFY SECURITY", "READ_ONLY", "NONE", "NONE", ["VERIFY USER-LEVEL AND OBSERVABLE SYSTEM STATE"],
            () => ({ok: true, kind: "verification", status: "VERIFICATION COMPLETE", verification: this.enforcementService.verify()}));
        register("SECURITY_APPLY_POLICY", "APPLY SECURITY POLICY", "SYSTEM", "PROFILE", "SYSTEM", ["APPLY RECOVERABLE TRANSACTION", "VERIFY RESULT"],
            context => this._securityApply(context));
        register("SECURITY_RESTORE", "RESTORE NOMAD POLICY", "SYSTEM", "NONE", "SYSTEM", ["RESTORE ONLY NOMAD-OWNED CHANGES", "VERIFY RESULT"],
            context => this._securityRestore(context));

        register("APPLICATION_LIST", "APPLICATIONS", "READ_ONLY", "NONE", "NONE", ["READ TRUSTED REGISTRY AND CATALOG"],
            () => this._applicationList());
        register("APPLICATION_INFO", "APPLICATION INFO", "READ_ONLY", "APPLICATION", "NONE", ["READ TRUSTED APPLICATION METADATA"],
            context => this._applicationInfo(context.targetId));
        register("APPLICATION_OPEN", "OPEN APPLICATION", "LOW", "APPLICATION", "NONE", ["OPEN REGISTERED APPLICATION"],
            context => this._applicationOpen(context.targetId));
        register("APPLICATION_CLOSE", "CLOSE APPLICATION", "LOW", "APPLICATION", "NONE", ["CLOSE NOMAD-MANAGED APPLICATION"],
            context => this._applicationClose(context.targetId));
        register("APPLICATION_INSTALL", "INSTALL APPLICATION", "PERSISTENT", "APPLICATION", "SYSTEM", ["USE TRUSTED PACKAGE CATALOG", "RUN FIXED PACKAGE-MANAGER ARGUMENTS"],
            context => this._applicationInstall(context));
        register("APPLICATION_REMOVE", "REMOVE APPLICATION", "PERSISTENT", "APPLICATION", "USER", ["REMOVE USER REGISTRY ENTRY ONLY", "DO NOT UNINSTALL SYSTEM PACKAGE"],
            context => this._applicationRemove(context));

        register("PROJECT_LIST", "PROJECTS", "READ_ONLY", "NONE", "NONE", ["READ PROJECT PROJECTION"],
            () => this.automation ? this.automation.list() : {ok: false, status: "AUTOMATION UNAVAILABLE"});
        register("PROJECT_INSPECT", "INSPECT PROJECT", "READ_ONLY", "REPOSITORY", "NONE", ["PARSE PROJECT METADATA ONLY"],
            c => this.automation ? this.automation.inspect(c.targetId) : {ok: false, status: "AUTOMATION UNAVAILABLE"});
        ["PROJECT_REPAIR", "PROJECT_PREPARE", "PROJECT_SETUP", "PROJECT_SETUP_WITH_HOOKS"].forEach(id => register(id, "PREPARE PROJECT", "PERSISTENT", "REPOSITORY", "NONE", ["AUTHORIZED ISOLATED DEPENDENCY SETUP"],
            c => this.automation ? c.phase === "EXECUTE" ? this.automation.authorize(c.stored.automationPlan) : this.automation.plan(c.targetId, id === "PROJECT_SETUP_WITH_HOOKS") : {ok: false, status: "AUTOMATION UNAVAILABLE"}));
        register("PROJECT_REPAIR_AND_RUN", "REPAIR & RUN", "PERSISTENT", "REPOSITORY", "NONE", ["AUTHORIZED SETUP AND ONE PROJECT LAUNCH"], async c => {
            const actions = this.repositoryActions;
            if (!this.automation || !actions || !actions.doctor) return {ok: false, status: "LAUNCH DOCTOR UNAVAILABLE"};
            if (c.phase === "EXECUTE") {
                const result = await this.automation.authorize(c.stored.automationPlan);
                if (!result.operation || result.operation.state !== "RUNNING") return result;
                const operation = this.automation.operations.get(result.operation.id);
                operation.afterSuccess = async () => {
                    const repository = await actions.repositoryService.resolveRepository(c.targetId);
                    const candidate = actions.runProfileService.inspect(repository).candidates.find(p => p.profileId === c.stored.runProfileId);
                    if (!candidate || candidate.profileFingerprint !== c.stored.runFingerprint || this._selectedProfile() !== c.stored.runSecurityProfile) return {ok: false, status: "PROJECT OR PROFILE CHANGED / RUN AUTHORIZATION REQUIRED"};
                    const policy = actions._executionSecurity();
                    if (!policy.allowed) return {ok: false, status: policy.status};
                    return actions._launch(repository, candidate);
                };
                return result;
            }
            const repository = await actions.repositoryService.resolveRepository(c.targetId);
            const inspection = actions.runProfileService.inspect(repository);
            const selection = actions._runSelection(repository, inspection);
            const candidate = inspection.candidates.find(p => p.profileId === selection.profileId) || (inspection.candidates.length === 1 ? inspection.candidates[0] : null);
            if (!candidate) return {ok: false, status: "RUN PROFILE SELECTION REQUIRED"};
            const diagnosis = await actions.doctor.preflight(repository, candidate, this.automation);
            if (diagnosis.findings.some(f => f.repairClass === "C")) return {ok: false, status: diagnosis.status};
            const plan = await this.automation.plan(c.targetId);
            if (!plan.confirmation) return plan;
            plan.confirmation.request = "REPAIR & RUN";
            plan.confirmation.effects.push("EXECUTE SELECTED REPOSITORY RUN PROFILE ONCE AFTER VERIFIED SETUP");
            plan.confirmation.fields.push({label: "RUN PROFILE", value: candidate.displayName});
            plan.stored.runProfileId = candidate.profileId;
            plan.stored.runFingerprint = candidate.profileFingerprint;
            plan.stored.runSecurityProfile = this._selectedProfile();
            return plan;
        });
        register("PROJECT_DIAGNOSE", "DIAGNOSE PROJECT", "READ_ONLY", "REPOSITORY", "NONE", ["READ PROJECT STATE"], async c => {
            const actions = this.repositoryActions;
            if (!actions || !actions.doctor) return {ok: false, status: "LAUNCH DOCTOR UNAVAILABLE"};
            const repository = await actions.repositoryService.resolveRepository(c.targetId);
            const inspection = actions.runProfileService.inspect(repository);
            const selection = actions._runSelection(repository, inspection);
            const candidate = inspection.candidates.find(p => p.profileId === selection.profileId) || (inspection.candidates.length === 1 ? inspection.candidates[0] : null);
            const result = await actions.doctor.preflight(repository, candidate, this.automation);
            return {ok: result.ok, kind: "diagnosis", status: result.status, diagnosis: {...result, profile: undefined}, repositoryId: c.targetId};
        });
        register("PROJECT_RUN", "RUN PROJECT", "LOW", "REPOSITORY", "NONE", ["PRESERVE RUN AUTHORIZATION"], c => this._repositoryRun(c));
        register("PROJECT_STOP", "STOP PROJECT", "LOW", "REPOSITORY", "NONE", ["STOP TRACKED PROJECT ONLY"], async c => {
            const active = this.automation && this.automation.active(c.targetId);
            return active ? this.automation.cancel(active.id) : this._repositoryAction(c.targetId, "stop");
        });
        register("PROJECT_PULL_RUN", "PULL THEN RUN PROJECT", "PERSISTENT", "REPOSITORY", "NONE", ["PULL", "REINSPECT", "REQUEST RUN AUTHORIZATION"], async c => {
            if (c.phase !== "EXECUTE") {
                const plan = await this._repositoryPersistent(c, "pull");
                if (plan.confirmation) {
                    plan.confirmation.request = "PULL THEN RUN PROJECT";
                    plan.confirmation.effects.push("REINSPECT EXECUTION FINGERPRINT", "RUN WITH EXISTING VALID TRUST OR REQUEST FRESH RUN AUTHORIZATION");
                }
                return plan;
            }
            const pulled = await this._repositoryAction(c.targetId, "pull");
            if (!pulled.ok) return pulled;
            if (this.automation) await this.automation.inspect(c.targetId);
            return this._repositoryRun({targetId: c.targetId, phase: "REQUEST"});
        });
        ["APPLICATION_SCAN", "APPLICATION_DISCOVERY_LIST"].forEach(id => register(id, "DISCOVER APPLICATIONS", "READ_ONLY", "NONE", "NONE", ["READ VERIFIED DESKTOP ENTRIES"],
            () => this.applicationAutomation ? this.applicationAutomation.scan() : {ok: false, status: "DISCOVERY UNAVAILABLE"}));
        ["APPLICATION_REGISTER", "APPLICATION_REPAIR"].forEach(id => register(id, "VERIFY APPLICATION", "PERSISTENT", "APPLICATION", "USER", ["VERIFY APPLICATION IDENTITY"],
            c => this.applicationAutomation ? c.phase === "EXECUTE" ? this.applicationAutomation.register(c.targetId, c.stored) : this.applicationAutomation.plan(c.targetId) : {ok: false, status: "DISCOVERY UNAVAILABLE"}));
        register("APPLICATION_IGNORE", "IGNORE APPLICATION", "LOW", "APPLICATION", "NONE", ["IGNORE FOR THIS SESSION"],
            c => this.applicationAutomation ? this.applicationAutomation.ignore(c.targetId) : {ok: false, status: "DISCOVERY UNAVAILABLE"});

        register("REPOSITORY_RUN", "RUN REPOSITORY", "LOW", "REPOSITORY", "NONE", ["PRESERVE FINGERPRINT AUTHORIZATION", "PRESERVE ISOLATION POLICY"],
            context => this._repositoryRun(context));
        register("REPOSITORY_STOP", "STOP REPOSITORY", "LOW", "REPOSITORY", "NONE", ["STOP SUPERVISED REPOSITORY PROCESS"],
            context => this._repositoryAction(context.targetId, "stop"));
        register("REPOSITORY_CODE", "OPEN REPOSITORY IN CODE", "LOW", "REPOSITORY", "NONE", ["OPEN TRUSTED REGISTERED CODE APPLICATION"],
            context => this._repositoryAction(context.targetId, "code"));
        register("REPOSITORY_TERMINAL", "OPEN REPOSITORY TERMINAL", "LOW", "REPOSITORY", "NONE", ["CHANGE TERMINAL DIRECTORY TO REGISTERED REPOSITORY"],
            context => this._repositoryAction(context.targetId, "terminal"));
        register("REPOSITORY_INFO", "REPOSITORY INFO", "READ_ONLY", "REPOSITORY", "NONE", ["READ TRUSTED REPOSITORY PROJECTION"],
            context => this._repositoryAction(context.targetId, "info"));
        register("REPOSITORY_GITHUB", "OPEN REPOSITORY GITHUB", "LOW", "REPOSITORY", "NONE", ["OPEN NORMALIZED GITHUB REMOTE"],
            context => this._repositoryAction(context.targetId, "github"));
        register("REPOSITORY_PULL", "PULL REPOSITORY", "PERSISTENT", "REPOSITORY", "NONE", ["FAST-FORWARD ONLY", "PRESERVE HOSTILE-GIT-CONFIG DEFENCES"],
            context => this._repositoryPersistent(context, "pull"));
        register("REPOSITORY_CLONE", "CLONE REPOSITORY", "PERSISTENT", "URL", "NONE", ["CLONE NORMALIZED HTTPS GITHUB URL", "REGISTER UNDER REPOSITORY ROOT"],
            context => this._repositoryPersistent(context, "clone"));
        register("REPOSITORY_LOG", "REPOSITORY LOG", "READ_ONLY", "REPOSITORY", "NONE", ["READ TRUSTED LOG PROJECTION ONLY"],
            () => ({ok: false, status: "REPOSITORY LOG VIEW UNAVAILABLE", detail: "NO TRUSTED LOG PROJECTION EXISTS"}));
        register("SYSTEM_STATUS", "SYSTEM STATUS", "READ_ONLY", "NONE", "NONE", ["READ NOMAD CONTROL CONTEXT"],
            () => this._systemStatus());
    }

    _securityStatus(verbose) {
        try {
            const status = sanitizeSecurityStatus(this.securityService.status({verbose}), verbose);
            let storage = null;
            try {
                const plan = this.enforcementService.plan(status.profile.id, {verbose: false});
                storage = plan && plan.storage ? this._projectSecurityPlan(plan).storage : null;
            } catch (error) {}
            return {
                ok: true, kind: verbose ? "audit" : "security-status", status: "SECURITY STATUS READY",
                security: status, storage
            };
        } catch (error) {
            return {ok: false, status: "SECURITY STATUS UNAVAILABLE"};
        }
    }

    _securityProfile(context) {
        const target = context.targetId;
        if (context.phase === "EXECUTE") {
            try {
                const selected = this.securityService.setProfile(target);
                return {ok: true, kind: "security-profile", status: "PROFILE CHANGED", profile: selected};
            } catch (error) {
                return {ok: false, status: cleanText(error && (error.status || error.message), "SECURITY PROFILE CHANGE REFUSED")};
            }
        }
        const current = this._selectedProfile();
        const plan = this.enforcementService.plan(target);
        return {
            confirmation: {
                request: "SELECT SECURITY PROFILE",
                target: `${current} -> ${target}`,
                securityProfile: current,
                privilege: "USER POLICY ONLY",
                effects: [
                    `SELECT ${target} USER-LEVEL POLICY GATES`,
                    "SYSTEM ENFORCEMENT REMAINS SEPARATE AND PENDING",
                    plan.sessionRestartRequired ? "SESSION RESTART REQUIRED" : "CURRENT SESSION ROUTES RETAINED"
                ],
                fields: [{label: "SYSTEM ENFORCEMENT", value: "NOT APPLIED BY PROFILE SELECTION"}]
            }
        };
    }

    _securityPlan(target) {
        const plan = this.enforcementService.plan(target || this._selectedProfile());
        return {ok: true, kind: "security-plan", status: cleanText(plan.status, "PLAN READY"), plan: this._projectSecurityPlan(plan)};
    }

    _securityApply(context) {
        if (context.phase === "EXECUTE") {
            const result = this.enforcementService.apply(context.targetId, {authorized: true});
            return Object.assign({kind: "security-apply"}, result);
        }
        const plan = this.enforcementService.plan(context.targetId);
        return {
            confirmation: {
                allowed: plan.safeToApply === true,
                status: plan.status,
                request: "APPLY SECURITY POLICY",
                target: context.targetId,
                securityProfile: this._selectedProfile(),
                privilege: "SYSTEM",
                effects: plan.categories.map(category => category.action),
                fields: this._storageFields(plan.storage)
            }
        };
    }

    _securityRestore(context) {
        if (context.phase === "EXECUTE") return Object.assign({kind: "security-restore"}, this.enforcementService.restore({apply: true, authorized: true}));
        const plan = this.enforcementService.restore();
        return {
            confirmation: {
                request: "RESTORE NOMAD POLICY",
                target: plan.targetProfile || "NORMAL",
                securityProfile: this._selectedProfile(),
                privilege: "SYSTEM IF NOMAD OWNS PRIVILEGED STATE",
                effects: plan.actions || ["SELECT NORMAL"]
            }
        };
    }

    _applicationList() {
        const registered = this.applicationPolicy
            ? this.applicationPolicy.projectAll(this.applicationRegistry.getApplications())
            : this.applicationRegistry.getApplications().map(publicApplication);
        const registeredIds = new Set(registered.map(application => application.id));
        let availableSources = new Set();
        if (this.installService && typeof this.installService.detectSources === "function") {
            try {
                availableSources = new Set(this.installService.detectSources()
                    .filter(source => source && source.available === true).map(source => source.source));
            } catch (error) {}
        }
        const catalog = this.packageCatalog.map(definition => ({
            id: definition.id,
            displayName: cleanText(definition.displayName, definition.id, 32),
            installed: registeredIds.has(definition.id),
            available: definition.sources.some(source => availableSources.has(source.source)),
            sources: definition.sources.map(source => source.source).slice(0, 4)
        }));
        return {ok: true, kind: "application-list", status: "APPLICATIONS READY", applications: registered, catalog, discovered: this.applicationAutomation ? this.applicationAutomation.scan().applications : []};
    }

    _applicationInfo(appId) {
        const application = this.applicationRegistry.get(appId);
        if (!application) return {ok: false, status: "APPLICATION NOT REGISTERED"};
        const projected = this.applicationPolicy ? this.applicationPolicy.project(application) : publicApplication(application);
        return {ok: true, kind: "application-info", status: "APPLICATION INFO", application: projected};
    }

    async _applicationOpen(appId) {
        let application = this.applicationRegistry.get(appId);
        if (!application) return {ok: false, status: "APPLICATION NOT REGISTERED / UNKNOWN EXECUTABLE NOT TRUSTED"};
        if (this._selectedProfile() === "LOCKDOWN" && application.type !== "internal") return {ok: false, status: "PROFILE BLOCKED / LOCKDOWN"};
        if (application.available === false && this.applicationAutomation && this.applicationAutomation.allowed()) {
            this.applicationAutomation.reload();
            application = this.applicationRegistry.get(appId);
            if (!application) return {ok: false, status: "REGISTRY STALE / APPLICATION NOT REGISTERED"};
        }
        if (application.available === false) return {ok: false, kind: "application-open", status: application.status || "APPLICATION NOT INSTALLED",
            cause: application.status === "WM_CLASS NOT AVAILABLE" ? "WM_CLASS_UNKNOWN" : "EXECUTABLE_MISSING"};
        const policy = this.applicationPolicy && this.applicationPolicy.evaluate(application);
        if (policy && !policy.allowed) return {ok: false, status: policy.status};
        if (application.type === "internal") return {
            ok: true, kind: "application-open", status: "APPLICATION READY", activateAppId: application.id,
            application: publicApplication(application)
        };
        const result = publicWindowResult(await this.windowManager.operate("launch", application.id, await this.getGeometry()));
        if (result.application) result.application = Object.assign(publicApplication(application), result.application);
        return Object.assign({kind: "application-open"}, result);
    }

    async _applicationClose(appId) {
        const application = this.applicationRegistry.get(appId);
        if (!application || application.type !== "external") return {ok: false, status: "APPLICATION CANNOT BE CLOSED"};
        const result = publicWindowResult(await this.windowManager.operate("close", appId));
        if (result.application) result.application = Object.assign(publicApplication(application), result.application);
        return Object.assign({kind: "application-close"}, result);
    }

    async _applicationInstall(context) {
        if (!["NORMAL", "PUBLIC"].includes(this._selectedProfile())) return {ok: false, status: "APPLICATION INSTALL BLOCKED BY SECURITY PROFILE"};
        if (!this.installService) return {ok: false, status: "APPLICATION INSTALL SERVICE UNAVAILABLE"};
        if (context.phase === "EXECUTE") {
            try {
                this.onProgress({kind: "application-stage", status: "INSTALLING TRUSTED PACKAGE", appId: context.targetId});
                await this.installService.apply(context.stored.installPlan);
                if (!["NORMAL", "PUBLIC"].includes(this._selectedProfile())) return {ok: false, status: "INSTALLATION SUCCESS / REGISTRATION BLOCKED BY PROFILE"};
                this.onProgress({kind: "application-stage", status: "INSTALLATION SUCCESS / DISCOVERING DESKTOP ENTRY", appId: context.targetId});
                try {
                    if (this.applicationAutomation) {
                        const completed = await this.applicationAutomation.installed(context.targetId, this.installService);
                        return {...completed, status: completed.ok ? "APPLICATION INSTALLED / READY" : "INSTALLATION SUCCESS / " + completed.status};
                    }
                    const registered = this.installService.registerInstalled(context.targetId);
                    this.applicationRegistry.reload();
                    this.onApplicationsChanged(this.applicationRegistry.getApplications());
                    return {ok: Boolean(registered && registered.application), kind: "application-install", status: registered && registered.application ? "APPLICATION INSTALLED" : "INSTALLATION SUCCESS / NOMAD REGISTRATION INCOMPLETE", application: registered && registered.application ? publicApplication(registered.application) : null};
                } catch (_) { return {ok: false, kind: "application-install", status: "INSTALLATION SUCCESS / NOMAD REGISTRATION INCOMPLETE"}; }

            } catch (error) {
                return {ok: false, status: cleanText(error && error.message, "APPLICATION INSTALL FAILED")};
            }
        }
        try {
            const plan = this.installService.plan(context.targetId);
            return {
                confirmation: {
                    request: "INSTALL APPLICATION",
                    target: plan.displayName,
                    securityProfile: this._selectedProfile(),
                    privilege: plan.requiresAdministrator ? "ADMINISTRATOR" : "USER",
                    effects: [`INSTALL TRUSTED CATALOG PACKAGE ${plan.package}`, `USE ${plan.source} WITHOUT ADDING REPOSITORIES OR KEYS`],
                    fields: [{label: "SOURCE", value: plan.source}, {label: "PACKAGE", value: plan.package}]
                },
                stored: {installPlan: plan}
            };
        } catch (error) {
            return {ok: false, status: cleanText(error && error.message, "NO SAFE INSTALL PLAN")};
        }
    }

    _applicationRemove(context) {
        if (!this.applicationService) return {ok: false, status: "APPLICATION REMOVE SERVICE UNAVAILABLE"};
        if (this.applicationService.protectedIds && this.applicationService.protectedIds.has(context.targetId)) {
            return {ok: false, status: "BUILT-IN APPLICATION CANNOT BE REMOVED"};
        }
        if (context.phase === "EXECUTE") {
            try {
                this.applicationService.remove(context.targetId);
                this.applicationRegistry.reload();
                this.onApplicationsChanged(this.applicationRegistry.getApplications());
                return {ok: true, kind: "application-remove", status: "APPLICATION REGISTRY ENTRY REMOVED"};
            } catch (error) {
                return {ok: false, status: cleanText(error && error.message, "APPLICATION REMOVE REFUSED")};
            }
        }
        const application = this.applicationRegistry.get(context.targetId);
        if (!application || application.permanent) return {ok: false, status: "BUILT-IN APPLICATION CANNOT BE REMOVED"};
        return {confirmation: {
            request: "REMOVE APPLICATION",
            target: application.displayName,
            securityProfile: this._selectedProfile(),
            privilege: "USER",
            effects: ["REMOVE USER REGISTRY ENTRY", "LEAVE INSTALLED SYSTEM PACKAGE UNCHANGED"]
        }};
    }

    async _repositoryRun(context) {
        if (context.phase === "EXECUTE" && context.stored && context.stored.authorization) {
            return this._repositoryAction(context.targetId, "run", context.stored.authorization);
        }
        const result = await this._repositoryAction(context.targetId, "run");
        if (!result || !result.prompt) return result;
        if (result.prompt.kind === "profile-selection") return {
            ok: true,
            kind: "selection",
            status: "RUN PROFILE SELECTION REQUIRED",
            selection: result.prompt
        };
        if (result.prompt.kind !== "authorization") return {ok: false, status: "RUN AUTHORIZATION INVALID"};
        const fields = result.prompt.fields || [];
        return this._challenge("REPOSITORY_RUN", context.targetId, this.registry.describe("REPOSITORY_RUN"), {
            request: "AUTHORIZE REPOSITORY RUN",
            target: result.prompt.repositoryName,
            securityProfile: this._selectedProfile(),
            privilege: "NONE",
            effects: ["EXECUTE REPOSITORY CODE ONCE", "PRESERVE FINGERPRINT AND ISOLATION GATES"],
            fields
        }, {
            authorization: {
                profileId: result.prompt.profileId,
                authorizationId: result.prompt.authorizationId,
                authorization: "run-once"
            }
        });
    }

    async _repositoryPersistent(context, actionId) {
        if (context.phase === "EXECUTE") {
            return actionId === "clone" ? this.repositoryActions.clone(context.targetId)
                : this._repositoryAction(context.targetId, actionId);
        }
        let target = context.targetId;
        if (actionId === "pull") {
            const info = await this._repositoryAction(context.targetId, "info");
            if (!info.ok || !info.repository) return info;
            target = info.repository.displayName;
        }
        return {confirmation: {
            request: actionId === "pull" ? "PULL REPOSITORY" : "CLONE REPOSITORY",
            target,
            securityProfile: this._selectedProfile(),
            privilege: "NONE",
            effects: actionId === "pull"
                ? ["FETCH TRUSTED REMOTE", "FAST-FORWARD ONLY", "ABORT ON LOCAL OR REMOTE CONFLICT"]
                : ["CLONE NORMALIZED HTTPS GITHUB URL", "CREATE ONE CHILD UNDER REPOSITORY ROOT"]
        }};
    }

    async _repositoryAction(repositoryId, actionId, runRequest = {}) {
        if (!this.repositoryActions) return {ok: false, status: "REPOSITORY SERVICE UNAVAILABLE"};
        const geometry = ["code", "github"].includes(actionId) ? await this.getGeometry() : undefined;
        const result = await this.repositoryActions.execute(repositoryId, actionId, geometry, runRequest);
        if (!result || typeof result !== "object") return {ok: false, status: "REPOSITORY ACTION FAILED"};
        return Object.assign({kind: `repository-${actionId}`}, result);
    }

    async _systemStatus() {
        const repositories = this.repositoryActions ? await this.repositoryActions.list() : {repositories: []};
        return {
            ok: true,
            kind: "system-status",
            status: "SYSTEM STATUS READY",
            profile: this._selectedProfile(),
            selectedRepositoryId: this.context.selectedRepositoryId,
            activeApplicationId: this.context.activeApplicationId,
            repositoryCount: Array.isArray(repositories.repositories) ? repositories.repositories.length : 0,
            applicationCount: this.applicationRegistry ? this.applicationRegistry.getApplications().length : 0
        };
    }

    _selectedProfile() {
        try { return this.profileService.get().profile; } catch (error) { return "UNKNOWN"; }
    }

    _projectSecurityPlan(plan) {
        return {
            targetProfile: PROFILE_SET.has(plan.targetProfile) ? plan.targetProfile : "UNKNOWN",
            selectedProfile: PROFILE_SET.has(plan.selectedProfile) ? plan.selectedProfile : "UNKNOWN",
            safeToApply: plan.safeToApply === true,
            status: cleanText(plan.status, "PLAN UNAVAILABLE"),
            privilegedPending: plan.privilegedPending === true,
            sessionRestartRequired: plan.sessionRestartRequired === true,
            helper: plan.helper ? {
                installed: plan.helper.installed === true,
                trusted: plan.helper.trusted === true,
                available: plan.helper.available === true,
                runtime: plan.helper.runtime === "/usr/bin/node" ? plan.helper.runtime : "/usr/bin/node",
                runtimeTrusted: plan.helper.runtimeTrusted === true,
                status: cleanText(plan.helper.status, "UNAVAILABLE")
            } : null,
            storage: plan.storage ? clone(plan.storage) : null,
            categories: (plan.categories || []).slice(0, 16).map(category => ({
                id: category.id,
                label: cleanText(category.label, "CATEGORY", 48),
                current: cleanText(category.current, "UNKNOWN", 96),
                desired: cleanText(category.desired, "UNKNOWN", 96),
                action: cleanText(category.action, "NO ACTION", 160),
                privileged: category.privileged === true,
                available: category.available === true
            }))
        };
    }

    _storageFields(storage) {
        if (!storage) return [];
        return [
            {label: "OBSERVATION", value: storage.observation || storage.state || "UNKNOWN"},
            {label: "ROOT BACKING", value: storage.rootBacking || "UNKNOWN"},
            {label: "REPOSITORY BACKING", value: storage.repositoryBacking || "UNKNOWN"},
            {label: "SAFE UNMOUNT CANDIDATES", value: String(Number.isSafeInteger(storage.safeUnmountCandidates)
                ? storage.safeUnmountCandidates : (Number.isSafeInteger(storage.eligibleCount) ? storage.eligibleCount : 0))},
            {label: "REASON", value: storage.reason || "UNKNOWN"}
        ];
    }

    _targetValid(kind, targetId, actionId) {
        if (kind === "NONE") return typeof targetId === "undefined" || targetId === null || targetId === "";
        if (kind === "PROFILE") return PROFILE_SET.has(targetId || "");
        if (kind === "APPLICATION") return APPLICATION_ID_PATTERN.test(targetId || "");
        if (kind === "REPOSITORY") return REPOSITORY_ID_PATTERN.test(targetId || "");
        if (kind === "URL") return actionId === "REPOSITORY_CLONE" && typeof targetId === "string"
            && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(targetId) && targetId.length <= 512;
        return false;
    }

    _pruneChallenges() {
        const now = this.nowMilliseconds();
        this.challenges.forEach((challenge, challengeId) => {
            if (!challenge || challenge.expiresAt <= now) this.challenges.delete(challengeId);
        });
    }
}

function validateControlRequest(request) {
    return Boolean(request && typeof request === "object" && !Array.isArray(request)
        && Object.keys(request).every(key => ["actionId", "targetId"].includes(key))
        && typeof request.actionId === "string"
        && (typeof request.targetId === "undefined" || typeof request.targetId === "string"));
}

module.exports = {
    CHALLENGE_ID_PATTERN,
    ControlPlaneService,
    cleanText,
    publicWindowResult,
    validateControlRequest
};
