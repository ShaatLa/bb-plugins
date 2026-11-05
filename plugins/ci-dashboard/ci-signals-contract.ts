import { z } from "zod";
import { repositorySchema } from "./metrics";

// RPC contract shared by server.ts (producer) and the app Signals panel (consumer).
const timestamp = z.iso.datetime({ offset: true });
const failureClass = z.enum(["runner_loss", "timeout", "transient", "flake", "real", "refused", "consequence", "superseded", "manual_cancel", "collateral_cancel", "unknown"]);
export const actorSchema = z.enum(["owner_sre", "pr_author", "lead", "manager"]);

export const signalSchema = z.object({
  id: z.string(),
  kind: z.enum(["pool_stall", "runner_loss", "mass_cancel", "rerun_failed", "flake", "transient", "timeout"]),
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string(), what: z.string(), impact: z.string(),
  where: z.object({
    pool: z.string().optional(), runId: z.number().optional(), attempt: z.number().optional(), jobId: z.number().optional(),
    jobName: z.string().optional(), runnerName: z.string().optional(), branch: z.string().nullable().optional(),
    headSha: z.string().optional(), pullRequests: z.array(z.number()).optional(), url: z.url().optional(),
  }),
  since: timestamp, until: timestamp.nullable(), actor: actorSchema, open: z.boolean(),
});

export const handledSchema = z.object({ state: z.enum(["dismissed", "investigating"]), threadId: z.string().optional(), at: timestamp });
export type Handled = z.infer<typeof handledSchema>;

/** An open critical/warning job-level signal or a run-level alert, with who deals with it. Sorted most severe first, then newest. */
export const problemSchema = z.object({
  id: z.string(), severity: z.enum(["critical", "warning"]), title: z.string(), what: z.string(), impact: z.string(),
  where: signalSchema.shape.where, since: timestamp, handled: handledSchema.nullable(),
});
export type Problem = z.infer<typeof problemSchema>;

export const poolStateSchema = z.object({
  pool: z.string(), queued: z.number(), inProgress: z.number(),
  oldestQueuedAt: timestamp.nullable(), lastStartedAt: timestamp.nullable(), queuedRunIds: z.array(z.number()),
});

const tally = z.object({ count: z.number(), runnerMs: z.number() });

export const failureRowSchema = z.object({
  class: failureClass, reason: z.string(), evidence: z.string().nullable(),
  runId: z.number(), attempt: z.number(), jobId: z.number(), jobName: z.string(), workflowName: z.string(),
  branch: z.string().nullable(), headSha: z.string(), pullRequests: z.array(z.number()),
  pool: z.string().nullable(), runnerName: z.string().nullable(),
  startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), url: z.url(),
});

export const rerunRowSchema = z.object({
  runId: z.number(), workflowName: z.string(), headSha: z.string(), headBranch: z.string().nullable(),
  attempts: z.number(), outcomes: z.array(z.string().nullable()), finalConclusion: z.string().nullable(),
  repeatedRunnerMs: z.number(), url: z.url(),
});

export const repositorySignalsSchema = z.object({
  repository: repositorySchema,
  updatedAt: timestamp.nullable(),
  /** Error of the last live poll or backfill step; null when healthy. */
  error: z.string().nullable(),
  live: z.object({ pools: z.array(poolStateSchema), truncated: z.boolean(), polledAt: timestamp.nullable() }),
  /** Open signals first (critical > warning > info, newest first), then resolved ones from the last 7 days. */
  signals: z.array(signalSchema),
  /** Open problems (see problemSchema), handled ones included. */
  problems: z.array(problemSchema),
  /** BB project linked to the repository, or null: "New session" needs it. */
  projectId: z.string().nullable(),
  /** Job-level window the aggregates below cover. */
  window: z.object({ since: timestamp, until: timestamp }),
  failureCounts: z.record(failureClass, z.number()),
  runnerLosses: z.object({ byPool: z.record(z.string(), tally), byJob: z.record(z.string(), tally), byDay: z.record(z.string(), tally) }),
  massCancels: z.array(z.object({ since: timestamp, until: timestamp, runners: z.array(z.string()), runIds: z.array(z.number()), jobs: z.number() })),
  /** Newest first, at most 50. */
  failures: z.array(failureRowSchema),
  /** Newest first, at most 20. */
  reruns: z.array(rerunRowSchema),
  backfill: z.object({ remaining: z.number(), failed: z.number(), pausedUntil: timestamp.nullable(), coveredSince: timestamp.nullable() }),
  /** Oldest stored job time; only returned for a range request, whose aggregates are cut to that range (open signals are not). */
  coverage: timestamp.nullable().optional(),
});

export const signalsOutputSchema = z.object({
  repositories: z.array(repositorySignalsSchema),
  actors: z.record(actorSchema, z.string()),
});
export type SignalsOutput = z.infer<typeof signalsOutputSchema>;
export const signalsInputSchema = z.object({ repository: repositorySchema.optional(), since: timestamp.optional(), until: timestamp.optional() }).strict().nullable();
export const navigationBadgeOutputSchema = z.object({ count: z.number(), critical: z.number() });
export const SIGNALS_CHANGED = "signals-changed";
const problemId = z.string().min(1).max(300);
export const problemActionInputSchema = z.object({ repository: repositorySchema, id: problemId, action: z.enum(["dismiss", "restore"]) }).strict();
export const problemActionOutputSchema = z.object({ handled: handledSchema.nullable() });
export const investigateInputSchema = z.object({ repository: repositorySchema, id: problemId, threadId: z.string().regex(/^thr_[A-Za-z0-9_-]{1,64}$/).optional() }).strict();
export const investigateOutputSchema = z.object({ threadId: z.string() });
