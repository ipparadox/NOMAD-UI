"use strict";
// Run explicitly with Electron, never via the Node unit-test glob.
// Exercises the actual production entrypoint, services, assets and WebSocket.
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {app, clipboard} = require("electron");
process.env.NOMAD_PRODUCTION = "1";
app.setName(require("../src/package.json").productName);
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "nomad-secure-gui-")));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const testI3 = process.argv.includes("--test-i3");
if (testI3) {
    // Main-only fixture configuration; real registry validation and OS launches.
    // No user registry or application profile is modified.
    assert(process.env.I3SOCK, "nested i3 socket required");
    const registryModule = require("../src/classes/applicationRegistry.js");
    const RealRegistry = registryModule.ApplicationRegistry;
    const registryPath = path.join(app.getPath("userData"), "gui-apps.json");
    fs.writeFileSync(registryPath, JSON.stringify({version: 1, applications: [
        {id: "gui-probe", displayName: "GUI PROBE", type: "external", executable: "/usr/bin/xmessage",
            args: ["-name", "nomad-gui-probe", "-buttons", "OK", "NOMAD GUI lifecycle"], wmInstance: "nomad-gui-probe"},
        {id: "vlc", displayName: "VLC", type: "external", executable: "/usr/bin/vlc",
            args: ["--no-one-instance", "--no-media-library", "--no-qt-privacy-ask"], wmClass: "vlc"}
    ]}), {mode: 0o600});
    registryModule.ApplicationRegistry = class extends RealRegistry {
        constructor(options) { super({...options, registryPath}); }
    };
    const wmModule = require("../src/classes/i3WindowManager.class.js");
    const RealWindowManager = wmModule.I3WindowManager;
    wmModule.I3WindowManager = class extends RealWindowManager {
        constructor(options) {
            super({...options, spawn(executable, args, spawnOptions) {
                return require("child_process").spawn(executable, args, {...spawnOptions, stdio: "inherit"});
            }});
        }
    };
}
let tested = false;
app.on("browser-window-created", (event, win) => {
    if (tested) return;
    tested = true;
    win.webContents.once("did-finish-load", async () => {
        const read = source => win.webContents.executeJavaScript(source, true);
        const until = async (predicate, label, timeout = 15000) => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                if (await predicate()) return;
                await sleep(150);
            }
            throw new Error(`Timed out: ${label}`);
        };
        let savedClipboard;
        let exitCode = 0;
        try {
            for (let i = 0; i < 100; i++) {
                if (await read("document.body.dataset.nomadRendererReady === 'true'")) break;
                await sleep(200);
            }
            assert(await read("document.body.dataset.nomadRendererReady === 'true'"), "frontend ready");
            const prefs = win.webContents.getLastWebPreferences();
            assert.strictEqual(prefs.nodeIntegration, false);
            assert.strictEqual(prefs.contextIsolation, true);
            assert.strictEqual(prefs.enableRemoteModule, false);
            assert.strictEqual(prefs.devTools, false);
            assert(await read("typeof require === 'undefined' && typeof process === 'undefined' && typeof module === 'undefined'"));
            const snapshot = `(() => ({
                clock: Number(document.body.dataset.nomadClockTimestamp),
                cpu: Number(document.body.dataset.nomadCpuGraphTimestamp),
                memory: Number(document.body.dataset.nomadMemoryTimestamp),
                traffic: Number(document.body.dataset.nomadNetworkGraphTimestamp),
                globe: Number(document.body.dataset.nomadGlobeTick),
                system: window.nomadTelemetry.system.lastSequence,
                network: window.nomadTelemetry.network.lastSequence
            }))()`;
            const before = await read(snapshot);
            // Exercise the real extra-PTY lifecycle and rapid duplicate activation.
            assert(await read("Promise.all([window.focusShellTab(1), window.focusShellTab(1)]).then(results => results.every(Boolean))"));
            assert.strictEqual(await read("Object.keys(window.term).length"), 2);
            await read("window.term[1].write('exit\\r')");
            await until(() => read("!window.term[1] && window.currentTerm === 0"), "extra terminal closes");
            assert(await read("window.focusShellTab(1)"), "closed tab reopens");
            await read("window.term[1].write('exit\\r')");
            await until(() => read("!window.term[1] && window.currentTerm === 0"), "reopened terminal closes");
            await read("document.getElementById('mod_toplist').click()");
            assert(await read("Boolean(document.getElementById('nomad_process_list'))"));
            await read("document.querySelector('#processContainer td.header').click(); window.nomadTelemetry.system.closeProcessList()");
            // Real mouse-handler path, then a harmless command over the authenticated transport.
            assert(await read(`(() => {
                const key = Array.from(document.querySelectorAll('.keyboard_key')).find(key => key.dataset.cmd === 'x');
                key.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 1, bubbles: true}));
                const highlighted = key.classList.contains('active');
                key.dispatchEvent(new PointerEvent('pointerup', {pointerId: 1, bubbles: true}));
                return highlighted && !key.classList.contains('active');
            })()`));
            await sleep(300);
            assert(await read("window.term[0].write(\"\\u0015printf 'NOMAD_%s\\\\n' 'GUI_OK'\\r\")"));
            await sleep(500);
            assert(await read(`(() => {
                const b = window.term[0].term.buffer.active;
                return Array.from({length: b.length}, (_, i) => b.getLine(i).translateToString()).some(line => line.includes('NOMAD_GUI_OK'));
            })()`), "authenticated terminal round trip");
            await read("window.term[0].write('sleep 30\\r')");
            await until(() => read("!document.getElementById('terminal_stop_foreground').hidden"), "foreground-stop X appears");
            await read("document.getElementById('terminal_stop_foreground').click()");
            await until(() => read("document.getElementById('terminal_stop_foreground').hidden"), "foreground-stop X stops process");
            win.focus();
            win.webContents.sendInputEvent({type: "keyDown", keyCode: "Space", modifiers: ["control"]});
            win.webContents.sendInputEvent({type: "keyUp", keyCode: "Space", modifiers: ["control"]});
            await sleep(200);
            assert(await read("window.nomadControlPlane.opened && window.nomadInputCapture.active"));
            await win.webContents.insertText("replace me");
            win.webContents.sendInputEvent({type: "keyDown", keyCode: "A", modifiers: ["control"]});
            win.webContents.sendInputEvent({type: "keyUp", keyCode: "A", modifiers: ["control"]});
            await sleep(100);
            await win.webContents.insertText("security status");
            assert.strictEqual(await read("window.nomadControlPlane.input.value"), "security status", "native Ctrl+A");
            savedClipboard = clipboard.readText();
            win.webContents.sendInputEvent({type: "keyDown", keyCode: "A", modifiers: ["control"]});
            win.webContents.sendInputEvent({type: "keyDown", keyCode: "C", modifiers: ["control"]});
            win.webContents.sendInputEvent({type: "keyUp", keyCode: "C", modifiers: ["control"]});
            await sleep(200);
            assert.strictEqual(clipboard.readText(), "security status", "native Ctrl+C");
            await win.webContents.insertText("");
            win.webContents.sendInputEvent({type: "keyDown", keyCode: "V", modifiers: ["control"]});
            win.webContents.sendInputEvent({type: "keyUp", keyCode: "V", modifiers: ["control"]});
            await sleep(200);
            assert.strictEqual(await read("window.nomadControlPlane.input.value"), "security status", "native Ctrl+V");
            await read(`(() => {
                const key = document.querySelector('.keyboard_enter');
                key.dispatchEvent(new PointerEvent('pointerdown', {pointerId: 2, bubbles: true}));
                key.dispatchEvent(new PointerEvent('pointerup', {pointerId: 2, bubbles: true}));
            })()`);
            await sleep(1200);
            assert(await read("window.nomadControlPlane.input.value === '' && !window.nomadControlPlane.pending"), "virtual Enter submits assistant");
            await read("window.nomadControlPlane.close()");
            const repoCount = await read("window.repositoryLauncher.repositories.length");
            if (repoCount) {
                assert(await read(`(async () => {
                    const panel = window.repositoryLauncher;
                    const id = panel.repositories[0].id;
                    panel.selectRepository(id);
                    await panel.refresh();
                    const kept = panel.selectedRepositoryId === id;
                    panel.close();
                    return kept;
                })()`), "repository selection persists across trusted refresh");
            }
            await read("document.getElementById('workspace_slot_add').click()");
            assert(await read("window.applicationLauncher.isOpen && document.querySelectorAll('[data-workspace-slot]').length > 0"));
            await read("window.applicationLauncher.close()");
            if (testI3) {
                const {execFile} = require("child_process");
                const i3Tree = () => new Promise((resolve, reject) => execFile("i3-msg", ["-s", process.env.I3SOCK, "-t", "get_tree"],
                    (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
                const leaves = (node, workspace) => {
                    const owner = node.type === "workspace" ? node.name : workspace;
                    const children = (node.nodes || []).concat(node.floating_nodes || []);
                    return (node.window ? [{node, workspace: owner}] : []).concat(children.flatMap(child => leaves(child, owner)));
                };
                const native = async id => leaves(await i3Tree()).find(({node}) => id === "gui-probe"
                    ? node.window_properties.instance === "nomad-gui-probe" : node.window_properties.class === "vlc");
                for (const id of ["gui-probe", "vlc"]) {
                    assert(await read(`window.applicationLauncher.activate('${id}')`), `${id} launcher activation`);
                    await until(async () => { const view = await native(id); return view && view.node.focused; }, `${id} native focus`);
                    await until(async () => {
                        const viewport = await read(`(() => { const r = document.getElementById('workspace_viewport').getBoundingClientRect();
                            return {x: r.x, y: r.y, width: r.width, height: r.height}; })()`);
                        const bounds = win.getContentBounds();
                        const rect = (await native(id)).node.rect;
                        return ["x", "y", "width", "height"].every(key => {
                            const expected = viewport[key] + (key === "x" ? bounds.x : key === "y" ? bounds.y : 0);
                            return Math.abs(rect[key] - expected) < 3;
                        });
                    }, `${id} geometry settles after native map/resize`);
                    assert.strictEqual(await read("window.workspaceManager.getState().slots[0].id"), id, "active-first tabs");
                    await read(`window.workspaceManager.minimize('${id}')`);
                    await until(async () => { const view = await native(id); return view && view.workspace === "__i3_scratch"; }, `${id} hides`);
                    await read(`window.workspaceManager.restore('${id}')`);
                    await until(async () => { const view = await native(id); return view && view.node.focused; }, `${id} restores`);
                    await read(`window.workspaceManager.fullscreen('${id}', true)`);
                    await until(async () => (await native(id)).node.fullscreen_mode > 0, `${id} fullscreen`);
                    await read(`window.workspaceManager.fullscreen('${id}', false)`);
                    await until(async () => (await native(id)).node.fullscreen_mode === 0, `${id} exits fullscreen`);
                }
                await read("window.workspaceManager.focus('gui-probe')");
                await until(async () => (await native("gui-probe")).node.focused, "MRU focus restores probe");
                assert.strictEqual(await read("window.workspaceManager.getState().slots[0].id"), "gui-probe");
                await read("window.workspaceManager.focus('terminal')");
                await until(async () => (await native("gui-probe")).workspace === "__i3_scratch"
                    && (await native("vlc")).workspace === "__i3_scratch", "terminal hides external windows");
                for (const id of ["gui-probe", "vlc"]) {
                    await read(`window.workspaceManager.close('${id}')`);
                    await until(async () => !(await native(id)), `${id} native close`);
                }
                console.log("SECURE I3 PASS: real generic app + VLC, geometry, native focus, minimize/restore, fullscreen, active-first/MRU, terminal return, close");
            }
            // Count actual chart paints, not merely appended sample timestamps.
            await read(`(() => {
                window.nomadGuiPaints = {cpu: 0, traffic: 0};
                for (const [name, charts] of [['cpu', window.nomadTelemetry.system.cpuCharts],
                    ['traffic', window.nomadTelemetry.network.trafficCharts]]) {
                    for (const chart of charts) {
                        const render = chart.render;
                        chart.render = function(...args) { window.nomadGuiPaints[name]++; return render.apply(this, args); };
                    }
                }
            })()`);
            const values = {cpu: new Set(), memory: new Set(), network: new Set(), globe: new Set()};
            for (let second = 0; second < 30; second++) {
                await sleep(1000);
                const measured = await read(`(async () => {
                    const system = await window.nomad.system.getTelemetry();
                    const network = await window.nomad.network.getTelemetry();
                    const camera = window.nomadTelemetry.network.globe.globe.camera.position;
                    return {cpu: system.cpu && system.cpu.load, memory: system.memory && system.memory.active,
                        network: network.traffic && [network.traffic.rx_bytes, network.traffic.tx_bytes].join(':'),
                        globe: [camera.x, camera.y, camera.z].join(':')};
                })()`);
                for (const key of Object.keys(values)) if (measured[key] !== null) values[key].add(measured[key]);
            }
            assert(values.cpu.size > 1, "real CPU measurements change");
            assert(values.memory.size > 1, "real memory measurements change");
            assert(values.network.size > 1, "real network byte counters change");
            assert(values.globe.size > 1, "globe camera actually moves");
            const paints = await read("window.nomadGuiPaints");
            assert(paints.cpu > 30 && paints.traffic > 30, "CPU and network canvases actually repaint");
            console.log(`LIVE MEASUREMENTS PASS: CPU=${values.cpu.size} RAM=${values.memory.size} network=${values.network.size} globe=${values.globe.size} distinct observations; CPU paints=${paints.cpu} traffic paints=${paints.traffic}; foreground-stop X passed`);
            const after = await read(snapshot);
            Object.keys(before).forEach(key => assert(after[key] > before[key], `${key} must advance during 30s observation`));
            console.log(`SECURE GUI PASS: isolation, terminal round trip, virtual keys, native Ctrl+A/C/V, Ctrl+Space, assistant Enter, repository selection (${repoCount}), workspace launcher, 30s clock/system/network/graphs/globe progression`);
            console.log(testI3 ? "NOT VALIDATED HERE: real CODE/BROWSER profiles and dedicated GDM login" : "NOT VALIDATED HERE: i3 managed external applications and dedicated GDM session");
        } catch (error) {
            console.error(`SECURE GUI FAIL: ${error.message}`);
            if (testI3) {
                const tree = JSON.parse(require("child_process").execFileSync("i3-msg", ["-s", process.env.I3SOCK, "-t", "get_tree"], {encoding: "utf8"}));
                const inspect = node => {
                    if (node.window) console.log("NATIVE WINDOW", node.window_properties);
                    (node.nodes || []).concat(node.floating_nodes || []).forEach(inspect);
                };
                inspect(tree);
            }
            exitCode = 1;
        } finally {
            if (savedClipboard !== undefined) clipboard.writeText(savedClipboard);
            app.exit(exitCode);
        }
    });
});
require("../src/_boot.js");
