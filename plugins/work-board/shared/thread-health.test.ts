import { describe, expect, it } from "vitest";
import type { TaskThread } from "./contract.js";
import { evaluateThreadHealth, staleIdleMinutes, threadHealthJson } from "./thread-health.js";

const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const iso = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();

function link(threadId: string, liveStatus: TaskThread["liveStatus"], updatedAt: string): TaskThread {
  return { id: `id_${threadId}`, taskId: "task", threadId, presetName: "p", title: `Title ${threadId}`, liveStatus, attachedAt: iso(500), updatedAt };
}

const stale = (status: string, links: TaskThread[], activityAgo: number, threshold: number | null = 45) =>
  threadHealthJson(evaluateThreadHealth(status, links, iso(activityAgo), threshold), T0).staleIdle;

describe("thread health", () => {
  it("flags idle exactly at the threshold, not a minute before", () => {
    expect(stale("in_progress", [link("thr_a", "idle", iso(45))], 90)).toEqual({ threadId: "thr_a", idleMinutes: 45 });
    expect(stale("in_progress", [link("thr_a", "idle", iso(44))], 90)).toBeNull();
  });

  it("measures from the later of idleSince and the last task activity", () => {
    expect(stale("in_progress", [link("thr_a", "idle", iso(120))], 10)).toBeNull();
    expect(stale("in_progress", [link("thr_a", "idle", iso(10))], 120)).toBeNull();
    expect(stale("in_progress", [link("thr_a", "idle", iso(120))], 50)).toEqual({ threadId: "thr_a", idleMinutes: 50 });
  });

  it.each(["done", "canceled", "in_review"])("ignores %s tasks", (status) => {
    expect(stale(status, [link("thr_a", "idle", iso(300))], 300)).toBeNull();
  });

  it.each(["working", "starting"] as const)("is suppressed by a %s thread", (busy) => {
    expect(stale("in_progress", [link("thr_a", "idle", iso(300)), link("thr_b", busy, iso(1))], 300)).toBeNull();
  });

  it("needs an idle thread and is disabled by a null threshold", () => {
    expect(stale("in_progress", [link("thr_a", "completed", iso(300))], 300)).toBeNull();
    expect(stale("in_progress", [], 300)).toBeNull();
    expect(stale("in_progress", [link("thr_a", "idle", iso(300))], 300, null)).toBeNull();
  });

  it("waits for the most recently idled thread", () => {
    expect(stale("in_progress", [link("thr_a", "idle", iso(300)), link("thr_b", "idle", iso(10))], 300)).toBeNull();
  });

  it("hides failed threads on finished tasks", () => {
    expect(evaluateThreadHealth("done", [link("thr_f", "failed", iso(5))], iso(300), null).failed).toEqual([]);
  });

  it("reports failed threads independently of the idle setting", () => {
    const health = evaluateThreadHealth("in_progress", [link("thr_f", "failed", iso(5)), link("thr_a", "idle", iso(300))], iso(300), null);
    expect(health.failed).toEqual([{ threadId: "thr_f", title: "Title thr_f", failedAt: iso(5) }]);
    expect(threadHealthJson(health, T0)).toEqual({ failed: ["thr_f"], staleIdle: null });
  });

  it("lets the UI cross the threshold with only a clock tick", () => {
    const { idle } = evaluateThreadHealth("todo", [link("thr_a", "idle", iso(44))], iso(300), 45);
    expect(staleIdleMinutes(idle, T0)).toBeNull();
    expect(staleIdleMinutes(idle, T0 + 60_000)).toBe(45);
  });
});
