import { z } from "zod";

const trackerProjectId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const count = z.number().int().nonnegative();
const receiptSchema = z.object({ mode: z.enum(["inline", "queued", "appended"]), id: z.string() });
const attemptSchema = z.object({ attemptId: z.string(), manager: z.string(), outcome: z.string(), startedAt: z.string(), error: z.string().nullable() });

export const checksStatusSchema = z.object({
  trackerId: z.string(),
  prefix: z.string(),
  bbProjectId: z.string().nullable(),
  config: z.object({
    enabled: z.boolean(), branch: z.string().nullable(), script: z.string().nullable(), args: z.array(z.string()),
    intervalMinutes: z.number().int(), timeoutSeconds: z.number().int(), snapshots: z.boolean(),
  }),
  enabledChangedAt: z.string().nullable(),
  enabledPrevious: z.boolean().nullable(),
  manager: z.string().nullable(),
  draining: z.boolean(),
  ownedByOtherTracker: z.string().nullable(),
  lastRun: z.number().nullable(),
  nextRun: z.number().nullable(),
  tickId: z.string().nullable(),
  exitCode: z.number().nullable(),
  failureStage: z.enum(["refresh", "script", "delivery"]).nullable(),
  error: z.string().nullable(),
  refreshFailures: count,
  refreshRetryAt: z.number().nullable(),
  managerError: z.string().nullable(),
  pushError: z.string().nullable(),
  lastDelivery: z.object({ at: z.number(), to: z.string().nullable(), receipt: receiptSchema.nullable(), reportId: z.string().nullable(), tickId: z.string().nullable() }).nullable(),
  pending: z.object({
    reportId: z.string(), tickId: z.string().nullable(), exitCode: z.number().nullable(), stagedAt: z.string().nullable(), projectId: z.string().nullable(),
    raw: z.string().nullable(), hasCandidate: z.boolean(), attempts: z.array(attemptSchema),
  }).nullable(),
  awaitingRetry: z.boolean(),
  stateMismatch: z.string().nullable(),
  stats: z.object({
    trackerId: z.string(), days: count, since: count, ticks: count, executed: count, deliveries: count, repeats: count, suppressedReports: count,
    refreshFailures: count, scriptFailures: count, deliveryFailures: count, newItems: z.record(z.string(), count),
  }),
});
export type ChecksStatus = z.infer<typeof checksStatusSchema>;

/** The owner's calls, served on the app's tasks contract: only the settings UI changes `enabled`, retries and resets. */
export const checksUiMethods = {
  getChecksStatus: { input: z.object({ projectId: trackerProjectId }).strict(), output: checksStatusSchema },
  updateChecksSetting: {
    input: z.object({ projectId: trackerProjectId, key: z.enum(["branch", "script", "args", "intervalMinutes", "timeoutSeconds", "snapshots"]), value: z.unknown() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  updateChecksEnabled: { input: z.object({ projectId: trackerProjectId, enabled: z.boolean() }).strict(), output: z.object({ enabled: z.boolean() }) },
  retryChecksReport: { input: z.object({ projectId: trackerProjectId }).strict(), output: z.object({ ok: z.literal(true) }) },
  resetChecksState: { input: z.object({ projectId: trackerProjectId }).strict(), output: z.object({ ok: z.literal(true) }) },
};
