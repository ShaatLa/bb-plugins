import { z } from "zod";
import { idSchema } from "./contract";

const timezone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Invalid time zone");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// Legacy archive formats v13–v24.
const recurrenceSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("daily"),time,timezone}).strict(),
  z.object({kind:z.literal("weekly"),time,timezone,weekdays:z.array(z.number().int().min(0).max(6)).min(1).max(7).refine(days => new Set(days).size === days.length,"Duplicate weekday")}).strict(),
  z.object({kind:z.literal("once"),at:z.iso.datetime({offset:true}),timezone}).strict(),
]);
const scheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("unassigned")}).strict(),
  z.object({kind:z.literal("thread"),threadId:z.string().regex(/^thr_[A-Za-z0-9_-]+$/)}).strict(),
  z.object({kind:z.literal("preset"),presetId:idSchema}).strict(),
]);
const uid=z.uuid();
const date=z.iso.datetime({offset:true});
export const scheduleSchema=z.object({id:uid,projectId:idSchema,templateTaskId:idSchema,title:z.string(),rule:recurrenceSchema,target:scheduleTargetSchema,enabled:z.boolean(),nextDueAt:date.nullable(),createdAt:date,updatedAt:date,overlapRunIds:z.array(uid).default([])}).strict();
export const scheduleSourceSchema=z.object({taskId:idSchema,scheduleId:uid,scheduleTitle:z.string(),role:z.enum(["template","recurring_run","one_time_run"]),scheduledFor:date.nullable(),startedAt:date.nullable(),runId:uid.nullable().default(null),occurrenceKey:z.string().nullable().default(null)}).strict();
const SCHEDULE_RUN_STATES=["starting","queued","running","completed","canceled","skipped","failed","delivery_unknown","cancel_pending"] as const;
export const scheduleRunSchema=z.object({id:uid,scheduleId:uid,projectId:idSchema,scheduleTitle:z.string(),occurrenceKey:z.string(),scheduledFor:date,state:z.enum(SCHEDULE_RUN_STATES),taskId:idSchema.nullable(),threadId:z.string().nullable(),queueId:z.string().nullable(),requestId:z.string().nullable(),reason:z.string().nullable(),startedAt:date.nullable(),finishedAt:date.nullable(),resolvedAt:date.nullable(),createdAt:date,updatedAt:date,pushState:z.enum(["not_attempted","sent","failed"]),pushChannels:z.array(z.enum(["web","desktop","mobile"])),pushError:z.string().nullable(),execution:z.record(z.string(),z.unknown()).nullable(),overlapRunIds:z.array(uid).default([]),missCount:z.number().int().positive().default(1),historical:z.boolean().default(false),cancelOutcome:z.enum(["canceled","skipped"]).optional(),lastQueueId:z.string().nullable().optional()}).strict();
