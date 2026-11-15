import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db";
import { formatTaskCost } from "../components/task-cost";
import { getTaskCost, taskCostThreadIds } from ".";

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
  it("counts linked threads, past and present, but not commenters, parent fallbacks or mistakes", () => {
    const { db, store, task, system } = setup();
    store.upsertTaskThread({ taskId: task.id, threadId: "thr_live", presetName: "Default", title: "Live", liveStatus: "working" });
    system("thr_archived", "Thread detached (archived): @thread:thr_archived (attached x)");
    system("thr_attached", "Thread attached: @thread:thr_attached");
    store.createComment({ taskId: task.id, kind: "agent", authorName: "Manager", threadId: "thr_manager", body: "Status?" });
    system("thr_parent", "Thread attached (parent fallback): @thread:thr_parent");
    system("thr_parent", "Thread detached (replaced): @thread:thr_parent (attached x)");
    store.upsertTaskThread({ taskId: task.id, threadId: "thr_parent_now", presetName: "Parent thread", title: "Lead", liveStatus: "idle" });
    system("thr_parent_now", "Thread attached (parent fallback): @thread:thr_parent_now");
    system("thr_mistake", "Thread attached: @thread:thr_mistake");
    system("thr_mistake", "Thread detached (manual): @thread:thr_mistake (attached x)");

    expect(new Set(taskCostThreadIds(db, task.id))).toEqual(new Set(["thr_live", "thr_archived", "thr_attached"]));
  });

  it("asks Tokenomos for the deduplicated sum including descendants", async () => {
    const { bb, harness, task, system } = setup();
    system("thr_agent", "Thread attached: @thread:thr_agent");
    harness.sdk.stub("plugins.callRpc", async () => SUM as never);

    await expect(getTaskCost(bb, task.id)).resolves.toEqual({ ...SUM.cost, threadCount: 3 });
    expect(harness.sdk.callsTo("plugins.callRpc")[0]![0]).toMatchObject({
      pluginId: "tokenomos",
      method: "costs.sum",
      input: { threadIds: ["thr_agent"], includeDescendants: true },
    });
  });

  it("marks the sum partial when a task has more threads than one call takes", async () => {
    const { bb, harness, task, system } = setup();
    for (let i = 0; i < 201; i++) system(`thr_${i}`, `Thread attached: @thread:thr_${i}`);
    harness.sdk.stub("plugins.callRpc", async () => SUM as never);

    expect((await getTaskCost(bb, task.id))?.partial).toBe(true);
    expect((harness.sdk.callsTo("plugins.callRpc")[0]![0] as { input: { threadIds: string[] } }).input.threadIds).toHaveLength(200);
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
    const cost = { ...SUM.cost, threadCount: 3 };
    expect(formatTaskCost(cost).amount).toBe("$12.40");
    expect(formatTaskCost({ ...cost, partial: true }).amount).toBe("~$12.40");
    expect(formatTaskCost({ ...cost, usd: null }).amount).toBe("56K tokens");
    expect(formatTaskCost({ ...cost, estimated: true }).detail).toContain("includes estimates");
  });
});
