const assert = require("assert");
const {ControlPlaneView} = require("../src/classes/controlPlaneView.class.js");

class ClassList {
    constructor() { this.values = new Set(); }
    add(...values) { values.forEach(value => this.values.add(value)); }
    remove(...values) { values.forEach(value => this.values.delete(value)); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
        const enabled = typeof force === "boolean" ? force : !this.values.has(value);
        if (enabled) this.values.add(value); else this.values.delete(value);
        return enabled;
    }
}

class Element {
    constructor(tagName, document) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.listeners = new Map();
        this.attributes = Object.create(null);
        this.dataset = Object.create(null);
        this.classList = new ClassList();
        this.className = "";
        this.hidden = false;
        this.disabled = false;
        this.value = "";
        this.textContent = "";
        this.id = "";
    }
    append(...children) { children.filter(Boolean).forEach(child => { this.children.push(child); child.parentElement = this; }); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    dispatch(type, event = {}) { (this.listeners.get(type) || []).forEach(listener => listener(event)); }
    focus() { this.ownerDocument.activeElement = this; }
}

class Document {
    constructor() { this.body = new Element("body", this); this.activeElement = null; }
    createElement(tagName) { return new Element(tagName, this); }
}

class HostWindow {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    dispatch(type, event) { const listener = this.listeners.get(type); if (listener) listener(event); }
}

function event(overrides = {}) {
    return Object.assign({
        key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false,
        prevented: false, stopped: false, immediate: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.immediate = true; }
    }, overrides);
}

function flush() { return new Promise(resolve => setImmediate(resolve)); }

async function run() {
    const document = new Document();
    const hostWindow = new HostWindow();
    const captures = [];
    let focusedTerminal = 0;
    let interpreted = [];
    let terminalWrites = 0;
    const bridge = {
        control: {
            request: async () => ({ok: true, status: "READY"}),
            confirm: async () => ({ok: true, status: "COMPLETE"}),
            cancel: async () => ({ok: true, status: "CANCELLED"}),
            setContext: async () => ({ok: true})
        },
        assistant: {
            interpret: async input => {
                interpreted.push(input);
                return {ok: true, status: "SECURITY STATUS READY"};
            }
        }
    };
    const view = new ControlPlaneView({
        bridge,
        document,
        window: hostWindow,
        inputCapture: {
            acquire(owner) { captures.push(["acquire", owner]); },
            release(owner) { captures.push(["release", owner]); }
        },
        focusTerminal() { focusedTerminal++; },
        activateApplication() { terminalWrites++; }
    }).initialize();

    const shortcut = event({code: "Space", ctrlKey: true});
    hostWindow.dispatch("keydown", shortcut);
    assert.strictEqual(view.opened, true);
    assert.strictEqual(view.mode, "assistant");
    assert.strictEqual(shortcut.prevented, true);
    assert.strictEqual(shortcut.immediate, true);
    assert.deepStrictEqual(captures, [["acquire", "nomad-control-plane"]]);
    assert.strictEqual(document.activeElement, view.input);

    view.input.value = "corre este repo";
    const enter = event({key: "Enter"});
    view.input.dispatch("keydown", enter);
    await flush();
    await flush();
    assert.deepStrictEqual(interpreted, ["corre este repo"]);
    assert.strictEqual(enter.prevented, true);
    assert.strictEqual(enter.immediate, true, "Enter must terminate routing at the intent parser input");
    assert.strictEqual(terminalWrites, 0, "assistant input must not be forwarded to the terminal");

    const escape = event({key: "Escape"});
    view.input.dispatch("keydown", escape);
    assert.strictEqual(view.opened, false);
    assert.strictEqual(escape.prevented, true);
    assert.deepStrictEqual(captures, [
        ["acquire", "nomad-control-plane"],
        ["release", "nomad-control-plane"]
    ]);
    assert.strictEqual(focusedTerminal, 1, "closing must restore terminal focus exactly once");

    view.open("assistant");
    const toggleClose = event({code: "Space", ctrlKey: true});
    hostWindow.dispatch("keydown", toggleClose);
    assert.strictEqual(view.opened, false);
    assert.strictEqual(focusedTerminal, 2);

    const markup = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "assets", "css", "control_plane.css"), "utf8");
    assert(markup.includes("border-radius: 0"));
    assert(!markup.includes("border-radius: 1"));
    assert(!markup.includes("chat"));
    assert(!markup.includes("avatar"));

    view.destroy();
    console.log("Ctrl+Space, native assistant input capture, parser-only Enter, Escape, focus restoration, and angular HUD styling passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
