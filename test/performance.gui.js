"use strict";
// Test-only CDP profiling. Never imported by the production renderer or preload.
const fs = require('fs');
const {app} = require('electron');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function measure(win, read, label, startup) {
    const directory = `/tmp/nomad-v069/${label}`;
    fs.mkdirSync(directory, {recursive:true});
    const debug = win.webContents.debugger;
    if (!debug.isAttached()) debug.attach('1.3');
    await debug.sendCommand('Performance.enable');
    await debug.sendCommand('Profiler.enable');
    const results = [];
    for (const [width,height] of [[1920,1080],[1366,768]]) {
        win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height},viewPosition:{x:0,y:0},viewSize:{width,height},deviceScaleFactor:1,scale:1});
        await sleep(2000);
        await read(`(() => {
            const audit = window.nomadPerf = {frames:[],longTasks:[],calls:{},restores:[],last:0};
            const wrap=(object,key,name)=>{if(!object || typeof object[key]!=='function')return;const original=object[key];
                object[key]=function(...args){const start=performance.now();try{return original.apply(this,args);}finally{const m=audit.calls[name]||(audit.calls[name]={count:0,ms:0,max:0});const dt=performance.now()-start;m.count++;m.ms+=dt;m.max=Math.max(m.max,dt);}};
                audit.restores.push(()=>object[key]=original);};
            const t=window.nomadTelemetry;
            wrap(t.network.globe.globe,'tick','globe');wrap(t.system,'apply','system');wrap(t.network,'apply','network');
            [...t.system.cpuCharts,...t.network.trafficCharts].forEach((chart,i)=>wrap(chart,'render','chart'+i));
            const tick=time=>{if(audit.last)audit.frames.push(time-audit.last);audit.last=time;audit.raf=requestAnimationFrame(tick);};audit.raf=requestAnimationFrame(tick);
            audit.observer=new PerformanceObserver(list=>audit.longTasks.push(...list.getEntries().map(e=>e.duration)));audit.observer.observe({entryTypes:['longtask']});
        })()`);
        const snapshot = async () => ({processes:app.getAppMetrics(),dom:await debug.sendCommand('Memory.getDOMCounters'),metrics:(await debug.sendCommand('Performance.getMetrics')).metrics});
        const before = await snapshot();
        await debug.sendCommand('Profiler.start');
        await sleep(15000);
        const profile = await debug.sendCommand('Profiler.stop');
        const after = await snapshot();
        const idle = await read(`(() => {const a=window.nomadPerf;cancelAnimationFrame(a.raf);a.observer.disconnect();a.restores.forEach(fn=>fn());return {frames:a.frames,longTasks:a.longTasks,calls:a.calls};})()`);
        fs.writeFileSync(`${directory}/${width}-profile.json`,JSON.stringify(profile));
        const actions=[];
        for(let i=0;i<10;i++) {
            actions.push(await read(`(async()=>{const out={};const measure=async(name,fn)=>{const t=performance.now();await fn();out[name+'WorkMs']=performance.now()-t;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));out[name+'FrameMs']=performance.now()-t;};
                await measure('controlOpen',()=>window.nomadControlPlane.open());await measure('controlClose',()=>window.nomadControlPlane.close());
                const repo=window.repositoryLauncher.repositories[0];if(repo){await measure('repository',()=>window.repositoryLauncher.selectRepository(repo.id));window.repositoryLauncher.close({restoreFocus:false});}
                await measure('launcher',()=>window.applicationLauncher.open());window.applicationLauncher.close({resume:false});
                await measure('tab',()=>window.focusShellTab(window.currentTerm===0?1:0));
                await measure('keyboard',()=>document.body.classList.toggle('no-virtual-keyboard'));return out;})()`));
            await sleep(150);
        }
        const attribution=[];
        if (width===1920) for (const mode of ['normal','globe-paused','charts-paused','both-paused']) {
            await read(`(() => {const t=window.nomadTelemetry;const globe=t.network.globe;
                window.nomadAttributionRestore=()=>{};
                const restores=[];
                if('${mode}'.includes('globe') || '${mode}'==='both-paused'){const tick=globe.globe.tick;globe.globe.tick=()=>{};restores.push(()=>globe.globe.tick=tick);}
                if('${mode}'.includes('charts') || '${mode}'==='both-paused') for(const chart of [...t.system.cpuCharts,...t.network.trafficCharts]) {const render=chart.render;chart.render=()=>{};restores.push(()=>chart.render=render);}
                window.nomadAttributionRestore=()=>restores.forEach(fn=>fn());
                window.nomadAttribution={frames:[],last:0};const tick=t=>{const a=window.nomadAttribution;if(a.last)a.frames.push(t-a.last);a.last=t;a.id=requestAnimationFrame(tick);};requestAnimationFrame(tick);
            })()`);
            const start=await snapshot();await sleep(8000);const end=await snapshot();
            const frames=await read(`(() => {const a=window.nomadAttribution;cancelAnimationFrame(a.id);window.nomadAttributionRestore();return a.frames;})()`);
            attribution.push({mode,start,end,frames});
        }
        results.push({width,height,before,after,idle,actions,attribution});
        fs.writeFileSync(`${directory}/metrics.json`,JSON.stringify({startup,results},null,2));
        console.log(`PERFORMANCE ${label} ${width}: ${idle.frames.length} frames, globe ${JSON.stringify(idle.calls.globe)}`);
    }
    win.webContents.disableDeviceEmulation();
    debug.detach();
}
module.exports = {measure};
