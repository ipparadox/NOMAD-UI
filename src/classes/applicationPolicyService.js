const {
    APPLICATION_TYPES,
    LOCKDOWN_BUILTIN_APPLICATION_IDS,
    normalizeApplicationId,
    publicApplication
} = require("./managedApplications.js");
const {normalizeSecurityProfile} = require("./securityProfileService.js");

class ApplicationPolicyService {
    constructor(opts = {}) {
        this.getSecurityProfile = typeof opts.getSecurityProfile === "function"
            ? opts.getSecurityProfile : (() => "NORMAL");
        this.lockdownBuiltIns = new Set(opts.lockdownBuiltIns || LOCKDOWN_BUILTIN_APPLICATION_IDS);
        this.getRunningExternalCount = typeof opts.getRunningExternalCount === "function"
            ? opts.getRunningExternalCount : null;
    }

    profile() {
        try {
            const selected = this.getSecurityProfile();
            return normalizeSecurityProfile(typeof selected === "string" ? selected : selected && selected.profile) || "UNKNOWN";
        } catch (error) {
            return "UNKNOWN";
        }
    }

    evaluate(application, profileValue = this.profile()) {
        const profile = normalizeSecurityProfile(profileValue);
        const appId = normalizeApplicationId(application && application.id);
        if (!profile || !appId || !application || ![APPLICATION_TYPES.INTERNAL, APPLICATION_TYPES.EXTERNAL].includes(application.type)) {
            return {allowed: false, profile: profile || "UNKNOWN", status: "APPLICATION POLICY UNAVAILABLE", isolation: "UNKNOWN"};
        }
        if (profile === "LOCKDOWN") {
            const allowed = application.type === APPLICATION_TYPES.INTERNAL && this.lockdownBuiltIns.has(appId);
            return {
                allowed,
                profile,
                status: allowed ? "BUILT-IN APPLICATION" : "BLOCKED BY LOCKDOWN",
                isolation: allowed ? "IN_PROCESS_CORE" : "NOT_APPLICABLE"
            };
        }
        if (application.type === APPLICATION_TYPES.INTERNAL) return {
            allowed: true,
            profile,
            status: "BUILT-IN APPLICATION",
            isolation: "IN_PROCESS_CORE"
        };
        return {
            allowed: true,
            profile,
            status: profile === "PUBLIC" ? "CONTROLLED REGISTRY; GUI SANDBOX NOT STRONG"
                : "CONTROLLED REGISTRY",
            isolation: profile === "PUBLIC" ? "CONTROLLED_NO_STRONG_SANDBOX" : "HOST_USER_SESSION"
        };
    }

    project(application, profileValue = this.profile()) {
        const projected = publicApplication(application);
        const policy = this.evaluate(application, profileValue);
        if (!policy.allowed) {
            projected.available = false;
            projected.status = policy.status;
        } else if (application.type === APPLICATION_TYPES.EXTERNAL && policy.profile === "PUBLIC") {
            projected.status = policy.status;
        }
        return projected;
    }

    projectAll(applications, profileValue = this.profile()) {
        return (applications || []).map(application => this.project(application, profileValue));
    }

    status(profileValue = this.profile()) {
        const profile = normalizeSecurityProfile(profileValue) || "UNKNOWN";
        let existingExternalCount = null;
        let existingProcessInventoryComplete = false;
        if (this.getRunningExternalCount) {
            try {
                const observation = this.getRunningExternalCount();
                const count = Number.isSafeInteger(observation) ? observation
                    : (observation && Number.isSafeInteger(observation.count) ? observation.count : null);
                if (Number.isSafeInteger(count) && count >= 0) existingExternalCount = count;
                existingProcessInventoryComplete = Number.isSafeInteger(observation)
                    || Boolean(observation && observation.complete === true);
            } catch (error) {}
        }
        if (profile === "LOCKDOWN") {
            const verified = existingExternalCount !== null && existingProcessInventoryComplete;
            const clean = verified && existingExternalCount === 0;
            return {
                state: clean ? "SECURE" : (verified ? "INSECURE" : "PARTIAL"),
                actual: clean ? "BUILTIN_ONLY" : (verified ? "EXTERNAL_PROCESS_ACTIVE" : "NEW_EXTERNAL_LAUNCHES_BLOCKED"),
                detail: verified
                    ? `MAIN-SIDE BUILT-IN GATE ACTIVE; ${existingExternalCount} EXISTING EXTERNAL APPLICATION(S)`
                    : (existingExternalCount === null
                        ? "MAIN-SIDE BUILT-IN GATE ACTIVE; EXISTING EXTERNAL APPLICATIONS NOT VERIFIED"
                        : `MAIN-SIDE BUILT-IN GATE ACTIVE; ${existingExternalCount} NOMAD-MANAGED EXTERNAL APPLICATION(S); OTHER USER PROCESSES NOT VERIFIED`),
                compliant: verified ? clean : null,
                existingExternalCount,
                existingProcessInventoryComplete
            };
        }
        if (profile === "PUBLIC") return {
            state: "PARTIAL",
            actual: "CONTROLLED_REGISTRY",
            detail: "REGISTERED APPLICATIONS ARE MAIN-SIDE CONTROLLED; BROAD X11/DBUS/HOME ACCESS PREVENTS A STRONG SANDBOX CLAIM",
            compliant: true,
            existingExternalCount,
            existingProcessInventoryComplete
        };
        if (profile === "NORMAL") return {
            state: "PARTIAL",
            actual: "CONTROLLED_REGISTRY",
            detail: "EXISTING REGISTRY BEHAVIOR PRESERVED; EXTERNAL APPLICATIONS RUN IN THE USER SESSION",
            compliant: true,
            existingExternalCount,
            existingProcessInventoryComplete
        };
        return {
            state: "UNKNOWN", actual: "BLOCKED", detail: "SECURITY PROFILE UNAVAILABLE",
            compliant: null, existingExternalCount, existingProcessInventoryComplete
        };
    }
}

module.exports = {ApplicationPolicyService};
