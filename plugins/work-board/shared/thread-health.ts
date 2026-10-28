import type { TaskThread, ThreadHealth } from "./contract.js";

const IDLE_EXEMPT_STATUSES = new Set(["done", "canceled", "in_review"]);

export function evaluateThreadHealth(
  taskStatus: string,
  links: readonly TaskThread[],
  lastActivityAt: string,
  thresholdMinutes: number | null,
): ThreadHealth {
  const failed = links
    .filter((link) => link.liveStatus === "failed")
    .map((link) => ({ threadId: link.threadId, title: link.title, failedAt: link.updatedAt }));
  const idleLinks = links.filter((link) => link.liveStatus === "idle");
  const busy = links.some((link) => link.liveStatus === "working" || link.liveStatus === "starting");
  if (thresholdMinutes === null || IDLE_EXEMPT_STATUSES.has(taskStatus) || busy || idleLinks.length === 0) {
    return { failed, idle: null };
  }
  // The most recently idled thread counts: the task is only stale once every idle thread has been quiet.
  const latest = idleLinks.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const since = latest.updatedAt > lastActivityAt ? latest.updatedAt : lastActivityAt;
  return { failed, idle: { threadId: latest.threadId, since, thresholdMinutes } };
}

/** Whole minutes idle once the threshold is reached, otherwise null. */
export function staleIdleMinutes(idle: ThreadHealth["idle"], now: number): number | null {
  if (!idle) return null;
  const minutes = Math.floor((now - Date.parse(idle.since)) / 60_000);
  return minutes >= idle.thresholdMinutes ? minutes : null;
}

/** The `threadHealth` object exposed by `show --json` / `list --json`. */
export function threadHealthJson(health: ThreadHealth, now: number) {
  const minutes = staleIdleMinutes(health.idle, now);
  return {
    failed: health.failed.map((entry) => entry.threadId),
    staleIdle: health.idle && minutes !== null ? { threadId: health.idle.threadId, idleMinutes: minutes } : null,
  };
}
