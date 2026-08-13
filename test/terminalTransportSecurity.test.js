const assert = require("assert");
const crypto = require("crypto");
const {
    TERMINAL_AUTH_TOKEN_PATTERN,
    normalizeTerminalPort,
    terminalWebsocketRequestAuthorized
} = require("../src/classes/terminal.class.js");

const token = crypto.randomBytes(32).toString("hex");
const otherToken = crypto.randomBytes(32).toString("hex");
const request = url => ({req: {url}});

assert(TERMINAL_AUTH_TOKEN_PATTERN.test(token));
assert.strictEqual(normalizeTerminalPort(3000), 3000);
assert.strictEqual(normalizeTerminalPort("3000"), 3000);
[0, 65536, -1, 1.5, "not-a-port", null, true, " 3000", "03000"].forEach(value => {
    assert.strictEqual(normalizeTerminalPort(value), null);
});

assert.strictEqual(terminalWebsocketRequestAuthorized(request(`/?token=${token}`), token), true);
assert.strictEqual(terminalWebsocketRequestAuthorized(request(`/?token=${otherToken}`), token), false);
assert.strictEqual(terminalWebsocketRequestAuthorized(request("/"), token), false);
assert.strictEqual(terminalWebsocketRequestAuthorized(request(`/?token=${token}&extra=true`), token), false);
assert.strictEqual(terminalWebsocketRequestAuthorized(request(`/other?token=${token}`), token), false);
assert.strictEqual(terminalWebsocketRequestAuthorized({req: {url: null}}, token), false);
assert.strictEqual(terminalWebsocketRequestAuthorized(request(`/?token=${token}`), "invalid"), false);

console.log("Terminal loopback transport capability and strict port checks passed");
