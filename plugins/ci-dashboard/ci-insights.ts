import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });
export const ciRunSchema = z.object({
  id: z.number().int().positive(), created_at: timestamp, conclusion: z.string().nullable(),
  workflow_id: z.number().int().positive().optional(), name: z.string().nullable().optional(),
  head_branch: z.string().nullable().optional(), event: z.string().optional(),
  run_attempt: z.number().int().positive().optional(), draftDeferred: z.boolean().optional(),
  run_started_at: timestamp.nullable().optional(), updated_at: timestamp.optional(),
});
type Run = z.infer<typeof ciRunSchema>;
const timingSchema = z.object({
  // Missing basis identifies legacy aggregates that must be rebuilt from raw records.
  basis: z.literal("success").optional(),
  count: z.number(), totalMs: z.number(), averageMs: z.number().nullable(),
  medianMs: z.number().nullable(), p95Ms: z.number().nullable(),
});
const countsSchema = z.object({ total: z.number(), passed: z.number(), failed: z.number(), eligible: z.number() });
const alertSchema = z.object({
  kind: z.enum(["main", "streak"]), workflowId: z.number(), name: z.string(), branch: z.string(),
  runId: z.number(), createdAt: timestamp, consecutive: z.number(),
});
export const ciInsightsSchema = z.object({
  draftPolicy: z.literal("job-evidence-v1").optional(),
  total: z.number(), identified: z.number(), defaultBranch: z.string().nullable(),
  main: countsSchema.nullable(), pullRequests: countsSchema,
  alerts: z.array(alertSchema), timing: timingSchema,
  workflows: z.array(countsSchema.extend({ id: z.number(), name: z.string(), timing: timingSchema, failureId: z.number().nullable() })),
  slowRuns: z.array(z.object({ id: z.number(), name: z.string(), branch: z.string().nullable(), durationMs: z.number() })),
});
export type CiInsights = z.infer<typeof ciInsightsSchema>;
const excluded = new Set(["cancelled", "skipped"]);
const failures = new Set(["failure", "timed_out", "startup_failure", "action_required", "stale"]);
const isPr = (run: Run) => ["pull_request", "pull_request_target", "pull_request_review"].includes(run.event ?? "");
const identified = (run: Run) => run.workflow_id !== undefined && run.name !== undefined && run.head_branch !== undefined && run.event !== undefined;
function counts(runs: Run[]) {
  return { total: runs.length, passed: runs.filter((run) => run.conclusion === "success").length,
    failed: runs.filter((run) => !run.draftDeferred && failures.has(run.conclusion ?? "")).length,
    eligible: runs.filter((run) => !run.draftDeferred && !excluded.has(run.conclusion ?? "")).length };
}
function duration(run: Run): number | null {
  if (!run.run_started_at || !run.updated_at) return null;
  const start = Date.parse(run.run_started_at), finish = Date.parse(run.updated_at);
  return finish >= start && start >= Date.parse(run.created_at) ? finish - start : null;
}
function timings(runs: Run[]) {
  const values = runs.filter((run) => run.conclusion === "success").map(duration).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const count = values.length, totalMs = values.reduce((sum, value) => sum + value, 0);
  return { basis: "success" as const, count, totalMs, averageMs: count ? totalMs / count : null,
    medianMs: count ? (values[Math.floor((count - 1) / 2)] + values[Math.floor(count / 2)]) / 2 : null,
    p95Ms: count ? values[Math.ceil(count * 0.95) - 1] : null };
}

export function summarizeCi(runs: Run[], defaultBranch: string | null): CiInsights {
  const known = runs.filter(identified);
  const groups = new Map<number, Run[]>(), branches = new Map<string, Run[]>();
  const ordered = [...known].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const run of ordered) {
    const workflow = groups.get(run.workflow_id!) ?? [];
    workflow.push(run); groups.set(run.workflow_id!, workflow);
    const key = JSON.stringify([run.workflow_id, run.head_branch, isPr(run)]);
    const branch = branches.get(key) ?? [];
    branch.push(run); branches.set(key, branch);
  }
  const alerts: CiInsights["alerts"] = [];
  for (const rows of branches.values()) {
    const relevant = rows.filter((run) => !run.draftDeferred && !excluded.has(run.conclusion ?? ""));
    const latest = relevant[0];
    if (!latest || !latest.head_branch || !failures.has(latest.conclusion ?? "")) continue;
    let consecutive = 0;
    for (const run of relevant) { if (!failures.has(run.conclusion ?? "")) break; consecutive++; }
    const main = latest.head_branch === defaultBranch && !isPr(latest);
    if (main || consecutive >= 3) alerts.push({
      kind: main ? "main" : "streak", workflowId: latest.workflow_id!, name: latest.name ?? `Workflow ${latest.workflow_id}`,
      branch: latest.head_branch ?? "Unknown branch", runId: latest.id, createdAt: latest.created_at, consecutive,
    });
  }
  alerts.sort((a, b) => Number(b.kind === "main") - Number(a.kind === "main") || b.consecutive - a.consecutive || b.runId - a.runId);
  const workflows = [...groups].map(([id, rows]) => ({ id, name: rows[0].name ?? `Workflow ${id}`,
    ...counts(rows), timing: timings(rows), failureId: rows.find((run) => !run.draftDeferred && failures.has(run.conclusion ?? ""))?.id ?? null,
  })).sort((a, b) => b.failed - a.failed || b.total - a.total || a.id - b.id);
  return {
    draftPolicy: "job-evidence-v1", total: runs.length, identified: known.length, defaultBranch,
    main: defaultBranch ? counts(known.filter((run) => run.head_branch === defaultBranch && !isPr(run))) : null,
    pullRequests: counts(known.filter(isPr)), alerts, workflows, timing: timings(runs),
    slowRuns: runs.filter((run) => run.conclusion === "success").flatMap((run) => {
      const durationMs = duration(run);
      return durationMs === null ? [] : [{ id: run.id, name: run.name ?? `Run #${run.id}`, branch: run.head_branch ?? null, durationMs }];
    }).sort((a, b) => b.durationMs - a.durationMs || b.id - a.id).slice(0, 5),
  };
}
