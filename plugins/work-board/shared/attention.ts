import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The plugin id Sweep runs under; only it may acknowledge a transition. */
export const SWEEP_PLUGIN_ID = "sweep";
export const ATTENTION_OWNER_ONLY = "The manager-attention mode and manager are changed by the owner in the project settings; this is an owner-only convention, and no command or setting call proves the caller is the owner.";

const modeSchema = z.enum(["off", "shadow", "live"]);
const bbProjectId = z.string().regex(/^proj_[A-Za-z0-9_-]+$/);
const trackerProjectId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

const handbackEntrySchema = z.object({ occurrenceId: z.string(), taskId: z.string(), taskKey: z.string(), signal: z.string(), firstSeenAt: z.string(), eligibleAt: z.string() }).strict();
export const attentionKindStateSchema = z.object({
  effective: z.object({ mode: modeSchema, generation: z.number().int() }).strict(),
  requested: z.object({ mode: z.enum(["shadow", "live"]), generation: z.number().int() }).strict().nullable(),
  transition: z.object({
    token: z.string(),
    direction: z.enum(["to_live", "to_shadow"]),
    generation: z.number().int(),
    state: z.enum(["preparing", "ready"]),
    readyAt: z.string().nullable(),
    readyRev: z.number().int().nullable(),
    handback: z.array(handbackEntrySchema).nullable(),
  }).strict().nullable(),
}).strict();

/** Every refusal carries `ok: false` and a code; a few add the state the caller needs to recover. */
const refusalSchema = z.object({ ok: z.literal(false), code: z.string() }).passthrough();

const occurrenceSchema = z.object({
  occurrenceId: z.string(), taskId: z.string(), taskKey: z.string(), signal: z.string(), firstSeenAt: z.string(), eligibleAt: z.string(),
  clearedAt: z.string().nullable(), retiredReason: z.string().nullable(), sweepBaselinedGeneration: z.number().int().nullable(), createdRev: z.number().int(), rev: z.number().int(),
}).strict();
const attemptSchema = z.object({
  attemptId: z.string(), batchId: z.string(), occurrenceIds: z.array(z.string()), recipientThreadId: z.string(), recipientSource: z.enum(["manager", "sweep_fallback", "parent"]), startedAt: z.string(),
  outcome: z.enum(["claimed", "sending", "appended", "queued", "inline", "failed", "unknown"]), queuedMessageId: z.string().nullable(), inlineEventRef: z.string().nullable(), acceptedAt: z.string().nullable(),
  disposition: z.enum(["waived_loss", "retry"]).nullable(), dispositionAt: z.string().nullable(), error: z.string().nullable(), rev: z.number().int(),
}).strict();
const observationSchema = z.object({ at: z.string(), taskId: z.string(), signal: z.string(), validity: z.enum(["valid", "unknown"]), rev: z.number().int() }).strict();

const settingsSchema = z.object({
  trackerId: trackerProjectId,
  linkedBbProjectId: z.string().nullable(),
  state: attentionKindStateSchema,
  changedAt: z.string().nullable(),
  previousMode: z.string().nullable(),
  shadowStartedAt: z.string().nullable(),
  /** Milliseconds of shadow observation still missing before live may be requested; 0 when the gate is open. */
  gateRemainingMs: z.number().int().min(0),
  manager: z.string().nullable(),
  managerChangedAt: z.string().nullable(),
  managerPrevious: z.string().nullable(),
  unresolvedAttempts: z.array(attemptSchema),
}).strict();

export const attentionRpcContract = defineRpcContract({
  "attention.modes": {
    experimental_description: "Read the manager-attention mode, requested transition and handback for a BB project (Sweep contract).",
    input: z.object({ projectId: bbProjectId }).strict(),
    output: z.union([z.object({ projectId: z.string(), trackerId: z.string(), kinds: z.record(z.string(), attentionKindStateSchema) }).strict(), refusalSchema]),
  },
  "attention.ack": {
    experimental_description: "Acknowledge a ready mode transition; accepted from the Sweep plugin only (Sweep contract).",
    input: z.object({
      projectId: bbProjectId, trackerId: z.string(), kind: z.string(), token: z.string(), generation: z.number().int().min(0),
      direction: z.enum(["to_live", "to_shadow"]), fenceId: z.string().min(1), acceptedOccurrenceIds: z.array(z.string()).optional(),
    }).strict(),
    output: z.union([
      z.object({
        ok: z.literal(true), generation: z.number().int(), direction: z.enum(["to_live", "to_shadow"]), mode: modeSchema,
        unmatched: z.array(z.object({ occurrenceId: z.string(), reason: z.string() }).strict()), baselined: z.array(z.string()), readyRev: z.number().int().nullable(), endRev: z.number().int(),
      }).strict(),
      refusalSchema,
    ]),
  },
  "attention.ledger": {
    experimental_description: "Read occurrences, delivery attempts and unknown observations changed after a revision (Sweep contract).",
    input: z.object({ projectId: bbProjectId, kind: z.string(), sinceRev: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
    output: z.union([z.object({ occurrences: z.array(occurrenceSchema), attempts: z.array(attemptSchema), observations: z.array(observationSchema), nextRev: z.number().int() }).strict(), refusalSchema]),
  },
  "attention.resolveKeys": {
    experimental_description: "Resolve card keys, aliases included, to task ids of the BB project's tracker (Sweep contract).",
    input: z.object({ projectId: bbProjectId, keys: z.array(z.string().min(1).max(40)).max(500) }).strict(),
    output: z.union([z.object({ resolved: z.record(z.string(), z.string()), unknown: z.array(z.string()) }).strict(), refusalSchema]),
  },
});

/** The owner's settings calls; they join the app's tasks contract, since the settings UI cannot carry a plugin caller. */
export const attentionUiMethods = {
  getAttentionSettings: {
    input: z.object({ projectId: trackerProjectId }).strict(),
    output: settingsSchema,
  },
  updateAttentionMode: {
    input: z.object({ projectId: trackerProjectId, mode: modeSchema, parityReviewed: z.boolean().optional() }).strict(),
    output: attentionKindStateSchema,
  },
  updateAttentionManager: {
    input: z.object({ projectId: trackerProjectId, manager: z.string().regex(/^thr_[A-Za-z0-9_-]+$/).nullable() }).strict(),
    output: z.object({ manager: z.string().nullable() }).strict(),
  },
  resolveAttentionAttempt: {
    input: z.object({ attemptId: z.string(), disposition: z.enum(["waived_loss", "retry"]) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
};
export type AttentionSettings = z.infer<typeof settingsSchema>;
