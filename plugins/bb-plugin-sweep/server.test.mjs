import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { deliveryStore } from './delivery.ts';
import plugin from './server.ts';
import { formatNotification } from './notification.ts';
import { managerTag, projectsTag, statsTag } from './overview-contract.ts';
const repo = await mkdtemp(join(tmpdir(), 'sweep-test-'));
const git = (...args) => execFileSync('git', args, {cwd:repo, stdio:'ignore'});
git('init','-b','main');git('config','user.email','test@example.com');git('config','user.name','Test');
await writeFile(join(repo,'sweep.py'), `import argparse,json,os\np=argparse.ArgumentParser()\np.add_argument('--committed-state');p.add_argument('--candidate-snapshot')\na=p.parse_args()\nif a.committed_state and os.path.exists(a.committed_state):\n print('sweep: 2 threads, 3 cards checked, 0 actions');raise SystemExit(0)\nprint('ANSWER EXA-1 q1: «Пример *ответа*»')\nprint('ACTION stale-status EXA-2: in_progress')\nprint('WAIT EXA-3: blocker EXA-4')\nprint('sweep: 2 threads, 3 cards checked, 2 actions')\nif a.candidate_snapshot: open(a.candidate_snapshot,'w').write('{"seen":true}')\nraise SystemExit(1)\n`);
await writeFile(join(repo,'repeat.py'), `import argparse,json
p=argparse.ArgumentParser()
p.add_argument('age');p.add_argument('key');p.add_argument('candidate')
p.add_argument('--waits', nargs='*', default=[])
p.add_argument('--committed-state');p.add_argument('--candidate-snapshot')
a=p.parse_args()
if a.key != 'none':
 print(f'ACTION idle-no-link {a.key}: idle {a.age} min')
for key in a.waits: print(f'WAIT {key}: blocker EXA-9')
if a.candidate != 'none':
 print('ANSWER EXA-4 q1: Example answer')
 if a.candidate != 'uncommitted':
  with open(a.candidate_snapshot,'w') as f: json.dump({'value':a.candidate},f)
print(f'sweep: {a.age} threads, 1 cards checked, 1 actions')
raise SystemExit(int(a.key != 'none' or a.candidate != 'none'))
`);
await writeFile(join(repo,'invalid.py'), `import os\nwith open(os.environ['BB_SWEEP_CANDIDATE_SNAPSHOT'],'w') as candidate:\n candidate.write('invalid JSON')\n`);
git('add','.');git('commit','-m','fixture');
const projectId='proj_test', first='thr_first', second='thr_second';
const config={enabled:true,branch:'main',script:'sweep.py',args:[],manager:first,snapshots:true,intervalMinutes:1,timeoutSeconds:300};
function projectSettings(getRemote = () => repo) {
  const project = () => ({ id: projectId, name: 'Test', gitRemoteUrl: getRemote() });
  return { list: async () => [project()], get: async () => project() };
}
let fail=true, health={status:'error'};
let answersError='Answers offline';
let answersEnabled=false;
const sent=[];let pushes=0, attempts=0;
const {bb,harness}=createFakePluginHost({pluginId:'sweep',sdk:{projects:projectSettings(),threads:{get:async({threadId})=>{if(health===null)return null;if(health instanceof Error)throw health;return makeThreadResponse({id:threadId,projectId:'proj_other',...health});},send:async(request)=>{attempts++;if(fail)throw Error('offline');sent.push(request);}},plugins:{list:async()=>({plugins:answersEnabled?[{id:'answers',enabled:true}]:[]}),callRpc:async({pluginId,method,input})=>{
  if (pluginId==='answers') throw Error(answersError);
  assert.equal(pluginId,'push-notifications');assert.equal(method,'notifications.send');
  assert.equal(input.title,'Sweep manager unreachable');pushes++;return {};
}}}});
try {
 await plugin(bb);
 assert.deepEqual(await harness.behavior.callRpc('overview.projects',null),[]);
 await harness.behavior.callRpc('configure',{projectId,config:{...config,remote:join(repo,'obsolete')}});
 assert.deepEqual(harness.experimental_rpcInvalidations.at(-1), [projectsTag, managerTag]);
 assert.deepEqual(await harness.behavior.callRpc('config.get',{projectId}),config);
 assert.deepEqual(await harness.behavior.callRpc('overview.projects',null),[{id:projectId,name:'Test',enabled:true}]);
 await harness.behavior.runSchedule('sweep');
 assert.deepEqual(harness.experimental_rpcInvalidations.at(-1), [statsTag(projectId)]);
 let s=await harness.behavior.callRpc('status',{projectId});assert.match(s.pending,/ACTION/);assert.equal(pushes,1);
 assert.equal(attempts,0);assert.match(s.managerError,/failed/);assert.match(s.error,/No enabled Agent Hub or Answers plugin/);
 answersEnabled=true;
 for (const failure of ['Plugin answers is not installed','RPC answers.notice was not found']) {
   answersError=failure;
   const previousPushes=pushes;
   await harness.behavior.callRpc('configure',{projectId,config});await harness.behavior.runSchedule('sweep');
   const retry=await harness.behavior.callRpc('status',{projectId});
   assert.equal(retry.pending,s.pending);assert.equal(retry.deliveredTo,undefined);
   assert.ok(retry.error.includes(failure));assert.equal(pushes,previousPushes+1);
 }
 for(const unavailable of [{runtime:{displayStatus:'error'}},{runtime:{displayStatus:'waiting-for-host'}},{archivedAt:1},{deletedAt:1},null,Error('lookup offline')]) {
   health=unavailable;await harness.behavior.callRpc('configure',{projectId,config});await harness.behavior.runSchedule('sweep');
   const retry=await harness.behavior.callRpc('status',{projectId});assert.equal(retry.pending,s.pending);assert.ok(retry.managerError);assert.equal(attempts,0);
 }
 health={};await harness.behavior.callRpc('configure',{projectId,config});await harness.behavior.runSchedule('sweep');
 assert.equal(attempts,1);assert.match((await harness.behavior.callRpc('status',{projectId})).managerError,/offline/);
 assert.equal((await harness.behavior.callRpc('run',{projectId})).exitCode,1);
 assert.equal((await harness.behavior.callRpc('status',{projectId})).pending,s.pending);
 await harness.behavior.callRpc('configure',{projectId,config:{...config,manager:second}});
 assert.equal((await harness.behavior.callRpc('manager',{projectId})).manager,second);
 fail=false;
 // Due-time is durable; advance the clock for the retry.
 const original=Date.now;Date.now=()=>original()+120000;
 try {await harness.behavior.runSchedule('sweep');}finally{Date.now=original;}
 assert.equal(sent[0].threadId,second);
 assert.equal(sent[0].input[0].text, '[bb message from plugin:sweep]\n\n' + [
   '`Needs attention` · 2 to review · 2 threads · 3 cards checked',
   '**Owner answers**',
   '- [EXA-1](/plugins/work-board/work-board/task/EXA-1) — «Пример \\*ответа\\*» · `q1`',
   '**Actions**',
   '- `stale status` · [EXA-2](/plugins/work-board/work-board/task/EXA-2): in\\_progress',
   '**Waiting**',
   '- [EXA-3](/plugins/work-board/work-board/task/EXA-3) — blocked by [EXA-4](/plugins/work-board/work-board/task/EXA-4)',
 ].join('\n\n'));
 s=await harness.behavior.callRpc('status',{projectId});assert.equal(s.pending,null);assert.equal(s.managerError,null);assert.equal(s.exitCode,0);assert.ok(s.lastRun);assert.equal(s.deliveredTo,second);assert.ok(s.deliveredTickId);assert.ok(s.nextRun);assert.match(s.delivered,/STATE Waiting list is clear/);
 assert.equal(s.deliveredTickId,s.tickId);
 const count=sent.length;
 Date.now=()=>original()+240000;try{await harness.behavior.runSchedule('sweep');}finally{Date.now=original;}assert.equal(sent.length,count);
 Date.now=()=>original()+3800000;try{await harness.behavior.runSchedule('sweep');}finally{Date.now=original;}assert.equal(sent.length,count);
 assert.match(sent.at(-1).input[0].text, /Waiting list is clear/);
 console.log('Sweep retry, redirect, manual-state and status checks passed');
}finally{await harness.lifecycle.dispose();}

const noticeInputs = [];
const noticePlugins = [];
const notices = new Map();
let fallbackPushes = 0;
let agentHubEnabled = false;
const fallbackHost = createFakePluginHost({pluginId:'sweep', sdk:{
  projects:projectSettings(),
  threads:{get:async()=>makeThreadResponse({status:'error'}),send:async()=>assert.fail('Failed manager must not receive a message')},
  plugins:{list:async()=>({plugins:[{id:'answers',enabled:true},{id:'agent-hub',enabled:agentHubEnabled}]}),callRpc:async({pluginId,method,input})=>{
    if (pluginId === 'push-notifications') { fallbackPushes++; return {}; }
    assert.equal(method,'notice');
    noticePlugins.push(pluginId);
    noticeInputs.push(input);
    if (notices.has(input.tickId)) return { id:notices.get(input.tickId), created:false };
    const id = `notice-${notices.size + 1}`;
    notices.set(input.tickId,id);
    if (notices.size === 1) throw Error('Lost reply after commit');
    return { id, created:true };
  }},
}});
try {
  const {bb,harness}=fallbackHost;
  await plugin(bb);
  await harness.behavior.callRpc('configure',{projectId,config});
  await harness.behavior.runSchedule('sweep');
  let s=await harness.behavior.callRpc('status',{projectId});
  assert.match(s.pending,/ACTION/);assert.equal(s.deliveredTo,undefined);assert.equal(fallbackPushes,1);
  assert.equal((await harness.behavior.callRpc('run',{projectId})).exitCode,1);
  assert.equal(noticeInputs.length,1);
  assert.deepEqual(noticeInputs[0], {
    source:'sweep', tickId:s.tickId, projectId, threadId:first, title:'Sweep report · Manager unavailable',
    markdown:formatNotification(1,s.pending.slice(s.pending.indexOf('\n')+1)),
  });
  await harness.behavior.callRpc('configure',{projectId,config});
  await harness.behavior.runSchedule('sweep');
  assert.deepEqual(noticeInputs[1],noticeInputs[0]);assert.equal(fallbackPushes,1);
  assert.ok(noticePlugins.every(id => id === 'answers'));
  s=await harness.behavior.callRpc('status',{projectId});
  assert.equal(s.pending,null);assert.equal(s.exitCode,0);assert.equal(s.deliveredTo,'answers');
  assert.equal(s.deliveredNoticeId,notices.get(s.deliveredTickId));assert.match(s.fallbackReason,/Manager thread failed/);
  const noticesBeforeRename = (await harness.behavior.callRpc('stats',{projectId,days:1})).answers;

  // Keep the full output when Markdown escaping would exceed the notice API limit.
  const oldPending = `[sweep] exit 1\nACTION test ${'_*'.repeat(400000)}\n`;
  deliveryStore(bb.storage.database()).stage(projectId,oldPending,null);
  agentHubEnabled = true;
  await harness.behavior.callRpc('configure',{projectId,config});
  await harness.behavior.runSchedule('sweep');
  assert.match(noticeInputs.at(-1).tickId,/^proj_test:legacy:[a-f0-9]{64}$/);
  assert.equal(noticeInputs.at(-1).markdown,oldPending);
  assert.equal(noticePlugins.at(-1),'agent-hub');
  s=await harness.behavior.callRpc('status',{projectId});
  assert.equal(s.pending,null);assert.equal(s.deliveredTo,'agent-hub');
  assert.equal((await harness.behavior.callRpc('stats',{projectId,days:1})).answers,noticesBeforeRename+1);
}finally{await fallbackHost.harness.lifecycle.dispose();}

const reports=[];
let projectRemote=repo;
const repeatHost=createFakePluginHost({pluginId:'sweep',sdk:{
  projects:projectSettings(()=>projectRemote),
  threads:{get:async()=>makeThreadResponse(),send:async request=>{reports.push(request.input[0].text);}},
}});
const realNow=Date.now;
let time=realNow();
Date.now=()=>time;
try {
  const {bb,harness}=repeatHost;
  await plugin(bb);
  const get=key=>harness.behavior.callRpc('config.get',{projectId,key});
  const set=(key,value)=>harness.behavior.callRpc('config.set',{projectId,key,value});
  const stats=()=>harness.behavior.callRpc('stats',{projectId,days:1});
  const scheduled=()=>harness.behavior.runSchedule('sweep');
  const status=()=>harness.behavior.callRpc('status',{projectId});
  const refuseCli = async (args, fix) => {
    const result = await harness.behavior.runCli(args, { projectId });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, fix);
  };
  await assert.rejects(set('remote',repo));
  await assert.rejects(harness.behavior.callRpc('environment.write',{bbCli:'relative/bb',runtimePath:''}), error => {
    assert.equal(error.code, 'invalid_input');
    assert.match(error.issues[0].message, /absolute path/);
    return true;
  });
  await refuseCli(['run'], /--project <id> explicitly/);
  await refuseCli(['config','set','branch','main'], /--project <id> explicitly/);
  await refuseCli(['config','set','branch','main','--project',projectId,'--project','proj_other'], /Pass --project only once/);
  await refuseCli(['config','set','branch','main','--project',projectId,'--dry-run'], /config get/);
  assert.equal(await get(), null);
  assert.deepEqual(await set('branch','main'),{branch:'main'});
  assert.deepEqual(await get('branch'),{branch:'main'});
  assert.equal((await status()).config,null);
  await assert.rejects(set('enabled',true), /Set branch .* and script/);
  await harness.behavior.callRpc('configure',{projectId,config:{...config,script:'invalid.py'}});
  const invalid = await harness.behavior.callRpc('run',{projectId});
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.output, /Write a complete JSON document/);
  assert.equal((await status()).pending, null);
  await assert.rejects(harness.behavior.callRpc('seed-state',{projectId,snapshot:'{}'}), /config set enabled false/);
  const repeatedConfig={...config,script:'repeat.py',args:['5','EXA-1','none']};
  await harness.behavior.callRpc('configure',{projectId,config:repeatedConfig});
  await scheduled();
  const db = bb.storage.database();
  const legacyState = JSON.parse(db.prepare('SELECT value FROM status WHERE id = ?').get(projectId).value);
  delete legacyState.lastReport.changes;
  db.prepare('UPDATE status SET value = ? WHERE id = ?').run(JSON.stringify(legacyState),projectId);
  time+=60000;
  const newArgs=['11','EXA-1','none'];
  await Promise.all([set('args',newArgs),set('timeoutSeconds',30)]);
  assert.deepEqual(await get(),{...repeatedConfig,args:newArgs,timeoutSeconds:30});
  const cli=await harness.behavior.runCli(['config','get','args','--project',projectId]);
  assert.equal(cli.exitCode,0);assert.deepEqual(JSON.parse(cli.stdout),{args:newArgs});
  await scheduled();
  assert.equal(reports.length,1);assert.equal((await stats()).suppressedReports,1);
  time+=3600000;
  await scheduled();assert.equal(reports.length,1);assert.equal((await stats()).reminderReports,0);

  const change=await harness.behavior.runCli(['config','set','args','["11","EXA-2","none"]','--project',projectId]);
  assert.equal(change.exitCode,0);assert.deepEqual(JSON.parse(change.stdout),{args:['11','EXA-2','none']});
  await scheduled();assert.equal(reports.length,2);
  await set('args',['11','EXA-2','one']);await scheduled();
  await set('args',['11','EXA-2','two']);await scheduled();
  assert.equal(reports.length,4);
  assert.equal(deliveryStore(bb.storage.database()).read(projectId).committed.toString(),'{"value": "two"}');

  projectRemote=join(repo,'missing');
  time+=60000;await scheduled();
  assert.equal((await status()).nextRun,time+60000);assert.equal(reports.length,5);
  time+=60000;await scheduled();
  assert.equal((await status()).nextRun,time+120000);assert.equal(reports.length,5);
  time+=60000;await scheduled();assert.equal((await stats()).ticks,8);
  const beforeManual=await stats();
  const invalidationsBeforeManual=harness.experimental_rpcInvalidations.length;
  projectRemote=null;
  const missing=await harness.behavior.callRpc('run',{projectId});
  assert.equal(missing.exitCode,2);assert.match(missing.output,/Git remote URL in the bb project settings/);
  assert.deepEqual(await stats(),beforeManual);
  assert.equal(harness.experimental_rpcInvalidations.length,invalidationsBeforeManual);
  projectRemote=repo;
  await set('args',['11','EXA-2','none']);
  time+=60000;await scheduled();
  assert.equal((await status()).refreshFailures,0);
  const results=await stats();
  assert.equal(results.ticks,9);assert.equal(results.executed,9);assert.equal(results.deliveries,5);
  assert.equal(results.refreshFailures,2);assert.equal(results.suppressedReports,4);
  assert.equal(results.repeats,6);assert.deepEqual(results.newItems,{'ACTION idle-no-link':2,ANSWER:1});
  const statsCli=await harness.behavior.runCli(['stats','--project',projectId,'--days','1']);
  assert.equal(statsCli.exitCode,0);assert.deepEqual(JSON.parse(statsCli.stdout),results);

  const waits = async (...items) => {
    await set('args',['11','none','none', ...(items.length ? ['--waits', ...items] : [])]);
    await scheduled();
  };
  await waits();assert.equal(reports.length,5); // Removing a finding alone is quiet.
  await waits('EXA-5');assert.equal(reports.length,6);
  assert.equal((await status()).exitCode,0);assert.match(reports.at(-1), /\*\*Waiting\*\*/);
  await waits('EXA-5','EXA-6');assert.equal(reports.length,7);
  time+=3600000;
  await waits('EXA-6','EXA-5');assert.equal(reports.length,7);
  await waits('EXA-6');assert.equal(reports.length,8);
  assert.doesNotMatch(reports.at(-1), /EXA-5/);
  await waits();assert.equal(reports.length,9);assert.match(reports.at(-1), /Waiting list is clear/);
  await waits();assert.equal(reports.length,9);
  for (let i=0; i<2; i++) {
    await set('args',['11','none','uncommitted']);
    await scheduled();
  }
  assert.equal(reports.length,11);
  assert.equal(deliveryStore(db).read(projectId).committed.toString(),'{"value": "two"}');
}finally{Date.now=realNow;await repeatHost.harness.lifecycle.dispose();await rm(repo,{recursive:true,force:true});}

assert.equal(formatNotification(0, 'STATE owner-answers: reopened q1\n'), '`Check complete`\n\n**State changes**\n\n- owner-answers: reopened q1');
assert.equal(formatNotification(1, 'ACTION bad-block thr_example: missing closing block\n'), '`Needs attention`\n\n**Actions**\n\n- `bad block` · @thread:thr_example: missing closing block');
assert.equal(formatNotification(2, 'ERROR checkout failed\n```\n  indented detail\n'), '`Check failed` (exit 2)\n\n````text\nERROR checkout failed\n```\n  indented detail\n````');

// A reload must cancel in-flight repository work before the service stop deadline.
const slowRepo = await mkdtemp(join(tmpdir(), 'sweep-stop-'));
const slowGit = (...args) => execFileSync('git', args, {cwd:slowRepo,stdio:'ignore'});
slowGit('init','-b','main');slowGit('config','user.email','test@example.com');slowGit('config','user.name','Test');
await writeFile(join(slowRepo,'sweep.py'),'import time\ntime.sleep(60)\n');slowGit('add','.');slowGit('commit','-m','slow fixture');
const stopHost=createFakePluginHost({pluginId:'sweep',sdk:{projects:projectSettings(()=>slowRepo),threads:{get:async()=>makeThreadResponse({projectId})}}});
try {
 await plugin(stopHost.bb);
 await stopHost.harness.behavior.callRpc('configure',{projectId,config:{enabled:true,branch:'main',script:'sweep.py',args:[],manager:first}});
 const service=stopHost.harness.behavior.runService('due-ticks');
 await new Promise(resolve=>setTimeout(resolve,200));
 service.controller.abort();
 let timer;try{await Promise.race([service.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('service did not cancel')),2000)})]);}finally{clearTimeout(timer);}
}finally{await stopHost.harness.lifecycle.dispose();await rm(slowRepo,{recursive:true,force:true});}
