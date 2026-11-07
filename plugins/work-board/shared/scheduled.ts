import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { idSchema, taskSchema, TASK_PRIORITIES } from "./contract";

const timezone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Invalid time zone");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const recurrenceSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("daily"),time,timezone}).strict(),
  z.object({kind:z.literal("weekly"),time,timezone,weekdays:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length,"Duplicate weekday")}).strict(),
  z.object({kind:z.literal("once"),at:z.iso.datetime({offset:true}),timezone}).strict(),
]);
export type Recurrence = z.infer<typeof recurrenceSchema>;
export const scheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("thread"),threadId:z.string().regex(/^thr_[A-Za-z0-9_-]+$/)}).strict(),
  z.object({kind:z.literal("preset"),presetId:idSchema}).strict(),
]);
const uid=z.uuid();
const date=z.iso.datetime({offset:true});
export const scheduleSchema=z.object({id:uid,projectId:idSchema,templateTaskId:idSchema,title:z.string(),rule:recurrenceSchema,target:scheduleTargetSchema,enabled:z.boolean(),nextDueAt:date.nullable(),createdAt:date,updatedAt:date,overlapRunIds:z.array(uid).default([])}).strict();
export type Schedule=z.infer<typeof scheduleSchema>;
export const scheduleSourceSchema=z.object({taskId:idSchema,scheduleId:uid,scheduleTitle:z.string(),role:z.enum(["template","recurring_run","one_time_run"]),scheduledFor:date.nullable(),startedAt:date.nullable(),runId:uid.nullable().default(null),occurrenceKey:z.string().nullable().default(null)}).strict();
export type ScheduleSource=z.infer<typeof scheduleSourceSchema>;
export const SCHEDULE_RUN_STATES=["starting","queued","running","completed","canceled","skipped","failed","delivery_unknown","cancel_pending"] as const;
export const scheduleRunSchema=z.object({id:uid,scheduleId:uid,projectId:idSchema,scheduleTitle:z.string(),occurrenceKey:z.string(),scheduledFor:date,state:z.enum(SCHEDULE_RUN_STATES),taskId:idSchema.nullable(),threadId:z.string().nullable(),queueId:z.string().nullable(),requestId:z.string().nullable(),reason:z.string().nullable(),startedAt:date.nullable(),finishedAt:date.nullable(),resolvedAt:date.nullable(),createdAt:date,updatedAt:date,pushState:z.enum(["not_attempted","sent","failed"]),pushChannels:z.array(z.enum(["web","desktop","mobile"])),pushError:z.string().nullable(),execution:z.record(z.string(),z.unknown()).nullable(),overlapRunIds:z.array(uid).default([]),missCount:z.number().int().positive().default(1),historical:z.boolean().default(false)}).strict();
export type ScheduleRun=z.infer<typeof scheduleRunSchema>;
const page=z.object({projectId:idSchema.optional(),scheduleId:uid.optional(),search:z.string().max(200).optional(),needsAttention:z.boolean().optional(),limit:z.number().int().min(1).max(100).default(50),cursor:z.string().max(128).optional()}).strict();
export const createScheduleInputSchema=z.object({projectId:idSchema,title:z.string().trim().min(1).max(500),description:z.string().max(1_000_000).default(""),priority:z.enum(TASK_PRIORITIES).default("none"),dependencyIds:z.array(idSchema).max(100).default([]),rule:recurrenceSchema,target:scheduleTargetSchema,enabled:z.boolean().default(true)}).strict();
export const updateScheduleInputSchema=createScheduleInputSchema.omit({projectId:true}).partial().extend({scheduleId:uid}).strict();
const scheduleResult=z.object({schedule:scheduleSchema}).strict();
const runResult=z.object({run:scheduleRunSchema}).strict();
const scheduleId=z.object({scheduleId:uid}).strict();
const key=z.string().trim().min(1).max(128);
export const scheduledRpcContract=defineRpcContract({
 listSchedules:{input:page.omit({scheduleId:true}),output:z.object({schedules:z.array(scheduleSchema),nextCursor:z.string().nullable()}).strict()},
 getSchedule:{input:scheduleId,output:z.object({schedule:scheduleSchema,task:taskSchema,dependencyIds:z.array(idSchema)}).strict()},
 createSchedule:{input:createScheduleInputSchema,output:scheduleResult},
 updateSchedule:{input:updateScheduleInputSchema,output:scheduleResult},
 setScheduleEnabled:{input:scheduleId.extend({enabled:z.boolean()}),output:scheduleResult},
 deleteSchedule:{input:scheduleId,output:z.object({deleted:z.boolean()}).strict()},
 previewSchedule:{input:z.object({rule:recurrenceSchema,after:date.optional(),count:z.number().int().min(1).max(10).default(3)}).strict(),output:z.object({dates:z.array(date)}).strict()},
 runSchedule:{input:scheduleId.extend({idempotencyKey:key}),output:runResult},
 retryScheduleRun:{input:z.object({runId:uid,idempotencyKey:key}).strict(),output:runResult},
 cancelScheduleRun:{input:z.object({runId:uid}).strict(),output:runResult},
 resolveScheduleRun:{input:z.object({runId:uid,note:z.string().trim().min(1).max(1000)}).strict(),output:runResult},
 listScheduleRuns:{input:page,output:z.object({runs:z.array(scheduleRunSchema),nextCursor:z.string().nullable()}).strict()},
 listScheduleResults:{input:page.omit({needsAttention:true}),output:z.object({results:z.array(z.object({task:taskSchema,source:scheduleSourceSchema}).strict()),nextCursor:z.string().nullable()}).strict()},
 getTaskSchedule:{input:z.object({taskId:idSchema}).strict(),output:z.object({source:scheduleSourceSchema.nullable()}).strict()},
});
export type ScheduledRpcContract=typeof scheduledRpcContract;
