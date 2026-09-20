"use strict";
// Rules inspect main-owned facts only. Plans name typed actions, never commands.
class RepairRule {
    constructor(id, repairClass, detect, diagnose) {
        this.id = id;
        this.repairClass = repairClass;
        this.severity = "ERROR";
        this.detect = detect;
        this.diagnose = diagnose;
        Object.freeze(this);
    }
    canAutoRepair() { return this.repairClass === "A"; }
    buildRepairPlan() {
        return {repairClass: this.repairClass, actionId: this.repairClass === "B" ? "PROJECT_SETUP" : null,
            authorizationRequired: this.repairClass === "B", sourceMutationAllowed: false};
    }
    verify(context) { return !this.detect(context); }
}
class RepairRuleRegistry {
    constructor() {
        this.rules = [
            new RepairRule("RUN_PROFILE_INVALID", "C", c => !c.candidate, () => "RUN PROFILE SELECTION REQUIRED"),
            new RepairRule("NODE_RUNTIME_MISMATCH", "C", c => c.type === "NODE" && !c.runtime.ok, c => c.runtime.status),
            new RepairRule("MISSING_EXECUTABLE", "C", c => Boolean(c.executableFailure), c => c.executableFailure),
            ...["MISSING", "INCOMPLETE", "STALE", "UNKNOWN"].map(state => new RepairRule(`NODE_DEPENDENCIES_${state}`,
                state === "UNKNOWN" || state === "STALE" ? "C" : "B", c => c.type === "NODE" && c.dependencies === state, () => `DEPENDENCIES ${state}`)),
            new RepairRule("PLATFORM_CONFLICT", "C", c => c.platformConflict, () => "PROJECT RUN PROFILE REQUIRES WINDOWS COMPONENT"),
            new RepairRule("PYTHON_RUNTIME_MISMATCH", "C", c => Boolean(c.pythonRuntimeFailure), c => c.pythonRuntimeFailure),
            new RepairRule("PYTHON_ENVIRONMENT_MISSING", "B", c => c.environmentMissing, () => "PROJECT-LOCAL PYTHON ENVIRONMENT MISSING"),
            new RepairRule("PROJECT_SETUP_REQUIRED", "B", c => c.setupRequired, () => "PROJECT SETUP REQUIRED"),
            new RepairRule("PROJECT_UNSUPPORTED", "C", c => Boolean(c.blocked), c => c.blocked)
        ];
    }
    diagnose(context) {
        return this.rules.filter(rule => rule.detect(context)).map(rule => ({id: rule.id, severity: rule.severity,
            repairClass: rule.repairClass, status: rule.diagnose(context), plan: rule.buildRepairPlan()}));
    }
}
const REPAIR_LIMITS = Object.freeze({maxSetupSteps: 8, maxLaunches: 1, maxAutomaticFailureRetries: 0});
module.exports = {RepairRule, RepairRuleRegistry, REPAIR_LIMITS};
