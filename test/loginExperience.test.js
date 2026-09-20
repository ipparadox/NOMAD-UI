"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");
const {SessionAuthProvider, registerSessionAuth} = require("../src/classes/sessionAuthProvider");
const source = fs.readFileSync("src/classes/asciiWaveBackground.class.js", "utf8");
const loginSource = fs.readFileSync("src/classes/loginExperience.class.js", "utf8");

// Run the real renderer-only canvas implementation at controlled timestamps.
function canvasHarness() {
    const listeners = new Map();
    const frames = new Map();
    let sequence = 0;
    let now = 0;
    const paints = [];
    const ctx = {setTransform(...args) { this.transform = args; },
        fillRect() { paints.length = 0; }, fillText(...args) { paints.push([this.fillStyle, ...args]); }};
    const canvas = {style: {}, getContext(type, options) {
        assert.strictEqual(type, "2d"); assert.strictEqual(options.alpha, false); return ctx;
    }};
    const window = {innerWidth: 280, innerHeight: 160, devicePixelRatio: 3,
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); }};
    const Wave = vm.runInNewContext(source + "\nAsciiWaveBackground", {
        window, performance: {now: () => now},
        requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; },
        cancelAnimationFrame(id) { frames.delete(id); }
    });
    const wave = new Wave(canvas);
    return {wave, canvas, ctx, window, listeners, frames, paints,
        tick(time) { now = time; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(time)); }};
}
const h = canvasHarness();
h.wave.start();
assert.strictEqual(h.canvas.width, 560); assert.strictEqual(h.canvas.height, 320);
assert.deepStrictEqual(h.ctx.transform, [2, 0, 0, 2, 0, 0]);
assert(h.ctx.font.startsWith("13px"));
assert(h.paints.length > 100);
assert(h.paints.every(p => " nomad-UI".includes(p[1])));
assert(h.paints.every(p => (p[2] - 7) % 14 === 0 && (p[3] - 8) % 16 === 0));
const initial = JSON.stringify(h.paints);
const digest = crypto.createHash("sha256").update(initial).digest("hex");
// Golden output protects the complete seeded noise/warp/swell/palette pipeline.
assert.strictEqual(digest, "708468f1b461112a45899a6dfde12b66aa88635aad78392ea36ae11dfd72f9b8");
h.tick(50); assert.strictEqual(h.wave.frames, 1, "30 FPS cap skips early RAF");
h.tick(70); assert.strictEqual(h.wave.frames, 2);
assert.notStrictEqual(JSON.stringify(h.paints), initial, "field evolves with time");
const baseline = canvasHarness(); baseline.wave.start();
h.listeners.get("pointermove")({clientX: 15, clientY: 25});
h.tick(110); baseline.tick(110);
assert.notStrictEqual(JSON.stringify(h.paints), JSON.stringify(baseline.paints), "pointer changes wave math");
h.listeners.get("pointerleave")();
h.window.innerWidth = 420; h.listeners.get("resize")(); assert.strictEqual(h.canvas.width, 840);
h.wave.start(); assert.strictEqual(h.frames.size, 1, "idempotent start");
h.wave.stop(); assert.strictEqual(h.frames.size, 0); assert.strictEqual(h.listeners.size, 0);
const count = h.wave.frames; h.tick(200); assert.strictEqual(h.wave.frames, count);
h.wave.start(); assert.strictEqual(h.listeners.size, 3);
h.wave.destroy(); assert(h.wave.destroyed); assert.strictEqual(h.frames.size, 0); assert.strictEqual(h.listeners.size, 0);
assert.strictEqual(h.canvas.width, 0); assert.strictEqual(h.canvas.height, 0, "release canvas backing store");
h.wave.start(); assert.strictEqual(h.frames.size, 0, "destroyed instance cannot restart");
h.wave.resize(); baseline.wave.destroy();
assert(source.includes("ramp: ' nomad-UI'")); assert(source.includes("let seed = 1337"));
assert(!/\b(?:video|img|fetch|require)\s*\(/.test(source));

async function providerTests() {
    const options = {userInfo: () => ({username: "operator", uid: 1000}), hostname: () => "field-node",
        inspect: async () => ({User: "1000", Active: "yes", Remote: "no", Service: "gdm-password"})};
    const provider = new SessionAuthProvider(options);
    assert.deepStrictEqual(await provider.getIdentity(), {operator: "operator", node: "field-node"});
    assert.strictEqual((await provider.getAuthenticationState()).channel, "GDM");
    assert.strictEqual((await provider.getAuthenticationState()).credentialRequired, false);
    assert.strictEqual(provider.getRateLimitState().applicable, false);
    assert.strictEqual((await provider.authenticate("credential-canary")).ok, false);
    for (const overrides of [{Service: "gdm-autologin"}, {User: "1001"}, {Active: "no"}, {Remote: "yes"}, {Service: "login"}]) {
        const other = new SessionAuthProvider({...options, inspect: async () => ({...await options.inspect(), ...overrides})});
        assert.strictEqual((await other.getAuthenticationState()).channel, "UNKNOWN");
    }
    const handlers = new Map(); const sender = {}; let verified = false;
    registerSessionAuth({handle: (channel, fn) => handlers.set(channel, fn)}, provider, value => value === sender, () => verified);
    assert.deepStrictEqual([...handlers.keys()], ["nomad.auth.session.get", "nomad.auth.session.confirm"]);
    for (const fn of handlers.values()) {
        assert.strictEqual((await fn({sender: {}}, {})).ok, false);
        for (const request of [null, [], {password: "credential-canary"}, {command: "true"}, {path: "/etc/passwd"}, ""]) {
            assert.strictEqual((await fn({sender}, request)).ok, false);
        }
    }
    const confirm = handlers.get("nomad.auth.session.confirm");
    assert.strictEqual((await confirm({sender}, {})).ok, false);
    verified = true;
    assert.deepStrictEqual(await confirm({sender}, {}), {ok: true, confirmed: true, status: "SESSION CONFIRMED"});
    assert.strictEqual((await provider.getAuthenticationState()).confirmed, true);
}

async function stateMachineTests() {
    const elements = new Map();
    const target = () => ({textContent: "", disabled: true, addEventListener() {}, removeEventListener() {}, focus() {}});
    const root = {dataset: {}, classList: {add() {}}, contains: () => true,
        querySelector(selector) { if (!elements.has(selector)) elements.set(selector, target()); return elements.get(selector); },
        animate() { const animation = {}; queueMicrotask(() => animation.onfinish()); return animation; },
        remove() { this.removed = true; }};
    const listeners = new Set();
    const host = {addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn)};
    let intervals = 0;
    const document = {...host, body: {dataset: {}, classList: {add() {}, remove() {}}}};
    const Login = vm.runInNewContext(loginSource + "\nLoginExperience", {window: host, document,
        setInterval: () => ++intervals, clearInterval: () => --intervals, performance: {now: () => 0},
        AsciiWaveBackground: class { start() {} destroy() { this.destroyed = true; } }});
    let confirmations = 0;
    const login = new Login(root, {
        getSession: async () => ({ok: true, rendererVerified: true, identity: {operator: "operator", node: "node"},
            authentication: {channel: "UNKNOWN", description: "OS SESSION"}}),
        confirmSession: async () => { confirmations++; return {ok: true, confirmed: true}; }
    });
    assert.strictEqual(login.state, "BOOTSTRAP");
    assert.throws(() => login.transition("NOMAD_READY"));
    await login.initialize(); assert.strictEqual(login.state, "AUTH_READY");
    await Promise.all([login.confirm(), login.confirm()]);
    assert.strictEqual(confirmations, 1); assert.strictEqual(login.state, "AUTH_SUCCESS");
    await login.confirmed;
    login.transition("SESSION_INITIALIZING");
    await login.reveal();
    assert.strictEqual(login.state, "NOMAD_READY"); assert(login.wave.destroyed); assert(root.removed);
    assert.strictEqual(intervals, 0); assert.strictEqual(listeners.size, 0);
    const retry = new Login(root, {confirmSession: async () => ({ok: false})});
    retry.transition("AUTH_INITIALIZING"); retry.transition("AUTH_READY");
    await retry.confirm(); assert.strictEqual(retry.state, "AUTH_FAILED");
    assert(retry.status.textContent.includes("UNAVAILABLE"));
    retry.provider.confirmSession = async () => ({ok: true, confirmed: true});
    await retry.confirm(); assert.strictEqual(retry.state, "AUTH_SUCCESS");
    retry.fatal();
    const failed = new Login(root, {getSession: async () => ({ok: false})});
    await assert.rejects(() => failed.initialize()); failed.fatal();
    assert.strictEqual(failed.state, "FATAL"); assert(failed.wave.destroyed);
}
Promise.all([providerTests(), stateMachineTests()]).then(() => {
    console.log("Login canvas golden output, lifecycle, input state machine, truthful provider and narrow IPC tests passed");
}).catch(error => { console.error(error); process.exitCode = 1; });
