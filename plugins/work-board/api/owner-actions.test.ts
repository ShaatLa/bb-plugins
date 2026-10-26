import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { createTasksStore } from "../db";
import { registerDelegation } from "../delegate";
import { registerTasksCli } from "../cli";
import { tasksRpcContract } from "../shared/contract";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});
function setup(failSend = false, archived = false) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: "active",
            archivedAt: archived ? 1 : null,
          }),
        send: async () => {
          if (failSend) throw new Error("Offline");
        },
      },
    },
  });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerDelegation(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({
    name: "Owner work",
    prefix: "OWN",
    color: "blue",
    linkedBbProjectId: "proj_owner",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Grant registry access",
    description: "Owner must grant access. Done when a test pull succeeds.",
    executionTarget: "owner",
    requesterThreadId: "thr_requester",
  });
  return { bb, harness, store, project, task };
}

describe("owner actions", () => {
  it("migrates existing tasks to agent without losing content or hierarchy", () => {
    const { bb, store, project } = setup();
    const parent = store.tasks.createTask({
      projectId: project.id,
      title: "Existing",
    });
    const child = store.tasks.createTask({
      projectId: project.id,
      title: "Child",
      parentTaskId: parent.id,
    });
    const db = bb.storage.database();
    db.exec(
      "ALTER TABLE tasks DROP COLUMN execution_target; ALTER TABLE tasks DROP COLUMN requester_thread_id; DELETE FROM schema_version WHERE version = 11;",
    );
    const migrated = createTasksStore(db);
    expect(migrated.getTask(parent.id)).toEqual(parent);
    expect(migrated.getTask(child.id)).toEqual(child);
    createTasksStore(db);
  });

  it("creates owner tasks in an epic via CLI, remembers the initiating thread and filters independently of type", async () => {
    const { harness, store, project, task } = setup();
    const epic = store.tasks.createTask({
      projectId: project.id,
      title: "Infrastructure",
      type: "epic",
    });
    const result = await harness.runCli(
      [
        "create",
        "--project",
        "OWN",
        "--title",
        "Enable access",
        "--executor",
        "owner",
        "--epic",
        epic.key,
        "--json",
      ],
      { threadId: "thr_creator" },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const created = JSON.parse(result.stdout).task;
    expect(created).toMatchObject({
      executionTarget: "owner",
      requesterThreadId: "thr_creator",
      type: "task",
      epicId: epic.id,
    });
    const owners = await harness.runCli([
      "list",
      "--executor",
      "owner",
      "--type",
      "task",
      "--json",
    ]);
    expect(owners.exitCode, owners.stderr).toBe(0);
    expect(
      JSON.parse(owners.stdout)
        .tasks.map((t: { id: string }) => t.id)
        .sort(),
    ).toEqual([task.id, created.id].sort());
    const agents = tasksRpcContract.listTasks.output.parse(
      await harness.callRpc("listTasks", { executionTarget: "agent" }),
    );
    expect(agents.tasks.map((t) => t.id)).toEqual([epic.id]);
    const page = store.tasks.listTasksPage({ limit: 1 });
    expect(() =>
      store.tasks.listTasksPage({
        limit: 1,
        cursor: page.nextCursor!,
        executionTarget: "owner",
      }),
    ).toThrow("current filters");
    const update = await harness.runCli([
      "update",
      epic.key,
      "--executor",
      "owner",
      "--requester-thread",
      "thr_other",
      "--json",
    ]);
    expect(update.exitCode, update.stderr).toBe(0);
    expect(JSON.parse(update.stdout).task).toMatchObject({
      type: "epic",
      executionTarget: "owner",
      requesterThreadId: "thr_other",
    });
    await expect(
      harness.callRpc("updateTask", {
        taskId: task.id,
        requesterThreadId: "invalid",
      }),
    ).rejects.toThrow();
  });

  it("rejects both dispatch APIs and CLI before contacting threads or changing the task", async () => {
    const { harness, store, task } = setup();
    const before = store.tasks.getTask(task.id);
    await expect(
      harness.callRpc("delegateToThread", {
        taskId: task.id,
        threadId: "thr_target",
      }),
    ).rejects.toThrow("Owner actions cannot be dispatched");
    await expect(
      harness.callRpc("delegate", { taskId: task.id, presetId: task.id }),
    ).rejects.toThrow("Owner actions cannot be dispatched");
    const result = await harness.runCli([
      "dispatch",
      task.key,
      "--thread",
      "thr_target",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Owner actions cannot be dispatched");
    expect(harness.sdk.callsTo("threads.get")).toHaveLength(0);
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([]);
    expect(store.tasks.getTask(task.id)).toEqual(before);
  });

  it.each(["updateTask", "boardMove"] as const)(
    "records completion and queues exactly one notification on %s",
    async (method) => {
      const { harness, store, task } = setup();
      const complete = () =>
        harness.callRpc(method, { taskId: task.id, status: "done" });
      expect(await complete()).toMatchObject({
        ok: true,
        task: { status: "done" },
        notification: "sent",
      });
      await complete();
      expect(harness.sdk.callsTo("threads.send")).toMatchObject([
        [{ threadId: "thr_requester", mode: "queue-if-active" }],
      ]);
      const completion = store.tasks
        .listComments(task.id)
        .filter((c) => c.body.startsWith("Owner action completed"));
      expect(completion).toHaveLength(1);
      expect(completion[0]?.notifiedCount).toBe(1);
      await harness.callRpc("updateTask", { taskId: task.id, status: "todo" });
      await complete();
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(2);
    },
  );

  it.each([
    [true, false],
    [false, true],
  ])(
    "preserves Done and exposes undelivered feedback (send failure=%s, archived=%s)",
    async (failSend, archived) => {
      const { harness, store, task } = setup(failSend, archived);
      const result = await harness.runCli([
        "update",
        task.key,
        "--status",
        "done",
        "--json",
      ]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        task: { status: "done" },
        notification: "not_sent",
      });
      expect(store.tasks.getTask(task.id)?.status).toBe("done");
      expect(
        store.tasks
          .listComments(task.id)
          .some(
            (c) =>
              c.body.toLowerCase().includes("notify") &&
              c.body.includes("manually"),
          ),
      ).toBe(true);
    },
  );

  it("does not notify for ordinary tasks or missing requester and refuses conversion while agents are working", async () => {
    const { harness, store, project, task } = setup();
    const agent = store.tasks.createTask({
      projectId: project.id,
      title: "Agent work",
    });
    store.tasks.upsertTaskThread({
      taskId: agent.id,
      threadId: "thr_running",
      presetName: "Worker",
      title: "Work",
      liveStatus: "working",
    });
    expect(
      await harness.callRpc("updateTask", {
        taskId: agent.id,
        executionTarget: "owner",
      }),
    ).toMatchObject({ ok: false, error: { code: "task_execution_invalid" } });
    await harness.callRpc("updateTask", { taskId: agent.id, status: "done" });
    await harness.callRpc("updateTask", {
      taskId: task.id,
      requesterThreadId: null,
      status: "done",
    });
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });
});
