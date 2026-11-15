import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db";
import { formatTaskCost } from "../components/task-cost";
import { getTaskCost, taskCostSpans } from ".";

const SUM = {
  priceVersion: "2026-11",
  cost: { usd: 12.4, tokens: { freshIn: 1000, cacheRead: 50_000, cacheWrite: 2000, output: 3000 }, estimated: false, partial: false },
  threadCount: 3,
  updatedAt: 1,
};

function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  const db = host.bb.storage.database();
  const store = createTasksStore(db);
  const project = store.createProject({ name: "Plugin", prefix: "PLUG", color: "blue" });
  const task = store.createTask({ projectId: project.id, title: "Cost" });
  const system = (threadId: string, body: string) =>
    store.createComment({ taskId: task.id, kind: "system", authorName: "Work Board", threadId, body });
  return { ...host, db, store, task, system };
}

describe("task cost", () => {
  it("builds one span per attachment and none for commenters or parent fallbacks", () => {
    const { db, store, task, system } = setup();
    const at = (comment: { id: string }, iso: string) =>
      db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(iso, comment.id);
    const t = (h: number) => Date.parse(`2026-10-26T${String(h).padStart(2, "0")}:00:00.000Z`);
    // A worker attached, moved on (manual detach), came back and is still linked.
    at(system("thr_worker", "Thread attached: @thread:thr_worker"), "2026-10-26T09:00:00.000Z");
    at(system("thr_worker", "Thread detached (manual): @thread:thr_worker (attached x)"), "2026-10-26T11:00:00.000Z");
    at(system("thr_worker", "Thread attached: @thread:thr_worker"), "2026-10-26T15:00:00.000Z");
    store.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", presetName: "Attached", title: "W", liveStatus: "idle" });
    db.prepare("UPDATE task_threads SET attached_at = ? WHERE thread_id = 'thr_worker'").run("2026-10-26T15:00:00.000Z");
    // Old link with only a detach left: spans from task creation.
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-10-26T08:00:00.000Z", task.id);
    at(system("thr_old", "Thread detached (archived): @thread:thr_old (attached x)"), "2026-10-26T10:00:00.000Z");
    store.createComment({ taskId: task.id, kind: "agent", authorName: "Manager", threadId: "thr_manager", body: "Status?" });
    system("thr_parent", "Thread attached (parent fallback): @thread:thr_parent");
    system("thr_parent", "Thread detached (replaced): @thread:thr_parent (attached x)");
    store.upsertTaskThread({ taskId: task.id, threadId: "thr_lead", presetName: "Parent thread", title: "Lead", liveStatus: "idle" });

    const { spans, taskCount } = taskCostSpans(db, task.id);
    expect(taskCount).toBe(1);
    expect(spans).toEqual([
      { threadId: "thr_worker", from: t(15), to: null },
      { threadId: "thr_worker", from: t(9), to: t(11) },
      { threadId: "thr_old", from: t(8), to: t(10) },
    ]);
  });

  it("gives a thread's time to the task it was attached to most recently", () => {
    const { db, store, task, system } = setup();
    const other = store.createTask({ projectId: task.projectId, title: "Next" });
    const at = (comment: { id: string }, iso: string) =>
      db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(iso, comment.id);
    const t = (h: number) => Date.parse(`2026-10-26T${String(h).padStart(2, "0")}:00:00.000Z`);
    // Attached here 09-17, but moved to another task 11-13 without detaching here.
    at(system("thr_worker", "Thread attached: @thread:thr_worker"), "2026-10-26T09:00:00.000Z");
    at(store.createComment({ taskId: other.id, kind: "system", authorName: "Work Board", threadId: "thr_worker", body: "Thread attached: @thread:thr_worker" }), "2026-10-26T11:00:00.000Z");
    at(store.createComment({ taskId: other.id, kind: "system", authorName: "Work Board", threadId: "thr_worker", body: "Thread detached (manual): @thread:thr_worker (attached x)" }), "2026-10-26T13:00:00.000Z");
    at(system("thr_worker", "Thread detached (manual): @thread:thr_worker (attached x)"), "2026-10-26T17:00:00.000Z");

    expect(taskCostSpans(db, task.id).spans).toEqual([
      { threadId: "thr_worker", from: t(13), to: t(17) },
      { threadId: "thr_worker", from: t(9), to: t(11) },
    ]);
    expect(taskCostSpans(db, other.id).spans).toEqual([{ threadId: "thr_worker", from: t(11), to: t(13) }]);
  });

  it("collects an epic's members and their subtasks into one deduplicated set", async () => {
    const { bb, harness, store, task } = setup();
    const epic = store.createTask({ projectId: task.projectId, title: "Epic", type: "epic" });
    const member = store.createTask({ projectId: epic.projectId, title: "Member", epicId: epic.id });
    const sub = store.createTask({ projectId: epic.projectId, title: "Sub", parentTaskId: member.id });
    store.createTask({ projectId: epic.projectId, title: "Outside" });
    const attach = (taskId: string, threadId: string) =>
      store.createComment({ taskId, kind: "system", authorName: "Work Board", threadId, body: `Thread attached: @thread:${threadId}` });
    attach(member.id, "thr_member");
    attach(sub.id, "thr_sub");
    attach(sub.id, "thr_shared");
    attach(member.id, "thr_shared");

    const { spans, taskCount } = taskCostSpans(bb.storage.database(), epic.id);
    expect(taskCount).toBe(2);
    // thr_shared is attached to both; the tree owns its time once.
    expect(spans.map((span) => span.threadId).sort()).toEqual(["thr_member", "thr_shared", "thr_sub"]);
    expect(spans.every((span) => span.to === null)).toBe(true);
    harness.sdk.stub("plugins.callRpc", async () => SUM as never);
    expect(await getTaskCost(bb, epic.id)).toMatchObject({ taskCount: 2 });
    expect(harness.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
  });

  it("asks Tokenomos for the sum over spans including descendants", async () => {
    const { bb, harness, task, system } = setup();
    system("thr_agent", "Thread attached: @thread:thr_agent");
    harness.sdk.stub("plugins.callRpc", async () => SUM as never);

    await expect(getTaskCost(bb, task.id)).resolves.toEqual({ ...SUM.cost, threadCount: 3, taskCount: 1 });
    expect(harness.sdk.callsTo("plugins.callRpc")[0]![0]).toMatchObject({
      pluginId: "tokenomos",
      method: "costs.sum",
      input: { spans: [{ threadId: "thr_agent", from: expect.any(Number), to: null }], includeDescendants: true },
    });
  });

  it("marks the sum partial when a task has more spans than one call takes", async () => {
    const { bb, harness, task, system } = setup();
    for (let i = 0; i < 2001; i++) system(`thr_${i}`, `Thread attached: @thread:thr_${i}`);
    harness.sdk.stub("plugins.callRpc", async () => SUM as never);

    expect((await getTaskCost(bb, task.id))?.partial).toBe(true);
    expect((harness.sdk.callsTo("plugins.callRpc")[0]![0] as { input: { spans: unknown[] } }).input.spans).toHaveLength(2000);
  });

  it("hides the cost when Tokenomos is missing or the task has no threads", async () => {
    const { bb, harness, task, system } = setup();
    await expect(getTaskCost(bb, task.id)).resolves.toBeNull();
    expect(harness.sdk.callsTo("plugins.callRpc")).toEqual([]);

    system("thr_agent", "Thread attached: @thread:thr_agent");
    harness.sdk.stub("plugins.callRpc", async () => {
      throw new Error("plugin tokenomos is not installed");
    });
    await expect(getTaskCost(bb, task.id)).resolves.toBeNull();

    harness.sdk.stub("plugins.callRpc", async () => ({ ...SUM, threadCount: 0 }) as never);
    await expect(getTaskCost(bb, task.id)).resolves.toBeNull();
  });

  it("formats dollars, approximate sums and token-only totals", () => {
    const cost = { ...SUM.cost, threadCount: 3, taskCount: 1 };
    expect(formatTaskCost(cost).amount).toBe("$12.40");
    expect(formatTaskCost({ ...cost, partial: true }).amount).toBe("~$12.40");
    expect(formatTaskCost({ ...cost, usd: null }).amount).toBe("56K tokens");
    expect(formatTaskCost({ ...cost, estimated: true }).detail).toContain("includes estimates");
  });
});
