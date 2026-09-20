"use strict";

const ACTION_ID_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const ACTION_RISKS = new Set(["READ_ONLY", "LOW", "PERSISTENT", "SYSTEM"]);
const TARGET_KINDS = new Set(["NONE", "PROFILE", "APPLICATION", "REPOSITORY", "URL"]);

class TrustedActionRegistry {
    constructor(definitions = []) {
        this.actions = new Map();
        definitions.forEach(definition => this.register(definition));
    }

    register(definition) {
        if (!definition || typeof definition !== "object" || Array.isArray(definition)
            || !ACTION_ID_PATTERN.test(definition.id || "")
            || !ACTION_RISKS.has(definition.risk)
            || !TARGET_KINDS.has(definition.targetKind)
            || typeof definition.handler !== "function"
            || this.actions.has(definition.id)) {
            throw new TypeError("Trusted action definition is invalid");
        }
        const normalized = Object.freeze({
            id: definition.id,
            label: String(definition.label || definition.id).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 64),
            risk: definition.risk,
            targetKind: definition.targetKind,
            privilege: String(definition.privilege || "NONE").replace(/[^A-Z0-9_ -]/g, "").slice(0, 64),
            effects: Object.freeze((Array.isArray(definition.effects) ? definition.effects : [])
                .filter(value => typeof value === "string")
                .slice(0, 12)
                .map(value => value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160))),
            handler: definition.handler
        });
        this.actions.set(normalized.id, normalized);
        return this.describe(normalized.id);
    }

    has(actionId) {
        return this.actions.has(actionId);
    }

    describe(actionId) {
        const action = this.actions.get(actionId);
        if (!action) return null;
        return {
            id: action.id,
            label: action.label,
            risk: action.risk,
            targetKind: action.targetKind,
            privilege: action.privilege,
            effects: action.effects.slice()
        };
    }

    list() {
        return Array.from(this.actions.keys()).sort().map(actionId => this.describe(actionId));
    }

    execute(actionId, context) {
        const action = this.actions.get(actionId);
        if (!action) return Promise.resolve({ok: false, status: "UNKNOWN TRUSTED ACTION"});
        return Promise.resolve().then(() => action.handler(context || Object.freeze({})));
    }
}

module.exports = {ACTION_ID_PATTERN, TrustedActionRegistry};
