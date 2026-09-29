"use strict";
// Standalone read-only inspection benchmark; fixture creation is outside timed spans.
const fs=require('fs'),os=require('os'),path=require('path');
const {performance}=require('perf_hooks');
const {LaunchDoctor}=require('../src/classes/launchDoctor');
const {inspectProject}=require('../src/classes/projectAdapters');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nomad-perf-project-'));
 try {
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{start:'node index.js'}}));
  fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:Object.fromEntries(Array.from({length:10000},(_,i)=>['node_modules/fixture'+i,{version:'1.0.0',resolved:'https://example.invalid/fixture'+i}]))}));
  fs.mkdirSync(path.join(root,'node_modules'));
  const repository={id:'repo_'+'a'.repeat(32),canonicalPath:root};
  const profile=inspectProject(repository).profiles[0];
  const doctor=new LaunchDoctor();
  const reads=fs.readSync;let count=0;fs.readSync=function(...args){count++;return reads.apply(this,args);};
  const samples=[];try {for(let i=0;i<30;i++){const start=performance.now();await doctor.preflight(repository,profile);samples.push(performance.now()-start);}} finally {fs.readSync=reads;}
  console.log(JSON.stringify({fixtureBytes:fs.statSync(path.join(root,'package-lock.json')).size,iterations:30,reads:count,coldMs:samples[0],warmMeanMs:samples.slice(1).reduce((a,b)=>a+b)/29,samples},null,2));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
