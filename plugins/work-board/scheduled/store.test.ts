import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';
import { createStore } from '../api';
import { createScheduledStore, ordinaryTaskVisibilitySql } from './store';
function fixture(){
 const host=createFakePluginHost({pluginId:'work-board'}),store=createStore(host.bb),scheduled=createScheduledStore(host.bb,store);
 const project=store.tasks.createProject({name:'Scheduled',prefix:'SCH',color:'blue'});
 const input={projectId:project.id,title:'Daily check',rule:{kind:'daily' as const,time:'09:00',timezone:'UTC'},target:{kind:'thread' as const,threadId:'thr_worker'}};
 return {...host,store,scheduled,project,input};
}
describe('scheduled persistence',()=>{
 it('keeps queued tasks hidden and preserves results after history expiry and schedule deletion',async()=>{
  const f=fixture(),now=new Date('2026-11-01T08:00:00Z'),s=f.scheduled.create(f.input,now);
  const r=f.scheduled.reserve(s.id,'slot:one','2026-11-01T09:00:00.000Z',now);
  expect(f.scheduled.reserve(s.id,r.run.occurrenceKey,r.run.scheduledFor,now)).toMatchObject({created:false,run:{id:r.run.id}});
  const task=f.scheduled.createRunTask(r.run.id);
  const visible=()=>f.bb.storage.database().prepare(`SELECT t.id FROM tasks t WHERE ${ordinaryTaskVisibilitySql()}`).all();
  expect(visible()).toEqual([]);
  f.scheduled.markStarted(r.run.id,{threadId:'thr_worker',requestId:'r1',title:'Worker',presetName:'Existing thread'},now);
  expect(visible()).toEqual([{id:task.id}]);
  f.store.tasks.updateTask(task.id,{status:'done'});f.scheduled.updateRun(r.run.id,{state:'completed',finishedAt:now.toISOString()},now);
  expect(visible()).toEqual([]);expect(f.scheduled.cleanup(new Date('2026-12-02T09:00:00Z'))).toBe(1);
  expect(()=>f.scheduled.reserve(s.id,r.run.occurrenceKey,r.run.scheduledFor)).toThrow('already ran');
  f.scheduled.remove(s.id);expect(f.store.tasks.getTask(s.templateTaskId)).toBeUndefined();
  expect(f.scheduled.results({}).results.map(x=>x.task.id)).toEqual([task.id]);expect(visible()).toEqual([]);
  f.store.tasks.updateTask(task.id,{status:'in_review'});expect(visible()).toEqual([{id:task.id}]);
  await f.harness.lifecycle.dispose();
 });
 it('clones immutable attachment references and warning dependencies, excluding past discussion',async()=>{
  const f=fixture(),pre=f.store.tasks.createTask({projectId:f.project.id,title:'Predecessor'}),s=f.scheduled.create({...f.input,dependencyIds:[pre.id]});
  const a=f.store.tasks.createAttachment({taskId:s.templateTaskId,fileName:'image.png',mime:'image/png',sizeBytes:12,blobPath:'attachments/immutable.png',isImage:true});
  f.store.tasks.updateTask(s.templateTaskId,{description:`![image](/attachments/${a.id})`});
  f.store.tasks.createComment({taskId:s.templateTaskId,kind:'system',authorName:'Work Board',body:'Past incident'});
  const r=f.scheduled.reserve(s.id,'manual:one',new Date().toISOString()),task=f.scheduled.createRunTask(r.run.id),[copy]=f.store.tasks.listAttachmentsForTask(task.id);
  expect(copy!.blobPath).toBe(a.blobPath);expect(copy!.id).not.toBe(a.id);expect(task.description).toContain(copy!.id);expect(task.description).not.toContain(a.id);
  expect(f.scheduled.createRunTask(r.run.id).id).toBe(task.id);expect(f.store.tasks.listComments(task.id)).toEqual([]);
  expect(f.bb.storage.database().prepare('SELECT blocking_task_id FROM task_dependencies WHERE task_id=?').all(task.id)).toEqual([{blocking_task_id:pre.id}]);
  await f.harness.lifecycle.dispose();
 });
 it('retains unresolved and active records, expires resolved errors seven days after resolution',async()=>{
  const f=fixture(),s=f.scheduled.create(f.input),at=new Date('2026-10-01T09:00:00Z');
  const first=f.scheduled.reserve(s.id,'one',at.toISOString(),at).run,second=f.scheduled.reserve(s.id,'two',at.toISOString(),at).run,third=f.scheduled.reserve(s.id,'three',at.toISOString(),at).run;
  f.scheduled.updateRun(first.id,{state:'failed',reason:'Unavailable'},at);f.scheduled.updateRun(second.id,{state:'failed',reason:'Unavailable'},at);f.scheduled.resolve(second.id,'Reviewed',at);
  expect(f.scheduled.cleanup(new Date('2026-10-08T08:59:59Z'))).toBe(0);expect(f.scheduled.cleanup(new Date('2026-10-08T09:00:00Z'))).toBe(1);
  expect(f.scheduled.run(first.id).resolvedAt).toBeNull();expect(f.scheduled.run(third.id).state).toBe('starting');
  await f.harness.lifecycle.dispose();
 });
 it('resumes into the future, paginates, rolls back invalid cross-project dependencies',async()=>{
  const f=fixture(),now=new Date('2026-11-07T12:00:00Z'),s=f.scheduled.create(f.input,now);
  expect(f.scheduled.setEnabled(s.id,false,now).nextDueAt).toBeNull();expect(f.scheduled.setEnabled(s.id,true,now).nextDueAt).toBe('2026-11-08T09:00:00.000Z');
  f.scheduled.create({...f.input,title:'Second'},now);const page=f.scheduled.list({limit:1});expect(page.nextCursor).toBe('1');
  expect(f.scheduled.list({limit:1,cursor:page.nextCursor!}).schedules[0]!.id).not.toBe(page.schedules[0]!.id);
  const other=f.store.tasks.createProject({name:'Other',prefix:'OTH',color:'red'}),foreign=f.store.tasks.createTask({projectId:other.id,title:'Other task'});
  expect(()=>f.scheduled.create({...f.input,dependencyIds:[foreign.id]})).toThrow('same project');expect(f.scheduled.list({}).schedules).toHaveLength(2);
  await f.harness.lifecycle.dispose();
 });
});
