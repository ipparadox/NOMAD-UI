"use strict";

const PROFILE_PHRASES = Object.freeze([
    {profile: "PUBLIC", patterns: [/^pon modo publico$/, /^activa (?:(?:el )?modo )?public(?:o)?$/, /^switch to public mode$/, /^public mode$/]},
    {profile: "LOCKDOWN", patterns: [/^pon modo lockdown$/, /^activa (?:(?:el )?modo )?lockdown$/, /^maxima seguridad$/, /^maximum security$/, /^switch to lockdown mode$/, /^lockdown mode$/]},
    {profile: "NORMAL", patterns: [/^pon modo normal$/, /^activa (?:(?:el )?modo )?normal$/, /^switch to normal mode$/, /^normal mode$/]}
]);

const SHELL_REQUEST_PATTERNS = Object.freeze([
    /(^|\s)sudo(?:\s|$)/,
    /\bcurl\b[^\n|]*\|\s*(?:ba)?sh\b/,
    /\bwget\b[^\n|]*\|\s*(?:ba)?sh\b/,
    /\b(?:bash|sh|zsh|powershell|cmd)\s+(?:command|comando|script)\b/,
    /\b(?:ejecuta|corre|run|execute|haz)\s+(?:este\s+)?(?:comando|command)\b/,
    /(?:^|\s)(?:rm|chmod|chown|mkfs|dd)\s+-/
]);

function normalizeIntentText(value) {
    if (typeof value !== "string") return "";
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[¿?¡!.,;:]+/g, " ").replace(/\s+/g, " ").trim();
}

function trustedApplicationId(value) {
    const aliases = {
        vlc: "vlc",
        spotify: "spotify",
        calculator: "gnome-calculator",
        calculadora: "gnome-calculator",
        "gnome calculator": "gnome-calculator"
    };
    return aliases[value] || (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value || "") ? value : null);
}

class DeterministicIntentParser {
    parse(input) {
        if (typeof input !== "string" || input.length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) {
            return {kind: "INVALID", status: "INTENT INPUT INVALID"};
        }
        const text = normalizeIntentText(input);
        if (!text) return {kind: "UNKNOWN", status: "UNKNOWN NOMAD INTENT"};
        if (SHELL_REQUEST_PATTERNS.some(pattern => pattern.test(text))) {
            return {kind: "REJECTED", status: "UNTRUSTED TERMINAL COMMAND"};
        }

        for (const entry of PROFILE_PHRASES) {
            if (entry.patterns.some(pattern => pattern.test(text))) {
                return {kind: "ACTION", actionId: "SECURITY_PROFILE_SET", targetId: entry.profile};
            }
        }

        if (["comprueba mi seguridad", "como de seguro estoy", "security status", "check my security"].includes(text)) {
            return {kind: "ACTION", actionId: "SECURITY_STATUS"};
        }
        if (["haz una auditoria", "audita mi seguridad", "audit security", "security audit"].includes(text)) {
            return {kind: "ACTION", actionId: "SECURITY_AUDIT"};
        }
        if (["verifica la seguridad", "verify security", "security verify"].includes(text)) {
            return {kind: "ACTION", actionId: "SECURITY_VERIFY"};
        }

        if (["que programas nuevos hay", "what new applications are there"].includes(text)) return {kind: "ACTION", actionId: "APPLICATION_DISCOVERY_LIST"};
        if (["actualiza la lista de programas", "refresh application list", "scan applications"].includes(text)) return {kind: "ACTION", actionId: "APPLICATION_SCAN"};
        if (["lista proyectos", "list projects"].includes(text)) return {kind: "ACTION", actionId: "PROJECT_LIST"};
        const registration = /^(?:anade|add) ([a-z0-9][a-z0-9._-]{0,63}) (?:a|to) nomad$/.exec(text);
        if (registration) return {kind: "ACTION", actionId: "APPLICATION_REGISTER", targetId: registration[1]};
        const repositoryActions = [
            {actionId: "PROJECT_PREPARE", phrases: ["prepara este repo", "configura este repo", "prepare this repo"]},
            {actionId: "PROJECT_SETUP", phrases: ["instala las dependencias", "install dependencies"]},
            {actionId: "PROJECT_INSPECT", phrases: ["que necesita este repo", "what does this repo need"]},
            {actionId: "PROJECT_PULL_RUN", phrases: ["haz pull y ejecutalo", "pull and run this repo"]},
            {actionId: "PROJECT_DIAGNOSE", phrases: ["diagnostica este repo", "por que no arranca", "diagnose this repo"]},
            {actionId: "PROJECT_REPAIR", phrases: ["repara este repo", "arregla este repo", "repair this repo"]},
            {actionId: "PROJECT_RUN", phrases: ["corre este repo", "ejecuta este repo", "run this repo"]},
            {actionId: "PROJECT_STOP", phrases: ["para este repo", "deten este repo", "stop this repo"]},
            {actionId: "REPOSITORY_CODE", phrases: ["abre este repo en code", "open this repo in code"]},
            {actionId: "REPOSITORY_PULL", phrases: ["haz pull", "actualiza este repo", "pull this repo", "update this repo"]},
            {actionId: "REPOSITORY_INFO", phrases: ["info de este repo", "repository info", "show repository info"]},
            {actionId: "REPOSITORY_LOG", phrases: ["ensename el log de este repo", "show this repo log", "show repository log"]}
        ];
        const repositoryAction = repositoryActions.find(entry => entry.phrases.includes(text));
        if (repositoryAction) return {kind: "ACTION", actionId: repositoryAction.actionId, contextualTarget: "SELECTED_REPOSITORY"};

        let match = /^(?:instala|install) ([a-z0-9][a-z0-9._ -]{0,63})$/.exec(text);
        if (match) {
            const appId = trustedApplicationId(match[1]);
            return appId ? {kind: "ACTION", actionId: "APPLICATION_INSTALL", targetId: appId}
                : {kind: "UNKNOWN", status: "APPLICATION NOT IN TRUSTED CATALOG"};
        }
        match = /^(?:abre|open) ([a-z0-9][a-z0-9._ -]{0,63})$/.exec(text);
        if (match) {
            const appId = trustedApplicationId(match[1]);
            return appId ? {kind: "ACTION", actionId: "APPLICATION_OPEN", targetId: appId}
                : {kind: "UNKNOWN", status: "APPLICATION NOT REGISTERED"};
        }

        return {kind: "UNKNOWN", status: "UNKNOWN NOMAD INTENT"};
    }
}

class StructuredIntentProvider {
    constructor(opts = {}) {
        this.id = opts.id || "UNCONFIGURED";
    }

    propose() {
        return Promise.resolve(null);
    }
}

function validateStructuredProposal(proposal, registry) {
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)
        || Object.keys(proposal).some(key => !["actionId", "targetId"].includes(key))
        || typeof proposal.actionId !== "string" || !registry || !registry.has(proposal.actionId)) return null;
    if (typeof proposal.targetId !== "undefined" && (typeof proposal.targetId !== "string" || proposal.targetId.length > 512)) return null;
    return {actionId: proposal.actionId, targetId: proposal.targetId};
}

module.exports = {
    DeterministicIntentParser,
    StructuredIntentProvider,
    normalizeIntentText,
    trustedApplicationId,
    validateStructuredProposal
};
