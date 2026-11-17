import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db";
import { formatTaskCost, modelSlices } from "../components/task-cost";
import { getTaskCostSpans, taskCostSpans } from ".";

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

  it("collects an epic's members and their subtasks into one deduplicated set", () => {
    const { bb, store, task } = setup();
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
  });

  it("caps the spans at one Tokenomos call and flags the rest", () => {
    const { db, task, system } = setup();
    expect(getTaskCostSpans(db, task.id)).toEqual({ spans: [], truncated: false, taskCount: 0 });
    for (let i = 0; i < 2001; i++) system(`thr_${i}`, `Thread attached: @thread:thr_${i}`);

    const result = getTaskCostSpans(db, task.id);
    expect(result.spans).toHaveLength(2000);
    expect(result).toMatchObject({ truncated: true, taskCount: 1 });
  });

  it("slices models by price, folding the tail into Other", () => {
    const model = (name: string, usd: number | null, tokens = 100) => ({
      provider: "p", model: name, calls: 1, cost: { ...SUM.cost, usd, tokens: { ...SUM.cost.tokens, freshIn: tokens, cacheRead: 0, cacheWrite: 0, output: 0 } },
    });
    const slices = modelSlices(["a", "b", "c", "d", "e", "f", "g"].map((name, i) => model(name, 7 - i)));
    expect(slices.map((slice) => slice.label)).toEqual(["a", "b", "c", "d", "e", "Other (2)"]);
    expect(slices.at(-1)).toMatchObject({ share: 3 / 28, amount: "$3.00" });
    expect(slices.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1);
    // A model without a price switches the pie to tokens; empty models drop out.
    expect(modelSlices([model("x", 1, 300), model("y", null, 100), model("z", 0, 0)]).map((s) => [s.label, s.share]))
      .toEqual([["x", 0.75], ["y", 0.25]]);
    expect(modelSlices([])).toEqual([]);
    // Colors follow the provider, with lighter shades for its further models.
    const colors = modelSlices([
      { ...model("opus", 3), provider: "claude-code" },
      { ...model("sonnet", 2), provider: "claude-code" },
      { ...model("sol", 1), provider: "codex" },
    ]).map((slice) => slice.color);
    expect(colors[0]).toBe("light-dark(#ea580c, #fb923c)");
    expect(colors[1]).toContain("#ea580c");
    expect(colors[1]).not.toBe(colors[0]);
    expect(colors[2]).toBe("light-dark(#2563eb, #60a5fa)");
  });

  it("formats dollars, approximate sums and token-only totals", () => {
    const cost = { ...SUM.cost, threadCount: 3, taskCount: 1 };
    expect(formatTaskCost(cost).amount).toBe("$12.40");
    expect(formatTaskCost({ ...cost, partial: true }).amount).toBe("~$12.40");
    expect(formatTaskCost({ ...cost, usd: null }).amount).toBe("56K tokens");
    expect(formatTaskCost({ ...cost, estimated: true }).detail).toContain("includes estimates");
  });
});
