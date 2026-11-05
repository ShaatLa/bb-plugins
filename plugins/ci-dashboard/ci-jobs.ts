import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GitHubRequest } from "./metrics";
import type { JobRecord } from "./ci-jobs-types";

const level = z.enum(["failure", "warning", "notice"]);
const annotation = z.object({ level, title: z.string(), message: z.string() });
// GitHub's check-run annotations use annotation_level and may send a null title.
const apiAnnotation = z.object({ annotation_level: level, title: z.string().nullable().optional(), message: z.string().nullable().optional() })
  .transform((a) => ({ level: a.annotation_level, title: a.title ?? "", message: a.message ?? "" }));
const job = z.object({ id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable(), created_at: z.string(), started_at: z.string().nullable(), completed_at: z.string().nullable(), labels: z.array(z.string()), runner_name: z.string().nullable(), runner_group_name: z.string().nullable(), steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable(), started_at: z.string().nullable().optional(), completed_at: z.string().nullable().optional() })), annotations: z.array(annotation).optional(), logExcerpt: z.string().nullable().optional(), head_sha: z.string().optional(), workflow_name: z.string().optional() });
type Context = { repository: string; runId: number; attempt: number; workflowName: string; event: string; headBranch: string | null; headSha: string; pullRequests: number[] };
export function normalizeJob(raw: unknown, ctx: Context): JobRecord {
  const j = job.parse(raw);
  return { ...ctx, jobId: j.id, workflowName: j.workflow_name ?? ctx.workflowName, headSha: j.head_sha ?? ctx.headSha, jobName: j.name, status: j.status, conclusion: j.conclusion, labels: j.labels, pool: j.labels[0] ?? null, runnerName: j.runner_name, runnerGroup: j.runner_group_name, createdAt: j.created_at, startedAt: j.started_at, completedAt: j.completed_at, failedSteps: j.steps.filter(s => s.conclusion === "failure").map(s => s.name), annotations: j.annotations ?? [], logExcerpt: null, carried: false };
}
export function markCarried(attempts: JobRecord[][]): void {
  for (let i = 1; i < attempts.length; i++) for (const j of attempts[i]) j.carried = attempts[i - 1].some(p => p.jobName === j.jobName && p.startedAt === j.startedAt && p.completedAt === j.completedAt);
}
export const jobMigrations = [
  "CREATE TABLE IF NOT EXISTS ci_jobs (repository TEXT NOT NULL, run_id INTEGER NOT NULL, attempt INTEGER NOT NULL, job_id INTEGER NOT NULL, created_at TEXT NOT NULL, pool TEXT, conclusion TEXT, head_sha TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (repository, run_id, attempt, job_id))",
  "CREATE INDEX IF NOT EXISTS ci_jobs_query ON ci_jobs (repository, created_at, pool, conclusion, head_sha)",
  "CREATE TABLE IF NOT EXISTS ci_attempts (repository TEXT NOT NULL, run_id INTEGER NOT NULL, attempt INTEGER NOT NULL, completed INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (repository, run_id, attempt))",
  // The run's age, so an attempt row is pruned together with its jobs (fetched_at only says when we looked).
  "ALTER TABLE ci_attempts ADD COLUMN created_at TEXT",
];
type Columns = { repository: string; run_id: number; attempt: number; job_id: number; created_at: string; pool: string | null; conclusion: string | null; head_sha: string; data: string };
// Fields already held by columns are not repeated in `data`, and default values are omitted; `toRecord` restores both.
// Rows written before this format hold a complete JobRecord (they have `jobId`) and are returned as they are.
function slim(j: JobRecord): string {
  const { repository, runId, attempt, jobId, createdAt, pool, conclusion, headSha, labels, ...rest } = j;
  const out: Record<string, unknown> = rest;
  if (labels.length !== (pool === null ? 0 : 1) || labels[0] !== (pool ?? undefined)) out.labels = labels;
  if (out.status === "completed") delete out.status;
  for (const key of ["workflowName", "headBranch", "runnerName", "runnerGroup", "startedAt", "completedAt", "logExcerpt"]) if (!out[key]) delete out[key];
  for (const key of ["pullRequests", "failedSteps", "annotations"]) if (!(out[key] as unknown[]).length) delete out[key];
  if (!out.carried) delete out.carried;
  return JSON.stringify(out);
}
function toRecord(r: Columns): JobRecord {
  const stored = JSON.parse(r.data);
  if (stored.jobId !== undefined) return stored;
  return { repository: r.repository, runId: r.run_id, attempt: r.attempt, jobId: r.job_id, createdAt: r.created_at, pool: r.pool, conclusion: r.conclusion, headSha: r.head_sha,
    workflowName: "", headBranch: null, pullRequests: [], status: "completed", labels: r.pool === null ? [] : [r.pool], runnerName: null, runnerGroup: null, startedAt: null, completedAt: null,
    failedSteps: [], annotations: [], logExcerpt: null, carried: false, ...stored };
}
const columns = "repository, run_id, attempt, job_id, created_at, pool, conclusion, head_sha, data";
export function createJobStore(database: ReturnType<BbPluginApi["storage"]["database"]>) {
  // Skipped jobs are no longer stored (nothing reads them); drop the ones earlier versions kept.
  database.prepare("DELETE FROM ci_jobs WHERE conclusion = 'skipped'").run();
  return {
    saveAttempt(repository: string, runId: number, attempt: number, jobs: JobRecord[], completed: boolean) {
      const previous = (database.prepare(`SELECT ${columns} FROM ci_jobs WHERE repository = ? AND run_id = ? AND attempt = ?`).all(repository, runId, attempt - 1) as Columns[]).map(toRecord);
      markCarried([previous, jobs]);
      const createdAt = jobs.reduce((min, j) => j.createdAt < min ? j.createdAt : min, new Date().toISOString());
      database.prepare("BEGIN").run();
      try {
        database.prepare("DELETE FROM ci_jobs WHERE repository = ? AND run_id = ? AND attempt = ?").run(repository, runId, attempt);
        for (const j of jobs) if (j.conclusion !== "skipped") database.prepare("INSERT INTO ci_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(repository, runId, attempt, j.jobId, j.createdAt, j.pool, j.conclusion, j.headSha, slim(j));
        database.prepare("INSERT OR REPLACE INTO ci_attempts (repository, run_id, attempt, completed, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(repository, runId, attempt, completed ? 1 : 0, Date.now(), createdAt);
        database.prepare("COMMIT").run();
      } catch (error) { database.prepare("ROLLBACK").run(); throw error; }
    },
    hasCompletedAttempt(repository: string, runId: number, attempt: number) { return !!database.prepare("SELECT 1 FROM ci_attempts WHERE repository = ? AND run_id = ? AND attempt = ? AND completed = 1").get(repository, runId, attempt); },
    listJobs({ repository, since, until }: { repository: string; since: string; until: string }): JobRecord[] { return (database.prepare(`SELECT ${columns} FROM ci_jobs WHERE repository = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at`).all(repository, since, until) as Columns[]).map(toRecord); },
    // Attempts follow their jobs by the run's age; rows from before created_at existed fall back to fetched_at.
    prune(olderThanIso: string) { database.prepare("DELETE FROM ci_attempts WHERE coalesce(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at / 1000, 'unixepoch')) < ?").run(olderThanIso); database.prepare("DELETE FROM ci_jobs WHERE created_at < ?").run(olderThanIso); },
    /** Repositories that are no longer configured lose their job rows at once. */
    pruneRepositories(active: string[]) {
      const keep = JSON.stringify(active.map(name => name.toLowerCase()));
      const where = "WHERE lower(repository) NOT IN (SELECT value FROM json_each(?))";
      return database.prepare(`DELETE FROM ci_jobs ${where}`).run(keep).changes + database.prepare(`DELETE FROM ci_attempts ${where}`).run(keep).changes;
    },
    /** Hard ceiling for job payload: whole oldest days go first. Attempt rows stay (tiny, pruned by age) so a dropped run is not refetched in a loop. */
    capBytes(maxBytes: number) {
      const days = database.prepare("SELECT substr(created_at, 1, 10) AS day, sum(length(data)) AS bytes FROM ci_jobs GROUP BY day ORDER BY day").all() as { day: string; bytes: number }[];
      let total = days.reduce((sum, d) => sum + d.bytes, 0), removedDays = 0;
      for (const d of days) {
        if (total <= maxBytes) break;
        database.prepare("DELETE FROM ci_jobs WHERE created_at >= ? AND created_at < ?").run(d.day, d.day + "\uffff");
        total -= d.bytes; removedDays++;
      }
      return { removedDays, bytes: total };
    },
    bytes() { return (database.prepare("SELECT coalesce(sum(length(data)), 0) AS bytes FROM ci_jobs").get() as { bytes: number }).bytes; },
  };
}
type Run = Omit<Context, "repository" | "runId"> & { id: number };
type FetchText = (path: string) => Promise<string>;
export async function fetchAttemptJobs(request: GitHubRequest, repository: string, run: Run, fetchText?: FetchText): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  for (let page = 1;; page++) {
    const response = await request(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`);
    const rows = z.object({ jobs: z.array(z.unknown()) }).parse(response.body).jobs;
    for (const raw of rows) {
      const j = normalizeJob(raw, { ...run, repository, runId: run.id });
      if (j.conclusion === "failure" || j.conclusion === "cancelled") {
        const response = await request(`/repos/${repository}/check-runs/${j.jobId}/annotations?per_page=50`);
        j.annotations = z.array(apiAnnotation).parse(response.body).filter(a => a.level !== "notice");
      }
      if (fetchText && j.conclusion === "failure" && j.failedSteps.length && !j.annotations.some(a => a.level === "failure" && /lost communication|shutdown signal|maximum execution time/i.test(`${a.title} ${a.message}`))) {
        try { const lines = (await fetchText(`/repos/${repository}/actions/jobs/${j.jobId}/logs`)).split(/\r?\n/); const index = lines.findIndex(line => line.includes("##[error]")); if (index >= 0) j.logExcerpt = lines.slice(Math.max(0, index - 29), index + 1).join("\n"); } catch { /* Logs are optional. */ }
      }
      jobs.push(j);
    }
    if (!response.hasNext) break;
    if (!rows.length) throw new Error("Incomplete job pagination");
  }
  return jobs;
}
export function createLogFetcher(token: string, signal: AbortSignal): FetchText {
  return async path => {
    const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) throw new Error(`Log fetch ${response.status}`);
    if (!response.body) return "";
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, pending = "", lines: string[] = [], found = false;
    const consume = (line: string) => { lines.push(line.replace(/\r$/, "")); if (lines.length > 30) lines.shift(); return line.includes("##[error]"); };
    try {
      while (size < 2_000_000 && !found) {
        const { done, value } = await reader.read();
        if (done) { pending += decoder.decode(); break; }
        const chunk = value.subarray(0, 2_000_000 - size); size += chunk.length;
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (consume(line)) { found = true; break; }
        }
      }
      if (!found && pending) consume(pending);
    } finally { await reader.cancel(); }
    return lines.join("\n");
  };
}
type Summary = { id: number; run_attempt: number; status: string; conclusion: string | null; name: string | null; event: string; head_branch: string | null; head_sha: string; pull_requests: (number | { number: number })[]; created_at: string };
// maxPerStep bounds one step so the caller's loop (live stall detection) never waits on a full hourly burst.
export function createBackfill({ store, request, fetchText, budgetPerHour = 1500, now = Date.now, maxPerStep = Math.ceil(budgetPerHour / 60) }: { store: ReturnType<typeof createJobStore>; request: GitHubRequest; fetchText?: FetchText; budgetPerHour?: number; now?: () => number; maxPerStep?: number }) {
  const queue: { repository: string; run: Run }[] = [], queued = new Set<string>(), failed = new Map<string, string>(), retries = new Map<string, { count: number; at: number }>(); let tokens = budgetPerHour, last = now(), pausedUntil: number | null = null;
  const keyOf = (repository: string, id: number, attempt: number) => `${repository}#${id}#${attempt}`;
  return {
    enqueue(repository: string, runs: Summary[]) {
      for (const r of [...runs].filter(r => r.status === "completed").sort((a, b) => b.created_at.localeCompare(a.created_at))) for (let attempt = 1; attempt <= r.run_attempt; attempt++) {
        const key = keyOf(repository, r.id, attempt);
        if (!queued.has(key) && !failed.has(key) && !store.hasCompletedAttempt(repository, r.id, attempt)) queued.add(key), queue.push({ repository, run: { id: r.id, attempt, workflowName: r.name ?? "", event: r.event, headBranch: r.head_branch, headSha: r.head_sha, pullRequests: r.pull_requests.map(p => typeof p === "number" ? p : p.number) } });
      }
    },
    async step(signal: AbortSignal) {
      let processed = 0; const current = now(); tokens = Math.min(budgetPerHour, tokens + Math.max(0, current - last) * budgetPerHour / 3_600_000); last = current;
      if (pausedUntil !== null && current >= pausedUntil) pausedUntil = null;
      let exhausted = false; let logRateError: unknown;
      let spent = 0;
      const charge = () => { if (signal.aborted) throw signal.reason; if (tokens < 1 || spent >= maxPerStep) { exhausted = true; throw new Error("Budget exhausted"); } tokens--; spent++; };
      let examined = queue.length;
      while (examined-- > 0 && queue.length && !pausedUntil && !signal.aborted && tokens >= 1 && spent < maxPerStep) {
        const item = queue[0];
        const key = keyOf(item.repository, item.run.id, item.run.attempt);
        const done = () => { queue.shift(); queued.delete(key); retries.delete(key); };
        if ((retries.get(key)?.at ?? 0) > current) { queue.push(queue.shift()!); continue; }
        if (store.hasCompletedAttempt(item.repository, item.run.id, item.run.attempt)) { done(); continue; }
        try {
          const jobs = await fetchAttemptJobs(async (path, init) => { charge(); return request(path, init); }, item.repository, item.run, fetchText ? async path => { charge(); try { return await fetchText(path); } catch (error) { if (/403|429/.test(String(error))) logRateError = error; throw error; } } : undefined);
          if (logRateError) throw logRateError;
          if (exhausted || signal.aborted) break;
          store.saveAttempt(item.repository, item.run.id, item.run.attempt, jobs, true); done(); processed++;
        } catch (error) { if (exhausted || signal.aborted) break; if (/403|429/.test(String(error))) { pausedUntil = now() + 900_000; break; }
          const count = (retries.get(key)?.count ?? 0) + 1;
          if (/\b404\b/.test(String(error)) || count >= 3) { failed.set(key, String(error instanceof Error ? error.message : error)); done(); }
          else { retries.set(key, { count, at: now() + (count === 1 ? 1_800_000 : 7_200_000) }); queue.push(queue.shift()!); } }
      }
      return { processed, remaining: queue.length, pausedUntil, failed: failed.size };
    },
  };
}
