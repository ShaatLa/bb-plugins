import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";
import { POST_MERGE_REVIEW_GRACE_MS, staleStatusObservations } from "../attention/observe";
import { prIdentity } from "../shared/git-sync";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

afterEach(() => { vi.useRealTimers(); });

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Grace", prefix: "EXA", color: "blue" });
  store.tasks.updateProject(project.id, { workflowPolicy: { bugfixStatus: null, doneStatus: "done", inProgressStatus: "in_progress", reviewStatus: "in_review", testingStatus: "in_testing", planningStatus: null, earlyStatuses: [], ownerDecisionLabel: null } });
  const statuses = [...(store.tasks.getProject(project.id)!.statuses ?? [])];
  if (!statuses.some((status) => status.id === "in_testing")) store.tasks.updateProject(project.id, { statuses: [...statuses, { id: "in_testing", name: "In testing" }] });
  const db = bb.storage.database();
  let pr = 0;
  /** Links one PR to the card with the given snapshot payload. */
  const link = (taskId: string, payload: Record<string, unknown>, excluded = false) => {
    const number = ++pr;
    const identity = prIdentity({ repository: "owner/repo", number });
    const at = new Date(NOW - 24 * HOUR).toISOString();
    db.prepare("INSERT INTO task_pr_links VALUES (?, ?, ?)").run(taskId, identity, JSON.stringify({ taskId, repository: "owner/repo", number, url: `https://github.com/owner/repo/pull/${number}`, source: "manual", confirmed: true, excluded, createdAt: at, updatedAt: at }));
    // A full snapshot, as `show` parses it; the raw `payload` fields win, so a test can also store a malformed one.
    const snapshot = { repository: "owner/repo", number, remoteId: `PR_${number}`, url: `https://github.com/owner/repo/pull/${number}`, title: "Example", headSha: "a".repeat(40), mergeSha: null, mergedAt: null, baseBranch: "main", updatedAt: at, observedAt: at, checks: [], requirementsKnown: true, ci: "passing", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [] };
    db.prepare("INSERT INTO git_pr_snapshots(project_id, identity, payload) VALUES (?, ?, ?)").run(project.id, identity, JSON.stringify({ ...snapshot, ...payload }));
  };
  const card = (status: string) => store.tasks.createTask({ projectId: project.id, title: status, status });
  const flags = (taskId: string, nowMs = NOW) => store.tasks.staleStatusFlags([taskId], undefined, nowMs).get(taskId) ?? [];
  const observed = (taskId: string, nowMs = NOW) => staleStatusObservations(db, [taskId], undefined, nowMs)[0]!.signals.no_open_pr.present;
  return { bb, harness, store, project, db, link, card, flags, observed };
}

describe("post-merge grace in the review status", () => {
  it("settles a fresh merge in review, flags an old, undated, malformed or future one, and keeps testing settled at any age", async () => {
    const f = setup();
    const fresh = f.card("in_review");
    f.link(fresh.id, { state: "merged", mergedAt: ago(HOUR) });
    const old = f.card("in_review");
    f.link(old.id, { state: "merged", mergedAt: ago(3 * HOUR) });
    const undated = f.card("in_review");
    f.link(undated.id, { state: "merged", mergedAt: undefined });
    const malformed = f.card("in_review");
    f.link(malformed.id, { state: "merged", mergedAt: "not a date" });
    const future = f.card("in_review");
    f.link(future.id, { state: "merged", mergedAt: new Date(NOW + HOUR).toISOString() });
    // A malformed or future value next to a valid old merge neither masks nor extends it.
    const mixed = f.card("in_review");
    f.link(mixed.id, { state: "merged", mergedAt: ago(3 * HOUR) });
    f.link(mixed.id, { state: "merged", mergedAt: new Date(NOW + HOUR).toISOString() });
    f.link(mixed.id, { state: "merged", mergedAt: "garbage" });
    const excluded = f.card("in_review");
    f.link(excluded.id, { state: "merged", mergedAt: ago(HOUR) }, true);
    const testing = f.card("in_testing");
    f.link(testing.id, { state: "merged", mergedAt: ago(30 * 24 * HOUR) });

    for (const [task, stale] of [[fresh, false], [old, true], [undated, true], [malformed, true], [future, true], [mixed, true], [excluded, true], [testing, false]] as const) {
      expect(f.flags(task.id).includes("no_open_pr"), task.id).toBe(stale);
      expect(f.observed(task.id), task.id).toBe(stale);
    }
    // The grace ends exactly two hours after the merge.
    expect(f.flags(fresh.id, NOW - HOUR + POST_MERGE_REVIEW_GRACE_MS - 1)).toEqual([]);
    expect(f.flags(fresh.id, NOW - HOUR + POST_MERGE_REVIEW_GRACE_MS)).toEqual(["no_open_pr"]);
    expect(f.observed(fresh.id, NOW - HOUR + POST_MERGE_REVIEW_GRACE_MS)).toBe(true);
    await f.harness.dispose();
  });

  it("selects, shows and pages by one clock, and an old cursor fails across expiry without a write", async () => {
    const f = setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const merged = f.card("in_review");
    f.link(merged.id, { state: "merged", mergedAt: ago(HOUR) });
    f.card("in_review");
    f.card("in_review");
    const list = async () => {
      const result = await f.harness.runCli(["list", "--project", "EXA", "--stale-status", "--json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      return JSON.parse(result.stdout).tasks as Array<{ id: string; staleStatusFlags: string[] }>;
    };
    const show = async () => { const r = await f.harness.runCli(["show", merged.key, "--json"]); expect(r.exitCode, r.stderr).toBe(0); return JSON.parse(r.stdout).staleStatusFlags; };
    expect((await list()).map((task) => task.id)).not.toContain(merged.id);
    expect(await show()).toEqual([]);
    const meta = async (skip?: boolean) => ((await f.harness.callRpc("listTaskCardMeta", { taskIds: [f.card("in_review").id], ...(skip ? { skipStaleStatusFlags: true } : {}) })) as { metadata: Array<{ staleStatusFlags: string[] }> }).metadata[0]!.staleStatusFlags;
    expect(await meta()).toEqual(["no_open_pr"]);
    expect(await meta(true)).toEqual([]);
    const page = await f.harness.callRpc("listTasks", { projectId: f.project.id, staleStatus: true, limit: 1 }) as { nextCursor: string };

    // Only the clock moves: the expiry alone changes the stale set the cursor was issued for.
    const changes = () => f.db.prepare<[], { n: number }>("SELECT total_changes() AS n").get()!.n;
    const before = changes();
    vi.setSystemTime(NOW + HOUR);
    await expect(f.harness.callRpc("listTasks", { projectId: f.project.id, staleStatus: true, limit: 1, cursor: page.nextCursor })).rejects.toThrow(/cursor/);
    expect(changes()).toBe(before);
    const after = await list();
    expect(after.find((task) => task.id === merged.id)?.staleStatusFlags).toEqual(["no_open_pr"]);
    expect(after.every((task) => task.staleStatusFlags.length > 0)).toBe(true);
    expect(await show()).toEqual(["no_open_pr"]);
    await f.harness.dispose();
  });
});
