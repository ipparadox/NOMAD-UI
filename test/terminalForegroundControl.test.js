const assert = require("assert");
const {TerminalForegroundControl} = require("../src/classes/terminalForegroundControl.class.js");

class FakeButton {
    constructor() {
        this.listeners = {};
        this.attributes = {};
        this.hidden = false;
        this.disabled = false;
    }

    addEventListener(type, listener) {
        this.listeners[type] = listener;
    }

    removeEventListener(type, listener) {
        if (this.listeners[type] === listener) delete this.listeners[type];
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }

    click() {
        const event = {
            prevented: false,
            stopped: false,
            preventDefault() { this.prevented = true; },
            stopPropagation() { this.stopped = true; }
        };
        this.listeners.click(event);
        return event;
    }
}

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

async function run() {
    const listeners = new Map();
    const requests = [];
    let resolveStop;
    const ipc = {
        on: (channel, listener) => listeners.set(channel, listener),
        removeListener: (channel, listener) => {
            if (listeners.get(channel) === listener) listeners.delete(channel);
        },
        invoke: (...args) => {
            requests.push(args);
            if (args[1] === "terminal.getForegroundState") {
                return Promise.resolve({ok: true, foregroundProcessRunning: false});
            }
            return new Promise(resolve => { resolveStop = resolve; });
        },
        emit: (channel, state) => listeners.get(channel)({}, state)
    };
    const button = new FakeButton();
    const container = {hidden: false};
    let resumeCalls = 0;
    const control = new TerminalForegroundControl({
        button,
        container,
        ipc,
        onResume: () => { resumeCalls++; }
    });

    assert.strictEqual(button.hidden, true, "idle shell must hide the terminal X");
    assert.strictEqual(container.hidden, true, "the hidden control must not shift the terminal label");
    assert.strictEqual(button.disabled, true);
    await control.initialize();
    assert.deepStrictEqual(requests, [["terminal-operation", "terminal.getForegroundState"]]);
    assert.strictEqual(button.hidden, true);

    ipc.emit("terminal-foreground-state", {foregroundProcessRunning: true});
    assert.strictEqual(button.hidden, false, "foreground child must reveal the terminal X");
    assert.strictEqual(container.hidden, false);
    assert.strictEqual(button.disabled, false);

    const click = button.click();
    assert.strictEqual(click.prevented, true);
    assert.strictEqual(click.stopped, true);
    assert.strictEqual(button.disabled, true, "the X must debounce while a stop is in progress");
    assert.deepStrictEqual(requests[1], ["terminal-operation", "terminal.stopForeground"],
        "the renderer must send only the closed-vocabulary operation name");
    resolveStop({ok: true, foregroundProcessRunning: false});
    await flush();
    assert.strictEqual(button.hidden, true, "successful stop must hide the terminal X");
    assert.strictEqual(resumeCalls, 1, "keyboard activation must restore terminal input focus after stopping");

    ipc.emit("terminal-foreground-state", {foregroundProcessRunning: true});
    assert.strictEqual(button.hidden, false);
    ipc.emit("terminal-foreground-state", {foregroundProcessRunning: false});
    assert.strictEqual(button.hidden, true, "natural process exit must hide the terminal X");

    control.destroy();
    assert.strictEqual(listeners.has("terminal-foreground-state"), false);
    assert.strictEqual(button.listeners.click, undefined);
    console.log("Terminal foreground X visibility and renderer IPC contract passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
