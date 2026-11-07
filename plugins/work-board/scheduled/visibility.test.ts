import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { createStore, registerTasksApi } from '../api';
import { navigationBadgeCounts } from '../api/badge';
import { createScheduledStore } from './store';
import { registerLifecycle } from '../lifecycle';
import { attachNamedTaskThread } from '../lifecycle/discovery';

describe('scheduled task visibility across ordinary readers',()=>{
 it('excludes queued/completed recurring tasks from RPC, counters and badge while preserving explicit reads',async()=>{
  const host=createFakePluginHost({pluginId:'work-board'}),store=createStore(host.bb),scheduled=createScheduledStore(host.bb,store);
  registerTasksApi(host.bb,store);
  const project=store.tasks.createProject({name:'Schedule',prefix:'VIS',color:'blue'});
  const s=scheduled.create({projectId:project.id,title:'Daily',rule:{kind:'daily',time:'09:00',timezone:'UTC'},target:{kind:'thread',threadId:'thr_worker'}});
  const run=scheduled.reserve(s.id,'first',new Date().toISOString()).run,task=scheduled.createRunTask(run.id);
  const listed=()=>host.harness.callRpc('listTasks',{});
  expect(await listed()).toMatchObject({tasks:[]});
  expect(await host.harness.callRpc('getTask',{taskId:task.id})).toMatchObject({task:{ordinaryVisible:false}});
  expect(store.projectTaskCount(project.id)).toBe(0);expect(store.openTaskCount()).toBe(0);
  expect(store.sidebarSummary()).toMatchObject([{taskCount:0}]);
  expect(navigationBadgeCounts(host.bb,store,['open'],Date.now()).count).toBe(0);
  expect(await host.harness.callRpc('listTasks',{includeScheduled:true})).toMatchObject({tasks:expect.arrayContaining([expect.objectContaining({id:task.id})])});
  scheduled.markStarted(run.id,{threadId:'thr_worker',requestId:'r1',title:'Worker',presetName:'Existing'});
  expect(await listed()).toMatchObject({tasks:[{id:task.id}]});
  store.tasks.updateTask(task.id,{status:'done'});
  expect(await listed()).toMatchObject({tasks:[]});expect(store.projectTaskCount(project.id)).toBe(0);
  expect(await host.harness.callRpc('getTask',{taskId:task.id})).toMatchObject({task:{ordinaryVisible:false}});
  store.tasks.updateTask(task.id,{status:'in_review'});
  expect(await listed()).toMatchObject({tasks:[{id:task.id}]});
  const once=scheduled.create({projectId:project.id,title:'Once',rule:{kind:'once',at:new Date(Date.now()+3600000).toISOString(),timezone:'UTC'},target:{kind:'thread',threadId:'thr_worker'}});
  const onceRun=scheduled.reserve(once.id,'first',new Date().toISOString()).run,onceTask=scheduled.createRunTask(onceRun.id);
  scheduled.markStarted(onceRun.id,{threadId:'thr_worker',requestId:'r2',title:'Worker',presetName:'Existing'});store.tasks.updateTask(onceTask.id,{status:'done'});
  expect((await host.harness.callRpc('listTasks',{}) as {tasks:{id:string}[]}).tasks.map(t=>t.id)).toContain(onceTask.id);
  await host.harness.lifecycle.dispose();
 });
 it('does not auto-attach a pre-start scheduled task or fetch historical completed worker sessions at startup',async()=>{
  const host=createFakePluginHost({pluginId:'work-board',sdk:{threads:{get:async({threadId})=>makeThreadResponse({id:threadId,status:'idle'})}}}),store=createStore(host.bb),scheduled=createScheduledStore(host.bb,store);
  const project=store.tasks.createProject({name:'Schedule',prefix:'SES',color:'blue',linkedBbProjectId:'proj_schedule'});
  const s=scheduled.create({projectId:project.id,title:'Daily',rule:{kind:'daily',time:'09:00',timezone:'UTC'},target:{kind:'thread',threadId:'thr_worker'}});
  const r=scheduled.reserve(s.id,'first',new Date().toISOString()).run,task=scheduled.createRunTask(r.id);
  attachNamedTaskThread(host.bb,store,makeThreadResponse({id:'thr_worker',projectId:'proj_schedule',title:task.key,status:'active'}));
  expect(store.tasks.listTaskThreads(task.id)).toEqual([]);
  scheduled.markStarted(r.id,{threadId:'thr_worker',requestId:'r1',title:'Worker',presetName:'Existing'});store.tasks.updateTask(task.id,{status:'done'});
  await registerLifecycle(host.bb,store);expect(host.harness.sdk.callsTo('threads.get')).toHaveLength(0);
  expect(()=>store.tasks.updateTask(s.templateTaskId,{status:'done'})).toThrow('template');
  expect(()=>store.tasks.deleteTask(s.templateTaskId)).toThrow('Scheduled settings');
  await host.harness.lifecycle.dispose();
 });
});
