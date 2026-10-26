import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore } from "../api";
import { registerDelegation } from ".";
import { registerTasksCli } from "../cli";

describe("dispatch to an existing thread", () => {
  it.each(["active", "idle"] as const)("sends context to a %s thread without a preset or linked project", async (status) => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "work-board",
      sdk: { threads: {
        get: async () => makeThreadResponse({ id: "thr_existing", title: "Current work", status }),
        send: async () => ({}),
      } },
    });
    try {
      const store = createStore(bb);
      const project = store.tasks.createProject({ name: "Personal", prefix: "TSK", color: "blue" });
      const task = store.tasks.createTask({ projectId: project.id, title: "Fix queue", description: "Keep current settings", status: "todo" });
      registerDelegation(bb, store);
      registerTasksCli(bb, store, { name: "Work Board", version: "test" });
      const result = await harness.runCli(["dispatch", task.key, "--thread", "thr_existing", "--instructions", "Verify the result", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).threadId).toBe("thr_existing");
      expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
      expect(harness.sdk.callsTo("threads.send")).toEqual([[{
        threadId: "thr_existing",
        mode: "queue-if-active",
        input: [{ type: "text", text: expect.stringContaining("Keep current settings"), mentions: [] }],
      }]]);
      const sent = JSON.stringify(harness.sdk.callsTo("threads.send"));
      expect(sent).toContain("Verify the result");
      expect(sent).toContain("Report-back contract");
      expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
      expect(store.tasks.listTaskThreads(task.id)).toEqual([expect.objectContaining({ threadId: "thr_existing", title: "Current work" })]);
      expect(store.tasks.listComments(task.id)).toHaveLength(1);
      expect(harness.realtimeSignals.map((event) => event.channel)).toEqual(["threads:changed", "tasks:changed", "comments:changed"]);
      for (const args of [[], ["--preset", "worker", "--thread", "thr_existing"]]) {
        const invalid = await harness.runCli(["dispatch", task.key, ...args]);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stderr).toContain("exactly one");
      }
    } finally { await harness.dispose(); }
  });

  it.each(["send failed", "archived", "deleted", "stopping"])("leaves task records unchanged when %s", async (failure) => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "work-board",
      sdk: { threads: {
        get: async () => makeThreadResponse({ id: "thr_existing", archivedAt: failure === "archived" ? 1 : null, deletedAt: failure === "deleted" ? 1 : null, status: failure === "stopping" ? "stopping" : "active" }),
        send: async () => { throw new Error("send failed"); },
      } },
    });
    try {
      const store = createStore(bb);
      const project = store.tasks.createProject({ name: "Personal", prefix: "TSK", color: "blue" });
      const task = store.tasks.createTask({ projectId: project.id, title: "Keep task", status: "todo" });
      registerDelegation(bb, store);
      await expect(harness.callRpc("delegateToThread", { taskId: task.id, threadId: "thr_existing" })).rejects.toThrow();
      expect(store.tasks.getTask(task.id)?.status).toBe("todo");
      expect(store.tasks.listTaskThreads(task.id)).toEqual([]);
      expect(store.tasks.listComments(task.id)).toEqual([]);
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(failure === "send failed" ? 1 : 0);
    } finally { await harness.dispose(); }
  });
});
