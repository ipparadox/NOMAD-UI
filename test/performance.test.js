"use strict";
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm');
const adapters=require('../src/classes/projectAdapters');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nomad-perf-test-'));
try {
 const repo={canonicalPath:root};
 const manifest=path.join(root,'package.json');
 fs.writeFileSync(manifest,JSON.stringify({scripts:{start:'node one.js'}}));
 let builds=0;
 const original=adapters.NodeProjectAdapter.prototype.inspect;
 adapters.NodeProjectAdapter.prototype.inspect=function(...args){builds++;return original.apply(this,args);};
 try {
  const first=adapters.inspectProject(repo);first.profiles[0].args.push('mutation');
  const second=adapters.inspectProject(repo);
  assert.strictEqual(builds,1,'unchanged input reuses derived plan');
  assert(!second.profiles[0].args.includes('mutation'),'cache cannot be mutated by consumers');
  fs.writeFileSync(manifest,JSON.stringify({scripts:{start:'node two.js'}}));
  assert.notStrictEqual(adapters.inspectProject(repo).fingerprint,second.fingerprint);
  assert.strictEqual(builds,2,'changed content invalidates');
  fs.mkdirSync(path.join(root,'node_modules'));
  assert.strictEqual(adapters.inspectProject(repo).state,'READY','setup state is live');
  fs.rmdirSync(path.join(root,'node_modules'));
  assert.strictEqual(adapters.inspectProject(repo).state,'SETUP_REQUIRED','cache cannot preserve stale setup readiness');
  fs.renameSync(manifest,path.join(root,'input.json'));
  fs.symlinkSync('input.json',manifest);
  assert.throws(()=>adapters.inspectProject(repo),/REFUSED/,'cache cannot bypass no-follow validation');
 } finally {adapters.NodeProjectAdapter.prototype.inspect=original;}
} finally {fs.rmSync(root,{recursive:true,force:true});}
const context=vm.createContext({window:{}});
vm.runInContext(fs.readFileSync(require.resolve('../src/classes/secureTelemetry.class.js'),'utf8'),context);
const Controller=vm.runInContext('NomadVisualCadence',context);
const changes=[];const controller=new Controller(reduced=>changes.push(reduced));
let time=0;controller.observe(time);
for(let i=0;i<100;i++)controller.observe(time+=50);
assert.deepStrictEqual(changes,[true],'sustained poor frames reduce decorative cadence');
for(let i=0;i<900;i++)controller.observe(time+=1000/60);
assert.deepStrictEqual(changes,[true],'short recovery does not toggle quality');
controller.reset(); // hidden time must not count toward recovery
for(let i=0;i<900;i++)controller.observe(time+=1000/60);
assert.deepStrictEqual(changes,[true]);
for(let i=0;i<1800;i++)controller.observe(time+=1000/60);
assert.deepStrictEqual(changes,[true,false],'sustained recovery restores full cadence');
console.log('Performance cache isolation, fresh security/setup validation and visual cadence hysteresis passed');
