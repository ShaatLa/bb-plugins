import type { GitHubRequest } from "./metrics";
import type { JobRecord, PoolQueueState, Signal } from "./ci-jobs-types";

export async function fetchLiveJobs(request: GitHubRequest, repository: string, normalize: (raw: unknown, ctx: { run: any; attempt: number }) => JobRecord): Promise<{ jobs: JobRecord[]; runIds: number[]; truncated: boolean }> {
  const jobs: JobRecord[] = [], runIds: number[] = []; let truncated = false;
  for (const status of ["queued", "in_progress"]) {
    const page = await request(`/repos/${repository}/actions/runs?status=${status}&per_page=100`);
    const body = page.body as { workflow_runs?: any[] };
    truncated ||= page.hasNext;
    for (const run of body.workflow_runs ?? []) {
      runIds.push(run.id);
      const result = await request(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      truncated ||= result.hasNext;
      const rows = (result.body as { jobs?: unknown[] }).jobs ?? [];
      jobs.push(...rows.map((job) => normalize(job, { run, attempt: run.run_attempt ?? 1 })));
    }
  }
  return { jobs, runIds, truncated };
}

/**
 * Runs seen queued/in progress by the previous poll that this poll no longer lists: they just finished (or moved between the two status lists).
 * A truncated listing is incomplete, so a run missing from it proves nothing.
 */
export function finishedRuns(previous: ReadonlySet<number> | undefined, current: { runIds: number[]; truncated: boolean }, previousTruncated = false): number[] {
  if (!previous || current.truncated || previousTruncated) return [];
  const now = new Set(current.runIds);
  return [...previous].filter((id) => !now.has(id));
}

export function poolQueueStates(jobs: JobRecord[], recentStarts: Array<{ pool: string | null; startedAt: string }>, now: number): PoolQueueState[] {
  const pools = new Map<string, JobRecord[]>();
  for (const job of jobs) { const pool = job.pool ?? "unknown"; pools.set(pool, [...(pools.get(pool) ?? []), job]); }
  for (const row of recentStarts) if (row.pool) pools.set(row.pool, pools.get(row.pool) ?? []);
  return [...pools].map(([pool, rows]) => {
    const queued = rows.filter((j) => ["queued", "waiting", "pending", "requested"].includes(j.status) && !j.startedAt);
    const starts = [...rows.flatMap((j) => j.startedAt ? [j.startedAt] : []), ...recentStarts.filter((r) => r.pool === pool).map((r) => r.startedAt)].map(Date.parse);
    return { pool, queued: queued.length, inProgress: rows.filter((j) => j.status === "in_progress").length,
      oldestQueuedAt: queued.map((j) => j.createdAt).sort()[0] ?? null,
      lastStartedAt: starts.length ? new Date(Math.max(...starts)).toISOString() : null,
      queuedRunIds: [...new Set(queued.map((j) => j.runId))] };
  });
}

export function detectStalls(states: PoolQueueState[], options: { stallMinutes?: number } = {}, now: number): Signal[] {
  const threshold = (options.stallMinutes ?? 10) * 60000;
  return states.flatMap((s) => {
    if (!s.queued || !s.oldestQueuedAt) return [];
    const sinceMs = Math.max(s.lastStartedAt ? Date.parse(s.lastStartedAt) : -Infinity, Date.parse(s.oldestQueuedAt));
    if (now - sinceMs < threshold) return [];
    const since = new Date(sinceMs).toISOString(), mins = Math.floor((now - sinceMs) / 60000);
    // One id per pool: cancelling the oldest queued job mid-stall must not reopen the incident and repeat the push.
    return [{ id: `pool_stall:${s.pool}`, kind: "pool_stall", severity: "critical", title: `Runner pool stalled: ${s.pool}`,
      what: `${s.queued} jobs queued in ${s.queuedRunIds.length} runs, ${s.inProgress} running, nothing started for ${mins} min`,
      where: { pool: s.pool }, since, until: null, impact: `${s.queued} jobs across ${s.queuedRunIds.length} runs are waiting`, actor: "owner_sre", open: true } satisfies Signal];
  });
}

export function createIncidentTracker(load: () => any, save: (state: any) => void) {
  return { update(current: Signal[], now: number) {
    const state: { open: Signal[]; recent: Signal[] } = load() ?? { open: [], recent: [] }; const old = new Map<string, Signal>(state.open.map((s) => [s.id, s]));
    const opened = current.filter((s) => !old.has(s.id));
    const resolved = [...old.values()].filter((s) => !current.some((c) => c.id === s.id)).map((s) => ({ ...s, open: false, until: new Date(now).toISOString() }));
    const open = current.map((s) => ({ ...s, open: true }));
    const cutoff = now - 7 * 86400000, recent = [...state.recent, ...resolved].filter((s) => Date.parse(s.until ?? s.since) >= cutoff).slice(-50);
    save({ open, recent }); return { opened, resolved, open: [...open, ...recent] };
  } };
}
