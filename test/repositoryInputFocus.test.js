const assert = require("assert");
const {InputCaptureController} = require("../src/classes/inputCapture.class.js");
const {RepositoryLauncher} = require("../src/classes/repositoryLauncher.class.js");

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

async function run() {
    const terminalKeys = [];
    const clones = [];
    const shortcutCaptureStates = [];
    let activeElement = null;
    let clipboard = "";
    let terminalFocusCalls = 0;
    const keyboard = {
        linkedToTerm: true,
        detachCalls: 0,
        attachCalls: 0,
        detach() {
            this.linkedToTerm = false;
            this.detachCalls++;
        },
        attach() {
            this.linkedToTerm = true;
            this.attachCalls++;
        }
    };
    const terminal = {
        focus() {
            activeElement = terminal;
            terminalFocusCalls++;
        }
    };
    const input = {
        value: "",
        selectionStart: 0,
        selectionEnd: 0,
        focus() {
            activeElement = input;
            this.selectionStart = Math.min(this.selectionStart, this.value.length);
            this.selectionEnd = Math.min(this.selectionEnd, this.value.length);
        }
    };
    const capture = new InputCaptureController({
        keyboard,
        isTerminalActive: () => true,
        focusTerminal: () => terminal.focus(),
        onchange: active => shortcutCaptureStates.push(active)
    });
    const launcher = new RepositoryLauncher({
        loadRepositories: async () => ({ok: true, repositories: []}),
        getActiveId: () => "terminal",
        onResume: id => {
            if (id !== "terminal") return false;
            terminal.focus();
            return true;
        },
        onclone: async repositoryUrl => {
            clones.push(repositoryUrl);
            return {ok: true, status: "CLONE COMPLETE\nREPOSITORY REGISTERED"};
        },
        onInputCaptureChange: active => {
            if (active) capture.acquire("repository-clone");
            else capture.release("repository-clone");
        }
    });
    launcher.cloneInputElement = input;

    const dispatchKey = (key, modifiers = {}) => {
        const state = {prevented: false, stopped: false, immediate: false};
        const event = {
            key,
            target: activeElement,
            ctrlKey: modifiers.ctrlKey === true,
            metaKey: modifiers.metaKey === true,
            altKey: modifiers.altKey === true,
            preventDefault: () => { state.prevented = true; },
            stopPropagation: () => { state.stopped = true; },
            stopImmediatePropagation: () => { state.immediate = true; }
        };
        launcher._handleKeydown(event);
        if (state.prevented) return state;

        if (activeElement === terminal) {
            terminalKeys.push(key);
            return state;
        }
        if (activeElement !== input) return state;

        const start = input.selectionStart;
        const end = input.selectionEnd;
        const replaceRange = (rangeStart, rangeEnd, text) => {
            input.value = input.value.slice(0, rangeStart) + text + input.value.slice(rangeEnd);
            input.selectionStart = input.selectionEnd = rangeStart + text.length;
        };
        if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "a") {
            input.selectionStart = 0;
            input.selectionEnd = input.value.length;
        } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "c") {
            clipboard = input.value.slice(start, end);
        } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "v") {
            replaceRange(start, end, clipboard);
        } else if (key === "Backspace") {
            if (start !== end) replaceRange(start, end, "");
            else if (start > 0) replaceRange(start - 1, end, "");
        } else if (key === "Delete") {
            if (start !== end) replaceRange(start, end, "");
            else if (end < input.value.length) replaceRange(start, end + 1, "");
        } else if (key === "ArrowLeft") {
            input.selectionStart = input.selectionEnd = Math.max(0, start - 1);
        } else if (key === "ArrowRight") {
            input.selectionStart = input.selectionEnd = Math.min(input.value.length, end + 1);
        } else if (key === "Home") {
            input.selectionStart = input.selectionEnd = 0;
        } else if (key === "End") {
            input.selectionStart = input.selectionEnd = input.value.length;
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            replaceRange(start, end, key);
        }
        return state;
    };

    assert.strictEqual(launcher.openAdd(), true);
    assert.strictEqual(capture.active, true, "the clone overlay must explicitly own text input");
    assert.strictEqual(keyboard.linkedToTerm, false, "capture must suspend virtual-keyboard terminal routing");
    assert.deepStrictEqual(shortcutCaptureStates, [true]);

    input.focus();
    assert.strictEqual(capture.handleMouseup(), false, "captured mouseup must not restore xterm focus");
    assert.strictEqual(activeElement, input, "URL input must retain focus after mouseup/click");
    assert.strictEqual(terminalFocusCalls, 0);

    activeElement = null;
    input.focus();
    capture.handleMouseup();
    assert.strictEqual(activeElement, input, "clicking the URL input again must restore and retain focus");

    input.value = "https://github.com/owner/rep";
    input.selectionStart = input.selectionEnd = input.value.length;
    dispatchKey("o");
    assert.strictEqual(input.value, "https://github.com/owner/repo");
    assert.deepStrictEqual(terminalKeys, [], "printable input must not reach the terminal");

    dispatchKey("Backspace");
    assert.strictEqual(input.value, "https://github.com/owner/rep", "Backspace must edit the URL field");
    dispatchKey("o");
    dispatchKey("Home");
    assert.strictEqual(input.selectionStart, 0);
    dispatchKey("Delete");
    assert.strictEqual(input.value, "ttps://github.com/owner/repo", "Delete must edit the URL field");
    dispatchKey("h");
    dispatchKey("End");
    dispatchKey("ArrowLeft");
    assert.strictEqual(input.selectionStart, input.value.length - 1);
    dispatchKey("ArrowRight");
    assert.strictEqual(input.selectionStart, input.value.length);
    const arrowDown = dispatchKey("ArrowDown");
    assert.strictEqual(arrowDown.prevented, false, "clone navigation must not steal input editing keys");
    assert.strictEqual(launcher.selectedChoiceIndex, 0);

    const selectAll = dispatchKey("a", {ctrlKey: true});
    assert.strictEqual(selectAll.prevented, false, "Ctrl+A must retain native input behavior");
    assert.deepStrictEqual([input.selectionStart, input.selectionEnd], [0, input.value.length]);
    dispatchKey("c", {ctrlKey: true});
    input.selectionStart = input.selectionEnd = input.value.length;
    dispatchKey("v", {ctrlKey: true});
    assert.ok(input.value.endsWith("https://github.com/owner/repo"), "Ctrl+C/Ctrl+V must retain native input behavior");

    input.value = "https://github.com/owner/repository";
    input.selectionStart = input.selectionEnd = input.value.length;
    launcher.selectedChoiceIndex = 1;
    const enter = dispatchKey("Enter");
    assert.strictEqual(enter.prevented, true);
    await flush();
    await flush();
    assert.deepStrictEqual(clones, ["https://github.com/owner/repository"]);
    assert.strictEqual(launcher.view, "clone-complete", "Enter in the URL input must submit CLONE, not the highlighted launcher choice");

    const escape = dispatchKey("Escape");
    assert.strictEqual(escape.prevented, true);
    assert.strictEqual(launcher.isOpen, false, "Escape must close the clone interface");
    assert.strictEqual(capture.active, false);
    assert.strictEqual(keyboard.linkedToTerm, true, "closing must restore terminal keyboard routing");
    assert.deepStrictEqual(shortcutCaptureStates, [true, false]);
    assert.strictEqual(activeElement, terminal, "closing must restore the previous terminal focus");

    dispatchKey("x");
    assert.deepStrictEqual(terminalKeys, ["x"], "normal terminal keyboard handling must resume after close");
    assert.strictEqual(capture.handleMouseup(), true, "legacy mouseup terminal restoration must resume after close");

    launcher.openAdd();
    input.focus();
    dispatchKey("Escape");
    assert.strictEqual(launcher.isOpen, false, "Escape must also close an unsubmitted clone form");
    launcher.destroy();

    console.log("Repository clone input focus ownership, editing, submission, Escape, and terminal restoration passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
