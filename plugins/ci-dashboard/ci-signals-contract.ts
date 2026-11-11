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

/** Who deals with a problem. `ref` (fix_pending only): a PR number like "#12", a tracker key like "FIX-1" or a URL. `by` is absent on entries stored before 0.5.0. */
export const handledSchema = z.object({ state: z.enum(["dismissed", "investigating", "fix_pending"]), threadId: z.string().optional(), ref: z.string().max(80).optional(), by: z.enum(["agent", "user"]).optional(), at: timestamp });
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

const timingStat = z.object({ p50: z.number(), p90: z.number() });
export const poolTimingSchema = z.object({ jobs: z.number(), queueWaitMs: timingStat, durationMs: timingStat });

export const failureRowSchema = z.object({
  class: failureClass, reason: z.string(), evidence: z.string().nullable(),
  /** Event of the run: pull_request, push, merge_group... */
  event: z.string(),
  /** merge_group only: the PR number parsed from the queue branch name, else null. */
  queuePullRequest: z.number().nullable(),
  /** merge_group job that failed while the newest completed pull_request run of the same PR passed the same job: fails only in the queue. */
  queueOnly: z.boolean(),
  runId: z.number(), attempt: z.number(), jobId: z.number(), jobName: z.string(), workflowName: z.string(),
  branch: z.string().nullable(), headSha: z.string(), pullRequests: z.array(z.number()),
  pool: z.string().nullable(), runnerName: z.string().nullable(),
  startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), url: z.url(),
});

export const rerunRowSchema = z.object({
  runId: z.number(), event: z.string(), queuePullRequest: z.number().nullable(), workflowName: z.string(), headSha: z.string(), headBranch: z.string().nullable(),
  attempts: z.number(), outcomes: z.array(z.string().nullable()), finalConclusion: z.string().nullable(),
  repeatedRunnerMs: z.number(), url: z.url(),
});

const laneStatSchema = z.object({ p50: z.number(), p90: z.number(), n: z.number(), days: z.array(z.object({ date: z.string(), p50: z.number(), p90: z.number(), n: z.number() })) });
export const laneTimingsSchema = z.object({ pipelines: z.array(z.object({ workflow: z.string(), event: z.string(), runs: z.number(), wall: laneStatSchema, lanes: z.array(laneStatSchema.extend({ name: z.string() })) })) });

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
  /** failureCounts split by run event. */
  failureCountsByEvent: z.record(z.string(), z.record(failureClass, z.number())),
  /** Queue wait (start - created) and duration percentiles per runner pool over executed jobs of the window; "unknown" when the pool is not known. */
  poolTimings: z.record(z.string(), poolTimingSchema),
  laneTimings: laneTimingsSchema.optional(),
  poolTimingsByEvent: z.record(z.string(), z.record(z.string(), poolTimingSchema)),
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

const fullSignalsOutputSchema = z.object({
  repositories: z.array(repositorySignalsSchema),
  actors: z.record(actorSchema, z.string()),
});
export type SignalsOutput = z.infer<typeof fullSignalsOutputSchema>;
export const signalsOutputSchema = z.object({
  repositories: z.array(repositorySignalsSchema.partial({ failures: true, poolTimings: true, poolTimingsByEvent: true, failureCountsByEvent: true })),
  actors: z.record(actorSchema, z.string()),
}) as unknown as typeof fullSignalsOutputSchema;
export function compactSignalsRow(row: z.infer<typeof repositorySignalsSchema>, now: number) {
  const { failures, poolTimings, poolTimingsByEvent, failureCountsByEvent, ...rest } = row;
  const resolved = row.signals.filter((signal) => !signal.open && now - Date.parse(signal.until ?? signal.since) <= 7 * 86400000)
    .sort((a, b) => Date.parse(b.until ?? b.since) - Date.parse(a.until ?? a.since)).slice(0, 10);
  return { ...rest, signals: [...row.signals.filter((signal) => signal.open), ...resolved] };
}
export const signalsInputSchema = z.object({ repository: repositorySchema.optional(), since: timestamp.optional(), until: timestamp.optional(),
  /** UI projection: omits failures, poolTimings, poolTimingsByEvent and failureCountsByEvent, and keeps open signals plus the 10 newest resolved ones within 7 days */
  compact: z.boolean().optional() }).strict().nullable();
export type SignalsChanged = { repository?: string; count?: number; critical?: number };
export const navigationBadgeOutputSchema = z.object({ count: z.number(), critical: z.number() });
export const SIGNALS_CHANGED = "signals-changed";
const problemId = z.string().min(1).max(300);
export const problemActionInputSchema = z.object({ repository: repositorySchema, id: problemId, action: z.enum(["dismiss", "restore"]) }).strict();
export const problemActionOutputSchema = z.object({ handled: handledSchema.nullable() });
export const investigateInputSchema = z.object({ repository: repositorySchema, id: problemId, threadId: z.string().regex(/^thr_[A-Za-z0-9_-]{1,64}$/).optional() }).strict();
export const investigateOutputSchema = z.object({ threadId: z.string() });
