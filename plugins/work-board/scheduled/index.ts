import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { publishTasksChanged, type TasksApiStore } from "../api";
import { scheduledRpcContract } from "../shared/scheduled";
import { scheduledService } from "./service";

export function createScheduledHandlers(bb:BbPluginApi,store:TasksApiStore):PluginRpcHandlers<typeof scheduledRpcContract> {
 const service=scheduledService(bb,store),data=service.data;
 const changed=()=>bb.realtime.publish("schedules:changed",{});
 return {
  listSchedules:input=>data.list(input),
  getSchedule:input=>data.detail(input.scheduleId),
  createSchedule:input=>{const schedule=data.create(input);changed();return {schedule};},
  updateSchedule:input=>{const schedule=data.update(input);publishTasksChanged(bb,schedule.templateTaskId,schedule.projectId);return {schedule};},
  setScheduleEnabled:input=>{const schedule=data.setEnabled(input.scheduleId,input.enabled);changed();return {schedule};},
  deleteSchedule:async input=>({deleted:await service.remove(input.scheduleId)}),
  previewSchedule:input=>({dates:data.preview(input.rule,input.after?new Date(input.after):undefined,input.count)}),
  runSchedule:async input=>({run:await service.runNow(input.scheduleId,input.idempotencyKey)}),
  retryScheduleRun:async input=>({run:await service.retry(input.runId,input.idempotencyKey)}),
  cancelScheduleRun:async input=>({run:await service.cancel(input.runId)}),
  resolveScheduleRun:input=>{const run=data.resolve(input.runId,input.note);changed();return {run};},
  listScheduleRuns:input=>data.runs(input),
  listScheduleResults:input=>data.results(input),
  getTaskSchedule:input=>({source:data.source(input.taskId)}),
 };
}
export function registerScheduled(bb:BbPluginApi,store:TasksApiStore) {
 const handlers=createScheduledHandlers(bb,store);
 bb.rpc.register(scheduledRpcContract,handlers);
 scheduledService(bb,store).register();
}
