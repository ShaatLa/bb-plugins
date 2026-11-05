import type { ClassifiedJob, FailureClass, JobRecord, RerunSummary, Signal } from "./ci-jobs-types";
import type { LossTally, MassCancel } from "./ci-classify";

const HOUR = 3_600_000;
const FAILED_FINAL = new Set(["failure", "timed_out"]);
const HIDDEN_FAILURES = new Set<FailureClass>(["refused", "consequence", "superseded", "manual_cancel"]);
const CLASSES: FailureClass[] = ["runner_loss", "timeout", "transient", "flake", "real", "refused", "consequence", "superseded", "manual_cancel", "collateral_cancel", "unknown"];

const runUrl = (repository: string, runId: number) => `https://github.com/${repository}/actions/runs/${runId}`;
const jobUrl = (repository: string, job: JobRecord) => `${runUrl(repository, job.runId)}/job/${job.jobId}`;
const jobWhere = (repository: string, job: JobRecord): Signal["where"] => ({
  runId: job.runId, attempt: job.attempt, jobId: job.jobId, jobName: job.jobName, runnerName: job.runnerName ?? undefined, pool: job.pool ?? undefined,
  branch: job.headBranch, headSha: job.headSha, pullRequests: job.pullRequests, url: jobUrl(repository, job),
});
const since = (job: JobRecord) => job.startedAt ?? job.createdAt;
const minutes = (job: JobRecord) => job.startedAt && job.completedAt ? Math.max(0, Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 60000)) : null;
const prs = (numbers: number[]) => numbers.map((n) => `#${n}`).join(", ");

export function buildSignals({ classified, reruns, massCancels, stalls, defaultBranch, repository, now, windowHours = 24 }: {
  classified: ClassifiedJob[]; reruns: RerunSummary[]; massCancels: MassCancel[]; stalls: Signal[];
  defaultBranch: string | null; repository: string; now: number; windowHours?: number;
}): Signal[] {
  const from = now - windowHours * HOUR;
  const inWindow = (iso: string | null) => iso !== null && Date.parse(iso) >= from;
  const isDefault = (branch: string | null) => defaultBranch !== null && branch === defaultBranch;
  const out: Signal[] = [...stalls];
  const where = (job: JobRecord) => jobWhere(repository, job);

  for (const group of massCancels) {
    if (!inWindow(group.until)) continue;
    const pools = new Set(group.jobs.map((c) => c.job.pool));
    const pool = pools.size === 1 ? [...pools][0] ?? undefined : undefined;
    out.push({ id: `mass_cancel:${group.since}`, kind: "mass_cancel", severity: "critical", title: `Mass runner loss${pool ? ` in ${pool}` : ""}`,
      what: `${group.jobs.length} jobs on ${group.runners.length} runners lost/cancelled within 2 min`, where: { pool },
      since: group.since, until: group.until, impact: `${group.runIds.length} runs affected; rerun needed`, actor: "owner_sre", open: true });
  }

  const byRun = new Map<number, ClassifiedJob[]>();
  for (const c of classified) byRun.set(c.job.runId, [...(byRun.get(c.job.runId) ?? []), c]);

  for (const { job, class: cls } of classified) {
    if (!inWindow(job.completedAt)) continue;
    const base = { where: where(job), since: since(job), until: job.completedAt, open: true } as const;
    const onDefault = isDefault(job.headBranch);
    const pr = job.pullRequests.length ? `PR ${prs(job.pullRequests)}` : `branch ${job.headBranch ?? "unknown"}`;
    if (cls === "runner_loss") out.push({ ...base, id: `runner_loss:${job.jobId}`, kind: "runner_loss", severity: onDefault ? "warning" : "info", actor: "owner_sre",
      title: `Runner lost: ${job.jobName}`, what: `${job.jobName} lost its runner ${job.runnerName ?? "(unknown)"} in ${job.pool ?? "unknown pool"} (run ${job.runId}, attempt ${job.attempt})`,
      impact: onDefault ? `CI red on ${job.headBranch}: deploy blocked until rerun` : `${pr} CI red; rerun needed` });
    else if (cls === "timeout") out.push({ ...base, id: `timeout:${job.jobId}`, kind: "timeout", severity: "info", actor: "owner_sre",
      title: `Job timed out: ${job.jobName}`, what: `${job.jobName} exceeded the maximum execution time${minutes(job) !== null ? ` after ${minutes(job)} min` : ""} on ${job.runnerName ?? "an unknown runner"} (run ${job.runId})`,
      impact: `${pr} CI red; rerun needed` });
    else if (cls === "flake") out.push({ ...base, id: `flake:${job.jobId}`, kind: "flake", severity: "info", actor: "lead",
      title: `Flaky job: ${job.jobName}`, what: `${job.jobName} failed at step ${job.failedSteps[0] ?? "unknown"}, then passed at the same sha (run ${job.runId})`,
      impact: "Flaky test costs a rerun" });
    else if (cls === "transient") out.push({ ...base, id: `transient:${job.jobId}`, kind: "transient", severity: "info", actor: onDefault ? "lead" : "pr_author",
      title: `Transient failure: ${job.jobName}`, what: `${job.jobName} hit a tool or network failure (run ${job.runId}, attempt ${job.attempt})`,
      impact: onDefault ? `Rerun ${job.headBranch} CI` : `${pr} CI red; rerun needed` });
  }

  for (const run of reruns) {
    if (!run.finalConclusion || !FAILED_FINAL.has(run.finalConclusion)) continue;
    // RerunSummary carries no timestamps: take them from the failed jobs of the final attempt.
    const last = (byRun.get(run.runId) ?? []).filter((c) => c.job.attempt === run.attempts);
    const ended = last.map((c) => c.job.completedAt).filter((t): t is string => t !== null).sort().at(-1) ?? null;
    if (!last.length || !inWindow(ended)) continue;
    const onDefault = isDefault(run.headBranch);
    const first = last[0]!.job;
    out.push({ id: `rerun_failed:${run.runId}:${run.attempts}`, kind: "rerun_failed", severity: onDefault ? "warning" : "info", actor: "lead",
      title: `Rerun still failing: ${run.workflowName}`, what: `Run ${run.runId} ended ${run.finalConclusion} after ${run.attempts} attempts (${run.outcomes.map((o) => o ?? "?").join(" → ")})`,
      where: { runId: run.runId, attempt: run.attempts, branch: run.headBranch, headSha: run.headSha, pullRequests: first.pullRequests, url: runUrl(repository, run.runId) },
      since: last.map((c) => since(c.job)).sort()[0]!, until: ended, impact: onDefault ? `CI red on ${run.headBranch}: deploy blocked` : `${first.pullRequests.length ? `PR ${prs(first.pullRequests)}` : `Branch ${run.headBranch ?? "unknown"}`} CI still red after rerun`, open: true });
  }
  return out;
}

/** Push only fresh, actionable incidents; the age guard stops the first backfill from flooding the phone. */
export function shouldPush(signal: Signal, defaultBranch: string | null, now: number): boolean {
  const severe = signal.severity === "critical" || (signal.severity === "warning" && defaultBranch !== null && signal.where.branch === defaultBranch);
  return severe && now - Date.parse(signal.since) <= 30 * 60_000;
}

const SEVERITY = { critical: 0, warning: 1, info: 2 };
/** Open signals first (critical > warning > info, newest first), then resolved ones newest first. */
export const sortSignals = (signals: Signal[]) => [...signals].sort((a, b) => Number(b.open) - Number(a.open) || SEVERITY[a.severity] - SEVERITY[b.severity] || Date.parse(b.since) - Date.parse(a.since));

/** Aggregates the Signals panel and agent views read; pure so it is cached with the analysis. */
export function summarizeAnalysis({ classified, reruns, losses, massCancels, repository }: {
  classified: ClassifiedJob[]; reruns: RerunSummary[]; massCancels: MassCancel[]; repository: string;
  losses: { byPool: Record<string, LossTally>; byJob: Record<string, LossTally>; byDay: Record<string, LossTally> };
}) {
  const failureCounts = Object.fromEntries(CLASSES.map((cls) => [cls, 0])) as Record<FailureClass, number>;
  for (const c of classified) failureCounts[c.class]++;
  const when = (c: ClassifiedJob) => Date.parse(c.job.completedAt ?? c.job.createdAt);
  const failures = classified.filter((c) => !HIDDEN_FAILURES.has(c.class)).sort((a, b) => when(b) - when(a)).slice(0, 50).map(({ job, class: cls, reason, evidence }) => ({
    class: cls, reason, evidence, runId: job.runId, attempt: job.attempt, jobId: job.jobId, jobName: job.jobName, workflowName: job.workflowName,
    branch: job.headBranch, headSha: job.headSha, pullRequests: job.pullRequests, pool: job.pool, runnerName: job.runnerName,
    startedAt: job.startedAt, completedAt: job.completedAt, url: jobUrl(repository, job),
  }));
  return {
    failureCounts, failures, runnerLosses: losses,
    massCancels: massCancels.map((m) => ({ since: m.since, until: m.until, runners: m.runners, runIds: m.runIds, jobs: m.jobs.length })),
    // Run ids grow with creation time, so they order reruns newest first without timestamps.
    reruns: [...reruns].sort((a, b) => b.runId - a.runId).slice(0, 20).map((r) => ({ ...r, url: runUrl(repository, r.runId) })),
  };
}
