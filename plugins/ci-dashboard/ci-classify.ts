import type { ClassifiedJob, FailureClass, JobRecord, RerunSummary } from "./ci-jobs-types";

const BAD = new Set(["failure", "cancelled", "timed_out", "startup_failure"]);
const TRANSIENT = [/http_50[234]/i, / 50[234] /, /Bad Gateway/i, /Gateway Time-?out/i, /Service Unavailable/i, /ECONNRESET/, /ETIMEDOUT/, /EAI_AGAIN/,
  /TLS handshake timeout/i, /i\/o timeout/i, /connection reset/i, /429 Too Many Requests/i];
const stripTimestamp = (line: string) => line.replace(/^\s*\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "").trim();
const ms = (job: JobRecord) => job.startedAt && job.completedAt ? Math.max(0, Date.parse(job.completedAt) - Date.parse(job.startedAt)) : 0;
const executed = (job: JobRecord) => !job.carried && job.conclusion !== "skipped";

export function classifyJobs(jobs: JobRecord[], opts: { aggregatorJobs?: string[]; policyJobs?: string[] } = {}): ClassifiedJob[] {
  // Indexed by sha+workflow+job: 14 days of jobs makes a linear scan per failure quadratic.
  const key = (job: JobRecord) => `${job.headSha}\0${job.workflowName}\0${job.jobName}`;
  const passed = new Map<string, JobRecord[]>();
  for (const job of jobs) if (job.conclusion === "success" && !job.carried) passed.set(key(job), [...(passed.get(key(job)) ?? []), job]);
  // An unknown sha must never pair unrelated jobs into a false flake.
  const passedLater = (job: JobRecord) => !!job.headSha && (passed.get(key(job)) ?? []).some((other) => other.runId > job.runId || (other.runId === job.runId && other.attempt > job.attempt));
  const verdict = (job: JobRecord): Omit<ClassifiedJob, "job"> => {
    const messages = job.annotations.filter((a) => a.level === "failure").map((a) => a.message);
    const find = (re: RegExp) => messages.find((m) => re.test(m)) ?? null;
    const make = (cls: FailureClass, reason: string, evidence: string | null = null) => ({ class: cls, reason, evidence });
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
      const line = job.logExcerpt?.split("\n").find((l) => TRANSIENT.some((re) => re.test(l)));
      if (line) return make("transient", "tool or network failure in log", stripTimestamp(line));
      return !(opts.policyJobs ?? []).includes(job.jobName) && passedLater(job) ? make("flake", "failed step passed later at the same sha") : make("real", "failed step did not pass later");
    }
    return make("unknown", "no recognizable cause");
  };
  return jobs.filter((job) => job.status === "completed" && !job.carried && BAD.has(job.conclusion ?? "")).map((job) => ({ job, ...verdict(job) }));
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
    return [{ runId: first.runId, workflowName: first.workflowName, headSha: first.headSha, headBranch: first.headBranch, attempts, outcomes,
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
  const hits = classified.filter((c) => ["runner_loss", "collateral_cancel", "timeout"].includes(c.class) && c.job.completedAt)
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
