import { describe, expect, it } from "vitest";
import type { JobRecord, Signal } from "./ci-jobs-types";
import { createIncidentTracker, detectStalls, fetchLiveJobs, poolQueueStates } from "./ci-live";

const base = (pool: string, runId: number, status: string, createdAt = "2026-11-05T09:50:00Z", startedAt: string | null = null): JobRecord => ({
  repository: "acme/widgets", runId, attempt: 1, jobId: runId, workflowName: "CI", jobName: "test", event: "push",
  headBranch: "main", headSha: "sha", pullRequests: [], status, conclusion: null, labels: [], pool, runnerName: null,
  runnerGroup: null, createdAt, startedAt, completedAt: null, failedSteps: [], annotations: [], logExcerpt: null, carried: false,
});

describe("live runner pools", () => {
  it("reproduces the 10:02Z stall while leaving the healthy pool alone", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => base("self-hosted", i + 1, "queued", "2026-11-05T07:30:00Z"))
      .concat([base("other-pool", 20, "in_progress", "2026-11-05T09:55:00Z", "2026-11-05T09:55:00Z")]);
    const states = poolQueueStates(jobs, [{ pool: "self-hosted", startedAt: "2026-11-05T07:38:00Z" }], Date.parse("2026-11-05T10:02:00Z"));
    const signals = detectStalls(states, {}, Date.parse("2026-11-05T10:02:00Z"));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: "pool_stall", severity: "critical", since: "2026-11-05T07:38:00.000Z", where: { pool: "self-hosted" } });
  });

  it("uses the threshold boundary and keeps the incident id stable as the queue grows", () => {
    const now = Date.parse("2026-11-05T10:02:00Z");
    const state = (minutes: number, queued: number) => ({ pool: "self-hosted", queued, inProgress: 0, oldestQueuedAt: new Date(now - minutes * 60000).toISOString(), lastStartedAt: null, queuedRunIds: [1] });
    expect(detectStalls([state(9, 1)], {}, now)).toHaveLength(0);
    expect(detectStalls([state(10, 1)], {}, now)).toHaveLength(1);
    expect(detectStalls([state(10, 1)], {}, now)[0].id).toBe(detectStalls([state(10, 8)], {}, now)[0].id);
    // Oldest queued job cancelled mid-stall: same incident.
    expect(detectStalls([state(10, 1)], {}, now)[0].id).toBe(detectStalls([state(25, 3)], {}, now)[0].id);
  });

  it("opens once across reload, then resolves into recent history", () => {
    let persisted: any;
    const signal = { id: "pool_stall:p:time", kind: "pool_stall", severity: "critical", title: "stall", what: "stall", where: { pool: "p" }, since: "2026-11-05T07:38:00Z", until: null, impact: "impact", actor: "owner_sre", open: true } as Signal;
    const tracker = () => createIncidentTracker(() => persisted, (value) => { persisted = value; });
    expect(tracker().update([signal], Date.parse("2026-11-05T10:02:00Z")).opened).toEqual([signal]);
    expect(tracker().update([signal], Date.parse("2026-11-05T10:03:00Z")).opened).toEqual([]);
    const drained = tracker().update([], Date.parse("2026-11-05T10:04:00Z"));
    expect(drained.resolved[0]).toMatchObject({ id: signal.id, open: false, until: "2026-11-05T10:04:00.000Z" });
    expect(drained.open).toContainEqual(expect.objectContaining({ id: signal.id, open: false }));
  });

  it("fetches both live run queues, marks pagination, and requests latest jobs", async () => {
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      if (path.includes("/actions/runs?")) return { body: { workflow_runs: [{ id: 7, run_attempt: 2 }] }, hasNext: path.includes("queued") };
      return { body: { jobs: [{ id: 70 }] }, hasNext: false };
    };
    const normalize = (raw: any, ctx: any) => ({ ...base("pool", ctx.run.id, "queued"), jobId: raw.id, attempt: ctx.attempt });
    const result = await fetchLiveJobs(request as any, "acme/widgets", normalize);
    expect(result).toMatchObject({ truncated: true, jobs: [{ jobId: 70, attempt: 2 }, { jobId: 70, attempt: 2 }] });
    expect(paths).toContain("/repos/acme/widgets/actions/runs/7/jobs?filter=latest&per_page=100");
  });
});
