"use strict";

const assert = require("assert");
const {SecureKeyboard} = require("../src/classes/secureKeyboard.class.js");

class FakeClassList {
    constructor(element) { this.element = element; }
    _values() { return this.element.className.split(/\s+/).filter(Boolean); }
    add(...names) { this.element.className = Array.from(new Set(this._values().concat(names))).join(" "); }
    remove(...names) { this.element.className = this._values().filter(name => !names.includes(name)).join(" "); }
    contains(name) { return this._values().includes(name); }
}

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.dataset = {};
        this.className = "";
        this.classList = new FakeClassList(this);
        this.listeners = {};
        this.attributes = {};
        this.textContent = "";
        this.value = "";
        this.selectionStart = 0;
        this.selectionEnd = 0;
    }
    set id(value) { this._id = value; if (value) this.ownerDocument.elements.set(value, this); }
    get id() { return this._id || ""; }
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
    replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    setPointerCapture() {}
    focus() { this.ownerDocument.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    setRangeText(value, start, end) {
        this.value = `${this.value.slice(0, start)}${value}${this.value.slice(end)}`;
        this.selectionStart = this.selectionEnd = start + value.length;
    }
    dispatchEvent(event) { (this.listeners[event.type] || []).forEach(listener => listener(event)); return true; }
    querySelectorAll(selector) {
        const all = [];
        const visit = element => { element.children.forEach(child => { all.push(child); visit(child); }); };
        visit(this);
        const classes = Array.from(selector.matchAll(/\.([A-Za-z0-9_-]+)/g), match => match[1]);
        return all.filter(element => classes.every(name => element.classList.contains(name)));
    }
}

class FakeDocument {
    constructor() { this.elements = new Map(); this.listeners = {}; this.activeElement = null; }
    createElement(tagName) { return new FakeElement(tagName, this); }
    createElementNS(namespace, tagName) { return this.createElement(tagName); }
    getElementById(id) { return this.elements.get(id) || null; }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
}

const document = new FakeDocument();
const container = document.createElement("section");
container.id = "keyboard";
const physicalListeners = {};
let stdinSounds = 0;
global.document = document;
global.window = {
    addEventListener: (type, listener) => { physicalListeners[type] = listener; },
    audioManager: {
        stdin: {play: () => { stdinSounds++; }},
        granted: {play: () => true}
    },
    passwordMode: "false"
};
global.Event = class Event {
    constructor(type) { this.type = type; }
};
global.KeyboardEvent = class KeyboardEvent {
    constructor(type, opts) { this.type = type; Object.assign(this, opts); }
};

const writes = [];
const shortcuts = [];
const terminal = {write: value => { writes.push(value); return true; }, term: {focus: () => true}};
const keyboard = new SecureKeyboard({
    container,
    getTerminal: () => terminal,
    onShortcut: action => { shortcuts.push(action); return true; },
    layout: {
        row_1: [
            {name: "CAPS", cmd: "ESCAPED|-- CAPSLCK: ON", shift_cmd: "ESCAPED|-- CAPSLCK: OFF"},
            {name: "A", cmd: "a", shift_cmd: "A", ctrl_cmd: "\u0001"},
            {name: "CTRL", cmd: "ESCAPED|-- CTRL: LEFT"},
            {name: "", cmd: " "},
            {name: "ENTER", cmd: "\r"},
            {name: "ESCAPED|-- ICON: ARROW_LEFT", cmd: "\u001bOD"}
        ]
    }
});

const keys = container.querySelectorAll(".keyboard_key");
const pointer = {preventDefault: () => {}, pointerId: 1};
const click = key => {
    key.listeners.pointerdown[0](pointer);
    key.listeners.pointerup[0](pointer);
};

click(keys[1]);
assert.deepStrictEqual(writes, ["a"]);
assert(!keys[1].classList.contains("active"));

click(keys[0]);
assert.strictEqual(container.dataset.isCapsLckOn, "true");
click(keys[1]);
assert.deepStrictEqual(writes, ["a", "A"]);
click(keys[0]);
assert.strictEqual(container.dataset.isCapsLckOn, "false");

keys[2].listeners.pointerdown[0](pointer);
click(keys[3]);
keys[2].listeners.pointerup[0](pointer);
assert.deepStrictEqual(shortcuts, ["CONTROL_PLANE"]);
assert.deepStrictEqual(writes, ["a", "A"], "Control Plane shortcut must not leak a space to the terminal");
assert.strictEqual(container.dataset.isCtrlOn, "false");

assert.strictEqual(keys[5].children[0].tagName, "SVG");
assert(!keys[5].textContent.includes("ICON"));

const input = document.createElement("input");
input.value = "ab";
input.selectionStart = input.selectionEnd = 1;
input.focus();
keyboard.detach();
click(keys[1]);
assert.strictEqual(input.value, "aab");
let enter = false;
input.addEventListener("keydown", event => { enter = event.key === "Enter"; });
click(keys[4]);
assert(enter, "virtual Enter must submit through the assistant input key handler");
assert.deepStrictEqual(writes, ["a", "A"], "captured input must never leak into the terminal");
keyboard.attach();

const physicalA = {key: "a", code: "KeyA", ctrlKey: false, shiftKey: false, altKey: false, repeat: false};
const soundsBefore = stdinSounds;
keyboard.keydownHandler(physicalA);
keyboard.keydownHandler(physicalA);
assert.strictEqual(stdinSounds, soundsBefore + 1, "xterm and document must not double-play physical key feedback");
assert(keys[1].classList.contains("active"));
keyboard.keyupHandler(physicalA);
assert(!keys[1].classList.contains("active"));
physicalListeners.blur();
assert.strictEqual(container.querySelectorAll(".keyboard_key.active").length, 0);

assert.strictEqual(keyboard.togglePasswordMode(), true);
assert.strictEqual(window.passwordMode, "true");
assert.strictEqual(keyboard.togglePasswordMode(), false);
assert.strictEqual(window.passwordMode, "false");

delete global.document;
delete global.window;
delete global.Event;
delete global.KeyboardEvent;
console.log("Secure virtual keyboard pointer routing, modifiers, symbols, input capture, highlighting, and release behavior passed");
