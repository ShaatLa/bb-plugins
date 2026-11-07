import { annotationHit, buildFailureLine, type FlakeRule } from "./flake-signatures";
import type { ClassifiedJob, FailureClass, JobRecord, RerunSummary } from "./ci-jobs-types";

/** Conclusions of a job that did not succeed and was not skipped. */
export const BAD = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);
const TRANSIENT = [/http_50[234]/i, / 50[234] /, /Bad Gateway/i, /Gateway Time-?out/i, /Service Unavailable/i, /ECONNRESET/, /ETIMEDOUT/, /EAI_AGAIN/,
  /TLS handshake timeout/i, /i\/o timeout/i, /connection reset/i, /429 Too Many Requests/i];
const stripTimestamp = (line: string) => line.replace(/^\s*\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "").trim();
const ms = (job: JobRecord) => job.startedAt && job.completedAt ? Math.max(0, Date.parse(job.completedAt) - Date.parse(job.startedAt)) : 0;
/** PR number of a merge queue run: head branch gh-readonly-queue/<base>/pr-<N>-<sha>; <base> may contain slashes. */
export const queuePullRequest = (headBranch: string | null): number | null => {
  const found = headBranch?.match(/^gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/i);
  return found ? Number(found[1]) : null;
};
const executed = (job: JobRecord) => !job.carried && job.conclusion !== "skipped";

export type ClassifyOptions = { aggregatorJobs?: string[]; policyJobs?: string[]; refusalSteps?: string[]; flakeRules?: FlakeRule[]; flakeHash?: string };
export const SIGNATURE_REASON = "matches a known flaky signature";
export const BUILD_REASON = "build or setup failed";
export const PASS_REASON = "same job passed at the same sha";
export function classifyJobs(jobs: JobRecord[], opts: ClassifyOptions = {}): ClassifiedJob[] {
  // Same code, same job: a pass in any run or workflow at this sha means the failure was not deterministic.
  // Reusable workflows prefix callee jobs ("Caller / Job"), so the leaf name pairs a push run with its merge-queue run.
  // Indexed: 14 days of jobs makes a linear scan per failure quadratic.
  const key = (job: JobRecord) => `${job.headSha}\0${job.jobName.split(" / ").pop()}`;
  const passed = new Map<string, JobRecord>();
  for (const job of jobs) if (job.conclusion === "success" && !job.carried && !passed.has(key(job))) passed.set(key(job), job);
  // An unknown sha must never pair unrelated jobs into a false flake.
  const passedElsewhere = (job: JobRecord) => job.headSha ? passed.get(key(job)) ?? null : null;
  const verdict = (job: JobRecord): Omit<ClassifiedJob, "job"> => {
    const messages = job.annotations.filter((a) => a.level === "failure").map((a) => a.message);
    const find = (re: RegExp) => messages.find((m) => re.test(m)) ?? null;
    const make = (cls: FailureClass, reason: string, evidence: string | null = null): Omit<ClassifiedJob, "job"> => ({ class: cls, reason, evidence });
    if ((opts.aggregatorJobs ?? []).includes(job.jobName)) return make("consequence", "aggregator failed because another job did");
    let hit = find(/lost communication with the server|received a shutdown signal/i);
    if (hit) return make("runner_loss", "runner lost or shut down", hit);
    if (job.conclusion === "failure" && !job.failedSteps.length && !messages.length) return make("runner_loss", "no failed step");
    if ((hit = find(/exceeded the maximum execution time/i))) return make("timeout", "job exceeded maximum execution time", hit);
    if ((hit = find(/Canceling since a higher priority waiting request/i))) return make("superseded", "cancelled by concurrency group", hit);
    if ((hit = find(/was canceled by @/i))) return make("manual_cancel", "run cancelled by a user", hit);
    // Never-started jobs (no annotations at all) are cancelled by the run, same as a fail-fast sibling.
    if (job.conclusion === "cancelled") return make("collateral_cancel", "cancelled without own failure", messages[0] ?? null);
    if (job.failedSteps.length) {
      const refusal = job.failedSteps.find((step) => (opts.refusalSteps ?? []).includes(step));
      if (refusal) return make("refused", "intentional refusal by a gate step", refusal);
      const line = job.logExcerpt?.split("\n").find((l) => TRANSIENT.some((re) => re.test(l)));
      if (line) return make("transient", "tool or network failure in log", stripTimestamp(line));
      // Nothing ran: no signature label and no pass at the same sha makes this a flake.
      const build = job.buildFailure?.match ?? buildFailureLine(job.annotations.filter((a) => a.level === "failure").map((a) => `${a.title}\n${a.message}`).join("\n"));
      if (build) return make("real", BUILD_REASON, build);
      const policy = (opts.policyJobs ?? []).includes(job.jobName);
      // Annotations need no network; a stored scan counts only for the rules version it was made with.
      const stored = job.signature && opts.flakeHash && job.signature.rules === opts.flakeHash && job.signature.label ? { label: job.signature.label, match: job.signature.match ?? "" } : null;
      const known = policy ? null : annotationHit(opts.flakeRules ?? [], job.annotations) ?? stored;
      if (known) return { ...make("flake", SIGNATURE_REASON, `${known.label}: ${known.match}`), flakeLabel: known.label };
      const pass = policy ? null : passedElsewhere(job);
      return pass ? make("flake", PASS_REASON, `${pass.workflowName} run ${pass.runId}`) : make("real", "same job never passed at this sha");
    }
    return make("unknown", "no recognizable cause");
  };
  return jobs.filter((job) => job.status === "completed" && !job.carried && BAD.has(job.conclusion ?? "")).map((job) => ({ job, ...verdict(job) }));
}

const QUEUE_ONLY_CLASSES = new Set<FailureClass>(["real", "flake", "transient", "timeout", "unknown"]);
/** Job ids of merge_group failures whose newest completed pull_request job (same PR, workflow, job name) succeeded: passes on the PR, fails in the queue. */
export function queueOnlyJobs(jobs: JobRecord[], classified: ClassifiedJob[]): Set<number> {
  const key = (pr: number, job: JobRecord) => `${pr}\0${job.workflowName}\0${job.jobName}`;
  const newest = new Map<string, JobRecord>();
  for (const job of jobs) {
    if (job.event !== "pull_request" || job.status !== "completed" || job.carried || job.conclusion === "skipped") continue;
    for (const pr of job.pullRequests) {
      const known = newest.get(key(pr, job));
      if (!known || job.runId > known.runId || (job.runId === known.runId && job.attempt > known.attempt)) newest.set(key(pr, job), job);
    }
  }
  const out = new Set<number>();
  for (const { job, class: cls } of classified) {
    const pr = job.event === "merge_group" ? queuePullRequest(job.headBranch) : null;
    if (pr !== null && QUEUE_ONLY_CLASSES.has(cls) && newest.get(key(pr, job))?.conclusion === "success") out.add(job.jobId);
  }
  return out;
}

export type TimingSample = { event: string; pool: string; completedAt: string; queueWaitMs: number; durationMs: number };
const stat = (values: number[]) => ({ p50: percentile(values, 50), p90: percentile(values, 90) });
/** Nearest-rank percentile of an ascending-sorted list (empty list: 0). */
export const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]! : 0;
export function timingSamples(jobs: JobRecord[]): TimingSample[] {
  const out: TimingSample[] = [];
  for (const job of jobs) {
    if (job.status !== "completed" || !executed(job) || !job.startedAt || !job.completedAt) continue;
    const created = Date.parse(job.createdAt), started = Date.parse(job.startedAt), completed = Date.parse(job.completedAt);
    if (Number.isNaN(created) || Number.isNaN(started) || Number.isNaN(completed)) continue;
    out.push({ event: job.event, pool: job.pool ?? "unknown", completedAt: job.completedAt, queueWaitMs: Math.max(0, started - created), durationMs: Math.max(0, completed - started) });
  }
  return out;
}
export type PoolTiming = { jobs: number; queueWaitMs: { p50: number; p90: number }; durationMs: { p50: number; p90: number } };
export function summarizeTimings(samples: TimingSample[]): { poolTimings: Record<string, PoolTiming>; poolTimingsByEvent: Record<string, Record<string, PoolTiming>> } {
  const groups = (pick: (s: TimingSample) => string, list: TimingSample[]) => {
    const by = new Map<string, TimingSample[]>();
    for (const s of list) { const g = by.get(pick(s)); if (g) g.push(s); else by.set(pick(s), [s]); }
    return Object.fromEntries([...by].map(([name, group]) => [name, { jobs: group.length,
      queueWaitMs: stat(group.map((s) => s.queueWaitMs).sort((a, b) => a - b)), durationMs: stat(group.map((s) => s.durationMs).sort((a, b) => a - b)) }])) as Record<string, PoolTiming>;
  };
  const byEvent = new Map<string, TimingSample[]>();
  for (const s of samples) { const g = byEvent.get(s.event); if (g) g.push(s); else byEvent.set(s.event, [s]); }
  return { poolTimings: groups((s) => s.pool, samples), poolTimingsByEvent: Object.fromEntries([...byEvent].map(([event, list]) => [event, groups((s) => s.pool, list)])) };
}

const RANK: Record<string, number> = { success: 0, cancelled: 1, timed_out: 2, startup_failure: 3, failure: 3 };
export function summarizeReruns(jobs: JobRecord[]): RerunSummary[] {
  const runs = new Map<string, JobRecord[]>();
  for (const job of jobs) runs.set(`${job.repository}#${job.runId}`, [...(runs.get(`${job.repository}#${job.runId}`) ?? []), job]);
  return [...runs.values()].flatMap((list) => {
    const attempts = Math.max(...list.map((job) => job.attempt));
    if (attempts < 2) return [];
    const outcomes = Array.from({ length: attempts }, (_, i) => {
      const own = list.filter((job) => job.attempt === i + 1 && executed(job));
      if (!own.length || own.some((job) => job.status !== "completed")) return null;
      return own.reduce<string>((worst, job) => (RANK[job.conclusion ?? ""] ?? 0) > (RANK[worst] ?? 0) ? job.conclusion! : worst, "success");
    });
    const first = list[0]!;
    return [{ runId: first.runId, event: first.event, workflowName: first.workflowName, headSha: first.headSha, headBranch: first.headBranch, attempts, outcomes,
      finalConclusion: outcomes[attempts - 1] ?? null,
      repeatedRunnerMs: list.filter((job) => job.attempt >= 2 && executed(job)).reduce((sum, job) => sum + ms(job), 0) }];
  });
}

export type LossTally = { count: number; runnerMs: number };
export function runnerLosses(classified: ClassifiedJob[]): { byPool: Record<string, LossTally>; byJob: Record<string, LossTally>; byDay: Record<string, LossTally> } {
  const out = { byPool: {} as Record<string, LossTally>, byJob: {} as Record<string, LossTally>, byDay: {} as Record<string, LossTally> };
  const add = (table: Record<string, LossTally>, key: string, runnerMs: number) => {
    const entry = (table[key] ??= { count: 0, runnerMs: 0 });
    entry.count++; entry.runnerMs += runnerMs;
  };
  for (const { job, class: cls } of classified) {
    if (cls !== "runner_loss") continue;
    const lost = ms(job);
    add(out.byPool, job.pool ?? "unknown", lost); add(out.byJob, job.jobName, lost);
    if (job.completedAt) add(out.byDay, new Date(job.completedAt).toISOString().slice(0, 10), lost);
  }
  return out;
}

export type MassCancel = { since: string; until: string; runners: string[]; runIds: number[]; jobs: ClassifiedJob[] };
export function detectMassCancel(classified: ClassifiedJob[], { windowMs = 120_000, minRunners = 3 } = {}): MassCancel[] {
  // A merge queue rebuild cancels every in-flight job of the groups behind a change: that is queue invalidation, not lost runners.
  const hits = classified.filter((c) => ["runner_loss", "collateral_cancel", "timeout"].includes(c.class) && c.job.completedAt
    && !(c.class === "collateral_cancel" && c.job.event === "merge_group"))
    .sort((a, b) => Date.parse(a.job.completedAt!) - Date.parse(b.job.completedAt!));
  const found: MassCancel[] = [];
  for (let i = 0; i < hits.length;) {
    const start = Date.parse(hits[i]!.job.completedAt!);
    let end = i;
    while (end + 1 < hits.length && Date.parse(hits[end + 1]!.job.completedAt!) - start <= windowMs) end++;
    const jobs = hits.slice(i, end + 1);
    const runners = [...new Set(jobs.map((c) => c.job.runnerName).filter((r): r is string => !!r))];
    if (runners.length >= minRunners) {
      found.push({ since: jobs[0]!.job.completedAt!, until: jobs.at(-1)!.job.completedAt!, runners, runIds: [...new Set(jobs.map((c) => c.job.runId))], jobs });
      i = end + 1;
    } else i++;
  }
  return found;
}
