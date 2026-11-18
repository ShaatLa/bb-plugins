import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { TasksApiStore } from "../api";
import type { Task as StoredTask } from "../db";
import { createDependencyStore } from "../dependencies/store";
import { createScheduleInputSchema, updateScheduleInputSchema, scheduleSchema, scheduleRunSchema, scheduleSourceSchema, type Schedule, type ScheduleRun, type ScheduleSource, type Recurrence } from "../shared/scheduled";
import { nextOccurrence } from "./recurrence";

export { ordinaryTaskVisibilitySql } from "./visibility";
type Page = { projectId?:string; scheduleId?:string; search?:string; needsAttention?:boolean; limit?:number; cursor?:string };
type ScheduleRow = {id:string;project_id:string;template_task_id:string;title:string;rule:string;target:string;enabled:number;next_due_at:string|null;created_at:string;updated_at:string};
type SourceRow = {task_id:string;schedule_id:string;schedule_title:string;role:ScheduleSource["role"];scheduled_for:string|null;started_at:string|null;run_id:string|null;occurrence_key:string|null};
const sourceFromRow=(r:SourceRow):ScheduleSource=>scheduleSourceSchema.parse({taskId:r.task_id,scheduleId:r.schedule_id,scheduleTitle:r.schedule_title,role:r.role,scheduledFor:r.scheduled_for,startedAt:r.started_at,runId:r.run_id,occurrenceKey:r.occurrence_key});
export function createScheduledStore(bb:BbPluginApi,store:TasksApiStore) {
 const db=bb.storage.database();
 const dependencies=createDependencyStore(db,store.tasks);
 const apiTask=(task:StoredTask)=>({...task,labelIds:store.tasks.listTaskLabels(task.id).map(x=>x.labelId)});
 const requireTask=(id:string)=>{const t=store.tasks.getTask(id);if(!t)throw new Error(`Task not found: ${id}`);return t;};
 const run=(id:string):ScheduleRun=>{const row=db.prepare<[string],{payload:string}>("SELECT payload FROM task_schedule_runs WHERE id=?").get(id);if(!row)throw new Error(`Scheduled run not found: ${id}`);return scheduleRunSchema.parse(JSON.parse(row.payload));};
 function overlaps(scheduleId:string):string[] {
  return db.prepare<[string],{run_id:string}>(`SELECT ss.run_id FROM task_scheduled_sources ss JOIN tasks t ON t.id=ss.task_id WHERE ss.schedule_id=? AND ss.role<>'template' AND ss.run_id IS NOT NULL AND t.status NOT IN ('done','canceled') ORDER BY t.created_at LIMIT 100`).all(scheduleId).map(x=>x.run_id);
 }
 const scheduleFromRow=(row:ScheduleRow):Schedule=>{ const unfinished=overlaps(row.id); return scheduleSchema.parse({id:row.id,projectId:row.project_id,templateTaskId:row.template_task_id,title:row.title,rule:JSON.parse(row.rule),target:JSON.parse(row.target),enabled:Boolean(row.enabled),nextDueAt:row.next_due_at,createdAt:row.created_at,updatedAt:row.updated_at,overlapRunIds:unfinished.length>1?unfinished:[]}); };
 const scheduleSelect=`SELECT s.*, t.title FROM task_schedules s JOIN tasks t ON t.id=s.template_task_id`;
 const get=(id:string):Schedule=>{const row=db.prepare<[string],ScheduleRow>(`${scheduleSelect} WHERE s.id=?`).get(id);if(!row)throw new Error(`Schedule not found: ${id}`);return scheduleFromRow(row);};
 function replaceDependencies(taskId:string,ids:string[]) {
  db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(taskId);
  for(const id of [...new Set(ids)])dependencies.add(taskId,id);
 }
 function setSource(source:ScheduleSource) {
  const s=scheduleSourceSchema.parse(source);
  db.prepare(`INSERT INTO task_scheduled_sources(task_id,schedule_id,schedule_title,role,scheduled_for,started_at,run_id,occurrence_key) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET schedule_id=excluded.schedule_id,schedule_title=excluded.schedule_title,role=excluded.role,scheduled_for=excluded.scheduled_for,started_at=excluded.started_at,run_id=excluded.run_id,occurrence_key=excluded.occurrence_key`).run(s.taskId,s.scheduleId,s.scheduleTitle,s.role,s.scheduledFor,s.startedAt,s.runId,s.occurrenceKey);
 }
 const source=(taskId:string):ScheduleSource|null=>{const row=db.prepare<[string],SourceRow>("SELECT * FROM task_scheduled_sources WHERE task_id=?").get(taskId);return row?sourceFromRow(row):null;};
 function create(raw:z.input<typeof createScheduleInputSchema>,now=new Date()) {
  const input=createScheduleInputSchema.parse(raw);
  if(input.enabled&&input.target.kind==="unassigned")throw new Error("Choose an execution target before enabling this schedule");
  return store.transaction(()=>{
   if(input.enabled&&input.rule.kind==="once"&&new Date(input.rule.at)<new Date(now.valueOf()-30*60_000))throw new Error("One-time date is more than 30 minutes in the past");
   const task=store.tasks.createTask({projectId:input.projectId,title:input.title,description:input.description,priority:input.priority});
   const id=randomUUID(),stamp=now.toISOString();
   const due=input.rule.kind==="once"?new Date(input.rule.at).toISOString():nextOccurrence(input.rule,now)?.toISOString()??null;
   db.prepare("INSERT INTO task_schedules(id,project_id,template_task_id,rule,target,enabled,next_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,input.projectId,task.id,JSON.stringify(input.rule),JSON.stringify(input.target),Number(input.enabled),input.enabled?due:null,stamp,stamp);
   setSource({taskId:task.id,scheduleId:id,scheduleTitle:input.title,role:"template",scheduledFor:null,startedAt:null,runId:null,occurrenceKey:null});
   replaceDependencies(task.id,input.dependencyIds);
   return get(id);
  });
 }
 function update(raw:z.input<typeof updateScheduleInputSchema>,now=new Date()) {
  const input=updateScheduleInputSchema.parse(raw);
  return store.transaction(()=>{
   const current=get(input.scheduleId),rule=input.rule??current.rule,enabled=input.enabled??current.enabled;
   if(enabled&&(input.target??current.target).kind==="unassigned")throw new Error("Choose an execution target before enabling this schedule");
   store.tasks.updateTask(current.templateTaskId,{...(input.title===undefined?{}:{title:input.title}),...(input.description===undefined?{}:{description:input.description}),...(input.priority===undefined?{}:{priority:input.priority})});
   if(input.dependencyIds!==undefined)replaceDependencies(current.templateTaskId,input.dependencyIds);
   let due=current.nextDueAt;
   if(!enabled)due=null;
   else if(input.rule!==undefined||!current.enabled)due=nextOccurrence(rule,new Date(now.valueOf()-1))?.toISOString()??null;
   db.prepare("UPDATE task_schedules SET rule=?,target=?,enabled=?,next_due_at=?,updated_at=? WHERE id=?").run(JSON.stringify(rule),JSON.stringify(input.target??current.target),Number(enabled),due,now.toISOString(),current.id);
   if(input.title!==undefined)db.prepare("UPDATE task_scheduled_sources SET schedule_title=? WHERE task_id=?").run(input.title,current.templateTaskId);
   return get(current.id);
  });
 }
 const setEnabled=(id:string,enabled:boolean,now=new Date())=>update({scheduleId:id,enabled},now);
 function remove(id:string) {
  return store.transaction(()=>{
   const current=get(id);
   // Result provenance and incidents deliberately have no FK cascade to the schedule.
   db.prepare("DELETE FROM task_schedules WHERE id=?").run(id);
   store.tasks.deleteTask(current.templateTaskId);
   return true;
  });
 }
 function pageSql(input:Page,alias:string,allowSchedule=true) {
  const where:string[]=[],params:(string|number)[]=[];
  if(input.projectId){where.push(`${alias}.project_id=?`);params.push(input.projectId);}
  if(input.scheduleId&&allowSchedule){where.push(`${alias}.schedule_id=?`);params.push(input.scheduleId);}
  if(input.cursor){if(!/^\d+$/.test(input.cursor)||Number(input.cursor)>1_000_000)throw new Error("Invalid schedule page cursor");}
  return {where,params,limit:Math.min(100,Math.max(1,input.limit??50)),offset:Number(input.cursor??0)};
 }
 function list(input:Page={}) {
  const q=pageSql(input,"s",false);
  if(input.search){q.where.push("instr(lower(t.title),lower(?))>0");q.params.push(input.search);}
  if(input.needsAttention)q.where.push("EXISTS(SELECT 1 FROM task_schedule_runs r WHERE r.schedule_id=s.id AND r.resolved_at IS NULL AND r.state IN ('skipped','failed','delivery_unknown','cancel_pending'))");
  const rows=db.prepare<(string|number)[],ScheduleRow>(`${scheduleSelect} ${q.where.length?"WHERE "+q.where.join(" AND "):""} ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?`).all(...q.params,q.limit+1,q.offset);
  return {schedules:rows.slice(0,q.limit).map(scheduleFromRow),nextCursor:rows.length>q.limit?String(q.offset+q.limit):null};
 }
 function runs(input:Page={}) {
  const q=pageSql(input,"r");
  if(input.needsAttention)q.where.push("r.resolved_at IS NULL AND r.state IN ('skipped','failed','delivery_unknown','cancel_pending')");
  if(input.search){q.where.push("instr(lower(json_extract(r.payload,'$.scheduleTitle')),lower(?))>0");q.params.push(input.search);}
  const rows=db.prepare<(string|number)[],{payload:string}>(`SELECT payload FROM task_schedule_runs r ${q.where.length?"WHERE "+q.where.join(" AND "):""} ORDER BY json_extract(r.payload,'$.createdAt') DESC,r.id LIMIT ? OFFSET ?`).all(...q.params,q.limit+1,q.offset);
  return {runs:rows.slice(0,q.limit).map(x=>scheduleRunSchema.parse(JSON.parse(x.payload))),nextCursor:rows.length>q.limit?String(q.offset+q.limit):null};
 }
 function results(input:Page={}) {
  const q=pageSql(input,"t",false);q.where.push("ss.role<>'template'");
  if(input.scheduleId){q.where.push("ss.schedule_id=?");q.params.push(input.scheduleId);}
  if(input.search){q.where.push("instr(lower(t.title),lower(?))>0");q.params.push(input.search);}
  const rows=db.prepare<(string|number)[],{id:string}>(`SELECT t.id FROM tasks t JOIN task_scheduled_sources ss ON ss.task_id=t.id WHERE ${q.where.join(" AND ")} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`).all(...q.params,q.limit+1,q.offset);
  return {results:rows.slice(0,q.limit).map(x=>({task:apiTask(requireTask(x.id)),source:source(x.id)!})),nextCursor:rows.length>q.limit?String(q.offset+q.limit):null};
 }
 function saveRun(value:ScheduleRun) {
  const r=scheduleRunSchema.parse(value);
  db.prepare(`INSERT INTO task_schedule_runs(id,schedule_id,project_id,occurrence_key,state,resolved_at,finished_at,thread_id,payload) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,resolved_at=excluded.resolved_at,finished_at=excluded.finished_at,thread_id=excluded.thread_id,payload=excluded.payload`).run(r.id,r.scheduleId,r.projectId,r.occurrenceKey,r.state,r.resolvedAt,r.finishedAt,r.threadId,JSON.stringify(r));
  return r;
 }
 function updateRun(id:string,patch:Partial<Omit<ScheduleRun,"id"|"scheduleId"|"projectId"|"occurrenceKey">>,now=new Date()) {
  return store.transaction(()=>saveRun({...run(id),...patch,updatedAt:now.toISOString()}));
 }
 function reserve(scheduleId:string,occurrenceKey:string,scheduledFor:string,now=new Date()):{run:ScheduleRun;created:boolean} {
  return store.transaction(()=>{
   const existing=db.prepare<[string,string],{payload:string}>("SELECT payload FROM task_schedule_runs WHERE schedule_id=? AND occurrence_key=?").get(scheduleId,occurrenceKey);
   if(existing)return {run:scheduleRunSchema.parse(JSON.parse(existing.payload)),created:false};
   // Successful history expires; the durable source still prevents resending that operation.
   if(db.prepare("SELECT 1 FROM task_scheduled_sources WHERE schedule_id=? AND occurrence_key=?").get(scheduleId,occurrenceKey))throw new Error("This operation already ran; its history expired. View Scheduled Results.");
   const s=get(scheduleId),stamp=now.toISOString();
   const value=scheduleRunSchema.parse({id:randomUUID(),scheduleId,projectId:s.projectId,scheduleTitle:s.title,occurrenceKey,scheduledFor,state:"starting",taskId:null,threadId:null,queueId:null,requestId:null,reason:null,startedAt:null,finishedAt:null,resolvedAt:null,createdAt:stamp,updatedAt:stamp,pushState:"not_attempted",pushChannels:[],pushError:null,execution:null,overlapRunIds:overlaps(scheduleId)});
   return {run:saveRun(value),created:true};
  });
 }
 function createRunTask(runId:string) {
  return store.transaction(()=>{
   const r=run(runId);if(r.taskId)return requireTask(r.taskId);
   const s=get(r.scheduleId),template=requireTask(s.templateTaskId);
   const task=store.tasks.createTask({projectId:s.projectId,title:template.title,description:template.description,priority:template.priority,type:"task"});
   let description=template.description;
   for(const a of store.tasks.listAttachmentsForTask(template.id)) {
    const clone=store.tasks.createAttachment({taskId:task.id,fileName:a.fileName,mime:a.mime,sizeBytes:a.sizeBytes,blobPath:a.blobPath,isImage:a.isImage});
    description=description.replaceAll(a.id,clone.id);
   }
   if(description!==template.description)store.tasks.updateTask(task.id,{description});
   for(const l of store.tasks.listTaskLabels(template.id))db.prepare("INSERT INTO task_labels(task_id,label_id) VALUES (?,?)").run(task.id,l.labelId);
   replaceDependencies(task.id,dependencies.list(template.id).blockedBy.map(x=>x.id));
   setSource({taskId:task.id,scheduleId:s.id,scheduleTitle:s.title,role:s.rule.kind==="once"?"one_time_run":"recurring_run",scheduledFor:r.scheduledFor,startedAt:null,runId:r.id,occurrenceKey:r.occurrenceKey});
   updateRun(r.id,{taskId:task.id});
   return requireTask(task.id);
  });
 }
 function markStarted(runId:string,input:{threadId:string;requestId:string;title:string;presetName:string;liveStatus?:import("../db").TaskThreadLiveStatus},now=new Date()) {
  return store.transaction(()=>{
   const r=run(runId);if(r.startedAt)return r;
   if(!r.taskId)throw new Error("Run task is missing");
   const task=requireTask(r.taskId);
   if(task.status==="backlog"||task.status==="todo")store.tasks.updateTask(r.taskId,{status:"in_progress"});
   db.prepare("UPDATE task_scheduled_sources SET started_at=? WHERE task_id=?").run(now.toISOString(),r.taskId);
   store.tasks.upsertTaskThread({taskId:r.taskId,threadId:input.threadId,title:input.title,presetName:input.presetName,liveStatus:input.liveStatus??"working"});
   return updateRun(runId,{state:task.status==="done"?"completed":task.status==="canceled"?"canceled":"running",threadId:input.threadId,requestId:input.requestId,startedAt:now.toISOString(),resolvedAt:null,finishedAt:["done","canceled"].includes(task.status)?now.toISOString():null,reason:null},now);
  });
 }
 function due(now=new Date(),limit=25) {
  return db.prepare<[string,number],ScheduleRow>(`${scheduleSelect} WHERE s.enabled=1 AND s.next_due_at IS NOT NULL AND s.next_due_at<=? ORDER BY s.next_due_at,s.id LIMIT ?`).all(now.toISOString(),Math.min(100,limit)).map(scheduleFromRow);
 }
 function advance(id:string,expectedDue:string,nextDue:string|null,now=new Date()) {
  return db.prepare("UPDATE task_schedules SET next_due_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_due_at=?").run(nextDue,now.toISOString(),id,expectedDue).changes>0;
 }
 function pending(threadId?:string,limit=100,afterId="",includeStarted=true) {
  return db.prepare<(string|number)[],{payload:string}>(`SELECT payload FROM task_schedule_runs WHERE state IN ('starting','queued',${includeStarted?"'running',":""}'delivery_unknown','cancel_pending') AND COALESCE(json_extract(payload,'$.historical'),0)=0 AND (resolved_at IS NULL OR state<>'delivery_unknown') ${threadId?"AND thread_id=?":""} ${afterId?"AND id>?":""} ORDER BY id LIMIT ?`).all(...(threadId?[threadId]:[]),...(afterId?[afterId]:[]),Math.min(500,limit)).map(x=>scheduleRunSchema.parse(JSON.parse(x.payload)));
 }
 function resolve(runId:string,note:string,now=new Date()) {
  const r=run(runId);if(r.state==="delivery_unknown"&&r.queueId)throw new Error("Cancel the known queued request before resolving delivery");if(["starting","queued","running","cancel_pending"].includes(r.state))throw new Error("Cancel or finish an active run before resolving it");
  return updateRun(runId,{resolvedAt:now.toISOString(),reason:[r.reason,`Resolved: ${note}`].filter(Boolean).join("\n")},now);
 }
 function cleanup(now=new Date()) {
  // Only disposable run history expires; task sources and user-visible results never do.
  return db.prepare(`DELETE FROM task_schedule_runs WHERE (state='completed' AND finished_at<=?) OR (state IN ('skipped','failed','canceled','delivery_unknown') AND resolved_at IS NOT NULL AND resolved_at<=?)`).run(new Date(now.valueOf()-30*86400000).toISOString(),new Date(now.valueOf()-7*86400000).toISOString()).changes;
 }
 function detail(id:string) {const s=get(id);return {schedule:s,task:apiTask(requireTask(s.templateTaskId)),dependencyIds:dependencies.list(s.templateTaskId).blockedBy.map(x=>x.id)};}
 function preview(rule:Recurrence,after=new Date(),count=3) {const dates:string[]=[];let date=after;for(let i=0;i<Math.min(10,count);i++){const next=nextOccurrence(rule,date);if(!next)break;dates.push(next.toISOString());date=next;}return dates;}
 return {get,detail,create,update,setEnabled,remove,list,runs,results,run,saveRun,updateRun,reserve,createRunTask,markStarted,due,advance,pending,resolve,cleanup,source,setSource,preview,apiTask,overlaps};
}
export type ScheduledStore=ReturnType<typeof createScheduledStore>;
