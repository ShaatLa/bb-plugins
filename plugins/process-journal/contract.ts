import { defineRpcContract } from "@get-bb/plugin-sdk";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { states } from "./states";
export { isOpen, type State } from "./states";

const id = z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/);
const text = z.string().trim().min(1).max(8_000);
const title = text.max(180);
const time = z.number().int().min(0).max(8_640_000_000_000_000);
const link = z.url({ protocol: /^https?$/ }).max(2048).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password;
}, "Links must not contain credentials");
const managerId = id.refine(value => value.startsWith("thr_"), "Expected a BB thread ID");
const scope = z.object({ projectId: id }).strict();
const revision = z.number().int().positive();
const state = z.enum(states);
export const noteSchema = z.object({
  value: z.number().optional(), note: text.optional(), evidence: z.array(link).max(12).optional(),
}).strict().refine(input => input.value !== undefined || input.note !== undefined, "Record a value or a Markdown note");
const metric = z.object({
  definition: text, unit: title.optional(), baseline: z.number().optional(), target: z.number().optional(),
  command: id.optional(),
}).strict();
const proposalFields = z.object({
  title, hypothesis: text, rollbackCondition: text, metric,
  links: z.array(link).max(20),
});
const check = z.object({ checkAt: time, deadlineAt: time }).strict();
const proposalCreate = proposalFields.extend({
  links: proposalFields.shape.links.default([]), managerId: managerId.optional(), deadlineAt: time, key: id.optional(),
}).strict();
export const entrySchema = scope.extend({
  id, title, failure: text, gap: text, links: z.array(link).max(20),
  createdAt: time, createdBy: z.string(), runId: id.optional(),
});
export const proposalSchema = proposalFields.extend({
  id, entryId: id, projectId: id, managerId, state, revision, obligation: revision,
  deadlineAt: time, checkAt: time.nullable(), createdAt: time, updatedAt: time,
});
export const transitionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("applied"), deadlineAt: time, reason: text }).strict(),
  check.extend({ state: z.literal("measuring"), reason: text }).strict(),
  z.object({ state: z.literal("kept"), reason: text }).strict(),
  z.object({ state: z.literal("reverted"), reason: text, override: z.boolean().optional() }).strict(),
  z.object({ state: z.literal("withdrawn"), reason: text }).strict(),
]);
const proposalRef = scope.extend({ proposalId: id });
const edit = proposalRef.extend({ revision });
export const eventSchema = z.object({
  seq: z.number().int(), at: time, actor: z.string(), kind: z.string(),
  message: z.string(), state: state.optional(), deadlineAt: time.optional(), checkAt: time.nullable().optional(), observation: noteSchema.optional(), unit: title.optional(), measurementSpec: z.string().optional(),
});
export const boardLinkSchema = z.object({
  taskId: id, key: title, deadlineSource: z.boolean(), status: title, dueDate: z.string().nullable(),
  syncedCheckAt: time.nullable(), syncedDueDate: z.string().nullable(), conflict: z.boolean(),
});
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const timezone = z.string().max(80).refine(value => {
  try { Temporal.Now.instant().toZonedDateTimeISO(value); return !/^[+-]/.test(value); }
  catch { return false; }
}, "Expected an IANA timezone");
export const configSchema = z.object({
  enabled: z.boolean().default(false),
  managers: z.array(managerId).max(50).refine(values => new Set(values).size === values.length).default([]),
  defaultManager: managerId.nullable().default(null),
  timeZone: timezone.default("UTC"),
  graceMinutes: z.number().int().min(1).max(10080).default(60),
  checkTime: localTime.default("09:00"),
  appliedMinutes: z.number().int().min(1).max(43200).default(1440),
  boardProject: id.nullable().default(null),
  scheduleEnabled: z.boolean().default(false),
  scheduleManager: managerId.nullable().default(null),
  scheduleSkill: id.nullable().default(null),
  scheduleTime: localTime.default("02:00"),
  scheduleCoveredThrough: z.iso.date().nullable().default(null),
  catchUpMinutes: z.number().int().min(1).max(1440).default(60),
}).strict();
const keyName = z.enum([...configSchema.keyof().options, "boardDisplay"]);
export { boardDisplaySchema, boardDisplayWriteSchema } from "./board-display-contract";
const runOutcome = z.enum(["completed", "failed"]);
export const runSchema = scope.extend({
  id, occurrence: z.iso.date(), managerId, skill: id, createdAt: time,
  status: z.enum(["pending", "sent", "uncertain", "completed", "failed"]),
  finishedAt: time.nullable(), note: text.nullable(),
});
const rows = z.object({ entry: entrySchema, proposal: proposalSchema });
const pagination = { limit: z.number().int().min(1).max(50).default(25), offset: z.number().int().min(0).max(100000).default(0) };
const view = z.enum(["board", "history"]).default("board");
export const historyRange = z.enum(["week", "month", "quarter"]);
const action = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output });
export const methods = {
  projects: action(z.object({}).strict(), z.array(z.object({
    id, name: z.string(), timeZone: timezone, managers: z.array(z.object({ id: managerId, name: z.string(), reachable: z.boolean() })),
  }))),
  "config.get": action(scope.extend({ key: keyName.optional() }), z.unknown()),
  "config.set": action(scope.extend({ key: keyName, value: z.unknown() }), z.unknown()),
  "entry.add": action(scope.extend({
    title, failure: text, gap: text, links: z.array(link).max(20).default([]),
    key: id.optional(), runId: id.optional(), proposal: proposalCreate.optional(),
  }), z.object({ entry: entrySchema, proposal: proposalSchema.nullable() })),
  "entry.list": action(scope.extend({ ...pagination, unproposed: z.boolean().optional() }),
    z.object({ items: z.array(entrySchema), nextOffset: z.number().int().nullable() })),
  "proposal.add": action(scope.extend({ entryId: id, proposal: proposalCreate, runId: id.optional() }), proposalSchema),
  "proposal.update": action(edit.extend({ patch: proposalFields.partial().extend({
    managerId: managerId.optional(), checkAt: time.optional(), deadlineAt: time.optional(),
  }).strict() }), proposalSchema),
  "proposal.transition": action(edit.extend({ transition: transitionSchema }), proposalSchema),
  "proposal.measure": action(edit.extend({ observation: noteSchema }), proposalSchema),
  "proposal.comment": action(proposalRef.extend({ body: text }), eventSchema),
  "proposal.rollback": action(proposalRef.extend({ evidence: text }), eventSchema),
  "proposal.ack": action(proposalRef.extend({ effectId: id, questionId: id }), eventSchema),
  "proposal.detail": action(proposalRef.extend({ before: z.number().int().positive().optional() }), rows.extend({
    events: z.array(eventSchema), nextBefore: z.number().int().nullable(), links: z.array(boardLinkSchema),
    managerReachable: z.boolean(), measured: z.boolean(),
  })),
  list: action(scope.extend({ ...pagination, managerId: managerId.optional(), state: state.optional(),
    view, range: historyRange.default("quarter"), overdue: z.boolean().optional(), withTotal: z.boolean().optional(),
  }), z.object({ items: z.array(rows.extend({ nextAt: time, overdue: z.boolean() })), nextOffset: z.number().int().nullable(), timeZone: timezone, total: z.number().int().nonnegative().optional() })),
  digest: action(scope.extend({ managerId: managerId.optional() }), z.object({
    applied: z.number(), kept: z.number(), reverted: z.number(), overdue: z.number(),
  })),
  "fix.create": action(edit.extend({ key: id, title: title.optional(), deadlineSource: z.boolean().default(false) }), boardLinkSchema),
  "fix.link": action(edit.extend({ taskKey: title, deadlineSource: z.boolean().default(false) }), boardLinkSchema),
  "fix.resolveDeadline": action(edit.extend({ taskId: id, prefer: z.enum(["journal", "card"]) }), boardLinkSchema),
  "run.list": action(scope.extend({ ...pagination, managerId: managerId.optional() }), z.object({ items: z.array(runSchema.extend({ delayed: z.boolean() })), nextOffset: z.number().int().nullable() })),
  "run.finish": action(scope.extend({ runId: id, status: runOutcome, note: text.optional() }), runSchema),
};
export const rpcContract = defineRpcContract(methods);
export type Entry = z.infer<typeof entrySchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type JournalEvent = z.infer<typeof eventSchema>;
export type BoardLink = z.infer<typeof boardLinkSchema>;
export type Config = z.infer<typeof configSchema>;
export type Run = z.infer<typeof runSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type Observation = z.infer<typeof noteSchema>;
export type Input<K extends keyof typeof methods> = z.output<typeof methods[K]["input"]>;
