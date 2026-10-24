import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerLifecycle } from ".";
import { handlers as delegationHandlers } from "../delegate";
import {
  archiveRecords,
  captureProject,
  restoreProject,
} from "../archive/storage";
import { reconcileTaskThreads } from "./thread-links";
import { deliverCommentToLatestAgent } from "../steer";
import { createStructuredStore } from "../structured/store";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});
function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "tasks-plus",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread)
            throw Object.assign(new Error("Missing thread"), {
              code: "thread_not_found",
            });
          return thread;
        },
        send: async () => {},
      },
    },
  });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({
    name: "Thread routing",
    prefix: "ROUTE",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Reroute work",
  });
  const add = (
    id: string,
    archived = false,
    parentThreadId: string | null = "thr_parent",
  ) => {
    const thread = makeThreadResponse({
      id,
      title: id,
      status: "idle",
      archivedAt: archived ? 1 : null,
      parentThreadId,
    });
    threads.set(id, thread);
    const link = store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: id,
      presetName: "Worker",
      title: id,
      liveStatus: "idle",
    });
    return { thread, link };
  };
  threads.set(
    "thr_parent",
    makeThreadResponse({
      id: "thr_parent",
      title: "Parent",
      status: "idle",
      parentThreadId: "thr_grandparent",
    }),
  );
  return { bb, harness, store, project, task, threads, add };
}

it("removes an archived predecessor, keeps its replacement and records history once", async () => {
  const f = setup();
  f.add("thr_old", true);
  f.add("thr_new");
  const result = await f.harness.callRpc("listTaskThreads", {
    taskId: f.task.id,
  });
  expect(result).toMatchObject({ taskThreads: [{ threadId: "thr_new" }] });
  expect(f.store.tasks.listComments(f.task.id)).toMatchObject([
    {
      threadId: "thr_old",
      kind: "system",
      body: expect.stringContaining("Thread detached (archived)"),
    },
  ]);
  await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(1);
});

it("inherits the latest worker's nearest available BB ancestor and continues upward after it is archived", async () => {
  const f = setup();
  const older = f.add("thr_old", true, "thr_older_parent");
  f.bb.storage
    .database()
    .prepare("UPDATE task_threads SET attached_at = '2020-01-01' WHERE id = ?")
    .run(older.link.id);
  f.add("thr_new", true);
  const result = await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id);
  expect(result).toMatchObject([
    { threadId: "thr_parent", presetName: "Parent thread" },
  ]);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(3);
  expect(f.store.tasks.listComments(f.task.id).map((c) => c.threadId)).toEqual(
    expect.arrayContaining(["thr_old", "thr_new", "thr_parent"]),
  );
  expect(f.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  f.threads.set("thr_parent", {
    ...f.threads.get("thr_parent")!,
    archivedAt: 1,
  });
  f.threads.set(
    "thr_grandparent",
    makeThreadResponse({ id: "thr_grandparent", status: "idle" }),
  );
  expect(
    await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
  ).toMatchObject([{ threadId: "thr_grandparent" }]);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(5);
  f.threads.set("thr_grandparent", {
    ...f.threads.get("thr_grandparent")!,
    archivedAt: 1,
  });
  expect(await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id)).toEqual(
    [],
  );
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(6);
});

it("frees a task if its workers and immediate parent are archived without touching other tasks", async () => {
  const f = setup();
  f.add("thr_old", true);
  f.add("thr_new", true);
  f.threads.set("thr_parent", {
    ...f.threads.get("thr_parent")!,
    archivedAt: 1,
  });
  const other = f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Other task",
  });
  f.store.tasks.upsertTaskThread({
    taskId: other.id,
    threadId: "thr_old",
    title: "Other link",
    presetName: "Worker",
    liveStatus: "idle",
  });
  expect(await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id)).toEqual(
    [],
  );
  expect(f.store.tasks.listTaskThreads(other.id)).toHaveLength(1);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(2);
  f.store.tasks.createComment({
    taskId: f.task.id,
    kind: "agent",
    authorName: "Old worker",
    threadId: "thr_new",
    body: "Old reply",
  });
  expect(
    await deliverCommentToLatestAgent(f.bb, f.store.tasks, {
      taskId: f.task.id,
      commentId: "test",
      body: "Decision",
      authorName: "Owner",
    }),
  ).toBe(0);
  expect(f.harness.sdk.callsTo("threads.send")).toHaveLength(0);
});

it("preserves all links and their history on transient SDK failures", async () => {
  const f = setup();
  f.add("thr_old", true);
  f.add("thr_new");
  f.harness.sdk.stub("threads.get", async () => {
    throw new Error("Offline");
  });
  expect(
    await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
  ).toHaveLength(2);
  expect(f.store.tasks.listComments(f.task.id)).toEqual([]);
});

it("handles missing threads without inventing a parent", async () => {
  const f = setup();
  f.add("thr_missing");
  f.threads.delete("thr_missing");
  expect(await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id)).toEqual(
    [],
  );
  expect(f.store.tasks.listComments(f.task.id)[0]?.body).toContain(
    "detached (missing)",
  );
});

it("reconciles archive events even for terminal cached workers", async () => {
  const f = setup();
  const { thread, link } = f.add("thr_worker");
  f.store.tasks.updateTaskThreadStatus(link.id, "completed");
  await registerLifecycle(f.bb, f.store);
  await f.harness.emitThreadEvent("thread.archived", {
    thread: { ...thread, archivedAt: 1 },
  });
  expect(f.store.tasks.listTaskThreads(f.task.id)).toMatchObject([
    { threadId: "thr_parent" },
  ]);
});

it.each([false, true])(
  "routes a saved answer to the replacement or the parent (parent=%s)",
  async (parent) => {
    const f = setup();
    f.add("thr_old", true);
    f.add("thr_new", parent);
    const structured = createStructuredStore(f.bb, f.store);
    const { question } = await structured.handlers.createQuestion({
      taskId: f.task.id,
      prompt: "Proceed?",
      mode: "single",
      options: ["Yes", "No"],
    });
    const result = await structured.handlers.answerQuestion({
      questionId: question.id,
      revision: question.revision,
      selectedOptionIds: [question.options[0]!.id],
      authorName: "Owner",
    });
    expect(result.notification).toBe("sent");
    expect(f.harness.sdk.callsTo("threads.send")).toEqual([
      [
        expect.objectContaining({
          threadId: parent ? "thr_parent" : "thr_new",
          mode: "queue-if-active",
        }),
      ],
    ]);
  },
);

it("releases a fallback parent when a replacement worker takes over", async () => {
  const f = setup();
  f.add("thr_old", true);
  await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id);
  f.add("thr_new");
  expect(
    await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
  ).toMatchObject([{ threadId: "thr_new" }]);
  expect(f.store.tasks.listComments(f.task.id)).toContainEqual(
    expect.objectContaining({
      threadId: "thr_parent",
      body: expect.stringContaining("Thread detached (replaced)"),
    }),
  );
});

it("preserves assignment history through an archive v6 round-trip", async () => {
  const f = setup();
  f.add("thr_old", true);
  f.threads.set("thr_parent", {
    ...f.threads.get("thr_parent")!,
    archivedAt: 1,
  });
  await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id);
  const capture = captureProject(f.bb, f.store, f.project.id);
  const records = await archiveRecords(f.store, capture, async () => {});
  expect(capture.manifest.version).toBe(6);
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks-plus" });
  harnesses.push(harness);
  const restored = createStore(bb);
  restoreProject(
    bb,
    restored,
    { manifest: capture.manifest, records },
    new Map(),
    false,
  );
  expect(restored.tasks.listTaskThreads(f.task.id)).toEqual([]);
  expect(restored.tasks.listComments(f.task.id)).toEqual(
    f.store.tasks.listComments(f.task.id),
  );
});

it("records explicit attach/detach history and refuses archived attachments", async () => {
  const f = setup();
  f.threads.set(
    "thr_worker",
    makeThreadResponse({ id: "thr_worker", status: "idle" }),
  );
  const api = delegationHandlers(f.bb, f.store);
  await api.taskThreadsAttach({ taskId: f.task.id, threadId: "thr_worker" });
  await api.taskThreadsAttach({ taskId: f.task.id, threadId: "thr_worker" });
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(1);
  await api.taskThreadsDetach({ taskId: f.task.id, threadId: "thr_worker" });
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(2);
  expect(await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id)).toEqual(
    [],
  );
  f.threads.set("thr_worker", {
    ...f.threads.get("thr_worker")!,
    archivedAt: 1,
  });
  await expect(
    api.taskThreadsAttach({ taskId: f.task.id, threadId: "thr_worker" }),
  ).rejects.toThrow("not archived");
});

it("coalesces concurrent checks without duplicate detachment history", async () => {
  const f = setup();
  f.add("thr_old", true);
  await Promise.all([
    reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
    reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
  ]);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(2);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(1);
});

it("repairs archived associations on startup even when their cached status was completed", async () => {
  const f = setup();
  const { link } = f.add("thr_old", true);
  f.store.tasks.updateTaskThreadStatus(link.id, "completed");
  await registerLifecycle(f.bb, f.store);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toMatchObject([
    { threadId: "thr_parent" },
  ]);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(2);
});

it("walks past archived ancestors to an available root", async () => {
  const f = setup();
  f.add("thr_worker", true);
  f.threads.set("thr_parent", {
    ...f.threads.get("thr_parent")!,
    archivedAt: 1,
  });
  f.threads.set(
    "thr_grandparent",
    makeThreadResponse({
      id: "thr_grandparent",
      archivedAt: 1,
      parentThreadId: "thr_root",
    }),
  );
  f.threads.set(
    "thr_root",
    makeThreadResponse({
      id: "thr_root",
      status: "idle",
      parentThreadId: null,
    }),
  );
  expect(
    await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
  ).toMatchObject([{ threadId: "thr_root" }]);
  expect(f.harness.sdk.callsTo("threads.get").flat()).toEqual(
    ["thr_worker", "thr_parent", "thr_grandparent", "thr_root"].map(
      (threadId) => ({ threadId }),
    ),
  );
  expect(f.store.tasks.listComments(f.task.id).at(-1)).toMatchObject({
    threadId: "thr_root",
    body: expect.stringContaining("parent fallback"),
  });
});

it("stops at the nearest available ancestor even if its parent is available too", async () => {
  const f = setup();
  f.add("thr_worker", true);
  f.threads.set(
    "thr_grandparent",
    makeThreadResponse({ id: "thr_grandparent", status: "idle" }),
  );
  expect(
    await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
  ).toMatchObject([{ threadId: "thr_parent" }]);
  expect(f.harness.sdk.callsTo("threads.get").flat()).not.toContainEqual({
    threadId: "thr_grandparent",
  });
});

it.each(["thr_worker", "thr_parent"])(
  "terminates an ancestor cycle through %s",
  async (parentThreadId) => {
    const f = setup();
    f.add("thr_worker", true);
    f.threads.set("thr_parent", {
      ...f.threads.get("thr_parent")!,
      archivedAt: 1,
      parentThreadId,
    });
    expect(await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id)).toEqual(
      [],
    );
    expect(f.harness.sdk.callsTo("threads.get")).toHaveLength(2);
    expect(f.store.tasks.listComments(f.task.id)).toHaveLength(1);
  },
);

it("preserves the assignment when a higher ancestor cannot be checked", async () => {
  const f = setup();
  f.add("thr_worker", true);
  f.threads.set("thr_parent", {
    ...f.threads.get("thr_parent")!,
    archivedAt: 1,
  });
  f.harness.sdk.stub("threads.get", async ({ threadId }) => {
    if (threadId === "thr_grandparent") throw new Error("Offline");
    return f.threads.get(threadId)!;
  });
  expect(
    await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
  ).toMatchObject([{ threadId: "thr_worker" }]);
  expect(f.store.tasks.listComments(f.task.id)).toEqual([]);
});

it("walks through an older attached worker when the replacement is its child", async () => {
  const f = setup();
  const older = f.add("thr_old", true);
  f.bb.storage.database().prepare("UPDATE task_threads SET attached_at = '2020-01-01' WHERE id = ?").run(older.link.id);
  f.add("thr_new", true, "thr_old");
  expect(await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id)).toMatchObject([{ threadId: "thr_parent" }]);
  expect(f.store.tasks.listComments(f.task.id)).toHaveLength(3);
});
