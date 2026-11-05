import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import { capOpenSignals } from "./cache-cleanup";
import type { Signal } from "./ci-jobs-types";
import { createBackfill, createLogFetcher, createJobStore, fetchAttemptJobs, jobMigrations } from "./ci-jobs";
import { fakeGithub, job, runContext, syntheticRun } from "./test-support";

function setup() {
  const data = syntheticRun(), db = createFakePluginHost().bb.storage.database();
  for (const sql of jobMigrations) db.prepare(sql).run();
  return { data, ...fakeGithub(data), store: createJobStore(db), context: (attempt: number) => runContext(data, attempt) };
}
const signal = () => new AbortController().signal;
test("pagination, annotations and carried jobs across attempts", async () => {
  const { request, calls, store, context } = setup();
  for (let attempt = 1; attempt <= 3; attempt++) { const jobs = await fetchAttemptJobs(request, "o/r", context(attempt)); store.saveAttempt("o/r", context(attempt).id, attempt, jobs, true); }
  const jobs = store.listJobs({ repository: "o/r", since: "2020", until: "2030" });
  expect(jobs).toHaveLength(12);
  expect(jobs.find(j => j.attempt === 3 && j.jobName === "Unit tests")?.carried).toBe(true);
  expect(jobs.find(j => j.attempt === 3 && j.jobName === "Lint")?.carried).toBe(true);
  expect(jobs.find(j => j.attempt === 3 && j.jobName === "Integration tests")?.carried).toBe(false);
  expect(jobs.find(j => j.attempt === 1 && j.jobName === "Unit tests")?.carried).toBe(false);
  expect(calls.some(p => p.endsWith("page=2"))).toBe(true);
  for (const j of jobs) expect(calls.filter(p => p.includes(`/check-runs/${j.jobId}/annotations`)).length).toBe(["failure", "cancelled"].includes(j.conclusion ?? "") ? 1 : 0);
  expect(jobs.find(j => j.attempt === 1 && j.jobName === "Lint")?.annotations[0]?.message).toContain("shutdown signal");
});
test("fetches logs only for failures that could be transient", async () => {
  const { request, context } = setup(); const logs = vi.fn(async (_path: string) => "before\n##[error] broken");
  const jobs = await fetchAttemptJobs(request, "o/r", context(1), logs);
  const id = (name: string) => jobs.find(j => j.jobName === name)!.jobId;
  expect(logs.mock.calls.map(([path]) => path)).toEqual([`/repos/o/r/actions/jobs/${id("Integration tests")}/logs`]);
  expect(jobs.find(j => j.jobName === "Integration tests")?.logExcerpt).toBe("before\n##[error] broken");
  expect(jobs.find(j => j.jobName === "Lint")?.logExcerpt).toBeNull(); // runner loss: no log needed
});
test("backfill respects completed attempts, budget and rate limits", async () => {
  const { data, request, store } = setup(); const run = { ...data.run, status: "completed" };
  const limited = createBackfill({ store, request, budgetPerHour: 1 }); limited.enqueue("o/r", [run]);
  expect(await limited.step(signal())).toMatchObject({ processed: 0, remaining: 3 });
  const clock = () => 1000; const rate = createBackfill({ store, request: async () => { throw new Error("429"); }, now: clock }); rate.enqueue("o/r", [run]);
  expect(await rate.step(signal())).toMatchObject({ processed: 0, pausedUntil: 901000 });
  const full = createBackfill({ store, request }); full.enqueue("o/r", [run]); expect((await full.step(signal())).processed).toBe(3);
  full.enqueue("o/r", [run]); expect((await full.step(signal())).remaining).toBe(0);
});

test("a failing attempt is skipped instead of blocking the backfill queue", async () => {
  const { data, request, store } = setup(); const run = { ...data.run, status: "completed" };
  const broken = createBackfill({ store, request: async (path, init) => { if (path.includes("/attempts/1/")) throw new Error("GitHub returned 404."); return request(path, init); } });
  broken.enqueue("o/r", [run]);
  expect(await broken.step(signal())).toMatchObject({ processed: 2, remaining: 0, failed: 1 });
  broken.enqueue("o/r", [run]); expect((await broken.step(signal())).remaining).toBe(0);
});

test("one step spends at most its per-step share of the hourly budget", async () => {
  const { data, request, calls, store } = setup(); const run = { ...data.run, status: "completed" };
  const backfill = createBackfill({ store, request, maxPerStep: 3 }); backfill.enqueue("o/r", [run]);
  const first = await backfill.step(signal());
  expect(calls.length).toBeLessThanOrEqual(3); expect(first.remaining).toBeGreaterThan(0);
});

test("retries failures after 30 minutes and two hours before giving up", async () => {
  const { data, store } = setup(); let now = 0; const request = vi.fn(async () => { throw new Error("500"); });
  const backfill = createBackfill({ store, request, now: () => now }); backfill.enqueue("o/r", [{ ...data.run, run_attempt: 1 }]);
  const step = () => backfill.step(signal());
  expect(await step()).toMatchObject({ remaining: 1, failed: 0 });
  now = 1_799_999; await step(); expect(request).toHaveBeenCalledTimes(1);
  now++; await step(); expect(request).toHaveBeenCalledTimes(2);
  now += 7_200_000; expect(await step()).toMatchObject({ remaining: 0, failed: 1 }); expect(request).toHaveBeenCalledTimes(3);
});

test("log streaming stops at the first error and keeps 30 lines", async () => {
  let cancelled = false, reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new TextEncoder().encode(reads === 1 ? Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("") + "##[error] broken\n" : "extra\n")); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));
  try { const result = await createLogFetcher("token", new AbortController().signal)("/logs"); expect(result.split("\n")).toHaveLength(30); expect(result).toContain("line 11"); expect(result).toContain("##[error] broken"); expect(reads).toBe(1); expect(cancelled).toBe(true); } finally { vi.unstubAllGlobals(); }
});

// --- storage: slim rows, no skipped jobs, retention ---
const fresh = () => { const db = createFakePluginHost().bb.storage.database(); for (const sql of jobMigrations) db.prepare(sql).run(); return { db, store: createJobStore(db) }; };
const rows = (db: ReturnType<typeof fresh>["db"]) => db.prepare("SELECT job_id, length(data) AS bytes FROM ci_jobs ORDER BY job_id").all() as { job_id: number; bytes: number }[];

test("skipped jobs are not stored, yet an executed job repeated from the previous attempt is still carried", () => {
  const { db, store } = fresh();
  store.saveAttempt("acme/widgets", 1, 1, [job({ jobId: 1 }), job({ jobId: 2, jobName: "Lint", conclusion: "skipped", pool: null, labels: [] })], true);
  store.saveAttempt("acme/widgets", 1, 2, [job({ jobId: 3, attempt: 2 }), job({ jobId: 4, attempt: 2, jobName: "Lint", conclusion: "skipped", pool: null, labels: [] })], true);
  expect(rows(db).map(r => r.job_id)).toEqual([1, 3]);
  expect(store.listJobs({ repository: "acme/widgets", since: "2020", until: "2030" }).map(j => [j.jobId, j.carried])).toEqual([[1, false], [3, true]]);
  expect(store.hasCompletedAttempt("acme/widgets", 1, 2)).toBe(true);
});
test("slim rows round-trip every JobRecord shape and are at most half the size of the old format", () => {
  const { db, store } = fresh();
  const shapes = [job({ jobId: 1 }), job({ jobId: 2, conclusion: "failure", failedSteps: ["Run tests"], annotations: [{ level: "failure", title: "t", message: "m" }], logExcerpt: "log", pullRequests: [7], carried: true }),
    job({ jobId: 3, conclusion: "cancelled", labels: ["self-hosted", "linux"], pool: "self-hosted", runnerName: null, runnerGroup: null, startedAt: null, completedAt: null, headBranch: null, workflowName: "" }),
    job({ jobId: 4, labels: [], pool: null }), job({ jobId: 5, status: "in_progress", conclusion: null })];
  store.saveAttempt("acme/widgets", 1, 1, shapes, true);
  expect(store.listJobs({ repository: "acme/widgets", since: "2020", until: "2030" }).sort((a, b) => a.jobId - b.jobId)).toEqual(shapes);
  const [success] = rows(db), before = JSON.stringify(shapes[0]).length;
  expect(success.bytes).toBeLessThanOrEqual(before / 2);
});
test("rows written by earlier versions (full JobRecord JSON) are still read", () => {
  const { db, store } = fresh(), legacy = job({ jobId: 9, headBranch: null });
  db.prepare("INSERT INTO ci_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(legacy.repository, 1, 1, 9, legacy.createdAt, legacy.pool, legacy.conclusion, legacy.headSha, JSON.stringify(legacy));
  store.saveAttempt("acme/widgets", 2, 1, [job({ jobId: 10, runId: 2 })], true);
  expect(store.listJobs({ repository: "acme/widgets", since: "2020", until: "2030" }).map(j => j.jobId)).toEqual([9, 10]);
  expect(store.listJobs({ repository: "acme/widgets", since: "2020", until: "2030" })[0]).toEqual(legacy);
  // A re-run after a legacy attempt still detects carried jobs against the old format.
  store.saveAttempt("acme/widgets", 1, 2, [job({ jobId: 11, attempt: 2 })], true);
  expect(store.listJobs({ repository: "acme/widgets", since: "2020", until: "2030" }).find(j => j.jobId === 11)?.carried).toBe(true);
});
test("startup drops skipped rows stored by earlier versions", () => {
  const { db } = fresh();
  db.prepare("INSERT INTO ci_jobs VALUES ('acme/widgets', 1, 1, 1, '2026-10-20T10:00:00Z', NULL, 'skipped', 'x', '{}')").run();
  createJobStore(db);
  expect(rows(db)).toEqual([]);
});
test("attempts are pruned together with their jobs by the run's age, not by when they were fetched", () => {
  const { db, store } = fresh();
  store.saveAttempt("acme/widgets", 1, 1, [job({ jobId: 1, createdAt: "2026-09-01T10:00:00Z" })], true); // old run, fetched just now
  store.saveAttempt("acme/widgets", 2, 1, [job({ jobId: 2, runId: 2, conclusion: "skipped" })], true); // recent run without stored jobs
  db.prepare("INSERT INTO ci_attempts (repository, run_id, attempt, completed, fetched_at) VALUES ('acme/widgets', 3, 1, 1, ?)").run(Date.parse("2026-09-01T00:00:00Z")); // legacy row
  store.prune("2026-10-01T00:00:00Z");
  expect(db.prepare("SELECT run_id FROM ci_attempts").all()).toEqual([{ run_id: 2 }]);
  expect(rows(db)).toEqual([]);
});
test("jobs and attempts of repositories that are no longer configured are deleted", () => {
  const { db, store } = fresh();
  store.saveAttempt("Acme/Widgets", 1, 1, [job({ jobId: 1, repository: "Acme/Widgets" })], true);
  store.saveAttempt("gone/repo", 1, 1, [job({ jobId: 2, repository: "gone/repo" })], true);
  expect(store.pruneRepositories(["acme/widgets"])).toBe(2);
  expect(db.prepare("SELECT repository FROM ci_jobs").all()).toEqual([{ repository: "Acme/Widgets" }]);
  expect(db.prepare("SELECT repository FROM ci_attempts").all()).toEqual([{ repository: "Acme/Widgets" }]);
});
test("the hard cap drops whole oldest days until the job data fits", () => {
  const { db, store } = fresh();
  for (const [i, day] of ["2026-10-18", "2026-10-19", "2026-10-20"].entries()) for (const k of [0, 1]) store.saveAttempt("acme/widgets", i * 10 + k, 1, [job({ jobId: i * 10 + k, runId: i * 10 + k, createdAt: `${day}T1${k}:00:00Z` })], true);
  const one = rows(db)[0].bytes;
  expect(store.capBytes(10 * one)).toEqual({ removedDays: 0, bytes: 6 * one });
  expect(store.capBytes(4 * one + 1)).toEqual({ removedDays: 1, bytes: 4 * one });
  expect(store.capBytes(one)).toEqual({ removedDays: 2, bytes: 0 });
  expect(store.bytes()).toBe(0);
});
test("open signals are capped at 200, most severe and newest first", () => {
  const signal = (i: number, severity: Signal["severity"]): Signal => ({ id: `s${i}`, kind: "flake", severity, title: "", what: "", where: {}, since: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), until: null, impact: "", actor: "owner_sre", open: true });
  const all = [...Array.from({ length: 250 }, (_, i) => signal(i, "info")), signal(300, "critical"), signal(301, "warning")];
  const capped = capOpenSignals(all);
  expect(capped).toHaveLength(200);
  expect(capped.slice(0, 2).map(s => s.id)).toEqual(["s300", "s301"]);
  expect(capped.map(s => s.id)).not.toContain("s0");
  expect(capOpenSignals(all.slice(0, 5))).toHaveLength(5);
});
