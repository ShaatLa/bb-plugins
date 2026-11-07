import { createFakePluginHost, makeThreadResponse, makeQueueEntry } from '@get-bb/plugin-sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, registerTasksApi } from '../api';
import { scheduledService } from './service';
import { registerScheduled } from './index';
import { scheduledRunMarker } from './acceptance';
import type { ScheduleRun } from '../shared/scheduled';

afterEach(()=>vi.useRealTimers());
function fixture(){
 const thread=makeThreadResponse({id:'thr_worker',environmentId:null,status:'active',runtime:{displayStatus:'active'}});
 let events:unknown[]=[],queue:ReturnType<typeof makeQueueEntry>[]=[],pushFails=false;
 const host=createFakePluginHost({pluginId:'work-board',sdk:{threads:{get:async()=>thread,defaultExecutionOptions:async()=>null,events:{list:async()=>events as never},queuedMessages:{list:async()=>queue,delete:async()=>({ok:true as const})},send:async input=>{
  const entry=makeQueueEntry({id:'queue_'+(queue.length+1),threadId:thread.id,content:input.input,waitingOn:{kind:'thread-busy'},state:'waiting'});queue.push(entry);return {ok:true as const,delivery:'queued' as const,queuedMessage:entry};
 }},plugins:{callRpc:async()=>{if(pushFails)throw new Error('Push unavailable');return {ok:true,channels:['desktop']};}}}});
 const store=createStore(host.bb),project=store.tasks.createProject({name:'Scheduled runtime',prefix:'RUN',color:'blue',linkedBbProjectId:'proj_runtime'});
 registerTasksApi(host.bb,store);registerScheduled(host.bb,store);
 const service=scheduledService(host.bb,store),data=service.data;
 const create=()=>data.create({projectId:project.id,title:'Daily check',rule:{kind:'daily',time:'09:00',timezone:'UTC'},target:{kind:'thread',threadId:thread.id}});
 const accept=(runs:ScheduleRun[],scope='turn')=>{
  events=[{type:'turn/input/accepted',seq:20,scope:scope==='turn'?{kind:'turn',turnId:'turn_1'}:{kind:'thread'},data:{clientRequestId:'request_1'}},{type:'client/turn/requested',seq:19,scope:{kind:'thread'},data:{requestId:'request_1',input:[],inputGroups:[[{type:'text',text:'Unrelated owner message'}],...runs.map(run=>[{type:'text',text:`${scheduledRunMarker(run.id)}\nDo this task`}]) ]}}];
  queue=[];
 };
 return {...host,store,project,service,data,create,thread,accept,setPushFailure:()=>{pushFails=true;},clearQueue:()=>{queue=[];},setEvents:(value:unknown[])=>{events=value;},getQueue:()=>queue};
}
describe('Scheduled execution',()=>{
 it('queues once, waits for matching accepted groups, and synchronizes Done/Reopen atomically',async()=>{
  const f=fixture();try{
   const s=f.create(),a=await f.service.runNow(s.id,'a'),again=await f.service.runNow(s.id,'a'),b=await f.service.runNow(s.id,'b');
   expect(a.state).toBe('queued');expect(again.id).toBe(a.id);expect(f.harness.sdk.callsTo('threads.send')).toHaveLength(2);
   expect(f.store.tasks.listTaskThreads(a.taskId!)).toEqual([]);
   expect((await f.harness.callRpc('listTasks',{}) as {tasks:unknown[]}).tasks).toEqual([]);
   f.accept([a,b],'thread');await f.service.reconcileThread(f.thread.id);
   expect(f.data.run(a.id).state).toBe('running');expect(f.data.run(b.id).state).toBe('running');
   expect(f.store.tasks.getTask(a.taskId!)?.status).toBe('in_progress');
   expect((await f.harness.callRpc('listTasks',{}) as {tasks:unknown[]}).tasks).toHaveLength(2);
   f.store.tasks.updateTask(a.taskId!,{status:'done'});expect(f.data.run(a.id).state).toBe('completed');
   expect((await f.harness.callRpc('listTasks',{}) as {tasks:unknown[]}).tasks).toHaveLength(1);
   f.store.tasks.updateTask(a.taskId!,{status:'in_review'});expect(f.data.run(a.id).state).toBe('running');
  }finally{await f.harness.dispose();}
 });
 it('does not infer cancellation from queue disappearance or repeat an unknown send after reload',async()=>{
  const f=fixture();try{
   const s=f.create(),r=await f.service.runNow(s.id,'unknown');f.clearQueue();f.setPushFailure();
   await f.service.reconcileThread(f.thread.id);
   expect(f.data.run(r.id)).toMatchObject({state:'delivery_unknown',pushState:'failed'});
   const count=f.harness.sdk.callsTo('threads.send').length;
   await f.service.reconcileAll();await f.service.runNow(s.id,'unknown');
   expect(f.harness.sdk.callsTo('threads.send')).toHaveLength(count);
   await expect(f.service.retry(r.id,'retry')).rejects.toThrow('unknown');
  }finally{await f.harness.dispose();}
 });
 it('requires positive cancellation evidence and keeps actual schedule deletion independent of results',async()=>{
  const f=fixture();try{
   const s=f.create(),r=await f.service.runNow(s.id,'cancel');
   f.harness.sdk.stub('threads.queuedMessages.delete',async()=>{const [entry]=f.getQueue();f.clearQueue();await f.harness.emitThreadEvent('message.cancelled',{entry:entry!});return {ok:true};});
   expect((await f.service.cancel(r.id)).state).toBe('canceled');
   expect(f.store.tasks.getTask(r.taskId!)?.status).toBe('canceled');
   expect(await f.service.remove(s.id)).toBe(true);expect(f.data.results({}).results).toHaveLength(1);
  }finally{await f.harness.dispose();}
 });
 it('reports cancellation as pending when DELETE returns without proof and refuses a misleading delete success',async()=>{
  const f=fixture();try{
   const s=f.create(),r=await f.service.runNow(s.id,'pending');
   f.harness.sdk.stub('threads.queuedMessages.delete',async()=>{f.clearQueue();return {ok:true};});
   expect((await f.service.cancel(r.id)).state).toBe('cancel_pending');
   await expect(f.service.remove(s.id)).rejects.toThrow('confirmed cancellation');expect(f.data.get(s.id).enabled).toBe(false);
   f.accept([r]);await f.service.reconcileThread(f.thread.id);expect(f.data.run(r.id).state).toBe('running');
  }finally{await f.harness.dispose();}
 });
 it('skips an unavailable target before creating a result, recording a failed push',async()=>{
  const f=fixture();try{
   f.thread.archivedAt=Date.now();f.setPushFailure();const r=await f.service.runNow(f.create().id,'unavailable');
   expect(r).toMatchObject({state:'skipped',taskId:null,pushState:'failed'});expect(f.harness.sdk.callsTo('threads.send')).toHaveLength(0);
   expect(f.store.tasks.listComments(f.data.get(r.scheduleId).templateTaskId)[0]?.body).toContain('Cannot start');
  }finally{await f.harness.dispose();}
 });
 it.each([30*60_000,30*60_000+1])('honors the inclusive 30-minute reboot grace (%i ms)',async age=>{
  vi.useFakeTimers({toFake:['Date']});const due=new Date('2026-11-07T09:00:00Z');vi.setSystemTime(due.valueOf()+age);
  const f=fixture();try{
   const s=f.data.create({projectId:f.project.id,title:'Once',rule:{kind:'once',at:due.toISOString(),timezone:'UTC'},target:{kind:'thread',threadId:f.thread.id}},new Date('2026-11-07T08:00:00Z'));
   await f.service.runDue(new Date());
   expect(f.data.get(s.id).nextDueAt).toBeNull();expect(f.data.runs({}).runs[0]?.state).toBe(age===30*60_000?'queued':'skipped');
   expect(f.harness.sdk.callsTo('threads.send')).toHaveLength(age===30*60_000?1:0);
  }finally{await f.harness.dispose();}
 });
 it('uses the current preset for new sessions and treats accepted work as started despite a lost response',async()=>{
  const f=fixture();try{
   const p=f.store.tasks.createPreset({name:'Worker',providerId:'codex',modelId:'old',reasoningLevel:'high',serviceTier:null,permissionMode:'auto',environmentKind:'project-default',baseBranch:null,machineId:null,instructions:''});
   const s=f.data.create({projectId:f.project.id,title:'New session',rule:{kind:'daily',time:'09:00',timezone:'UTC'},target:{kind:'preset',presetId:p.id}});
   f.store.tasks.updatePreset(p.id,{modelId:'current'});
   f.harness.sdk.stub('threads.spawn',async input=>{
    const r=f.data.runs({}).runs[0]!;f.accept([r]);return makeThreadResponse({id:'thr_new',environmentId:null,status:'active'});
   });
   const r=await f.service.runNow(s.id,'preset');expect(r.state).toBe('running');expect(r.execution).toMatchObject({model:'current'});
   expect(f.harness.sdk.callsTo('threads.spawn')[0]?.[0]).toMatchObject({model:'current',pluginMetadata:{scheduledRunId:r.id}});
   const another=f.create();f.harness.sdk.stub('threads.send',async()=>{const pending=f.data.runs({scheduleId:another.id}).runs[0]!;f.accept([pending]);throw new Error('Response lost');});
   expect((await f.service.runNow(another.id,'lost')).state).toBe('running');
  }finally{await f.harness.dispose();}
 });
 it('never age-deletes unresolved state and does not poll completed or in-review session history on every tick',async()=>{
  const f=fixture();try{
   const s=f.create(),r=await f.service.runNow(s.id,'review');f.accept([r]);await f.service.reconcileThread(f.thread.id);
   f.store.tasks.updateTask(r.taskId!,{status:'in_review'});
   const before=f.harness.sdk.callsTo('threads.get').length;await f.service.reconcileAll();
   expect(f.harness.sdk.callsTo('threads.get')).toHaveLength(before);
   expect(f.data.run(r.id).state).toBe('running');
  }finally{await f.harness.dispose();}
 });
 it('starts the recent slot after a long outage instead of discarding it with older missed slots',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-07T09:10:00Z'));
  const f=fixture();try{
   const s=f.data.create({projectId:f.project.id,title:'Daily recovery',rule:{kind:'daily',time:'09:00',timezone:'UTC'},target:{kind:'thread',threadId:f.thread.id}},new Date('2026-11-04T08:00:00Z'));
   await f.service.runDue(new Date());
   expect(f.harness.sdk.callsTo('threads.send')).toHaveLength(1);
   const queued=f.data.runs({scheduleId:s.id}).runs.find(r=>r.state==='queued');expect(queued?.scheduledFor).toBe('2026-11-07T09:00:00.000Z');
   expect(f.data.get(s.id).nextDueAt).toBe('2026-11-08T09:00:00.000Z');
  }finally{await f.harness.dispose();}
 });
 it('shares immutable accepted attribution without rereading large history or rewriting unchanged queues',async()=>{
  const f=fixture();try{
   const s=f.create(),r=await f.service.runNow(s.id,'cached');
   f.setEvents([{type:'turn/input/accepted',seq:11,data:{clientRequestId:'other'}},{type:'client/turn/requested',seq:10,data:{requestId:'other',input:[{type:'text',text:'Other work'}]}}]);
   await f.service.reconcileThread(f.thread.id);
   const bodyReads=()=>f.harness.sdk.callsTo('threads.events.list').filter(args=>(args[0] as {types:string[]}).types.includes('client/turn/requested')).length;
   const before=bodyReads(),signals=f.harness.realtimeSignals.length,updated=f.data.run(r.id).updatedAt;
   await f.service.reconcileThread(f.thread.id);
   expect(bodyReads()).toBe(before);expect(f.harness.realtimeSignals).toHaveLength(signals);expect(f.data.run(r.id).updatedAt).toBe(updated);
  }finally{await f.harness.dispose();}
 });
 it('recovers lost spawn responses from plugin metadata without spawning again',async()=>{
  const f=fixture();try{
   const preset=f.store.tasks.createPreset({name:'Lost worker',providerId:'codex',modelId:'model',reasoningLevel:'high',serviceTier:null,permissionMode:'auto',environmentKind:'project-default',baseBranch:null,machineId:null,instructions:''});
   const s=f.data.create({projectId:f.project.id,title:'Lost response',rule:{kind:'daily',time:'09:00',timezone:'UTC'},target:{kind:'preset',presetId:preset.id}});
   f.harness.sdk.stub('threads.spawn',async()=>{f.accept([f.data.runs({scheduleId:s.id}).runs[0]!]);throw new Error('Connection lost');});
   const r=await f.service.runNow(s.id,'lost-spawn');expect(r.state).toBe('delivery_unknown');
   f.harness.sdk.stub('threads.list',async()=>[makeThreadResponse({id:'thr_lost',environmentId:null,originPluginId:'work-board'})] as never);
   f.harness.sdk.stub('threads.experimental_listPluginMetadata',async()=>({threads:[{threadId:'thr_lost',metadata:{scheduledRunId:r.id}}]}));
   await f.service.reconcileAll();expect(f.data.run(r.id)).toMatchObject({state:'running',threadId:'thr_lost'});
   expect(f.harness.sdk.callsTo('threads.spawn')).toHaveLength(1);
  }finally{await f.harness.dispose();}
 });
 it('coalesces repeated automatic misses and avoids repeat comments/pushes',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
  const f=fixture();try{
   const s=f.data.create({projectId:f.project.id,title:'Daily miss',rule:{kind:'daily',time:'09:00',timezone:'UTC'},target:{kind:'thread',threadId:f.thread.id}},new Date('2026-11-07T08:00:00Z'));
   await f.service.runDue(new Date());vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));await f.service.runDue(new Date());
   expect(f.data.runs({scheduleId:s.id}).runs).toMatchObject([{state:'skipped',missCount:2}]);
   expect(f.store.tasks.listComments(s.templateTaskId)).toHaveLength(1);expect(f.harness.sdk.callsTo('plugins.callRpc')).toHaveLength(1);
  }finally{await f.harness.dispose();}
 });
 it('bounds concurrent manual dispatches',async()=>{
  const f=fixture();try{
   let active=0,peak=0,counter=0;f.harness.sdk.stub('threads.send',async (input:Parameters<typeof f.bb.sdk.threads.send>[0])=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    const queuedMessage=makeQueueEntry({id:'q_'+(++counter),threadId:f.thread.id,content:input.input,waitingOn:{kind:'thread-busy'},state:'waiting'});
    return {ok:true,delivery:'queued',queuedMessage};
   });
   const s=f.create();await Promise.all(Array.from({length:6},(_,i)=>f.service.runNow(s.id,String(i))));expect(peak).toBe(2);
  }finally{await f.harness.dispose();}
 });

 it('does not move a fast completed task backwards when start confirmation arrives late',async()=>{
  const f=fixture();try{
   const r=await f.service.runNow(f.create().id,'fast');f.store.tasks.updateTask(r.taskId!,{status:'done'});
   f.thread.status='idle';f.accept([r]);await f.service.reconcileThread(f.thread.id);
   expect(f.data.run(r.id).state).toBe('completed');expect(f.store.tasks.getTask(r.taskId!)?.status).toBe('done');
   expect(f.store.tasks.listTaskThreads(r.taskId!)[0]?.liveStatus).toBe('idle');
  }finally{await f.harness.dispose();}
 });

 it('resumes a provably unsent reservation after restart inside grace',async()=>{
  const f=fixture();try{
   const s=f.create(),r=f.data.reserve(s.id,'slot:reserved',new Date().toISOString()).run;
   expect(r.taskId).toBeNull();await f.service.reconcileAll();
   expect(f.data.run(r.id).state).toBe('queued');expect(f.harness.sdk.callsTo('threads.send')).toHaveLength(1);
   await f.service.reconcileAll();expect(f.harness.sdk.callsTo('threads.send')).toHaveLength(1);
  }finally{await f.harness.dispose();}
 });

 it('reconciles queued work across a real plugin reload without resending',async()=>{
  const f=fixture();let replacement:Awaited<ReturnType<typeof f.harness.lifecycle.reload>>|undefined;
  try{
   const s=f.create(),r=await f.service.runNow(s.id,'reload');
   replacement=await f.harness.lifecycle.reload(async bb=>registerScheduled(bb,createStore(bb)));
   const next=scheduledService(replacement.bb,createStore(replacement.bb));await next.reconcileThread(f.thread.id);
   const before=replacement.harness.sdk.callsTo('threads.send').length;
   expect((await next.runNow(s.id,'reload')).id).toBe(r.id);expect(next.data.run(r.id).state).toBe('queued');
   expect(replacement.harness.sdk.callsTo('threads.send')).toHaveLength(before);
  }finally{if(replacement)await replacement.harness.dispose();else await f.harness.dispose();}
 });

});
