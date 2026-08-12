const assert = require("assert");
const {
    TerminalForegroundProcessController,
    handleTerminalOperation,
    parseLinuxProcStat
} = require("../src/classes/terminalForegroundProcessController.js");

function processStat(pid, changes = {}) {
    return Object.assign({
        pid,
        state: "S",
        parentPid: 1,
        processGroupId: pid,
        sessionId: 100,
        ttyNumber: 34816,
        foregroundProcessGroupId: pid,
        startTime: String(pid * 10)
    }, changes);
}

function procStatLine(stat, name = "terminal worker") {
    const fields = [
        stat.state,
        stat.parentPid,
        stat.processGroupId,
        stat.sessionId,
        stat.ttyNumber,
        stat.foregroundProcessGroupId
    ].map(String).concat(Array(13).fill("0"), stat.startTime);
    return `${stat.pid} (${name}) ${fields.join(" ")}\n`;
}

function fixture(opts = {}) {
    const shell = processStat(100, {
        processGroupId: 100,
        sessionId: 100,
        foregroundProcessGroupId: 100,
        startTime: "1000"
    });
    const records = new Map([[shell.pid, shell]]);
    const signals = [];
    const states = [];
    const controller = new TerminalForegroundProcessController({
        platform: "linux",
        shellPid: shell.pid,
        readProcessStat: async pid => records.has(pid) ? Object.assign({}, records.get(pid)) : null,
        listProcessIds: async () => Array.from(records.keys()),
        kill: (target, signal) => {
            signals.push([target, signal]);
            if (opts.onSignal) opts.onSignal({target, signal, shell, records});
        },
        wait: async milliseconds => {
            if (opts.onWait) await opts.onWait({milliseconds, shell, records});
        },
        setInterval: opts.setInterval,
        clearInterval: opts.clearInterval,
        onState: state => states.push(state)
    });
    return {controller, records, shell, signals, states};
}

function addForegroundChild(test, pid = 200, changes = {}) {
    test.shell.foregroundProcessGroupId = pid;
    test.records.set(pid, processStat(pid, Object.assign({
        processGroupId: pid,
        sessionId: test.shell.sessionId,
        ttyNumber: test.shell.ttyNumber,
        foregroundProcessGroupId: pid
    }, changes)));
}

async function run() {
    const parsedSource = processStat(321, {
        parentPid: 100,
        processGroupId: 320,
        sessionId: 100,
        ttyNumber: 34816,
        foregroundProcessGroupId: 320,
        startTime: "987654321"
    });
    assert.deepStrictEqual(parseLinuxProcStat(procStatLine(parsedSource, "worker (safe)")), parsedSource,
        "Linux stat parsing must tolerate spaces and parentheses in process names");
    assert.strictEqual(parseLinuxProcStat("not a proc stat"), null);

    const lifecycle = fixture();
    assert.deepStrictEqual(await lifecycle.controller.refresh(), {
        ok: true,
        foregroundProcessRunning: false
    }, "an idle shell must not expose an active stop control");
    assert.deepStrictEqual(lifecycle.signals, []);

    addForegroundChild(lifecycle);
    assert.strictEqual((await lifecycle.controller.refresh()).foregroundProcessRunning, true,
        "the PTY foreground child must make the stop control available");
    assert.deepStrictEqual(lifecycle.states[lifecycle.states.length - 1], {
        ok: true,
        foregroundProcessRunning: true
    });
    lifecycle.shell.foregroundProcessGroupId = lifecycle.shell.processGroupId;
    lifecycle.records.delete(200);
    assert.strictEqual((await lifecycle.controller.refresh()).foregroundProcessRunning, false,
        "natural foreground-process exit must clear the stop control");

    let poll;
    let pollCleared = false;
    const automatic = fixture({
        setInterval: callback => {
            poll = callback;
            return {unref() {}};
        },
        clearInterval: () => { pollCleared = true; }
    });
    await automatic.controller.start();
    addForegroundChild(automatic);
    await poll();
    assert.strictEqual(automatic.controller.getState().foregroundProcessRunning, true,
        "polling must discover commands that start without relying on typed text or terminal output");
    automatic.shell.foregroundProcessGroupId = automatic.shell.processGroupId;
    automatic.records.delete(200);
    await poll();
    assert.strictEqual(automatic.controller.getState().foregroundProcessRunning, false,
        "polling must clear state when a command exits naturally");
    automatic.controller.destroy();
    assert.strictEqual(pollCleared, true);

    const cooperative = fixture({
        onSignal: ({signal, shell, records}) => {
            if (signal !== "SIGINT") return;
            shell.foregroundProcessGroupId = shell.processGroupId;
            records.delete(200);
        }
    });
    addForegroundChild(cooperative);
    await cooperative.controller.refresh();
    const cooperativeResult = await cooperative.controller.stopForeground();
    assert.deepStrictEqual(cooperative.signals, [[-200, "SIGINT"]],
        "the first stop action must signal only the kernel-reported foreground process group");
    assert.strictEqual(cooperative.records.has(100), true, "the NOMAD shell must survive a cooperative stop");
    assert.strictEqual(cooperativeResult.foregroundProcessRunning, false);

    const resistant = fixture({
        onSignal: ({signal, shell, records}) => {
            if (signal !== "SIGKILL") return;
            shell.foregroundProcessGroupId = shell.processGroupId;
            records.delete(200);
        }
    });
    addForegroundChild(resistant);
    await resistant.controller.refresh();
    await resistant.controller.stopForeground();
    assert.deepStrictEqual(resistant.signals, [
        [-200, "SIGINT"],
        [-200, "SIGTERM"],
        [-200, "SIGKILL"]
    ], "a resistant foreground group must receive bounded INT, TERM, then KILL escalation");
    assert.strictEqual(resistant.signals.some(([target]) => target === -100), false,
        "escalation must never signal the shell process group");
    assert.strictEqual(resistant.records.has(100), true);

    const idle = fixture();
    await idle.controller.stopForeground();
    assert.deepStrictEqual(idle.signals, [], "an idle shell must never be signaled");

    const unrelated = fixture();
    unrelated.records.set(900, processStat(900, {
        processGroupId: 900,
        sessionId: 900,
        ttyNumber: 999,
        foregroundProcessGroupId: 900
    }));
    await unrelated.controller.stopForeground();
    assert.deepStrictEqual(unrelated.signals, [], "an arbitrary unrelated process cannot be selected");
    unrelated.shell.foregroundProcessGroupId = 900;
    await unrelated.controller.refresh();
    await unrelated.controller.stopForeground();
    assert.deepStrictEqual(unrelated.signals, [],
        "even a claimed group is refused when no live member belongs to the shell session and TTY");

    const reused = fixture({
        onSignal: ({signal, records}) => {
            if (signal !== "SIGINT") return;
            records.set(200, processStat(200, {
                processGroupId: 200,
                sessionId: 100,
                ttyNumber: 34816,
                foregroundProcessGroupId: 200,
                startTime: "different-generation"
            }));
        }
    });
    addForegroundChild(reused);
    await reused.controller.refresh();
    await reused.controller.stopForeground();
    assert.deepStrictEqual(reused.signals, [[-200, "SIGINT"]],
        "escalation must stop when the captured process identity no longer exists");

    let stopCalls = 0;
    const boundaryTerminal = {
        getForegroundProcessState: async () => ({
            ok: true,
            foregroundProcessRunning: true,
            pid: 1234,
            processGroupId: 1234,
            signal: "SIGKILL"
        }),
        stopForeground: async () => {
            stopCalls++;
            return {ok: true, foregroundProcessRunning: false, pid: 1234};
        }
    };
    const publicState = await handleTerminalOperation(boundaryTerminal, ["terminal.getForegroundState"]);
    assert.deepStrictEqual(publicState, {ok: true, foregroundProcessRunning: true},
        "main-to-renderer state must remove all process identity details");
    assert.deepStrictEqual(await handleTerminalOperation(boundaryTerminal, ["terminal.stopForeground"]), {
        ok: true,
        foregroundProcessRunning: false
    });
    assert.strictEqual(stopCalls, 1);

    const invalidRequests = [
        [{operation: "terminal.stopForeground", pid: 200}],
        ["terminal.stopForeground", 200],
        ["terminal.stopForeground", "SIGKILL"],
        ["terminal.stopForeground", {processGroupId: 200}],
        ["terminal.stopForeground "]
    ];
    for (const request of invalidRequests) {
        const result = await handleTerminalOperation(boundaryTerminal, request);
        assert.strictEqual(result.ok, false);
    }
    assert.strictEqual(stopCalls, 1, "renderer-supplied PID, group, signal, or extra data must never reach the controller");
    assert.strictEqual(JSON.stringify(publicState).includes("1234"), false);
    assert.strictEqual(JSON.stringify(publicState).includes("SIGKILL"), false);

    console.log("Terminal foreground detection, identity validation, escalation, and IPC boundary passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
