import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GitHubRequest } from "./metrics";
import type { ClassifiedJob, JobRecord, JobSignature } from "./ci-jobs-types";
import { BAD, classifyJobs, PASS_REASON, type ClassifyOptions } from "./ci-classify";
import { annotationHit, buildFailureLine, matchLine, MAX_ARTIFACT_BYTES, type FlakeRule, type SignatureHit } from "./flake-signatures";
import { failedTestNames, scanZip, zipTextEntries, type ZipEvidence } from "./flake-artifacts";

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
  for (const key of ["workflowName", "headBranch", "runnerName", "runnerGroup", "startedAt", "completedAt", "logExcerpt", "buildFailure"]) if (!out[key]) delete out[key];
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
    /** Rewrites one stored job (e.g. after a signature re-scan); the indexed columns never change. */
    saveJob(j: JobRecord) { database.prepare("UPDATE ci_jobs SET data = ? WHERE repository = ? AND run_id = ? AND attempt = ? AND job_id = ?").run(slim(j), j.repository, j.runId, j.attempt, j.jobId); },
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
/** Collects while a log streams past: the first rule hit and the first build or setup failure line. */
export type LogScan = { rules: FlakeRule[]; hit: SignatureHit | null; build?: string | null };
type FetchText = (path: string, scan?: LogScan) => Promise<string>;
type FetchBinary = (path: string, maxBytes: number) => Promise<Buffer>;
/** Known-flake scan settings for one repository (the backfill serves one repository per instance). */
export type FlakeConfig = { repository: string; rules: FlakeRule[]; hash: string; artifacts: RegExp[]; classify: Omit<ClassifyOptions, "flakeRules" | "flakeHash">; /** Start of the job-history window re-scanned after a rules change. */ since: string };
type FlakeScan = { config: FlakeConfig; fetchArtifact?: FetchBinary; /** Artifact scan result per run attempt and rules version: an archive is downloaded once. */ cache: Map<string, ZipEvidence> };
const sign = (hash: string, hit: SignatureHit | null, source: JobSignature["source"]): JobSignature => ({ rules: hash, label: hit?.label ?? null, match: hit?.match ?? null, source: hit ? source : null });
const rateLimited = (error: unknown) => /403|429/.test(String(error));
const artifactListing = z.object({ artifacts: z.array(z.object({ id: z.number(), name: z.string(), size_in_bytes: z.number(), expired: z.boolean().optional(), created_at: z.string().nullable().optional() })) });
/**
 * Artifacts of the run whose names match the globs and that were created while this attempt's own jobs ran.
 * Artifacts are run-level and the API names no attempt, so the job window is the only link. Errors propagate.
 */
async function attemptArtifacts(request: GitHubRequest, repository: string, run: { id: number; attempt: number }, attemptJobs: JobRecord[], globs: RegExp[]): Promise<{ id: number }[]> {
  const own = attemptJobs.filter(j => !j.carried);
  const from = Math.min(...own.map(j => Date.parse(j.createdAt))), to = Math.max(...own.map(j => Date.parse(j.completedAt ?? j.createdAt))) + 300_000;
  const { artifacts } = artifactListing.parse((await request(`/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`)).body);
  return artifacts.filter(a => {
    if (a.expired || a.size_in_bytes > MAX_ARTIFACT_BYTES || !globs.some(re => re.test(a.name))) return false;
    const created = a.created_at ? Date.parse(a.created_at) : NaN;
    return !(created < from || created > to);
  });
}
/**
 * Scans the run's artifacts. `report` is true when any is a recognized test report: then `hit` and `build` come from the failed tests of the reports only.
 * Errors propagate and leave the cache untouched; null without globs or a downloader.
 */
async function artifactEvidence(request: GitHubRequest, repository: string, run: { id: number; attempt: number }, attemptJobs: JobRecord[], { config, fetchArtifact, cache }: FlakeScan): Promise<ZipEvidence | null> {
  if (!config.artifacts.length || !fetchArtifact) return null;
  const key = `${repository}#${run.id}#${run.attempt}#${config.hash}`;
  if (cache.has(key)) return cache.get(key)!;
  let report = false, reportHit: SignatureHit | null = null, textHit: SignatureHit | null = null, build: string | null = null;
  for (const a of await attemptArtifacts(request, repository, run, attemptJobs, config.artifacts)) {
    const found = scanZip(await fetchArtifact(`/repos/${repository}/actions/artifacts/${a.id}/zip`, MAX_ARTIFACT_BYTES), config.rules);
    if (found.report) { report = true; reportHit ??= found.hit; build ??= found.build; } else textHit ??= found.hit;
  }
  const evidence: ZipEvidence = { report, hit: report ? reportHit : textHit, build };
  if (cache.size >= 500) cache.clear();
  cache.set(key, evidence);
  return evidence;
}
/** Failed jobs the scan decides: real, or a flake only by a same-sha pass. Signatures and annotations already decided the rest. */
const candidates = (classified: ClassifiedJob[]) => classified.filter(c => c.class === "real" || (c.class === "flake" && c.reason === PASS_REASON)).map(c => c.job);
/**
 * What one failed job's scan found. Recognized test reports of the attempt win over log lines: with one, only its failed tests count
 * (and only for the lone candidate, since artifacts are run-level); otherwise the log, then any plain artifact text. Null: no evidence (unreadable log), retry later.
 */
function scanResult(hash: string, lone: boolean, artifacts: ZipEvidence | null, log: LogScan | null): Pick<JobRecord, "signature" | "buildFailure"> | null {
  const own = lone ? artifacts : null;
  if (artifacts?.report) return { signature: sign(hash, own?.hit ?? null, "artifact"), buildFailure: own?.build ? { match: own.build } : null };
  if (!log) return null;
  return { signature: sign(hash, log.hit ?? own?.hit ?? null, log.hit ? "log" : "artifact"), buildFailure: log.build ? { match: log.build } : null };
}
export async function fetchAttemptJobs(request: GitHubRequest, repository: string, run: Run, fetchText?: FetchText, flake?: FlakeScan): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [], logs = new Map<JobRecord, LogScan>();
  for (let page = 1;; page++) {
    const response = await request(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100&page=${page}`);
    const rows = z.object({ jobs: z.array(z.unknown()) }).parse(response.body).jobs;
    for (const raw of rows) {
      const j = normalizeJob(raw, { ...run, repository, runId: run.id });
      if (j.conclusion === "failure" || j.conclusion === "cancelled") {
        const response = await request(`/repos/${repository}/check-runs/${j.jobId}/annotations?per_page=50`);
        j.annotations = z.array(apiAnnotation).parse(response.body).filter(a => a.level !== "notice");
      }
      if (flake && j.conclusion === "failure" && j.failedSteps.length) { const hit = annotationHit(flake.config.rules, j.annotations); if (hit) j.signature = sign(flake.config.hash, hit, "annotation"); }
      if (fetchText && j.conclusion === "failure" && j.failedSteps.length && !j.annotations.some(a => a.level === "failure" && /lost communication|shutdown signal|maximum execution time/i.test(`${a.title} ${a.message}`))) {
        // The rest of the log is only streamed for rules when annotations did not already decide.
        const scan: LogScan | undefined = flake && !j.signature ? { rules: flake.config.rules, hit: null, build: null } : undefined;
        try {
          const lines = (await fetchText(`/repos/${repository}/actions/jobs/${j.jobId}/logs`, scan)).split(/\r?\n/); const index = lines.findIndex(line => line.includes("##[error]")); if (index >= 0) j.logExcerpt = lines.slice(Math.max(0, index - 29), index + 1).join("\n");
          // Held back: a recognized test report of the attempt overrides what the log says.
          if (scan) logs.set(j, scan);
        } catch { /* Logs are optional. */ }
      }
      jobs.push(j);
    }
    if (!response.hasNext) break;
    if (!rows.length) throw new Error("Incomplete job pagination");
  }
  if (flake) {
    const { config } = flake;
    const decide = candidates(classifyJobs(jobs, { ...config.classify, flakeRules: config.rules, flakeHash: config.hash }));
    let artifacts: ZipEvidence | null = null;
    if (decide.length) try { artifacts = await artifactEvidence(request, repository, run, jobs, flake); } catch (error) { if (rateLimited(error)) throw error; }
    for (const j of decide) { const found = scanResult(config.hash, decide.length === 1, artifacts, logs.get(j) ?? null); if (found) Object.assign(j, found); }
  }
  return jobs;
}
export function createLogFetcher(token: string, signal: AbortSignal): FetchText {
  return async (path, scan) => {
    const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(scan ? 60_000 : 20_000)]) });
    if (!response.ok) throw new Error(`Log fetch ${response.status}`);
    if (!response.body) return "";
    const reader = response.body.getReader(), decoder = new TextDecoder();
    // The excerpt stops at the first error or after 2 MB; rules keep scanning up to 8 MB, or until a build failure decides the job.
    const limit = scan ? 8_000_000 : 2_000_000;
    let size = 0, before = 0, pending = "", lines: string[] = [], found = false;
    // Without rules the 2 MB limit is the loop limit itself; with rules the excerpt freezes once a chunk starts past 2 MB.
    const settled = () => found || (!!scan && before >= 2_000_000);
    const consume = (line: string) => {
      if (!settled()) { lines.push(line.replace(/\r$/, "")); if (lines.length > 30) lines.shift(); if (line.includes("##[error]")) found = true; }
      if (scan) { if (!scan.hit) scan.hit = matchLine(scan.rules, line.replace(/\r$/, "")); scan.build ??= buildFailureLine(line); }
    };
    try {
      while (size < limit && !(settled() && (!scan || scan.build))) {
        const { done, value } = await reader.read();
        if (done) { pending += decoder.decode(); break; }
        before = size;
        const chunk = value.subarray(0, limit - size); size += chunk.length;
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          consume(line);
          if (settled() && (!scan || scan.build)) break;
        }
      }
      if (pending && !(settled() && (!scan || scan.build))) consume(pending);
    } finally { await reader.cancel(); }
    return lines.join("\n");
  };
}
/** Downloads an artifact zip: the API answers with a redirect to blob storage, which must not receive the token. */
export function createArtifactFetcher(token: string, signal: AbortSignal): FetchBinary {
  return async (path, maxBytes) => {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    let response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }, redirect: "manual", signal: timeout });
    let url = new URL(`https://api.github.com${path}`);
    for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400 && response.headers.get("location"); hop++) {
      url = new URL(response.headers.get("location")!, url);
      if (url.protocol !== "https:") throw new Error("Artifact redirect refused");
      response = await fetch(url, { redirect: "manual", signal: timeout });
    }
    // No status digits for the blob hop: a storage 403 (expired link) is not a GitHub rate limit.
    if (!response.ok) throw new Error(url.hostname === "api.github.com" ? `Artifact fetch ${response.status}` : "Artifact download failed");
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error("Artifact too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  };
}
const runRow = z.object({ id: z.number(), status: z.string(), conclusion: z.string().nullable(), run_attempt: z.number().optional(), name: z.string().nullable().optional(), event: z.string().optional(), head_branch: z.string().nullable().optional(), head_sha: z.string().optional(), pull_requests: z.array(z.union([z.number(), z.object({ number: z.number() })])).optional(), created_at: z.string() });
type Summary = { id: number; run_attempt: number; status: string; conclusion: string | null; name: string | null; event: string; head_branch: string | null; head_sha: string; pull_requests: (number | { number: number })[]; created_at: string };
// maxPerStep bounds one step so the caller's loop (live stall detection) never waits on a full hourly burst.
export function createBackfill({ store, request, fetchText, fetchArtifact, budgetPerHour = 1500, now = Date.now, maxPerStep = Math.ceil(budgetPerHour / 60) }: { store: ReturnType<typeof createJobStore>; request: GitHubRequest; fetchText?: FetchText; fetchArtifact?: FetchBinary; budgetPerHour?: number; now?: () => number; maxPerStep?: number }) {
  const queue: { repository: string; run: Run; createdAt: string; /** Just finished: fetched before the history backlog. */ urgent?: boolean }[] = [], queued = new Set<string>(), failed = new Map<string, string>(), retries = new Map<string, { count: number; at: number }>(); let tokens = budgetPerHour, last = now(), pausedUntil: number | null = null;
  // Re-scan state: the rules version each repository is fully scanned for, jobs that failed to scan (not retried until restart) and the artifact results.
  const rescanned = new Map<string, string>(), unscannable = new Set<string>(), artifactCache = new Map<string, ZipEvidence>();
  const keyOf = (repository: string, id: number, attempt: number) => `${repository}#${id}#${attempt}`;
  const testCache = new Map<string, string[]>();
  const refill = () => {
    const current = now(); tokens = Math.min(budgetPerHour, tokens + Math.max(0, current - last) * budgetPerHour / 3_600_000); last = current;
    if (pausedUntil !== null && current >= pausedUntil) pausedUntil = null;
    return current;
  };
  /** One request on the hourly budget, for callers outside `step` (fast path, deployments, test names); a rate limit pauses the whole backfill. */
  async function spend<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    signal.throwIfAborted(); refill();
    if (pausedUntil !== null || tokens < 1) throw new Error("Budget exhausted");
    tokens--;
    try { return await call(); } catch (error) { if (/403|429/.test(String(error))) pausedUntil = now() + 900_000; throw error; }
  }
  // `urgent` runs (just finished) go before everything else; promoting an already queued attempt keeps a backlog from hiding it.
  function enqueue(repository: string, runs: Summary[], urgent = false) {
    for (const r of [...runs].filter(r => r.status === "completed").sort((a, b) => b.created_at.localeCompare(a.created_at))) for (let attempt = 1; attempt <= r.run_attempt; attempt++) {
      const key = keyOf(repository, r.id, attempt);
      if (queued.has(key)) { const item = queue.find(q => keyOf(q.repository, q.run.id, q.run.attempt) === key); if (item && urgent) item.urgent = true; }
      else if (!failed.has(key) && !store.hasCompletedAttempt(repository, r.id, attempt)) queued.add(key), queue.push({ repository, createdAt: r.created_at, urgent: urgent || undefined, run: { id: r.id, attempt, workflowName: r.name ?? "", event: r.event, headBranch: r.head_branch, headSha: r.head_sha, pullRequests: r.pull_requests.map(p => typeof p === "number" ? p : p.number) } });
    }
    // Newest first across enqueues: a deep-history backlog must not starve runs that just finished.
    queue.sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || b.createdAt.localeCompare(a.createdAt));
  }
  return {
    enqueue, spend,
    /**
     * Fast path: runs the live poll saw in progress and no longer sees. One request each; a run that finished unsuccessfully is queued ahead of the backlog.
     * Handled ids leave `ids`; ids left when the budget or a rate limit stops the loop are retried by the next call.
     */
    async resolveFinished(repository: string, ids: Set<number>, signal: AbortSignal): Promise<number> {
      let enqueued = 0;
      // At most one step's share of requests per call: a burst of finished runs must not drain the budget in one loop.
      for (const id of [...ids].slice(0, maxPerStep)) {
        try {
          const run = runRow.parse((await spend(signal, () => request(`/repos/${repository}/actions/runs/${id}`))).body);
          ids.delete(id);
          if (run.status === "completed" && run.conclusion && run.conclusion !== "success" && run.conclusion !== "skipped") {
            enqueue(repository, [{ id: run.id, run_attempt: run.run_attempt ?? 1, status: "completed", conclusion: run.conclusion, name: run.name ?? null, event: run.event ?? "", head_branch: run.head_branch ?? null, head_sha: run.head_sha ?? "", pull_requests: run.pull_requests ?? [], created_at: run.created_at }], true);
            enqueued++;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if (/Budget exhausted|403|429/.test(String(error))) break;
          // Missing, malformed or failing run: the periodic history refresh still covers it.
          ids.delete(id);
        }
      }
      return enqueued;
    },
    /** Failed test names that failedTests already extracted for this attempt; never fetches. */
    cachedFailedTests(repository: string, run: { id: number; attempt: number }, globs: RegExp[]): string[] | null {
      return testCache.get(`${repository}#${run.id}#${run.attempt}#${globs.map(g => g.source).join(",")}`) ?? null;
    },
    /** Names of the failed tests in the attempt's test-report artifacts (the configured globs, FAILED entries only); null without globs, budget or a readable report. Cached per attempt. */
    async failedTests(repository: string, run: { id: number; attempt: number }, attemptJobs: JobRecord[], globs: RegExp[], signal: AbortSignal): Promise<string[] | null> {
      if (!globs.length || !fetchArtifact) return null;
      const key = `${repository}#${run.id}#${run.attempt}#${globs.map(g => g.source).join(",")}`;
      if (testCache.has(key)) return testCache.get(key)!;
      try {
        const names: string[] = [];
        for (const a of (await spend(signal, () => attemptArtifacts(request, repository, run, attemptJobs, globs))).slice(0, 5)) {
          const zip = await spend(signal, () => fetchArtifact(`/repos/${repository}/actions/artifacts/${a.id}/zip`, MAX_ARTIFACT_BYTES));
          for (const entry of zipTextEntries(zip)) for (const name of failedTestNames(entry.text) ?? []) if (!names.includes(name)) names.push(name);
        }
        if (testCache.size >= 500) testCache.clear();
        testCache.set(key, names);
        return names;
      } catch { return null; }
    },
    async step(signal: AbortSignal, flakeConfig?: FlakeConfig) {
      let processed = 0, storedFailures = 0, signaturesUpdated = 0; const current = refill();
      let exhausted = false; let logRateError: unknown;
      let spent = 0;
      const charge = () => { if (signal.aborted) throw signal.reason; if (tokens < 1 || spent >= maxPerStep) { exhausted = true; throw new Error("Budget exhausted"); } tokens--; spent++; };
      const chargedRequest: GitHubRequest = async (path, init) => { charge(); return request(path, init); };
      const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A) => { charge(); try { return await call(...args); } catch (error) { if (/403|429/.test(String(error))) logRateError = error; throw error; } };
      const chargedText = fetchText && guard(fetchText);
      const flake: FlakeScan | undefined = flakeConfig?.rules.length ? { config: flakeConfig, fetchArtifact: fetchArtifact && guard(fetchArtifact), cache: artifactCache } : undefined;
      let examined = queue.length;
      while (examined-- > 0 && queue.length && !pausedUntil && !signal.aborted && tokens >= 1 && spent < maxPerStep) {
        const item = queue[0];
        const key = keyOf(item.repository, item.run.id, item.run.attempt);
        const done = () => { queue.shift(); queued.delete(key); retries.delete(key); };
        if ((retries.get(key)?.at ?? 0) > current) { queue.push(queue.shift()!); continue; }
        if (store.hasCompletedAttempt(item.repository, item.run.id, item.run.attempt)) { done(); continue; }
        try {
          const jobs = await fetchAttemptJobs(chargedRequest, item.repository, item.run, chargedText, flake);
          if (logRateError) throw logRateError;
          if (exhausted || signal.aborted) break;
          store.saveAttempt(item.repository, item.run.id, item.run.attempt, jobs, true); done(); processed++;
          if (jobs.some(j => BAD.has(j.conclusion ?? ""))) storedFailures++;
          // A failed job left unscanned (unreadable log) is picked up by the re-scan.
          if (flake && jobs.some(j => j.conclusion === "failure" && j.failedSteps.length && !j.signature)) rescanned.delete(item.repository);
        } catch (error) { if (exhausted || signal.aborted) break; if (/403|429/.test(String(error))) { pausedUntil = now() + 900_000; break; }
          const count = (retries.get(key)?.count ?? 0) + 1;
          if (/\b404\b/.test(String(error)) || count >= 3) { failed.set(key, String(error instanceof Error ? error.message : error)); done(); }
          else { retries.set(key, { count, at: now() + (count === 1 ? 1_800_000 : 7_200_000) }); queue.push(queue.shift()!); } }
      }
      // Stored jobs that classify as real and were not scanned with the current rules, newest first, on the budget the queue left over.
      if (flake && chargedText && !exhausted && !pausedUntil && !signal.aborted && tokens >= 1 && spent < maxPerStep && rescanned.get(flake.config.repository) !== flake.config.hash) {
        const { config } = flake, stored = store.listJobs({ repository: config.repository, since: config.since, until: "9999" });
        const real = candidates(classifyJobs(stored, { ...config.classify, flakeRules: config.rules, flakeHash: config.hash }));
        const attemptKey = (j: JobRecord) => `${j.runId}#${j.attempt}`, perAttempt = new Map<string, number>();
        for (const j of real) perAttempt.set(attemptKey(j), (perAttempt.get(attemptKey(j)) ?? 0) + 1);
        const when = (j: JobRecord) => j.completedAt ?? j.createdAt;
        const pending = real.filter(j => j.signature?.rules !== config.hash && !unscannable.has(`${j.jobId}#${config.hash}`)).sort((a, b) => when(b).localeCompare(when(a)));
        let finished = true;
        for (const j of pending) {
          try {
            // Reports first (cached per attempt): a recognized one makes the log irrelevant, so it is not even fetched.
            const artifacts = await artifactEvidence(chargedRequest, j.repository, { id: j.runId, attempt: j.attempt }, stored.filter(x => x.runId === j.runId && x.attempt === j.attempt), flake);
            let log: LogScan | null = null;
            if (!artifacts?.report) { log = { rules: config.rules, hit: null, build: null }; await chargedText(`/repos/${j.repository}/actions/jobs/${j.jobId}/logs`, log); }
            Object.assign(j, scanResult(config.hash, perAttempt.get(attemptKey(j)) === 1, artifacts, log));
            store.saveJob(j); signaturesUpdated++;
          } catch (error) {
            finished = false;
            if (exhausted || signal.aborted) break;
            if (/403|429/.test(String(error))) { pausedUntil = now() + 900_000; break; }
            unscannable.add(`${j.jobId}#${config.hash}`);
          }
        }
        if (finished) rescanned.set(config.repository, config.hash);
      }
      return { processed, remaining: queue.length, pausedUntil, failed: failed.size, /** Attempts stored with a non-success job, and stored jobs rewritten by a signature re-scan: the classification may have changed. */ storedFailures, signaturesUpdated };
    },
  };
}
