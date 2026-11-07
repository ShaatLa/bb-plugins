import { threadLiveStatus } from "../lifecycle/thread-links";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildSeedPrompt, presetSpawnEnvironment } from "../delegate";
import { publishTasksChanged } from "../api";
import type { TasksApiStore } from "../api";
import { createDependencyStore } from "../dependencies/store";
import { errorMessage } from "../shared/errors";
import type { ScheduleRun } from "../shared/scheduled";
import { createScheduledStore } from "./store";
import { isWithinGrace, localSlotKey, nextOccurrence } from "./recurrence";
import { acceptedScheduledRuns, scheduledRunMarker } from "./acceptance";

type Thread=Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
type QueueEntry=Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number];
const instances=new WeakMap<BbPluginApi,ReturnType<typeof createService>>();
const pushOutput=z.object({ok:z.literal(true),channels:z.array(z.enum(["web","desktop","mobile"]))});
const terminalStates=new Set(["completed","canceled","skipped","failed"]);
function limiter(max:number) {
 let active=0;const queue:Array<()=>void>=[];
 return async <T>(action:()=>Promise<T>):Promise<T>=>{
  await new Promise<void>(resolve=>{const start=()=>{active++;resolve();};if(active<max)start();else queue.push(start);});
  try{return await action();}finally{active--;queue.shift()?.();}
 };
}
function definiteFailure(error:unknown) {
 return typeof error==="object"&&error!==null&&"status" in error&&typeof error.status==="number"&&[400,401,403,404,409,422].includes(error.status);
}
function createService(bb:BbPluginApi,store:TasksApiStore) {
 const data=createScheduledStore(bb,store),db=bb.storage.database(),reads=limiter(2),dispatchSlots=limiter(2);
 const acceptedScopes=new Map<string,string[]>(),absentSince=new Map<string,number>();
 const startingThreads=new Set<string>();
 const flights=new Map<string,Promise<ScheduleRun>>(),threadReads=new Map<string,Promise<void>>(),removing=new Set<string>();
 let closed=false,tickFlight:Promise<void>|null=null,cleanupDay="",pendingCursor="";
 const alive=()=>{if(closed)throw new Error("Scheduled service disposed");};
 const trackedThreads=new Set(db.prepare<[],{thread_id:string}>("SELECT DISTINCT thread_id FROM task_schedule_runs WHERE thread_id IS NOT NULL AND state IN ('starting','queued','delivery_unknown','cancel_pending') AND COALESCE(json_extract(payload,'$.historical'),0)=0 AND (resolved_at IS NULL OR state<>'delivery_unknown') LIMIT 256").all().map(x=>x.thread_id));
 const trackThread=(id:string)=>{trackedThreads.add(id);if(trackedThreads.size>256)trackedThreads.delete(trackedThreads.values().next().value!);};
 const hasPendingThread=(threadId:string)=>{
  if(!trackedThreads.has(threadId))return false;
  const found=Boolean(db.prepare("SELECT 1 FROM task_schedule_runs WHERE thread_id=? AND state IN ('starting','queued','delivery_unknown','cancel_pending') AND COALESCE(json_extract(payload,'$.historical'),0)=0 AND (resolved_at IS NULL OR state<>'delivery_unknown') LIMIT 1").get(threadId));
  if(!found)trackedThreads.delete(threadId);return found;
 };
 const refreshStarting=(threadId:string)=>{
  if(db.prepare("SELECT 1 FROM task_schedule_runs WHERE thread_id=? AND state='starting' AND resolved_at IS NULL AND COALESCE(json_extract(payload,'$.historical'),0)=0 LIMIT 1").get(threadId))startingThreads.add(threadId);
  else startingThreads.delete(threadId);
  if(startingThreads.size>256)startingThreads.delete(startingThreads.values().next().value!);
 };
 const changed=(r?:ScheduleRun,taskChanged=false)=>{
  if(closed)return;
  if(!taskChanged)bb.realtime.publish("schedules:changed",{projectId:r?.projectId??null});
  if(taskChanged&&r?.taskId){publishTasksChanged(bb,r.taskId,r.projectId);bb.realtime.publish("threads:changed",{taskId:r.taskId});}
 };
 function note(r:ScheduleRun,body:string) {
  let s;try{s=data.get(r.scheduleId);}catch{return;}
  store.tasks.createComment({taskId:s.templateTaskId,kind:"system",authorName:"Work Board",body});
  bb.realtime.publish("comments:changed",{taskId:s.templateTaskId});
 }
 async function notify(id:string) {
  const r=data.run(id);if(r.pushState!=="not_attempted")return;
  // Persist the attempt before the non-idempotent push; reload never sprays duplicates.
  data.updateRun(id,{pushState:"failed",pushError:"Delivery outcome not yet confirmed"});
  try {
   const result=await bb.sdk.plugins.callRpc({pluginId:"push-notifications",method:"notifications.send",input:{title:`Scheduled task needs attention: ${r.scheduleTitle}`.slice(0,80),body:(r.reason??r.state).slice(0,180)},outputSchema:pushOutput});
   alive();data.updateRun(id,{pushState:result.channels.length?"sent":"failed",pushChannels:result.channels,pushError:result.channels.length?null:"No notification channel received the message"});
  }catch(error){if(!closed)data.updateRun(id,{pushState:"failed",pushError:errorMessage(error).slice(0,1000)});}
  if(!closed)changed(data.run(id));
 }
 async function incident(id:string,state:"failed"|"skipped"|"delivery_unknown",reason:string) {
  const current=data.run(id),stamp=new Date().toISOString();
  if(current.resolvedAt!==null||(current.state===state&&current.reason!==null))return current;
  const previous=db.prepare<[string,string,string,string],{payload:string}>(`SELECT payload FROM task_schedule_runs WHERE schedule_id=? AND state=? AND resolved_at IS NULL AND id<>? AND json_extract(payload,'$.reason')=? AND COALESCE(json_extract(payload,'$.historical'),0)=0 ORDER BY id LIMIT 1`).get(current.scheduleId,state,id,reason);
  if(previous&&!current.taskId&&current.occurrenceKey.startsWith("slot:")) {
   const old=JSON.parse(previous.payload) as ScheduleRun;
   const merged=data.updateRun(old.id,{missCount:old.missCount+1});
   db.prepare("DELETE FROM task_schedule_runs WHERE id=?").run(id);
   changed(merged);return merged;
  }
  const r=data.updateRun(id,{state,reason:reason.slice(0,2000),...(state==="delivery_unknown"?{}:{finishedAt:stamp})});
  if(r.threadId)refreshStarting(r.threadId);
  if(!previous){note(r,`Scheduled run ${r.scheduledFor}: ${state} — ${r.reason}`);await notify(r.id);}
  changed(r);return data.run(r.id);
 }
 async function missingDelivery(id:string,reason:string) {
  const r=data.run(id);if(r.resolvedAt||r.startedAt||terminalStates.has(r.state))return r;
  const first=absentSince.get(id);
  if(first===undefined){absentSince.set(id,Date.now());if(absentSince.size>256)absentSince.delete(absentSince.keys().next().value!);return r;}
  // Dispatch precedes accepted input; tolerate the ordinary handoff before escalating an unknown.
  if(Date.now()-first<120_000)return r;
  if(r.queueId)data.updateRun(id,{lastQueueId:r.queueId,queueId:null});
  return incident(id,"delivery_unknown",reason);
 }
 async function accepted(threadId:string,thread:Thread) {
  if(!hasPendingThread(threadId))return;
  const events=await bb.sdk.threads.events.list({threadId,types:["turn/input/accepted"],order:"desc",limit:"10",signal:AbortSignal.timeout(5000)});
  alive();
  for(const event of events)if(event.type==="turn/input/accepted") {
   const parsed=z.object({clientRequestId:z.string()}).safeParse(event.data);if(!parsed.success)continue;
   const cacheKey=JSON.stringify([threadId,event.seq,parsed.data.clientRequestId]);
   let runIds=acceptedScopes.get(cacheKey);
   if(runIds===undefined) {
    // Cache only small immutable attribution; never retain request bodies or reread them on idle polls.
    const requests=await bb.sdk.threads.events.list({threadId,types:["client/turn/requested"],beforeSeq:String(event.seq),order:"desc",limit:"10",signal:AbortSignal.timeout(5000)});
    alive();
    const request=requests.find(x=>z.object({requestId:z.literal(parsed.data.clientRequestId)}).safeParse(x.data).success);
    if(!request)continue; // Missing data can be a persistence race; retry instead of caching absence.
    runIds=acceptedScheduledRuns(request.data,parsed.data.clientRequestId);acceptedScopes.set(cacheKey,runIds);
    if(acceptedScopes.size>256)acceptedScopes.delete(acceptedScopes.keys().next().value!);
   }
   for(const runId of runIds) {
    let r;try{r=data.run(runId);}catch{continue;}
    if(r.threadId!==threadId||r.startedAt||!r.taskId||r.historical)continue;
    // Sent, dispatched and session-active all precede actual input acceptance.
    absentSince.delete(r.id);
    const started=data.markStarted(r.id,{threadId,requestId:parsed.data.clientRequestId,title:thread.title??thread.titleFallback??threadId,presetName:"Scheduled",liveStatus:threadLiveStatus(thread)});
    note(started,`Scheduled run started · ${r.scheduledFor} · @thread:${threadId}`);refreshStarting(threadId);changed(started,true);
   }
  }
 }
 async function processQueue(entry:QueueEntry) {
  const ids=acceptedScheduledRuns({requestId:"queued",input:entry.content},"queued");
  for(const id of ids) {
   let r;try{r=data.run(id);}catch{continue;}
   if(r.startedAt||r.historical||terminalStates.has(r.state))continue;
   absentSince.delete(id);
   trackThread(entry.threadId);
   if(r.threadId!==entry.threadId||r.queueId!==entry.id||r.resolvedAt||(r.state!=="queued"&&r.state!=="cancel_pending")){r=data.updateRun(id,{threadId:entry.threadId,queueId:entry.id,resolvedAt:null,...(r.state==="cancel_pending"?{}:{state:"queued"})});refreshStarting(entry.threadId);changed(r);}
   if(r.state==="cancel_pending")continue;
   if(entry.waitingOn?.kind==="host-offline"||entry.waitingOn?.kind==="stopping") {
    await cancel(id,"Assigned session is unavailable; queued launch must not resume later");
   }else if(entry.state==="failed_exhausted")await incident(id,"failed",entry.failureReason??"Queued launch exhausted its delivery attempts");
  }
 }
 function cancelEvent(entry:QueueEntry) {
  const row=db.prepare<[string],{id:string}>("SELECT id FROM task_schedule_runs WHERE json_extract(payload,'$.queueId')=?").get(entry.id);if(!row)return;
  const r=data.run(row.id);if(r.startedAt||r.historical||terminalStates.has(r.state))return;
  const state=r.cancelOutcome??"canceled",stamp=new Date().toISOString();
  const result=data.updateRun(r.id,{state,finishedAt:stamp,resolvedAt:state==="canceled"?stamp:null,reason:r.reason??"Queued run canceled"});
  if(r.taskId&&state==="canceled"){const task=store.tasks.getTask(r.taskId);if(task&&!["done","canceled"].includes(task.status))store.tasks.updateTask(r.taskId,{status:"canceled"});}absentSince.delete(r.id);changed(result);
  if(state==="skipped")void notify(r.id);
 }
 async function reconcileThread(threadId:string) {
  const existing=threadReads.get(threadId);if(existing)return existing;
  if(!hasPendingThread(threadId))return;
  const promise=reads(async()=>{
   const rows=data.pending(threadId,500,"",false);if(!rows.length)return;
   let thread:Thread;
   try {thread=await bb.sdk.threads.get({threadId,signal:AbortSignal.timeout(5000)});}catch(error){
    if(typeof error==="object"&&error!==null&&"code" in error&&error.code==="thread_not_found") {
     for(const r of rows)if(!r.startedAt)await incident(r.id,"delivery_unknown","Assigned session disappeared before execution or cancellation could be confirmed");
    }
    return;
   }
   alive();await accepted(threadId,thread);
   const current=rows.map(r=>data.run(r.id)).filter(r=>!r.startedAt&&!terminalStates.has(r.state));
   if(!current.length)return;
   if(thread.archivedAt!==null||thread.deletedAt!==null) {
    for(const r of current)await incident(r.id,"delivery_unknown","Assigned session became unavailable before execution or cancellation could be confirmed");return;
   }
   let queue:QueueEntry[];
   try{queue=await bb.sdk.threads.queuedMessages.list({threadId,signal:AbortSignal.timeout(5000)});}catch{return;}
   alive();
   for(const entry of queue)await processQueue(entry);
   const ids=new Set(queue.map(x=>x.id));
   for(const old of current) {
    const r=data.run(old.id);if(r.startedAt||terminalStates.has(r.state))continue;
    if(r.queueId&&ids.has(r.queueId)){absentSince.delete(r.id);continue;}
    if(flights.has(r.id))continue;
    // Queue disappearance alone proves neither dispatch nor cancellation, even after two reads.
    await missingDelivery(r.id,r.state==="cancel_pending"?"Cancellation outcome is unknown; no queued request or accepted start was confirmed":"Request is absent from the queue; execution or cancellation is not confirmed");
   }
  }).catch(error=>{if(!closed)bb.log.warn(`Scheduled reconciliation failed: ${errorMessage(error)}`);}).finally(()=>threadReads.delete(threadId));
  threadReads.set(threadId,promise);return promise;
 }
 async function cancel(id:string,unavailableReason?:string):Promise<ScheduleRun> {
  let r=data.run(id);
  if(r.historical)throw new Error("Imported history has no live queued request to cancel");
  if(r.startedAt)throw new Error("Run already started; stopping its session is a separate action");
  if(terminalStates.has(r.state))return r;
  if(!r.queueId||!r.threadId) {
   if(flights.has(id))throw new Error("Dispatch is in flight; wait for its delivery status before canceling");
   if(!r.taskId){const stamp=new Date().toISOString();const canceled=data.updateRun(id,{state:"canceled",reason:"Canceled before dispatch",finishedAt:stamp,resolvedAt:stamp});changed(canceled);return canceled;}
   return incident(id,"delivery_unknown","No confirmed queue ID is available to cancel");
  }
  // A positive cancelled event is the proof; an idempotent DELETE/empty queue is not.
  r=data.updateRun(id,{state:"cancel_pending",cancelOutcome:unavailableReason?"skipped":"canceled",reason:unavailableReason??"Cancellation requested"});changed(r);
  try{await bb.sdk.threads.queuedMessages.delete({threadId:r.threadId!,queuedMessageId:r.queueId!});}catch(error){
   if(!closed)data.updateRun(id,{reason:`Cancellation could not be confirmed: ${errorMessage(error)}`});
  }
  alive();
  if(unavailableReason&&data.run(id).state==="cancel_pending")await notify(id);
  // Do not await a reconcile already holding its read slot (processQueue can call cancel).
  return data.run(id);
 }
 async function preflightThread(threadId:string) {
  const thread=await bb.sdk.threads.get({threadId,signal:AbortSignal.timeout(5000)});
  if(thread.archivedAt!==null||thread.deletedAt!==null||thread.status==="stopping"||thread.runtime.displayStatus==="waiting-for-host")throw new Error("Assigned session is archived, deleted, stopping or waiting for its host");
  if(thread.environmentId) {
   const environment=await bb.sdk.environments.get({environmentId:thread.environmentId,signal:AbortSignal.timeout(5000)});
   const host=await bb.sdk.hosts.get({hostId:environment.hostId,signal:AbortSignal.timeout(5000)});
   if(host.status!=="connected"||host.lifecycle.phase!=="active")throw new Error("Assigned session host is unavailable");
  }
  return thread;
 }
 async function dispatch(id:string):Promise<ScheduleRun> {
  const existing=flights.get(id);if(existing)return existing;
  const flight=dispatchSlots(async()=>{
   let r=data.run(id),s=data.get(r.scheduleId);if(r.state!=="starting")return r;
   let thread:Thread|undefined,preset,threadExecution:Record<string,unknown>|null=null;
   try {
    if(removing.has(s.id))throw new Error("Schedule is being deleted");
    if(s.target.kind==="unassigned")throw new Error("Choose an execution target for this imported schedule");
    if(s.target.kind==="thread") { thread=await preflightThread(s.target.threadId); threadExecution=await bb.sdk.threads.defaultExecutionOptions({threadId:thread.id}); }
    else {
     preset=store.tasks.getPreset(s.target.presetId);if(!preset)throw new Error("Assigned preset no longer exists");
     if(!store.tasks.getProject(s.projectId)?.linkedBbProjectId)throw new Error("Schedule project is not linked to a BB project");
     if(preset.machineId){const host=await bb.sdk.hosts.get({hostId:preset.machineId,signal:AbortSignal.timeout(5000)});if(host.status!=="connected"||host.lifecycle.phase!=="active")throw new Error("Assigned preset host is unavailable");}
    }
   }catch(error){alive();return incident(id,"skipped",`Cannot start: ${errorMessage(error)}`);}
   alive();if(removing.has(s.id))return incident(id,"skipped","Schedule is being deleted");
   const task=data.createRunTask(id),project=store.tasks.getProject(s.projectId)!;
   const execution=preset?{providerId:preset.providerId,model:preset.modelId,reasoningLevel:preset.reasoningLevel,serviceTier:preset.serviceTier,permissionMode:preset.permissionMode,environmentKind:preset.environmentKind,machineId:preset.machineId,baseBranch:preset.baseBranch}:{targetThreadId:thread!.id,providerId:thread!.providerId,...threadExecution};
   r=data.updateRun(id,{threadId:thread?.id??null,execution});if(thread){trackThread(thread.id);refreshStarting(thread.id);}
   // shortcut: SDK queues return full messages; keep task previews small until ID-only reads exist.
   const seedTask={...task,description:task.description.length>12_000?`${task.description.slice(0,12_000)}\n\nFull description: bb work-board show ${task.key} --json`:task.description};
   const attachments=store.tasks.listAttachmentsForTask(task.id);
   const prompt=`${scheduledRunMarker(id)}\n${buildSeedPrompt({task:seedTask,project,subtasks:[],attachments:attachments.slice(0,20),recentComments:[],blockedBy:createDependencyStore(db,store.tasks).blockers([task.id]).get(task.id),presetInstructions:preset?.instructions??"",extraInstructions:`Scheduled occurrence: ${r.scheduledFor}. Use the task workflow; completing a turn is not Done.`})}`;
   try {
    if(thread) {
     const delivery=await bb.sdk.threads.send({threadId:thread.id,mode:"queue-if-active",input:[{type:"text",text:prompt,mentions:[]}]});
     alive();r=data.run(id);
     if(!r.startedAt&&!terminalStates.has(r.state)&&r.state!=="cancel_pending") {
      if(delivery.delivery==="queued"&&!(r.lastQueueId===delivery.queuedMessage.id&&r.queueId===null)) {data.updateRun(id,{state:"queued",queueId:delivery.queuedMessage.id});refreshStarting(thread.id);await processQueue(delivery.queuedMessage);}
      // Inline send still needs its matching accepted-input event.
     }
    }else {
     const environment=await presetSpawnEnvironment(bb,preset!);alive();
     const created=await bb.sdk.threads.spawn({projectId:project.linkedBbProjectId!,environment,providerId:preset!.providerId,model:preset!.modelId,reasoningLevel:preset!.reasoningLevel,...(preset!.serviceTier?{serviceTier:preset!.serviceTier}:{}),permissionMode:preset!.permissionMode,title:`${task.key} · ${task.title}`.slice(0,120),prompt,pluginMetadata:{scheduledRunId:id}});
     alive();thread=created;r=data.run(id);
     if(!r.startedAt)data.updateRun(id,{threadId:created.id});trackThread(created.id);refreshStarting(created.id);
    }
   }catch(error){if(closed)throw error;const known=data.run(id);if(known.threadId)await reconcileThread(known.threadId);if(data.run(id).startedAt)return data.run(id);return incident(id,definiteFailure(error)?"failed":"delivery_unknown",`Delivery ${definiteFailure(error)?"failed":"outcome unknown"}: ${errorMessage(error)}`);}
   if(thread)await reconcileThread(thread.id);
   changed(data.run(id));return data.run(id);
  }).finally(()=>flights.delete(id));
  flights.set(id,flight);return flight;
 }
 async function runNow(scheduleId:string,key:string) {
  alive();if(removing.has(scheduleId))throw new Error("Schedule is being deleted");
  if(data.get(scheduleId).target.kind==="unassigned")throw new Error("Choose an execution target before starting this schedule");
  const reservation=data.reserve(scheduleId,`manual:${key}`,new Date().toISOString());
  return reservation.created?dispatch(reservation.run.id):reservation.run;
 }
 async function retry(runId:string,key:string) {
  const r=data.run(runId);
  if(r.startedAt||!new Set(["skipped","failed","canceled"]).has(r.state))throw new Error("Retry requires a confirmed unstarted failed, skipped or canceled run; review unknown delivery first");
  return runNow(r.scheduleId,`retry:${r.id}:${key}`);
 }
 async function remove(scheduleId:string) {
  alive();data.get(scheduleId);removing.add(scheduleId);
  try {
   data.setEnabled(scheduleId,false);
   const pending=db.prepare<[string],{id:string}>("SELECT id FROM task_schedule_runs WHERE schedule_id=? AND state IN ('starting','queued','delivery_unknown','cancel_pending') AND COALESCE(json_extract(payload,'$.historical'),0)=0 AND (resolved_at IS NULL OR state<>'delivery_unknown') LIMIT 101").all(scheduleId);
   if(pending.length>100)throw new Error("Cancel the pending run backlog before deleting this schedule");
   for(const {id} of pending) {
    const r=await cancel(id);
    if(r.startedAt)continue;
    if(!terminalStates.has(r.state))throw new Error("Schedule paused; deletion waits for confirmed cancellation of its pending launch. Review Scheduled history.");
   }
   const deleted=data.remove(scheduleId);changed();return deleted;
  }finally{removing.delete(scheduleId);}
 }
 async function recoverThread(thread:Pick<Thread,"id"|"originPluginId">) {
  if(thread.originPluginId!=="work-board"||!db.prepare("SELECT 1 FROM task_schedule_runs WHERE thread_id IS NULL AND state IN ('starting','delivery_unknown') AND COALESCE(json_extract(payload,'$.historical'),0)=0 AND resolved_at IS NULL LIMIT 1").get())return;
  try {
   const metadata=await reads(()=>bb.sdk.threads.getPluginMetadata({threadId:thread.id,pluginId:"work-board",signal:AbortSignal.timeout(5000)}));alive();
   const parsed=z.object({scheduledRunId:z.uuid()}).safeParse(metadata);if(!parsed.success)return;
   const r=data.run(parsed.data.scheduledRunId);if(r.historical||r.startedAt||terminalStates.has(r.state))return;
   data.updateRun(r.id,{threadId:thread.id});trackThread(thread.id);await reconcileThread(thread.id);
  }catch(error){if(!closed)bb.log.warn(`Scheduled thread recovery: ${errorMessage(error)}`);}
 }
 async function reconcileAll() {
  const all=data.pending(undefined,100,pendingCursor,false);pendingCursor=all.at(-1)?.id??"";
  if(!all.length)return;
  await Promise.all([...new Set(all.flatMap(r=>r.threadId&&!r.startedAt?[r.threadId]:[]))].map(id=>{trackThread(id);return reconcileThread(id);}));
  for(const old of all.filter(r=>!r.threadId&&!flights.has(r.id))) {
   if(old.state!=="starting")continue;
   if(!old.taskId) {
    // No task means the durable pre-send transaction never happened: resuming cannot duplicate delivery.
    let enabled=false;try{enabled=data.get(old.scheduleId).enabled;}catch{ /* Schedule may have been removed. */ }
    if(enabled&&isWithinGrace(new Date(old.scheduledFor),new Date()))await dispatch(old.id);
    else await incident(old.id,"skipped","Launch interrupted before dispatch; schedule paused, removed or grace expired");
   }else await missingDelivery(old.id,"Interrupted launch: session creation or delivery may have completed; no automatic resend");
  }
  const unresolved=all.filter(r=>!r.threadId).flatMap(old=>{try{const r=data.run(old.id);return !r.threadId&&!r.resolvedAt&&(r.state==="delivery_unknown"||r.state==="starting")?[r]:[];}catch{return [];}});
  if(unresolved.length) {
   // Resolve only recent plugin-owned candidates in one metadata batch, not 50 serial reads.
   const candidates=await reads(()=>bb.sdk.threads.list({originPluginId:"work-board",includeHidden:true,limit:50,signal:AbortSignal.timeout(5000)}));
   if(candidates.length) {
    const metadata=await reads(()=>bb.sdk.threads.experimental_listPluginMetadata({pluginId:"work-board",threadIds:candidates.map(t=>t.id),signal:AbortSignal.timeout(5000)}));
    for(const row of metadata.threads) {
     const parsed=z.object({scheduledRunId:z.uuid()}).safeParse(row.metadata);
     if(!parsed.success||!unresolved.some(r=>r.id===parsed.data.scheduledRunId))continue;
     const r=data.run(parsed.data.scheduledRunId);if(r.historical||r.startedAt||terminalStates.has(r.state))continue;
     data.updateRun(r.id,{threadId:row.threadId});trackThread(row.threadId);await reconcileThread(row.threadId);
    }
   }
  }
 }
 async function runDue(now=new Date()) {
  alive();if(tickFlight)return tickFlight;
  tickFlight=(async()=>{
   try{await reconcileAll();}catch(error){if(!closed)bb.log.warn(`Scheduled recovery unavailable: ${errorMessage(error)}`);}alive();
   await Promise.all(data.due(now,25).map(s=>dispatchSlots(async()=>{
    if(removing.has(s.id)||!s.nextDueAt)return;
    const originalDue=s.nextDueAt,next=nextOccurrence(s.rule,now)?.toISOString()??null;
    // After a long outage, a newer slot may still be inside the grace window.
    const recent=nextOccurrence(s.rule,new Date(now.valueOf()-30*60_000-1));
    const due=recent&&recent<=now&&recent>=new Date(originalDue)?recent.toISOString():originalDue;
    const reserved=store.transaction(()=>{
     if(!data.advance(s.id,originalDue,next,now))return null;
     return {main:data.reserve(s.id,`slot:${localSlotKey(new Date(due),s.rule.timezone)}`,due,now),missed:due!==originalDue?data.reserve(s.id,`slot:${localSlotKey(new Date(originalDue),s.rule.timezone)}`,originalDue,now):null};
    });
    const reservation=reserved?.main;
    if(reserved?.missed?.created)await incident(reserved.missed.run.id,"skipped",`Earlier occurrences missed while BB was unavailable (before ${due})`);
    if(!reservation?.created)return;
    if(!isWithinGrace(new Date(due),now)){await incident(reservation.run.id,"skipped","Scheduled time missed by more than 30 minutes");return;}
    // Dispatch uses its own limiter; don't nest the same semaphore around it.
    return reservation.run.id;
   }))).then(async(ids)=>{await Promise.all(ids.filter((id):id is string=>typeof id==="string").map(dispatch));});
   const day=now.toISOString().slice(0,10);if(day!==cleanupDay){data.cleanup(now);cleanupDay=day;}
  })().finally(()=>{tickFlight=null;});
  return tickFlight;
 }
 function observe(threadId:string) {void reconcileThread(threadId);}
 function observeLifecycle(thread:Thread) {
  if(thread.archivedAt!==null||thread.deletedAt!==null) {
   for(const r of data.pending(thread.id,500).filter(r=>r.startedAt&&r.state==="running"&&r.taskId&&store.tasks.getTask(r.taskId)?.status==="in_progress"))
    void incident(r.id,"failed","Session became unavailable before the task reached Done");
  }
  observe(thread.id);
 }
 async function failTurn(event:{threadId:string;requestId:string;inputAccepted:boolean;errorInfo?:unknown}) {
  const ids=new Set(db.prepare<[string,string],{id:string}>("SELECT id FROM task_schedule_runs WHERE thread_id=? AND json_extract(payload,'$.requestId')=? AND state='running' AND COALESCE(json_extract(payload,'$.historical'),0)=0").all(event.threadId,event.requestId).map(r=>r.id));
  if(hasPendingThread(event.threadId)) {
   const requests=await reads(()=>bb.sdk.threads.events.list({threadId:event.threadId,types:["client/turn/requested"],order:"desc",limit:"10",signal:AbortSignal.timeout(5000)}));
   for(const request of requests)for(const id of acceptedScheduledRuns(request.data,event.requestId))ids.add(id);
  }
  for(const id of ids) {
   let r;try{r=data.run(id);}catch{continue;}
   if(r.threadId!==event.threadId||r.historical||r.resolvedAt||!r.taskId)continue;
   const task=store.tasks.getTask(r.taskId);if(!task||["done","canceled","in_review"].includes(task.status))continue;
   if(event.inputAccepted&&!r.startedAt)r=data.markStarted(id,{threadId:event.threadId,requestId:event.requestId,title:event.threadId,presetName:"Scheduled",liveStatus:"failed"});
   else if(!event.inputAccepted&&!r.startedAt)data.updateRun(id,{requestId:event.requestId});
   const error=z.object({message:z.string()}).safeParse(event.errorInfo);
   await incident(id,"failed",error.success?error.data.message:"The scheduled request failed");
  }
 }

 function dispatched(entry:QueueEntry) {
  for(const id of acceptedScheduledRuns({requestId:"dispatched",input:entry.content},"dispatched")) {
   let r;try{r=data.run(id);}catch{continue;}
   if(r.startedAt||r.historical||terminalStates.has(r.state))continue;
   r=data.updateRun(id,{state:"starting",threadId:entry.threadId,queueId:null,lastQueueId:entry.id,resolvedAt:null});
   trackThread(entry.threadId);refreshStarting(entry.threadId);changed(r);
  }
  observe(entry.threadId);
 }
 function register() {
  bb.events.on("experimental_thread.events",({thread})=>{if(startingThreads.has(thread.id))observe(thread.id);});
  bb.events.on("thread.created",({thread})=>{void recoverThread(thread);});
  for(const event of ["thread.active","thread.idle","thread.failed","thread.archived","thread.deleted"] as const)
   bb.events.on(event,({thread})=>observeLifecycle(thread));
  bb.events.on("message.queued",({entry})=>{void processQueue(entry).catch(error=>{if(!closed)bb.log.warn(errorMessage(error));});});
  bb.events.on("message.dispatched",({entry})=>dispatched(entry));
  bb.events.on("message.cancelled",({entry})=>cancelEvent(entry));
  bb.events.on("turn.failed",event=>failTurn(event).catch(error=>{if(!closed)bb.log.warn(errorMessage(error));}));
  bb.background.schedule("scheduled-tasks","* * * * *",()=>runDue());
  bb.onDispose(()=>{closed=true;instances.delete(bb);});
  // Events are not replayed: register first, then reconcile without delaying plugin load.
  void reconcileAll().catch(error=>{if(!closed)bb.log.warn(`Scheduled startup: ${errorMessage(error)}`);});
 }
 return {data,runNow,retry,cancel,remove,runDue,reconcileThread,reconcileAll,recoverThread,processQueue,cancelEvent,register};
}
export function scheduledService(bb:BbPluginApi,store:TasksApiStore) {
 const found=instances.get(bb);if(found)return found;
 const service=createService(bb,store);instances.set(bb,service);return service;
}
