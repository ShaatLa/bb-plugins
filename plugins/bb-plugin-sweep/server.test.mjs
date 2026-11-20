import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { deliveryStore } from './delivery.ts';
import plugin from './server.ts';
import { formatNotification } from './notification.ts';
import { reportContents } from './reports.ts';
import { managerTag, projectsTag, statsTag } from './overview-contract.ts';
const repo = await mkdtemp(join(tmpdir(), 'sweep-test-'));
const git = (...args) => execFileSync('git', args, {cwd:repo, stdio:'ignore'});
git('init','-b','main');git('config','user.email','test@example.com');git('config','user.name','Test');
await writeFile(join(repo,'sweep.py'), `import argparse,json,os\np=argparse.ArgumentParser()\np.add_argument('--committed-state');p.add_argument('--candidate-snapshot')\na=p.parse_args()\nif a.committed_state and os.path.exists(a.committed_state):\n print('sweep: 2 threads, 3 cards checked, 0 actions');raise SystemExit(0)\nprint('ANSWER EXA-1 q1: «Пример *ответа*»')\nprint('ACTION stale-status EXA-2: in_progress, board flags no_active_thread')\nprint('WAIT EXA-3: blocker EXA-4')\nprint('sweep: 2 threads, 3 cards checked, 2 actions')\nif a.candidate_snapshot: open(a.candidate_snapshot,'w').write('{"seen":true}')\nraise SystemExit(1)\n`);
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
   '- `stale status` · [EXA-2](/plugins/work-board/work-board/task/EXA-2): in\\_progress, board flags no\\_active\\_thread',
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

// A report for a busy manager extends this plugin's queued row; another sender's row is left alone and a new message is queued.
for (const [origin, merges] of [['sweep', true], ['someone-else', false]]) {
  const row={id:'q1',content:[{type:'text',text:'Earlier notice',mentions:[]}],originPluginId:origin,state:'queued',editable:true,updatedAt:42};
  const sentRequests=[], updates=[];
  const mergeHost=createFakePluginHost({pluginId:'sweep',sdk:{projects:projectSettings(),threads:{
    get:async()=>makeThreadResponse(),
    send:async request=>{sentRequests.push(request);},
    queuedMessages:{list:async()=>[row],update:async request=>{updates.push(request);return row;}},
  },plugins:{list:async()=>({plugins:[]})}}});
  try {
    await plugin(mergeHost.bb);
    await mergeHost.harness.behavior.callRpc('configure',{projectId,config:{...config,script:'repeat.py',args:['5','EXA-1','none']}});
    await mergeHost.harness.behavior.runSchedule('sweep');
    assert.equal(sentRequests.length, merges ? 0 : 1);
    assert.equal(updates.length, merges ? 1 : 0);
    if (merges) {
      assert.equal(updates[0].queuedMessageId,'q1');assert.equal(updates[0].expectedUpdatedAt,42);
      assert.match(updates[0].input[0].text,/^Earlier notice\n\n---\n\n/);
      assert.doesNotMatch(updates[0].input[0].text,/\[bb message from plugin/);
    } else assert.match(sentRequests[0].input[0].text,/^\[bb message from plugin:sweep\]/);
  } finally { await mergeHost.harness.lifecycle.dispose(); }
}

// In shadow, a later retry must acknowledge the original report's findings, not the retry tick's findings.
let shadowUnavailable = false;
let shadowSendFails = true;
let shadowDeliveries = 0;
let shadowKeyKnown = true;
const shadowHost = createFakePluginHost({pluginId:'sweep',sdk:{
  projects:projectSettings(),
  threads:{get:async()=>makeThreadResponse(),send:async()=>{
    if (shadowSendFails) throw new Error('offline');
    return {delivery:'queued',queuedMessage:{id:`queue_example_${++shadowDeliveries}`}};
  }},
  plugins:{list:async()=>({plugins:[]}),callRpc:async({pluginId,method,input})=>{
    if (pluginId === 'push-notifications') return {};
    assert.equal(pluginId,'work-board');
    if (method === 'attention.modes') {
      if (shadowUnavailable) throw new Error('Work Board unavailable');
      return {projectId,trackerId:'tracker_example',kinds:{'stale-status':{effective:{mode:'shadow',generation:1}}}};
    }
    assert.equal(method,'attention.resolveKeys');
    assert.deepEqual(input,{projectId,keys:['EXA-2']});
    return shadowKeyKnown ? {resolved:{'EXA-2':'task_example'},unknown:[]} : {resolved:{},unknown:['EXA-2']};
  }},
}});
try {
  const {bb,harness} = shadowHost;
  await plugin(bb);
  const rpc = (method, input) => harness.behavior.callRpc(method,input);
  const observations = input => rpc('attention.observations',{projectId,since:0,...input});
  await rpc('configure',{projectId,config});
  await rpc('run',{projectId});
  assert.deepEqual((await observations()).observations,[]);
  await harness.behavior.runSchedule('sweep');
  const [staged] = (await observations()).observations;
  assert.deepEqual(staged.findings,[{taskKey:'EXA-2',taskId:'task_example',signal:'no_active_thread'}]);
  assert.deepEqual([staged.trackerId,staged.generation],['tracker_example',1]);
  assert.ok(staged.scanStartedAt <= staged.at && staged.at <= staged.stagedAt);
  assert.ok(staged.stagedAt);
  assert.equal(staged.receipt,null);

  shadowSendFails = false;
  shadowUnavailable = true;
  await rpc('config.set',{projectId,key:'manager',value:first});
  await harness.behavior.runSchedule('sweep');
  const page = await observations({limit:1});
  assert.equal(page.observations[0].tickId,staged.tickId);
  assert.ok(page.observations[0].acceptedAt);
  assert.deepEqual(page.observations[0].receipt,{mode:'queued',id:'queue_example_1',destination:first});
  const following = await observations({cursor:page.nextCursor});
  assert.equal(following.observations.length,1);
  assert.deepEqual(following.observations[0].issues,['mode-unavailable']);
  assert.deepEqual(following.observations[0].findings,[]);
  assert.deepEqual(following.observations[0].receipt,{mode:'queued',id:'queue_example_2',destination:first});

  shadowUnavailable = false;
  shadowKeyKnown = false;
  await rpc('config.set',{projectId,key:'snapshots',value:false});
  await harness.behavior.runSchedule('sweep');
  const unresolved = (await observations()).observations.at(-1);
  assert.deepEqual(unresolved.issues,['unresolved-task-key']);
  assert.deepEqual(unresolved.findings,[{taskKey:'EXA-2',taskId:null,signal:'no_active_thread'}]);
} finally { await shadowHost.harness.lifecycle.dispose(); }

const worktreeTest = await mkdtemp(join(tmpdir(), 'sweep-worktrees-'));
const storageRoot = join(worktreeTest, 'thread-storage');
const cleanTree = join(storageRoot, 'thr_archived', 'clean tree');
const dirtyTree = join(storageRoot, 'thr_archived', 'dirty-tree');
const managedTree = join(storageRoot, 'thr_archived', 'managed-tree');
const activeTree = join(storageRoot, 'thr_active', 'active-tree');
const outsideTree = join(worktreeTest, 'thread-storage-other', 'thr_archived', 'outside-tree');
const worktreeReports = [];
let worktreeSendFails = true;
const worktreeHost = createFakePluginHost({pluginId:'sweep',sdk:{
  system:{config:async()=>({primaryHostId:'host_example'})},
  hosts:{get:async()=>({threadStorageRootPath:storageRoot})},
  projects:{...projectSettings(),get:async()=>({id:projectId,name:'Example',gitRemoteUrl:repo,sources:[{hostId:'host_example',path:repo}]})},
  environments:{list:async()=>[
    {projectId:'proj_other',managed:true,isGitRepo:true,status:'ready',path:managedTree},
    {projectId,managed:false,isGitRepo:true,status:'ready',path:dirtyTree},
  ]},
  threads:{get:async()=>makeThreadResponse(),list:async({threadIds})=>threadIds.includes('thr_archived') ? [makeThreadResponse({id:'thr_archived',projectId,archivedAt:1})] : [],send:async request=>{
    if (worktreeSendFails) throw new Error('offline');
    worktreeReports.push(request.input[0].text);
  }},
  plugins:{list:async()=>({plugins:[]}),callRpc:async({pluginId})=>{
    if (pluginId === 'push-notifications') return {};
    throw new Error('optional plugin unavailable');
  }},
}});
try {
  await mkdir(join(storageRoot,'thr_archived'),{recursive:true});
  for (const path of [cleanTree,dirtyTree,managedTree,activeTree,outsideTree]) git('worktree','add','--detach',path);
  await writeFile(join(dirtyTree,'changes.txt'),'unsaved example');
  await plugin(worktreeHost.bb);
  const {harness} = worktreeHost;
  const quiet = {...config,script:'repeat.py',args:['5','none','none'],snapshots:false};
  const run = async () => {
    await harness.behavior.callRpc('configure',{projectId,config:quiet});
    await harness.behavior.runSchedule('sweep');
    return harness.behavior.callRpc('status',{projectId});
  };
  const staged = await run();
  assert.match(staged.pending,/^ACTION archived-worktree thr_archived: .*/m);
  assert.match(staged.pending,/clean tree" \(\d+ KiB, clean\)/);
  assert.match(staged.pending,/dirty-tree" \(\d+ KiB, dirty\)/);
  assert.doesNotMatch(staged.pending,/managed-tree|active-tree|outside-tree/);
  assert.equal(staged.pending.match(/^ACTION archived-worktree/gm).length,1);
  worktreeSendFails = false;
  await run();
  await run();
  assert.equal(worktreeReports.length,1);
  assert.match(worktreeReports[0],/@thread:thr_archived/);
  git('worktree','remove',cleanTree);
  await run();
  git('worktree','add','--detach',cleanTree);
  await run();
  assert.equal(worktreeReports.length,2);
  assert.match(worktreeReports[1],/clean tree.*clean\)/);
  assert.doesNotMatch(worktreeReports[1],/dirty-tree/);
  assert.equal(await readFile(join(dirtyTree,'changes.txt'),'utf8'),'unsaved example');
  const finding = 'ACTION archived-worktree thr_archived: "/example/tree" (4 KiB, clean)';
  const failure = 'ERROR checkout unavailable';
  assert.equal(reportContents(2,`${failure}\n${finding}`).fingerprint,reportContents(2,failure).fingerprint);
  assert.match(formatNotification(2,`${failure}\n${finding}`),/\*\*Archived worktrees\*\*\n\n- @thread:thr_archived/);
} finally {
  await worktreeHost.harness.lifecycle.dispose();
  await rm(worktreeTest,{recursive:true,force:true});
}

const reports=[];
let projectRemote=repo;
const repeatHost=createFakePluginHost({pluginId:'sweep',sdk:{
  projects:projectSettings(()=>projectRemote),
  threads:{get:async()=>makeThreadResponse(),send:async request=>{reports.push(request.input[0].text);}},
  plugins:{list:async()=>({plugins:[]})},
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
const stopHost=createFakePluginHost({pluginId:'sweep',sdk:{projects:projectSettings(()=>slowRepo),threads:{get:async()=>makeThreadResponse({projectId})},plugins:{list:async()=>({plugins:[]})}}});
try {
 await plugin(stopHost.bb);
 await stopHost.harness.behavior.callRpc('configure',{projectId,config:{enabled:true,branch:'main',script:'sweep.py',args:[],manager:first}});
 const service=stopHost.harness.behavior.runService('due-ticks');
 await new Promise(resolve=>setTimeout(resolve,200));
 service.controller.abort();
 let timer;try{await Promise.race([service.done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('service did not cancel')),2000)})]);}finally{clearTimeout(timer);}
}finally{await stopHost.harness.lifecycle.dispose();await rm(slowRepo,{recursive:true,force:true});}

// ---- Transfer of the runner between Sweep and Work Board --------------------------------------------------------------
const xferRepo = await mkdtemp(join(tmpdir(), 'sweep-transfer-'));
const xgit = (...args) => execFileSync('git', args, {cwd:xferRepo, stdio:'ignore'});
xgit('init','-b','main');xgit('config','user.email','test@example.com');xgit('config','user.name','Test');
await writeFile(join(xferRepo,'ctl.py'), `import argparse,json,os
p=argparse.ArgumentParser()
p.add_argument('mode');p.add_argument('--waits',nargs='*',default=[])
p.add_argument('--committed-state');p.add_argument('--candidate-snapshot')
a=p.parse_args()
text=open(a.committed_state).read() if a.committed_state and os.path.exists(a.committed_state) else None
n=json.loads(text)['n'] if text else 0
print('STATE input='+(str(n) if text else 'none'))
for w in a.waits: print('WAIT '+w+': blocker EXA-9')
print('sweep: 1 threads, 1 cards checked, 0 actions')
if a.candidate_snapshot:
 if a.mode=='advance': open(a.candidate_snapshot,'w').write(json.dumps({'n':n+1}))
 elif text: open(a.candidate_snapshot,'w').write(text)
`);
await writeFile(join(xferRepo,'fail.py'), `print('ERROR boom')\nraise SystemExit(2)\n`);
await writeFile(join(xferRepo,'slow.py'), `import time\ntime.sleep(1.5)\n`);
xgit('add','.');xgit('commit','-m','fixture');

// The same literal document is pinned in the Work Board suite (checks/transfer.test.ts).
const pinnedDocument = {"format":"bb-runner-state/1","from":"sweep","bbProjectId":"proj_example","handoffId":"handoff_example","previous":null,"exportedAt":"2026-01-01T00:00:00.000Z","committed":{"size":7,"sha256":"50fb9ee7a50fd1c8e2a0b35c9a2e9d5dbb9ee5b2cd8a98d7d2b02a9fb3b3a8c1"},"lastReport":{"fingerprint":"fingerprint_example","manager":"thr_example","at":1767225600000,"changes":{"noteworthy":["item_example"],"waiting":"waiting_example"}},"lastFailure":{"fingerprint":"failure_example","manager":"thr_example"},"reportedWorktrees":["/example/tree"],"lastMeasuredWorktree":"/example/tree"};
{
  const { transferDocument } = await import('./transfer.ts');
  assert.deepEqual(transferDocument.parse(pinnedDocument), pinnedDocument);
  assert.throws(() => transferDocument.parse({ ...pinnedDocument, extra: 1 }));
  assert.throws(() => transferDocument.parse({ ...pinnedDocument, format: 'bb-runner-state/2' }));
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
/** A Work Board with the same rules as the real one, as far as Sweep can see it. */
function fakeWorkBoard() {
  const wb = { row: null, transferring: false, claim: 'grant', calls: [], document: null, bytes: Buffer.alloc(0) };
  const own = () => ({ owner: wb.row?.owner ?? null, trackerId: wb.row?.trackerId ?? null, sentId: wb.row?.sentId ?? null, sentConfirmed: !!wb.row?.sentConfirmed, receivedId: wb.row?.receivedId ?? null, transferring: wb.transferring });
  wb.callRpc = async ({ method, input, outputSchema }) => {
    wb.calls.push(method);
    let value;
    if (method === 'checks.claim') {
      if (wb.claim === 'throw') throw new Error('Work Board offline');
      value = wb.claim === 'missing' ? {} : wb.claim === 'refuse' ? { granted: false, reason: 'a tracker is enabled' } : { granted: true };
    } else if (method === 'checks.ownership') value = own();
    else {
      assert.ok(wb.row?.sentId === input.handoffId && !wb.row.sentConfirmed, 'only the current unconfirmed send is served');
      if (method === 'checks.transferDocument') value = wb.document;
      else { assert.equal(method, 'checks.transferChunk'); const slice = wb.bytes.subarray(input.offset, input.offset + 262144); value = { data: slice.toString('base64'), end: input.offset + slice.length >= wb.bytes.length }; }
    }
    return outputSchema.parse(value);
  };
  /** Work Board starts sending: the row names its handoff, unconfirmed, and the document and bytes are served. */
  wb.send = (handoffId, previous, bytes, extra = {}) => {
    wb.bytes = bytes ?? Buffer.alloc(0);
    wb.document = { format: 'bb-runner-state/1', from: 'work-board', bbProjectId: projectId, handoffId, previous, exportedAt: '2026-01-01T00:00:00.000Z', committed: bytes ? { size: bytes.length, sha256: sha(bytes) } : null, reportedWorktrees: [], ...extra };
    wb.row = { ...wb.row, owner: 'work-board', trackerId: 'tracker_example', sentId: handoffId, sentConfirmed: false };
  };
  wb.confirmSend = () => { wb.row = { ...wb.row, owner: 'sweep', trackerId: null, sentConfirmed: true }; };
  /** Work Board receives what Sweep exported. */
  wb.receive = async (call, document) => {
    const parts = []; let offset = 0;
    for (;;) { const chunk = await call('transfer.chunk', { handoffId: document.handoffId, offset }); parts.push(Buffer.from(chunk.data, 'base64')); offset += parts.at(-1).length; if (chunk.end) break; }
    const bytes = Buffer.concat(parts);
    if (document.committed) { assert.equal(bytes.length, document.committed.size); assert.equal(sha(bytes), document.committed.sha256); }
    wb.row = { owner: 'work-board', trackerId: 'tracker_example', sentId: wb.row?.sentId ?? null, sentConfirmed: !!wb.row?.sentConfirmed, receivedId: document.handoffId };
    return bytes;
  };
  return wb;
}
let xferSendFails = false, xferPushes = 0;
const xferReports = [];
function xferHost(wb, { listed = true, settings } = {}) {
  const host = createFakePluginHost({ pluginId: 'sweep', settings, sdk: {
    projects: projectSettings(() => xferRepo),
    threads: { get: async () => makeThreadResponse(), send: async request => { if (xferSendFails) throw new Error('offline'); xferReports.push(request.input[0].text); } },
    plugins: { list: async () => ({ plugins: listed ? [{ id: 'work-board', enabled: true }] : [] }), callRpc: async request => {
      if (request.pluginId === 'push-notifications') { xferPushes++; return {}; }
      assert.equal(request.pluginId, 'work-board');
      return wb.callRpc(request);
    } },
  } });
  const call = (method, input = {}) => host.harness.behavior.callRpc(method, { projectId, ...input });
  const configure = (fields = {}) => call('configure', { config: { ...config, script: 'ctl.py', args: ['advance'], snapshots: true, ...fields } });
  const tick = async fields => { await configure(fields); await host.harness.behavior.runSchedule('sweep'); return call('status'); };
  return { ...host, call, configure, tick, committed: () => deliveryStore(host.bb.storage.database()).read(projectId)?.committed?.toString() ?? null };
}

// Admission: a refusal, an error or a missing field stops the run; a grant is recorded once; an absent Work Board admits.
{
  const wb = fakeWorkBoard();
  const host = xferHost(wb);
  xferReports.length = 0;
  try {
    await plugin(host.bb);
    const claims = () => wb.calls.filter(call => call === 'checks.claim').length;
    for (const [claim, message] of [['refuse', /Work Board holds/], ['throw', /could not confirm/], ['missing', /could not confirm/]]) {
      wb.claim = claim;
      const refused = await host.tick();
      assert.match(refused.error, message);
      assert.ok(refused.nextRun >= Date.now() + 50000 && refused.nextRun <= Date.now() + 61000);
      assert.equal(refused.handoff, undefined);
      await assert.rejects(host.call('run'), message);
    }
    assert.deepEqual([xferPushes, xferReports.length], [0, 0]);
    wb.claim = 'grant';
    const granted = await host.tick();
    assert.deepEqual(granted.handoff, { granted: true });
    assert.equal(granted.error, null);
    assert.equal(xferReports.length, 1);
    const before = claims();
    await host.tick(); await host.call('run');
    assert.equal(claims(), before);
  } finally { await host.harness.lifecycle.dispose(); }

  const absent = xferHost(wb, { listed: false });
  const quiet = new Error('must not call Work Board');
  wb.callRpc = async () => { throw quiet; };
  try {
    await plugin(absent.bb);
    const ran = await absent.tick();
    assert.equal(ran.handoff, undefined);
    assert.equal(ran.error, null);
    assert.equal((await absent.call('run')).exitCode, 0);
  } finally { await absent.harness.lifecycle.dispose(); }

  // The legacy whole-JSON setting can say enabled: true, but an unmarked project still needs the claim.
  const refusing = fakeWorkBoard(); refusing.claim = 'refuse';
  const legacy = xferHost(refusing, { settings: { projects: JSON.stringify({ [projectId]: { ...config, script: 'ctl.py', args: ['advance'], snapshots: true } }) } });
  try {
    await plugin(legacy.bb);
    await legacy.harness.behavior.runSchedule('sweep');
    assert.match((await legacy.call('status')).error, /Work Board holds/);
  } finally { await legacy.harness.lifecycle.dispose(); }
}

// Export, the marker, import, settling and the round trip.
{
  const wb = fakeWorkBoard();
  const host = xferHost(wb);
  const { call } = host;
  try {
    await plugin(host.bb);
    xferReports.length = 0;
    let s = await host.tick();
    assert.equal(xferReports.length, 1);
    assert.equal(host.committed(), '{"n": 1}');
    // An enabled project, a pending report and a running check each refuse the export and name the way out.
    await assert.rejects(call('transfer.export'), /Disable Sweep first/);
    xferSendFails = true;
    s = await host.tick();
    assert.match(s.pending, /STATE/);
    await host.configure({ enabled: false });
    await assert.rejects(call('transfer.export'), /report is pending/);
    xferSendFails = false;
    await host.tick({ args: ['same'] });
    assert.equal((await call('status')).pending, null);
    await host.configure({ enabled: false, script: 'slow.py', args: [] });
    const slow = call('run');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await call('status')).running, true);
    await assert.rejects(call('transfer.export'), /running: false/);
    await slow;
    await host.configure({ enabled: false });

    const document = await call('transfer.export');
    assert.deepEqual([document.format, document.from, document.bbProjectId, document.previous], ['bb-runner-state/1', 'sweep', projectId, null]);
    assert.deepEqual(document.committed, { size: 8, sha256: sha(Buffer.from(host.committed())) });
    assert.ok(document.lastReport.changes && document.lastReport.manager === first);
    assert.equal(document.exportedAt, new Date(Date.parse(document.exportedAt)).toISOString());
    assert.deepEqual(await call('transfer.export'), document);
    s = await call('status');
    assert.equal(s.handoff.sent.id, document.handoffId);
    assert.deepEqual([s.running, s.importing, s.incoming, s.hasState], [false, false, null, true]);
    // The sender is marked: no run, enable, seed or second export.
    await assert.rejects(call('run'), /sent to Work Board/);
    await assert.rejects(host.configure({ enabled: true }), /export-to-sweep/);
    await assert.rejects(call('config.set', { key: 'enabled', value: true }), /export-to-sweep/);
    await assert.rejects(call('seed-state', { snapshot: '{}' }), /transfer/);
    const unmarked = await call('config.set', { key: 'timeoutSeconds', value: 20 });
    assert.deepEqual(unmarked, { timeoutSeconds: 20 });
    // Only the current unconfirmed id is served, and a confirmation needs Work Board's receipt.
    await assert.rejects(call('transfer.chunk', { handoffId: 'handoff_forged', offset: 0 }), /No unconfirmed send/);
    await assert.rejects(call('transfer.confirm', { handoffId: document.handoffId }), /not recorded the receipt/);
    await assert.rejects(call('transfer.confirm', { handoffId: 'handoff_forged' }), /No send with that handoff id/);
    const received = await wb.receive(call, document);
    assert.equal(received.toString(), host.committed());
    assert.deepEqual(await call('transfer.confirm', { handoffId: document.handoffId }), { confirmed: true });
    assert.deepEqual(await call('transfer.confirm', { handoffId: document.handoffId }), { confirmed: true, duplicate: true });
    await assert.rejects(call('transfer.export'), /already holds/);
    await assert.rejects(call('transfer.chunk', { handoffId: document.handoffId, offset: 0 }), /No unconfirmed send/);
    await assert.rejects(call('run'), /sent to Work Board/);

    // Work Board returns the state. Forged ids, wrong lineage and an unconfirmed earlier send are refused before anything is staged.
    const first1 = document.handoffId;
    const returned = Buffer.from('{"n":7}');
    const lastReport = { fingerprint: reportContents(0, 'x').fingerprint, manager: first, at: 1, changes: reportContents(0, 'STATE input=7\nWAIT EXA-3: blocker EXA-9\nsweep: 1 threads, 1 cards checked, 0 actions\n').changes };
    const failureFingerprint = reportContents(2, 'ERROR boom').fingerprint;
    wb.send('handoff_a', first1, returned, { lastReport, lastFailure: { fingerprint: failureFingerprint, manager: first }, reportedWorktrees: ['/example/tree'], lastMeasuredWorktree: '/example/tree' });
    await assert.rejects(call('transfer.import', { handoffId: 'handoff_forged' }), /not sending that handoff/);
    assert.deepEqual(await call('transfer.preflight', { previous: first1 }), { accept: true, reason: null });
    assert.match((await call('transfer.preflight', { previous: 'handoff_old' })).reason, /Newer state is held here/);
    wb.document = { ...wb.document, previous: 'handoff_old' };
    await assert.rejects(call('transfer.import', { handoffId: 'handoff_a' }), /Newer state is held here/);
    wb.document = { ...wb.document, previous: first1, bbProjectId: 'proj_other' };
    await assert.rejects(call('transfer.import', { handoffId: 'handoff_a' }), /does not belong/);
    wb.document = { ...wb.document, bbProjectId: projectId, from: 'sweep' };
    await assert.rejects(call('transfer.import', { handoffId: 'handoff_a' }), /does not belong/);
    wb.document = { ...wb.document, from: 'work-board', committed: { size: returned.length, sha256: sha(Buffer.from('other')) } };
    await assert.rejects(call('transfer.import', { handoffId: 'handoff_a' }), /do not match/);
    assert.equal((await call('status')).incoming, null);
    wb.send('handoff_a', first1, returned, { lastReport, lastFailure: { fingerprint: failureFingerprint, manager: first }, reportedWorktrees: ['/example/tree'], lastMeasuredWorktree: '/example/tree' });
    assert.deepEqual(await call('transfer.import', { handoffId: 'handoff_a' }), { staged: true });
    assert.deepEqual(await call('transfer.import', { handoffId: 'handoff_a' }), { staged: true, duplicate: true });
    s = await call('status');
    assert.equal(s.incoming, 'handoff_a');
    assert.equal(host.committed(), '{"n": 2}');
    // Staged: frozen, and not applied while Work Board has not confirmed.
    await assert.rejects(call('run'), /sent to Work Board/);
    await assert.rejects(host.configure({ enabled: true }), /export-to-sweep/);
    await assert.rejects(call('transfer.export'), /already staged/);
    assert.equal((await call('transfer.preflight', { previous: first1 })).accept, false);
    assert.deepEqual(await call('transfer.commit', { handoffId: 'handoff_a' }), { settled: 'waiting' });
    assert.equal((await call('status')).incoming, 'handoff_a');
    // Work Board confirms; two settlers overlap and the checkpoint is applied exactly once.
    wb.confirmSend();
    const settled = await Promise.all([call('transfer.commit', { handoffId: 'handoff_a' }), call('transfer.commit', { handoffId: 'handoff_a' })]);
    assert.deepEqual(settled.map(result => result.settled).sort(), ['applied', 'none']);
    s = await call('status');
    assert.deepEqual(s.handoff, { granted: true, received: 'handoff_a' });
    assert.deepEqual([s.incoming, s.enabled, s.config.enabled, s.reportedWorktrees, s.lastMeasuredWorktree, s.delivered, s.pendingWorktrees], [null, undefined, false, ['/example/tree'], '/example/tree', undefined, undefined]);
    assert.equal(host.committed(), returned.toString());
    // A late reply after the next tick advanced the state is a no-op, and a duplicate import writes nothing.
    assert.deepEqual(await call('transfer.commit', { handoffId: 'handoff_a' }), { settled: 'none' });
    assert.deepEqual(await call('transfer.import', { handoffId: 'handoff_a' }), { staged: false, duplicate: true });

    // After the import: an unchanged failure sends nothing, an unchanged Waiting list sends nothing, a cleared one says so.
    const reportsBefore = xferReports.length;
    await host.tick({ script: 'fail.py', args: [], snapshots: false });
    assert.equal(xferReports.length, reportsBefore);
    await host.tick({ args: ['same', '--waits', 'EXA-3'] });
    assert.equal(xferReports.length, reportsBefore);
    assert.equal(host.committed(), returned.toString());
    await host.tick({ args: ['same'] });
    assert.equal(xferReports.length, reportsBefore + 1);
    assert.match(xferReports.at(-1), /Waiting list is clear/);

    // The next round: advance, export with previous = the received id; a replayed older handoff is refused, an aborted one is discarded.
    await host.tick({ args: ['advance'] });
    await host.configure({ enabled: false });
    const second = await call('transfer.export');
    assert.equal(second.previous, 'handoff_a');
    assert.notEqual(second.handoffId, first1);
    assert.equal(second.committed.size, Buffer.byteLength(host.committed()));
    await wb.receive(call, second);
    await call('transfer.confirm', { handoffId: second.handoffId });
    wb.send('handoff_old', first1, returned);
    await assert.rejects(call('transfer.import', { handoffId: 'handoff_old' }), /Newer state is held here/);
    wb.send('handoff_b', second.handoffId, Buffer.from('{"n":20}'));
    assert.deepEqual(await call('transfer.import', { handoffId: 'handoff_b' }), { staged: true });
    wb.row = { ...wb.row, sentId: null, sentConfirmed: false };
    assert.deepEqual(await call('transfer.commit', { handoffId: 'handoff_b' }), { settled: 'discarded' });
    s = await call('status');
    assert.deepEqual([s.incoming, s.handoff.sent.id], [null, second.handoffId]);
    assert.notEqual(host.committed(), '{"n":20}');

    // Settling on its own: the commit call is lost; the next run applies the staged state once Work Board shows the confirmation.
    wb.send('handoff_c', second.handoffId, Buffer.from('{"n":30}'));
    await call('transfer.import', { handoffId: 'handoff_c' });
    wb.confirmSend();
    assert.equal((await call('run')).exitCode, 0);
    s = await call('status');
    assert.deepEqual([s.incoming, s.handoff.received, host.committed()], [null, 'handoff_c', '{"n":30}']);
  } finally { await host.harness.lifecycle.dispose(); }
}

// Cancel and abort: an unconfirmed send is cleared only on Work Board's positive answer.
{
  const wb = fakeWorkBoard();
  const host = xferHost(wb);
  try {
    await plugin(host.bb);
    await host.configure({ enabled: false });
    const document = await host.call('transfer.export');
    assert.equal(document.committed, null);
    wb.transferring = true;
    await assert.rejects(host.call('transfer.cancel'), /transferring or has received/);
    wb.transferring = false;
    wb.row = { owner: 'work-board', trackerId: 'tracker_example', sentId: null, sentConfirmed: false, receivedId: document.handoffId };
    await assert.rejects(host.call('transfer.cancel'), /transferring or has received/);
    wb.row = null;
    assert.deepEqual(await host.call('transfer.cancel'), { cancelled: true });
    assert.deepEqual(await host.call('transfer.cancel'), { cancelled: false });
    assert.equal((await host.call('status')).handoff?.sent, undefined);
    assert.notEqual((await host.call('transfer.export')).handoffId, document.handoffId);
  } finally { await host.harness.lifecycle.dispose(); }
}

// Byte-exact chunked transfer, in both directions: 5 MB of whitespace and of non-ASCII text, and no bytes at all.
for (const bytes of [Buffer.from(' \n\t\r'.repeat(1310720)), Buffer.from('Пример «значение» ✓ '.repeat(262144 + 1)).subarray(0, 5 * 1048576), null]) {
  const wb = fakeWorkBoard();
  const out = xferHost(wb);
  try {
    await plugin(out.bb);
    await out.configure({ enabled: false });
    if (bytes) deliveryStore(out.bb.storage.database()).replace(projectId, bytes);
    const document = await out.call('transfer.export');
    assert.deepEqual(document.committed, bytes ? { size: bytes.length, sha256: sha(bytes) } : null);
    if (bytes) {
      const parts = [];
      for (let offset = 0, end = false; !end; offset += parts.at(-1).length) {
        const chunk = await out.call('transfer.chunk', { handoffId: document.handoffId, offset });
        parts.push(Buffer.from(chunk.data, 'base64')); end = chunk.end;
        assert.ok(parts.at(-1).length <= 262144);
      }
      assert.equal(parts.length, Math.ceil(bytes.length / 262144));
      assert.ok(Buffer.concat(parts).equals(bytes));
    }
  } finally { await out.harness.lifecycle.dispose(); }
  const inbound = xferHost(wb);
  try {
    await plugin(inbound.bb);
    await inbound.configure({ enabled: false });
    wb.send('handoff_big', null, bytes);
    assert.deepEqual(await inbound.call('transfer.import', { handoffId: 'handoff_big' }), { staged: true });
    // A staged handoff with no send of its own: no run, enable or seed until Work Board confirms it.
    await assert.rejects(inbound.call('run'), /pending for this project/);
    await assert.rejects(inbound.configure({ enabled: true }), /pending for this project/);
    await assert.rejects(inbound.call('seed-state', { snapshot: '{}' }), /transfer/);
    wb.confirmSend();
    assert.deepEqual(await inbound.call('transfer.commit', { handoffId: 'handoff_big' }), { settled: 'applied' });
    const stored = deliveryStore(inbound.bb.storage.database()).read(projectId)?.committed ?? null;
    assert.ok(bytes ? stored?.equals(bytes) : stored === null);
  } finally { await inbound.harness.lifecycle.dispose(); }
}
// The legacy whole-JSON setting cannot get a marked project past admission, and a scheduled tick writes the refusal without a push.
{
  const wb = fakeWorkBoard();
  const legacy = xferHost(wb, { settings: { projects: JSON.stringify({ [projectId]: { ...config, script: 'ctl.py', args: ['advance'], snapshots: true } }) } });
  try {
    await plugin(legacy.bb);
    legacy.bb.storage.database().exec('CREATE TABLE IF NOT EXISTS status (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    legacy.bb.storage.database().prepare('INSERT INTO status VALUES (?, ?)').run(projectId, JSON.stringify({ handoff: { granted: true, sent: { id: 'handoff_example', at: 1, confirmed: true } } }));
    const pushes = xferPushes, reports = xferReports.length;
    await legacy.harness.behavior.runSchedule('sweep');
    const refused = await legacy.call('status');
    assert.match(refused.error, /sent to Work Board/);
    assert.deepEqual([xferPushes, xferReports.length, wb.calls], [pushes, reports, []]);
  } finally { await legacy.harness.lifecycle.dispose(); }
}

// Export: the paths of an accepted report are reported before the export, and a legacy baseline is normalized or crosses without changes.
{
  const wb = fakeWorkBoard();
  const host = xferHost(wb);
  try {
    await plugin(host.bb);
    await host.tick();
    const db = host.bb.storage.database();
    const edit = change => { const state = JSON.parse(db.prepare('SELECT value FROM status WHERE id = ?').get(projectId).value); change(state); db.prepare('UPDATE status SET value = ? WHERE id = ?').run(JSON.stringify(state), projectId); return state; };
    const original = edit(() => {}).lastReport.changes;
    assert.ok(original);
    edit(state => { state.pendingWorktrees = ['/example/tree']; });
    deliveryStore(db).stage(projectId, '[sweep] exit 1 tick=proj_test:1\nACTION archived-worktree thr_example: "/example/tree" (4 KiB, clean)\n', null);
    await host.tick({ args: ['same'] });
    await host.configure({ enabled: false });
    edit(state => { delete state.lastReport.changes; });
    const normalized = await host.call('transfer.export');
    assert.deepEqual(normalized.reportedWorktrees, ['/example/tree']);
    assert.deepEqual(normalized.lastReport.changes, reportContents(1, 'ACTION archived-worktree thr_example: "/example/tree" (4 KiB, clean)\n').changes);
  } finally { await host.harness.lifecycle.dispose(); }

  const legacy = xferHost(wb);
  try {
    await plugin(legacy.bb);
    await legacy.tick();
    const db = legacy.bb.storage.database();
    const state = JSON.parse(db.prepare('SELECT value FROM status WHERE id = ?').get(projectId).value);
    delete state.lastReport.changes; delete state.delivered;
    db.prepare('UPDATE status SET value = ? WHERE id = ?').run(JSON.stringify(state), projectId);
    await legacy.configure({ enabled: false });
    const document = await legacy.call('transfer.export');
    assert.equal(document.lastReport.fingerprint, state.lastReport.fingerprint);
    assert.equal('changes' in document.lastReport, false);
    // An unknown baseline: the first scheduled run on the receiver resends once, then the report is known again.
    const receiver = xferHost(wb);
    try {
      await plugin(receiver.bb);
      await receiver.configure({ enabled: false });
      const bytes = Buffer.from(legacy.committed());
      wb.send('handoff_legacy', null, bytes, { lastReport: document.lastReport });
      await receiver.call('transfer.import', { handoffId: 'handoff_legacy' });
      wb.confirmSend();
      await receiver.call('transfer.commit', { handoffId: 'handoff_legacy' });
      const before = xferReports.length;
      await receiver.tick({ args: ['same', '--waits', 'EXA-3'] });
      assert.equal(xferReports.length, before + 1);
      await receiver.tick({ args: ['same', '--waits', 'EXA-3'] });
      assert.equal(xferReports.length, before + 1);
    } finally { await receiver.harness.lifecycle.dispose(); }
  } finally { await legacy.harness.lifecycle.dispose(); }
}
await rm(xferRepo, { recursive: true, force: true });
console.log('Sweep transfer checks passed');
