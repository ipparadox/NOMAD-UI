"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sizes = [[1920,1080], [1920,1200], [1600,900], [1366,768], [1200,800]];
const output = "/tmp/nomad-v068";
// Capture before production boot sanitizes inherited environment variables.
const retainedAudit = process.env.NOMAD_GUI_RETAINED_AUDIT === '1';
fs.mkdirSync(output, {recursive: true});

async function keyboardSnapshot(read) {
    return read(`(() => {
        const rect = e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
        const keyboard=document.getElementById('keyboard'), style=getComputedStyle(keyboard);
        return {workspace:rect(document.getElementById('main_shell')), repository:rect(document.getElementById('repository')),
            keyboard:rect(keyboard), visibility:style.visibility, opacity:Number(style.opacity),
            keys:[...keyboard.querySelectorAll('.keyboard_key')].map(rect), width:innerWidth,height:innerHeight};
    })()`);
}

async function keyboardSettled(read, hidden, label) {
    // CSS transitions start after style resolution, not at the harness mutation.
    // Await their actual completion on slow/software-rendered VM compositors.
    await read(`(async () => {
        const elements=['keyboard','repository'].map(id=>document.getElementById(id));
        elements.forEach(element=>element.getBoundingClientRect());
        let timer;
        try { await Promise.race([
            Promise.all(elements.flatMap(element=>element.getAnimations()).map(animation=>animation.finished)),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('keyboard transition timeout')),5000);})
        ]); } finally { clearTimeout(timer); }
    })()`);
    const first = await keyboardSnapshot(read);
    await sleep(350);
    const last = await keyboardSnapshot(read);
    for (const area of ['workspace','repository','keyboard']) for (const axis of ['x','y','width','height']) {
        assert(Math.abs(first[area][axis]-last[area][axis]) <= 2, `${label}: no delayed ${area} ${axis} reflow (${first[area][axis]} -> ${last[area][axis]})`);
    }
    assert.strictEqual(last.visibility, hidden ? 'hidden' : 'visible', `${label}: keyboard visibility`);
    if (!hidden) {
        assert(last.opacity > .99, `${label}: keyboard fully revealed`);
        assert(last.keys.length > 40, `${label}: keys mounted`);
        for (const key of last.keys) assert(key.x >= last.repository.right-2 && key.right <= last.width+2
            && key.y >= last.workspace.bottom-2 && key.bottom <= last.height+2, `${label}: key inside lower keyboard region ${JSON.stringify(key)}`);
    }
    // A style read alone does not guarantee capturePage has a new composited frame.
    await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    return last;
}

async function matrix(win, read, login) {
    const results = [];
    for (const [width,height] of sizes) for (const zoom of [1,1.25,1.5]) {
        win.webContents.enableDeviceEmulation({screenPosition: "desktop", screenSize: {width,height},
            viewPosition: {x: 0, y: 0}, viewSize: {width,height}, deviceScaleFactor: 1, scale: 1});
        win.webContents.setZoomFactor(zoom);
        await sleep(300);
        const geometry = await read(`(() => {
            const rect = selector => { const e = document.querySelector(selector); if (!e) return null;
                const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
            return {width:innerWidth,height:innerHeight, card:rect('.nomad-login-center'), cardFooter:rect('.nomad-login-card-footer'), strip:rect('.nomad-login-checks'),
                workspace:rect('#main_shell'), left:rect('#mod_column_left'), right:rect('#mod_column_right'),
                security:rect('#nomad_security_strip'), repository:rect('#repository'), keyboard:rect('#keyboard')};
        })()`);
        const label = `${login ? "login" : "main"}-${width}x${height}-${zoom}`;
        results.push({label,...geometry});
        fs.writeFileSync(path.join(output, `${login ? "login" : "main"}-geometry.json`), JSON.stringify(results,null,2));
        fs.writeFileSync(path.join(output, `${label}.png`), (await win.webContents.capturePage()).toPNG());
        const inside = r => r && r.x >= -2 && r.y >= -2 && r.right <= geometry.width + 2 && r.bottom <= geometry.height + 2;
        if (login) {
            assert(inside(geometry.card), `${label}: login inside viewport ${JSON.stringify(geometry)}`);
            assert(Math.abs(geometry.card.x + geometry.card.width/2 - geometry.width/2) < 2, `${label}: centered login ${JSON.stringify(geometry)}`);
            assert(geometry.card.bottom <= geometry.strip.y + 2, `${label}: card clears statuses`);
            assert(geometry.cardFooter.bottom <= geometry.card.bottom + 2, `${label}: footer contained by card`);
            assert(inside(geometry.strip), `${label}: status strip visible`);
        } else {
            assert(inside(geometry.workspace) && geometry.workspace.height > 150, `${label}: usable workspace`);
            assert(inside(geometry.repository), `${label}: repository inside viewport`);
            assert(geometry.left.bottom <= geometry.repository.y + 2, `${label}: late process list clears repository`);
            assert(geometry.security.bottom <= geometry.keyboard.y + 2, `${label}: security clears keyboard ${JSON.stringify(geometry)}`);
            assert(geometry.left.right <= geometry.workspace.x + 2 && geometry.workspace.right <= geometry.right.x + 2, `${label}: HUD columns do not overlap ${JSON.stringify(geometry)}`);
            assert(await read(`(() => { const globe=window.nomadTelemetry.network.globe.globe;
                return Math.abs(globe.camera.aspect-globe.domElement.offsetWidth/globe.domElement.offsetHeight)<.02; })()`), `${label}: globe projection matches CSS aspect`);
            await read("document.body.classList.add('no-virtual-keyboard')");
            await sleep(80);
            assert(await read(`Math.abs(document.getElementById('main_shell').getBoundingClientRect().height - ${geometry.workspace.height}) < 2`), `${label}: keyboard transition preserves workspace`);
            const closed = await keyboardSettled(read, true, label);
            assert(await read("document.getElementById('repository_container').getBoundingClientRect().right <= innerWidth + 2"), `${label}: expanded repository visible`);
            await read("document.body.classList.remove('no-virtual-keyboard')");
            const opened = await keyboardSettled(read, false, label);
            results[results.length-1].keyboardStates = {closed, opened};
            await read("window.repositoryLauncher.repositories[0] && window.repositoryLauncher.selectRepository(window.repositoryLauncher.repositories[0].id)");
            await sleep(150);
            assert(await read(`(() => { const menu=window.repositoryLauncher.element; if (!window.repositoryLauncher.repositories.length) return true;
                const r=menu.getBoundingClientRect(); return r.x>=0 && r.y>=0 && r.right<=innerWidth+2 && r.bottom<=innerHeight+2 && menu.scrollWidth<=menu.clientWidth+2; })()`), `${label}: repository actions contained without horizontal scrolling`);
            if (zoom === 1) fs.writeFileSync(path.join(output, `repo-selected-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
            await read("window.repositoryLauncher.close({restoreFocus:false})");
            await sleep(150);
        }
        fs.writeFileSync(path.join(output, `${label}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.webContents.disableDeviceEmulation();
    win.webContents.setZoomFactor(1);
    if (!login) {
        await read("window.nomadControlPlane.open(); window.nomadControlPlane.showHelp()");
        await sleep(150);
        fs.writeFileSync(path.join(output,"control-plane.png"),(await win.webContents.capturePage()).toPNG());
        await read("window.nomadControlPlane.close(); window.applicationLauncher.open()");
        await sleep(150);
        fs.writeFileSync(path.join(output,"app-launcher.png"),(await win.webContents.capturePage()).toPNG());
        await read("window.applicationLauncher.close({resume:false})");
        await read("document.body.classList.add('no-virtual-keyboard')");
        await keyboardSettled(read, true, 'native keyboard closed');
        fs.writeFileSync(path.join(output,"keyboard-closed.png"),(await win.webContents.capturePage()).toPNG());
        await read("document.body.classList.remove('no-virtual-keyboard')");
        await keyboardSettled(read, false, 'native keyboard open');
        fs.writeFileSync(path.join(output,"keyboard-open.png"),(await win.webContents.capturePage()).toPNG());
    }
    fs.writeFileSync(path.join(output, `${login ? "login" : "main"}-geometry.json`), JSON.stringify(results,null,2));
    console.log(`POLISH GEOMETRY PASS: ${login ? "login" : "main"}, ${results.length} resolution/scale combinations`);
}
async function diagnostics(win, read, seconds = 10) {
    // CDP counters measure actual engine allocations/listeners; no global timer monkey-patching.
    const debug = win.webContents.debugger;
    if (!debug.isAttached()) debug.attach("1.3");
    await debug.sendCommand("Performance.enable");
    if (retainedAudit) {
        await read('window.focusShellTab(1).then(() => window.focusShellTab(0))');
        await sleep(350);
    }
    const started = Date.now();
    const samples = [];
    const retained = [];
    const collectRetained = async () => {
        await debug.sendCommand('HeapProfiler.collectGarbage');
        retained.push({elapsed:Date.now()-started,dom:await debug.sendCommand('Memory.getDOMCounters'),
            terminalCount:await read('Object.keys(window.term).length')});
    };
    if (retainedAudit) await collectRetained();
    const sample = async () => ({elapsed: Date.now()-started,
        dom: await debug.sendCommand("Memory.getDOMCounters"),
        metrics: (await debug.sendCommand("Performance.getMetrics")).metrics,
        process: require("electron").app.getAppMetrics().find(metric => metric.pid === win.webContents.getOSProcessId())});
    samples.push(await sample());
    const actions = [];
    await read(`window.nomadSoakFrames = {count:0,worst:0,last:performance.now(),start:performance.now()};
        window.nomadSoakTick = t => { const m=window.nomadSoakFrames; m.count++; m.worst=Math.max(m.worst,t-m.last); m.last=t;
            m.id=requestAnimationFrame(window.nomadSoakTick); }; requestAnimationFrame(window.nomadSoakTick);`);
    let nextSample = 60000;
    for (let cycle=0; Date.now()-started < seconds*1000; cycle++) {
        const action = await read(`(() => { const times={}; const measure=(name,fn) => { const start=performance.now(); fn(); times[name]=performance.now()-start; };
            const cp=window.nomadControlPlane;
            measure('controlPlane',()=>cp.open()); cp.close();
            const repo=window.repositoryLauncher.repositories[0];
            if (repo) { measure('repository',()=>window.repositoryLauncher.selectRepository(repo.id)); window.repositoryLauncher.close({restoreFocus:false}); }
            measure('appLauncher',()=>window.applicationLauncher.open()); window.applicationLauncher.close({resume:false});
            measure('keyboard',()=>document.body.classList.toggle('no-virtual-keyboard'));
            return times; })()`);
        actions.push(action);
        if (Object.values(action).some(ms => ms > 100)) console.log(`POLISH BUDGET WARNING: feedback ${JSON.stringify(action)}`);
        if (cycle % 10 === 0) {
            await read("window.focusShellTab(window.currentTerm === 0 ? 1 : 0)");
            await read("window.term[window.currentTerm].write('printf NOMAD_SOAK' + String.fromCharCode(13))");
        }
        if (cycle % 60 === 0) {
            const state = await read("window.nomad.control.request('APPLICATION_OPEN','gui-probe')");
            assert(state.ok, "soak opens only registered fixture");
            await sleep(200);
            const closed = await read("window.nomad.control.request('APPLICATION_CLOSE','gui-probe')");
            assert(closed.ok, "soak closes only registered fixture");
            await read("window.workspaceManager.focus('terminal')");
        }
        await sleep(Math.min(1000, Math.max(0, seconds*1000-(Date.now()-started))));
        if (Date.now()-started >= nextSample) {
            samples.push(await sample());
            nextSample = Date.now()-started + 60000;
            fs.writeFileSync(path.join(output,"soak-progress.json"), JSON.stringify({seconds:(Date.now()-started)/1000,samples,actions},null,2));
            console.log(`SOAK ${Math.round((Date.now()-started)/1000)}s: ${JSON.stringify(samples[samples.length-1].dom)}`);
        }
    }
    const frames = await read(`(() => { const m=window.nomadSoakFrames; cancelAnimationFrame(m.id);
        document.body.classList.remove('no-virtual-keyboard'); return {fps:m.count*1000/(performance.now()-m.start),worst:m.worst}; })()`);
    samples.push(await sample());
    fs.writeFileSync(path.join(output,"soak.json"),JSON.stringify({seconds,elapsedSeconds:(Date.now()-started)/1000,frames,samples,actions},null,2));
    if (retainedAudit) {
        await collectRetained();
        fs.writeFileSync(path.join(output,'retained.json'),JSON.stringify(retained,null,2));
    }
    fs.writeFileSync(path.join(output,'health.json'),JSON.stringify(await read('nomadSystemHealth(window)'),null,2));
    console.log(`POLISH SOAK: ${seconds}s, ${frames.fps.toFixed(1)} FPS, worst frame ${frames.worst.toFixed(1)}ms; metrics ${output}/soak.json`);
    await read(fs.readFileSync(path.join(__dirname,"support/visualAudit.js"),"utf8"));
    await sleep(150);
    fs.writeFileSync(path.join(output,"visual-audit.png"),(await win.webContents.capturePage()).toPNG());
    await read("document.getElementById('nomad_dev_visual_audit').remove()");
    debug.detach();
}
module.exports = {matrix, diagnostics};
