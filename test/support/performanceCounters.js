"use strict";
// Test process only: count named operations, never payloads, paths or output.
const state={active:false,counts:{}};
const restores=[];
function wrap(object,key,label) {
    const original=object[key];
    if(typeof original!=='function')return;
    object[key]=function(...args){if(state.active)state.counts[label]=(state.counts[label]||0)+1;return original.apply(this,args);};
    restores.push(()=>{object[key]=original;});
}
function installIPC() {
    const {ipcMain}=require('electron');
    const handle=ipcMain.handle;
    ipcMain.handle=function(channel,listener){return handle.call(this,channel,function(...args){
        if(state.active)state.counts.ipcInvokes=(state.counts.ipcInvokes||0)+1;
        return listener.apply(this,args);
    });};
    restores.push(()=>{ipcMain.handle=handle;});
}
function start(win) {
    state.counts={};
    wrap(win.webContents,'send','ipcSends');
    const fs=require('fs');
    for(const key of ['readSync','readFileSync','readdirSync','lstatSync','realpathSync'])wrap(fs,key,key);
    wrap(require('../../src/classes/repositoryService').RepositoryService.prototype,'refresh','repositoryRefresh');
    wrap(require('../../src/classes/desktopEntryDiscovery').DesktopEntryDiscovery.prototype,'scan','desktopScan');
    wrap(require('../../src/classes/i3WindowManager.class').I3WindowManager.prototype,'_tree','i3Tree');
    state.active=true;
}
function snapshot(){return {...state.counts};}
function stop(){state.active=false;while(restores.length)restores.pop()();}
module.exports={installIPC,start,snapshot,stop};
