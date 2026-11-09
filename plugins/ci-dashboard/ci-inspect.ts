import { z } from "zod";
import { alertStreak } from "./ci-insights";
import { queuePullRequest, type PoolTiming } from "./ci-classify";
import type { ClassifiedJob, JobRecord, Signal } from "./ci-jobs-types";
import { fitSections, problemContext, signalTitle, type ProblemContextInput, type ProblemLike } from "./ci-problems";
import { cap, jobRef, parseRef, poolRef, prRef, queueRef, runRef, shaRef } from "./ci-refs";
import type { Problem } from "./ci-signals-contract";

// Drill-down by ref for agents (ci_dashboard_metrics with `ref`). Built only from what the server already holds in memory and in the local store: no GitHub requests.
// Safety: ids, names, classes and labels only; never log text, annotations, classifier evidence, signature matches or env values.

export const inspectionSchema = z.object({
  ref: z.string(), kind: z.enum(["problem", "run", "job", "queue", "pool", "pr", "sha"]), summary: z.string(),
  facts: z.record(z.string(), z.unknown()), related: z.array(z.string()), next: z.array(z.string()).optional(),
});
export type Inspection = z.infer<typeof inspectionSchema>;

export type InspectInput = Omit<ProblemContextInput, "compact" | "refs" | "notes"> & {
  /** Open problems (handled state included) and open or recently resolved signals. */
  problems: Problem[]; signals: Signal[]; poolTimings: Record<string, PoolTiming>;
  /** Merge queue removal confirmation: "confirmed" once announced, "rejected" when the PR never left the queue, else "pending". */
  queueStatus: (key: string) => "confirmed" | "pending" | "rejected";
  /** Failed test names of an attempt that were already extracted (cache only; never fetches). */
  cachedTests: (run: { id: number; attempt: number }) => string[] | null;
};

const FIRST = Number.MAX_SAFE_INTEGER;
const LIST = 12, ROWS = 8;
const SECTION_BUDGET = 3000;
const timeOf = (job: JobRecord) => Date.parse(job.completedAt ?? job.startedAt ?? job.createdAt) || 0;
const sha7 = (sha: string) => sha.slice(0, 7);
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const isOwn = (c: ClassifiedJob) => !["collateral_cancel", "superseded", "manual_cancel"].includes(c.class);
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
const jobRow = ({ job, class: cls, flakeLabel }: ClassifiedJob) => ({ ref: jobRef(job.jobId), name: clip(job.jobName, 80), class: cls, ...(flakeLabel ? { label: clip(flakeLabel, 60) } : {}) });
const rows = <T>(list: T[], max = ROWS) => ({ rows: list.slice(0, max), ...(list.length > max ? { more: list.length - max } : {}) });
const counts = (classes: string[]) => Object.fromEntries([...new Set(classes)].map((cls) => [cls, classes.filter((item) => item === cls).length]));

type RunRow = { id: number; workflow: string; event: string; branch: string | null; sha: string; prs: number[]; conclusion: string | null; at: number; attempt: number };
/** Every run the dashboard knows: stored history first, then runs only known through stored or live jobs. */
function runTable(input: InspectInput) {
  const table = new Map<number, RunRow>();
  for (const run of input.runs ?? []) table.set(run.id, { id: run.id, workflow: run.name ?? "", event: run.event ?? "", branch: run.head_branch ?? null, sha: run.head_sha ?? "", prs: run.pull_requests ?? [], conclusion: run.conclusion, at: Date.parse(run.created_at), attempt: run.run_attempt ?? 1 });
  for (const job of [...input.classified.map((c) => c.job), ...(input.liveJobs ?? [])]) {
    const known = table.get(job.runId);
    if (known) known.attempt = Math.max(known.attempt, job.attempt);
    else table.set(job.runId, { id: job.runId, workflow: job.workflowName, event: job.event, branch: job.headBranch, sha: job.headSha, prs: job.pullRequests, conclusion: null, at: Date.parse(job.createdAt) || 0, attempt: job.attempt });
  }
  return table;
}
const runPr = (run: RunRow) => run.event === "merge_group" ? queuePullRequest(run.branch) : null;
const runLine = (run: RunRow, reruns: InspectInput["reruns"]) => ({ ref: runRef(run.id), workflow: clip(run.workflow, 60), event: run.event, conclusion: run.conclusion ?? reruns.find((item) => item.runId === run.id)?.finalConclusion ?? "unknown" });

const asProblem = (signal: Signal): ProblemLike => ({ id: signal.id, severity: signal.severity, title: signalTitle(signal), what: signal.what, impact: signal.impact, where: signal.where, since: signal.since });

/** Refs related to a problem (job, run, queue, pool, sha, PRs, the runs and jobs of a streak or mass cancel), newest first, capped with a "+N more" note. */
export function relatedRefs(problem: ProblemLike, input: Pick<InspectInput, "alerts" | "classified" | "runs" | "massCancels" | "pools">, max = LIST): string[] {
  const { where } = problem, out: { ref: string; at: number }[] = [], add = (ref: string, at = 0) => out.push({ ref, at });
  const alert = input.alerts.find((item) => `run:${item.kind}:${item.runId}` === problem.id), runId = where.runId ?? alert?.runId;
  if (where.jobId !== undefined) add(jobRef(where.jobId), FIRST);
  if (runId !== undefined) add(runRef(runId, where.attempt), FIRST - 1);
  const ofRun = runId === undefined ? [] : input.classified.filter((c) => c.job.runId === runId && (where.attempt === undefined || c.job.attempt === where.attempt));
  const mergeGroup = ofRun.find((c) => c.job.event === "merge_group");
  if (mergeGroup) add(queueRef(mergeGroup.job.runId, mergeGroup.job.attempt), FIRST - 2);
  if (where.pool) add(poolRef(where.pool), FIRST - 3);
  if (where.headSha) add(shaRef(where.headSha), FIRST - 4);
  for (const number of where.pullRequests ?? []) add(prRef(number), FIRST - 5);
  const attempt = where.attempt ?? Math.max(0, ...ofRun.map((c) => c.job.attempt));
  for (const c of ofRun) if (c.job.attempt === attempt) add(jobRef(c.job.jobId), timeOf(c.job));
  if (alert) for (const run of alertStreak(input.runs ?? [], alert)) add(runRef(run.id), Date.parse(run.created_at));
  const group = input.massCancels.find((item) => `mass_cancel:${item.since}` === problem.id);
  if (group) { for (const id of group.runIds) add(runRef(id), id); for (const c of group.jobs) add(jobRef(c.job.jobId), timeOf(c.job)); }
  if (problem.id.startsWith("pool_stall:") && where.pool) for (const id of input.pools.find((state) => state.pool === where.pool)?.queuedRunIds ?? []) add(runRef(id), id);
  return cap(out, max);
}

function inspectProblem(id: string, input: InspectInput): Inspection {
  const problem = input.problems.find((item) => item.id === id), signal = input.signals.find((item) => item.id === id);
  const like = problem ?? (signal ? asProblem(signal) : undefined);
  if (!like) throw new Error(`"${id.slice(0, 80)}" is not an open problem or a recent signal (it may have resolved). List them with ci_dashboard_metrics view=problems or view=signals.`);
  const refs = relatedRefs(like, input);
  const sections = fitSections(problemContext(like, { ...input, refs: undefined, compact: { maxLines: 5 } }), SECTION_BUDGET, 200);
  const handled = problem?.handled ?? null, open = problem !== undefined || signal?.open === true;
  return {
    ref: id, kind: "problem", summary: `${like.title} (${like.severity}${open ? "" : ", resolved"}${handled ? `, ${handled.state}` : ""})`,
    facts: { severity: like.severity, open, handled, since: like.since, ...(signal?.until ? { until: signal.until } : {}),
      sections: sections.kept.map(({ title, lines }, index) => ({ title, lines: [...lines, ...(sections.dropped[index] ? [`- … ${sections.dropped[index]} more line(s) omitted`] : [])] })) },
    related: refs, ...(problem && !handled ? { next: [`ci_dashboard_manage action=take id=${id}`] } : {}),
  };
}

function inspectRun(ref: string, runId: number, attempt: number | undefined, input: InspectInput): Inspection {
  const table = runTable(input), run = table.get(runId), rerun = input.reruns.find((item) => item.runId === runId);
  if (!run) throw new Error(`Run ${runId} is not known to CI Dashboard (no stored history, jobs or live data).`);
  const latest = Math.max(run.attempt, rerun?.attempts ?? 1), shown = attempt ?? latest;
  const failed = input.classified.filter((c) => c.job.runId === runId && c.job.attempt === shown).sort((a, b) => timeOf(b.job) - timeOf(a.job));
  const live = (input.liveJobs ?? []).filter((job) => job.runId === runId && job.status !== "completed");
  const conclusion = run.conclusion ?? rerun?.finalConclusion ?? (live.length ? "running" : "unknown"), pr = runPr(run);
  const jobs = rows(failed.map(jobRow), LIST);
  const related: { ref: string; at: number }[] = [{ ref: shaRef(run.sha), at: FIRST - 1 }];
  if (run.event === "merge_group" && failed.length) related.push({ ref: queueRef(runId, shown), at: FIRST });
  for (const problem of input.problems) if (problem.where.runId === runId || problem.id === `run:main:${runId}` || problem.id === `run:streak:${runId}`) related.push({ ref: problem.id, at: FIRST - 2 });
  for (const number of run.prs) related.push({ ref: prRef(number), at: FIRST - 3 });
  if (pr !== null) related.push({ ref: prRef(pr), at: FIRST - 3 });
  return {
    ref, kind: "run", summary: `${run.workflow || "run"} ${runId} attempt ${shown}${latest > shown ? ` of ${latest}` : ""} · ${run.event || "unknown event"}${run.branch ? ` on ${run.branch}` : ""} · ${conclusion} · ${failed.length} non-success job(s)`,
    facts: { workflow: run.workflow, event: run.event, branch: run.branch, sha: sha7(run.sha), pullRequests: run.prs, ...(pr === null ? {} : { queuePullRequest: pr }), attempt: shown, attempts: latest, conclusion,
      nonSuccessJobs: jobs.rows, ...(jobs.more ? { moreJobs: jobs.more } : {}), url: `https://github.com/${input.repository}/actions/runs/${runId}` },
    related: cap(related),
  };
}

function inspectJob(ref: string, jobId: number, input: InspectInput): Inspection {
  const found = input.classified.find((c) => c.job.jobId === jobId), job = found?.job ?? (input.liveJobs ?? []).find((item) => item.jobId === jobId);
  if (!job) throw new Error(`Job ${jobId} is not known to CI Dashboard (only failed jobs of the stored window and live jobs are kept).`);
  const pr = job.event === "merge_group" ? queuePullRequest(job.headBranch) : null, tests = input.cachedTests({ id: job.runId, attempt: job.attempt });
  const related: { ref: string; at: number }[] = [{ ref: runRef(job.runId, job.attempt), at: FIRST }, { ref: shaRef(job.headSha), at: FIRST - 2 }];
  if (job.event === "merge_group") related.push({ ref: queueRef(job.runId, job.attempt), at: FIRST - 1 });
  if (job.pool) related.push({ ref: poolRef(job.pool), at: FIRST - 3 });
  for (const number of job.pullRequests) related.push({ ref: prRef(number), at: FIRST - 4 });
  if (job.inheritedFrom) related.push({ ref: prRef(job.inheritedFrom.pullRequest), at: FIRST - 1 }, { ref: runRef(job.inheritedFrom.runId), at: FIRST - 1 });
  for (const problem of input.problems) if (problem.where.jobId === jobId) related.push({ ref: problem.id, at: FIRST - 1 });
  const duration = job.startedAt && job.completedAt ? Date.parse(job.completedAt) - Date.parse(job.startedAt) : null;
  return {
    ref, kind: "job", summary: `${job.jobName} · ${found ? `${found.class} (${found.reason})` : `${job.status}${job.conclusion ? ` / ${job.conclusion}` : ""}, not classified`} · run ${job.runId} attempt ${job.attempt}`,
    facts: { name: job.jobName, workflow: job.workflowName, event: job.event, branch: job.headBranch, sha: sha7(job.headSha), pullRequests: job.pullRequests, ...(pr === null ? {} : { queuePullRequest: pr }),
      status: job.status, conclusion: job.conclusion, ...(found ? { class: found.class, reason: found.reason } : {}), ...(found?.flakeLabel ? { label: clip(found.flakeLabel, 60) } : {}),
      ...(job.inheritedFrom ? { inheritedFrom: job.inheritedFrom } : {}),
      failedSteps: job.failedSteps.slice(0, 5).map((step) => clip(step, 80)), runner: job.runnerName, pool: job.pool, startedAt: job.startedAt, completedAt: job.completedAt, ...(duration === null ? {} : { duration: seconds(duration) }),
      ...(tests?.length ? { failedTests: tests.slice(0, 5).map((name) => clip(name.replace(/\s+/g, " "), 100)), ...(tests.length > 5 ? { moreTests: tests.length - 5 } : {}) } : {}),
      url: `https://github.com/${input.repository}/actions/runs/${job.runId}/job/${job.jobId}` },
    related: cap(related),
  };
}

function inspectQueue(ref: string, runId: number, attempt: number, input: InspectInput): Inspection {
  const jobs = input.classified.filter((c) => c.job.runId === runId && c.job.attempt === attempt && c.job.event === "merge_group").sort((a, b) => timeOf(b.job) - timeOf(a.job));
  if (!jobs.length) throw new Error(`No merge queue attempt ${runId}:${attempt} with stored failed jobs (queue refs come from observer lines and view=failures rows with event merge_group).`);
  const first = jobs[0]!.job, pr = queuePullRequest(first.headBranch), status = input.queueStatus(`queue:${runId}:${attempt}`);
  const classes = counts(jobs.map((c) => c.class)), own = jobs.some((c) => isOwn(c) && c.class !== "consequence"), list = rows(jobs.map(jobRow), LIST);
  const related: { ref: string; at: number }[] = [{ ref: runRef(runId, attempt), at: FIRST }, { ref: shaRef(first.headSha), at: FIRST - 2 }];
  if (pr !== null) related.push({ ref: prRef(pr), at: FIRST - 1 });
  // The origin of the failure, when the group ahead already failed it (the first inherited job names it; every distinct origin is related).
  const origins = jobs.flatMap((c) => c.job.inheritedFrom ? [c.job.inheritedFrom] : []);
  for (const origin of origins) related.push({ ref: prRef(origin.pullRequest), at: FIRST - 1 }, { ref: runRef(origin.runId), at: FIRST - 1 });
  for (const problem of input.problems) if (problem.where.runId === runId) related.push({ ref: problem.id, at: FIRST - 1 });
  return {
    ref, kind: "queue", summary: `${pr === null ? "Merge queue run" : `PR #${pr} merge queue run`} ${runId} attempt ${attempt} · removal ${status} · ${jobs.length} non-success job(s)`,
    facts: { pullRequest: pr, confirmation: status, ownFailure: own, ...(origins[0] ? { inheritedFrom: origins[0] } : {}), classes, jobs: list.rows, ...(list.more ? { moreJobs: list.more } : {}), url: `https://github.com/${input.repository}/actions/runs/${runId}` },
    related: cap(related),
  };
}

function inspectPool(ref: string, pool: string, input: InspectInput): Inspection {
  const state = input.pools.find((item) => item.pool === pool), timing = input.poolTimings[pool], losses = input.classified.filter((c) => c.class === "runner_loss" && c.job.pool === pool);
  const stall = [...input.problems, ...input.signals].find((item) => item.id === `pool_stall:${pool}`), stalled = stall !== undefined && ("open" in stall ? stall.open : true);
  if (!state && !timing && !losses.length && !stall) throw new Error(`Pool "${pool.slice(0, 60)}" is unknown. Known pools: ${[...new Set([...input.pools.map((item) => item.pool), ...Object.keys(input.poolTimings)])].slice(0, 10).join(", ") || "none"}.`);
  const related: { ref: string; at: number }[] = losses.map((c) => ({ ref: jobRef(c.job.jobId), at: timeOf(c.job) }));
  if (stalled) related.push({ ref: `pool_stall:${pool}`, at: FIRST });
  for (const id of state?.queuedRunIds ?? []) related.push({ ref: runRef(id), at: FIRST - 1 });
  return {
    ref, kind: "pool", summary: `Pool ${pool}: ${state ? `${state.queued} queued, ${state.inProgress} running` : "no live state"}${timing ? `, p90 wait ${minutes(timing.queueWaitMs.p90)}` : ""}${stalled ? ", STALLED" : ""}`,
    facts: { ...(state ? { queued: state.queued, inProgress: state.inProgress, oldestQueuedAt: state.oldestQueuedAt, lastStartedAt: state.lastStartedAt } : { live: "no live state in memory" }),
      ...(timing ? { jobs: timing.jobs, queueWait: { p50: seconds(timing.queueWaitMs.p50), p90: seconds(timing.queueWaitMs.p90) }, duration: { p50: seconds(timing.durationMs.p50), p90: seconds(timing.durationMs.p90) } } : {}),
      openStall: stalled, runnerLosses: losses.length, window: `${input.windowDays ?? 14} days of stored jobs` },
    related: cap(related),
  };
}

function inspectPr(ref: string, number: number, input: InspectInput): Inspection {
  const table = runTable(input), mine = [...table.values()].filter((run) => run.event === "merge_group" ? runPr(run) === number : run.prs.includes(number)).sort((a, b) => b.id - a.id);
  if (!mine.length) throw new Error(`No run of PR #${number} is stored (the stored history and job window do not mention it).`);
  const ids = new Set(mine.map((run) => run.id)), group = mine.filter((run) => run.event === "merge_group"), pulls = mine.filter((run) => run.event !== "merge_group");
  const related: { ref: string; at: number }[] = [];
  for (const problem of input.problems) if (problem.where.pullRequests?.includes(number) || (problem.where.runId !== undefined && ids.has(problem.where.runId))) related.push({ ref: problem.id, at: FIRST });
  for (const c of input.classified) if (ids.has(c.job.runId)) { related.push({ ref: jobRef(c.job.jobId), at: timeOf(c.job) }); if (c.job.event === "merge_group") related.push({ ref: queueRef(c.job.runId, c.job.attempt), at: timeOf(c.job) + 1 }); }
  const line = (run: RunRow) => runLine(run, input.reruns), pullRows = rows(pulls.map(line)), groupRows = rows(group.map(line));
  return {
    ref, kind: "pr", summary: `PR #${number}: ${pulls.length} pull_request run(s), ${group.length} merge_group run(s)`,
    facts: { pullRequestRuns: pullRows.rows, ...(pullRows.more ? { morePullRequestRuns: pullRows.more } : {}), mergeGroupRuns: groupRows.rows, ...(groupRows.more ? { moreMergeGroupRuns: groupRows.more } : {}) },
    related: cap(related),
  };
}

function inspectSha(ref: string, prefix: string, input: InspectInput): Inspection {
  const table = runTable(input), shas = [...new Set([...table.values()].map((run) => run.sha).filter((sha) => sha.toLowerCase().startsWith(prefix)))];
  if (!shas.length) throw new Error(`No stored run or job has a head commit starting with ${prefix}.`);
  if (shas.length > 1) throw new Error(`Ref sha:${prefix} is ambiguous: ${shas.slice(0, 5).map((sha) => sha.slice(0, 12)).join(", ")}${shas.length > 5 ? ", …" : ""}. Use a longer prefix.`);
  const sha = shas[0]!, runs = [...table.values()].filter((run) => run.sha === sha).sort((a, b) => b.id - a.id), jobs = input.classified.filter((c) => c.job.headSha === sha);
  const losses = jobs.filter((c) => c.class === "runner_loss").length, list = rows(runs.map((run) => runLine(run, input.reruns)));
  const related: { ref: string; at: number }[] = jobs.map((c) => ({ ref: jobRef(c.job.jobId), at: timeOf(c.job) }));
  for (const run of runs) { for (const number of run.prs) related.push({ ref: prRef(number), at: FIRST }); const pr = runPr(run); if (pr !== null) related.push({ ref: prRef(pr), at: FIRST }); }
  for (const problem of input.problems) if (problem.where.headSha === sha) related.push({ ref: problem.id, at: FIRST });
  return {
    ref, kind: "sha", summary: `Commit ${sha7(sha)}: ${runs.length} run(s), ${jobs.length} non-success job(s), ${losses} runner loss(es)`,
    facts: { sha: sha.slice(0, 12), runs: list.rows, ...(list.more ? { moreRuns: list.more } : {}), nonSuccessJobs: jobs.length, byClass: counts(jobs.map((c) => c.class)), runnerLosses: losses },
    related: cap(related),
  };
}

/** Resolves one ref from the data already in memory and the local store; unknown refs throw an error that lists the accepted forms. */
export function inspect(text: string, input: InspectInput): Inspection {
  const ref = parseRef(text), canonical = text.trim();
  switch (ref.kind) {
    case "problem": return inspectProblem(ref.id, input);
    case "run": return inspectRun(canonical, ref.runId, ref.attempt, input);
    case "job": return inspectJob(canonical, ref.jobId, input);
    case "queue": return inspectQueue(canonical, ref.runId, ref.attempt, input);
    case "pool": return inspectPool(canonical, ref.pool, input);
    case "pr": return inspectPr(canonical, ref.number, input);
    case "sha": return inspectSha(canonical, ref.sha, input);
  }
}
