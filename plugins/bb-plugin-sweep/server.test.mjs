import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
const repo = await mkdtemp(join(tmpdir(), 'sweep-test-'));
const git = (...args) => execFileSync('git', args, {cwd:repo, stdio:'ignore'});
git('init','-b','main');git('config','user.email','test@example.com');git('config','user.name','Test');
await writeFile(join(repo,'sweep.py'), `import argparse,json,os\np=argparse.ArgumentParser()\np.add_argument('--committed-state');p.add_argument('--candidate-snapshot')\na=p.parse_args()\nif a.committed_state and os.path.exists(a.committed_state):\n print('sweep: quiet');raise SystemExit(0)\nprint('ACTION test')\nif a.candidate_snapshot: open(a.candidate_snapshot,'w').write('{"seen":true}')\nraise SystemExit(1)\n`);
git('add','.');git('commit','-m','fixture');
const projectId='proj_test', first='thr_first', second='thr_second';let fail=true;const sent=[];let pushes=0;
const {bb,harness}=createFakePluginHost({pluginId:'sweep',sdk:{projects:{list:async()=>[{id:projectId,name:'Test'}]},threads:{get:async({threadId})=>makeThreadResponse({id:threadId,projectId:"proj_other"}),send:async(request)=>{if(fail)throw Error('offline');sent.push(request);}},plugins:{callRpc:async()=>{pushes++;return {};}}}});
try {
 await plugin(bb);
 const config={enabled:true,remote:repo,branch:'main',script:'sweep.py',args:[],manager:first,snapshots:true,intervalMinutes:1};
 await harness.behavior.callRpc('configure',{projectId,config});
 await harness.behavior.runSchedule('sweep');
 let s=await harness.behavior.callRpc('status',{projectId});assert.match(s.pending,/ACTION/);assert.equal(pushes,1);
 await harness.behavior.callRpc('run',{projectId});assert.equal((await harness.behavior.callRpc('status',{projectId})).pending,s.pending);
 await harness.behavior.callRpc('configure',{projectId,config:{...config,manager:second}});
 assert.equal((await harness.behavior.callRpc('manager',{projectId})).manager,second);
 fail=false;
 // Due-time is durable; advance the clock for the retry.
 const original=Date.now;Date.now=()=>original()+120000;
 try {await harness.behavior.runSchedule('sweep');}finally{Date.now=original;}
 assert.equal(sent[0].threadId,second);assert.match(sent[0].input[0].text,/ACTION/);
 s=await harness.behavior.callRpc('status',{projectId});assert.equal(s.pending,null);assert.equal(s.exitCode,0);assert.ok(s.lastRun);assert.equal(s.deliveredTo,second);assert.ok(s.deliveredTickId);assert.ok(s.nextRun);assert.match(s.delivered,/alive/);
 const count=sent.length;
 Date.now=()=>original()+240000;try{await harness.behavior.runSchedule('sweep');}finally{Date.now=original;}assert.equal(sent.length,count);
 Date.now=()=>original()+3800000;try{await harness.behavior.runSchedule('sweep');}finally{Date.now=original;}assert.equal(sent.length,count+1);assert.match(sent.at(-1).input[0].text,/alive/);
 console.log('Sweep retry, redirect, manual-state and status checks passed');
}finally{await harness.lifecycle.dispose();await rm(repo,{recursive:true,force:true});}

// A reload must cancel in-flight repository work before the service stop deadline.
const slowRepo = await mkdtemp(join(tmpdir(), 'sweep-stop-'));
const slowGit = (...args) => execFileSync('git', args, {cwd:slowRepo,stdio:'ignore'});
slowGit('init','-b','main');slowGit('config','user.email','test@example.com');slowGit('config','user.name','Test');
await writeFile(join(slowRepo,'sweep.py'),'import time\ntime.sleep(60)\n');slowGit('add','.');slowGit('commit','-m','slow fixture');
const stopHost=createFakePluginHost({pluginId:'sweep',sdk:{projects:{list:async()=>[{id:projectId,name:'Test'}]},threads:{get:async()=>makeThreadResponse({projectId})}}});
try {
 await plugin(stopHost.bb);
 await stopHost.harness.behavior.callRpc('configure',{projectId,config:{enabled:true,remote:slowRepo,branch:'main',script:'sweep.py',args:[],manager:first}});
 const service=stopHost.harness.behavior.runService('due-ticks');
 await new Promise(resolve=>setTimeout(resolve,200));
 service.controller.abort();
 let timer;try{await Promise.race([service.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('service did not cancel')),2000)})]);}finally{clearTimeout(timer);}
}finally{await stopHost.harness.lifecycle.dispose();await rm(slowRepo,{recursive:true,force:true});}
