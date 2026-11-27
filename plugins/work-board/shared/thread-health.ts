import type { TaskThread, ThreadHealth } from "./contract.js";
import { ROLE_DEFAULTS } from "./status-roles.js";

export function evaluateThreadHealth(
  taskStatus: string,
  links: readonly TaskThread[],
  lastActivityAt: string,
  thresholdMinutes: number | null,
  /** The project's review status (workflow policy): the task waits for review there. */
  waitingStatuses: readonly (string | null)[] = [ROLE_DEFAULTS.reviewStatus],
  /** An unanswered owner question: the agent is waiting for the owner, not stuck. */
  waitingOnOwner = false,
  /** The project's closed statuses: a closed card has no idle or failed-thread attention (a dead thread on finished work needs none). */
  closedStatuses: readonly string[] = ROLE_DEFAULTS.closedStatuses,
): ThreadHealth {
  const failed = closedStatuses.includes(taskStatus) ? [] : links
    .filter((link) => link.liveStatus === "failed")
    .map((link) => ({ threadId: link.threadId, title: link.title, failedAt: link.updatedAt }));
  const idleLinks = links.filter((link) => link.liveStatus === "idle");
  const busy = links.some((link) => link.liveStatus === "working" || link.liveStatus === "starting");
  if (thresholdMinutes === null || closedStatuses.includes(taskStatus) || waitingStatuses.includes(taskStatus) || waitingOnOwner || busy || idleLinks.length === 0) {
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
