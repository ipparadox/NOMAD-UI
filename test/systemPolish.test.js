"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const {nomadSystemHealth} = require("../src/classes/systemHealth.class.js");
const {createNomadLog} = require("../src/cli/nomadLog.js");
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomad-polish-"));
    try {
        const logPath = path.join(root,"logs","session.log");
        const log = createNomadLog({logPath,maxBytes:256});
        for (let i=0;i<100;i++) log("info", "token=secret bounded record");
        assert(fs.statSync(logPath).size <= 256);
        assert(!fs.readFileSync(logPath,"utf8").includes("token=secret"));
        // A full prior session rotates at startup; archives preserve evidence.
        fs.writeFileSync(logPath,"x".repeat(256),{mode:0o600});
        createNomadLog({logPath,maxBytes:256})("info","new session");
        assert.strictEqual(fs.readFileSync(logPath+".1","utf8"),"x".repeat(256));
        fs.writeFileSync(logPath,"y".repeat(256));
        fs.symlinkSync(path.join(root,"unrelated"),logPath+".2");
        createNomadLog({logPath,maxBytes:256})("info","unsafe archive refused");
        assert.strictEqual(fs.readFileSync(logPath,"utf8"),"y".repeat(256));
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
    const host = {document:{body:{dataset:{nomadBridge:"VERIFIED"}}}, currentTerm:0,
        term:{0:{socket:{readyState:3}}}, nomad:Object.freeze({
            control:{request:async()=>({ok:true,profile:"LOCKDOWN",repositoriesHealth:"UNKNOWN"})},
            system:{getTelemetry:async()=>({ok:true,status:"PARTIAL",timestamp:Date.now()})},
            network:{getTelemetry:async()=>({ok:false})},
            windowManager:{snapshot:async()=>[]}, applications:{request:async()=>{throw Error("offline");}}
        })};
    const health = Object.fromEntries((await nomadSystemHealth(host)).map(f=>[f.label,f.value]));
    assert.strictEqual(health.TERMINAL,"FAILED");
    assert.strictEqual(health.TELEMETRY,"DEGRADED");
    assert.strictEqual(health.NETWORK,"FAILED");
    assert.strictEqual(health["APPLICATION REGISTRY"],"UNKNOWN");
    assert.strictEqual(health["WINDOW SYNC"],"UNKNOWN");
    assert.strictEqual(health["SECURITY PROFILE"],"LOCKDOWN");
    // Exercise the real transport lifecycle without a backend or real sockets.
    const sockets=[]; const timers=new Map(); let next=0; let removes=0; let capabilities=0;
    class Socket {
        constructor(url) { assert(url.startsWith("ws://127.0.0.1:3000/?token=")); this.events={}; sockets.push(this); }
        addEventListener(name,fn){this.events[name]=fn;}
        close(){} send(){}
    }
    const parent={addEventListener(){},removeEventListener(){removes++;}};
    const context=vm.createContext({window:{Terminal:class {
        loadAddon(){} open(){} attachCustomKeyEventHandler(){} resize(){} writeln(){} dispose(){}
    },FitAddon:{FitAddon:class {proposeDimensions(){return null;}}},AttachAddon:{AttachAddon:class {dispose(){}}}},
        document:{getElementById:()=>parent},WebSocket:Socket,console,
        setTimeout:fn=>{timers.set(++next,fn);return next;}, clearTimeout:id=>timers.delete(id)});
    vm.runInContext(fs.readFileSync(path.join(__dirname,"../src/classes/secureTerminalClient.class.js"),"utf8"),context);
    context.opts={bridge:{onClientState:()=>()=>{},sendClientEvent(){},connection:async()=>{capabilities++;return {port:3000,authToken:"a".repeat(64)};}},parentId:"terminal0",port:3000,authToken:"a".repeat(64)};
    vm.runInContext("client = new SecureTerminalClient(opts)",context);
    sockets[0].events.open();
    for(let i=0;i<3;i++) {
        sockets[sockets.length-1].events.close({code:1006});
        for(const [id,fn] of [...timers]) {timers.delete(id);await fn();}
        if(i<2) sockets[sockets.length-1].events.open();
    }
    assert.strictEqual(capabilities,2,"two lifetime retries, fresh capability each time");
    assert.strictEqual(timers.size,0,"no infinite reconnect loop");
    vm.runInContext("client.dispose(); client.dispose()",context);
    assert.strictEqual(removes,1,"terminal wheel listener removed once");
    console.log("System polish: truthful health, bounded/revalidated log rotation, bounded authenticated terminal reconnect and disposal passed");
})().catch(error=>{console.error(error);process.exitCode=1;});
