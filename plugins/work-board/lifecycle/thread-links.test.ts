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
import { reconcileTaskThreads, reconcileTaskThreadsStrict } from "./thread-links";
import { deliverCommentToLatestAgent } from "../steer";
import { createStructuredStore } from "../structured/store";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});
function setup() {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
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

it("throws a failed read to a strict caller, also one that joined another caller's run", async () => {
  const f = setup();
  f.add("thr_new");
  f.harness.sdk.stub("threads.get", async () => {
    throw new Error("Offline");
  });
  const [lenient, strict] = await Promise.allSettled([
    reconcileTaskThreads(f.bb, f.store.tasks, f.task.id),
    reconcileTaskThreadsStrict(f.bb, f.store.tasks, f.task.id),
  ]);
  expect(lenient).toMatchObject({ status: "fulfilled", value: [{ threadId: "thr_new" }] });
  expect(strict).toMatchObject({ status: "rejected", reason: { message: "Offline" } });
  expect(f.harness.sdk.callsTo("threads.get")).toHaveLength(1);
});

it("reruns once on links changed during the reads, and never lists a stopping session to a lenient caller", async () => {
  const f = setup();
  f.add("thr_stop");
  f.threads.set("thr_stop", { ...f.threads.get("thr_stop")!, status: "stopping" });
  let late = 0;
  f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    const thread = f.threads.get(threadId)!;
    // Each of the first two runs sees a session attached while it reads.
    if (threadId === "thr_stop" && late < 2) f.add(`thr_late_${++late}`);
    return thread;
  });
  const links = await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id);
  expect(late).toBe(2);
  expect(links.map((link) => link.threadId).sort()).toEqual(["thr_late_1", "thr_late_2"]);
  expect(f.store.tasks.listTaskThreads(f.task.id)).toHaveLength(3);
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
    const { question } = await structured.handlers.createQuestion({ kind: "decision", askedByThread: null,
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

// A parent-fallback link on the card, then one more linked thread with the given title and origin.
async function withParentAndChild(title: string, linkOrigin: "discovery" | "manual", cardKey?: string) {
  const f = setup();
  f.add("thr_old", true);
  await reconcileTaskThreads(f.bb, f.store.tasks, f.task.id);
  const task = cardKey ? f.store.tasks.createTask({ projectId: f.project.id, title: "Other card" }) : f.task;
  if (cardKey) {
    // the fallback link above belongs to the first card; build the same state on the second one
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_parent", presetName: "Parent thread", title: "Parent", liveStatus: "idle", linkOrigin: "parent" });
    f.store.tasks.createComment({ taskId: task.id, threadId: "thr_parent", kind: "system", authorName: "Work Board", body: "Thread attached (parent fallback): @thread:thr_parent" });
  }
  f.threads.set("thr_child", makeThreadResponse({ id: "thr_child", title, status: "active", parentThreadId: "thr_parent" }));
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_child", presetName: "Auto attached", title, liveStatus: "working", linkOrigin });
  const links = await reconcileTaskThreads(f.bb, f.store.tasks, task.id);
  const replaced = f.store.tasks.listComments(task.id).some((c) => c.body.includes("Thread detached (replaced)"));
  return { f, task, ids: links.map((link) => link.threadId).sort(), replaced };
}

it.each(["review", "plan-review", "code-review", "check"])("keeps the parent link when a title-attached %s child joins", async (role) => {
  const probe = setup();
  const { ids, replaced } = await withParentAndChild(`${probe.task.key} ${role}: Reroute work`, "discovery");
  expect(ids).toEqual(["thr_child", "thr_parent"]);
  expect(replaced).toBe(false);
});

it("keeps the parent link on every card of an EXA-1+2 style review title", async () => {
  const probe = setup();
  const [prefix] = probe.task.key.split("-");
  const first = await withParentAndChild(`${prefix}-1+2 review: Both`, "discovery");
  expect(first.task.key).toBe(`${prefix}-1`);
  expect(first.ids).toEqual(["thr_child", "thr_parent"]);
  const second = await withParentAndChild(`${prefix}-1+2 review: Both`, "discovery", "second");
  expect(second.task.key).toBe(`${prefix}-2`);
  expect(second.ids).toEqual(["thr_child", "thr_parent"]);
});

it("still replaces the parent link for a title-attached implementation child", async () => {
  const probe = setup();
  const { ids, replaced } = await withParentAndChild(`${probe.task.key} impl: Reroute work`, "discovery");
  expect(ids).toEqual(["thr_child"]);
  expect(replaced).toBe(true);
});

it("counts an explicitly linked thread as a worker whatever its title", async () => {
  const probe = setup();
  const { ids, replaced } = await withParentAndChild(`${probe.task.key} review: Reroute work`, "manual");
  expect(ids).toEqual(["thr_child"]);
  expect(replaced).toBe(true);
});

it("does not treat a review of another card as a reviewer of this one", async () => {
  const { ids, replaced } = await withParentAndChild("EXA-3 review: Elsewhere", "discovery");
  expect(ids).toEqual(["thr_child"]);
  expect(replaced).toBe(true);
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
  expect(capture.manifest.version).toBe(26);
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
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

it("starts independent worker lookups in parallel", async () => {
  const f = setup();
  f.add("thr_parallel_one");
  f.add("thr_parallel_two");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  f.harness.sdk.stub("threads.get", async ({ threadId }) => {
    started.push(threadId);
    await gate;
    return f.threads.get(threadId)!;
  });
  const result = reconcileTaskThreads(f.bb, f.store.tasks, f.task.id);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started.sort()).toEqual(["thr_parallel_one", "thr_parallel_two"]);
  } finally {
    release();
    await result;
  }
});

it("does not hand a finished task to the parent and releases a fallback parent when the task finishes", async () => {
  const done = setup();
  done.add("thr_worker", true);
  done.store.tasks.updateTask(done.task.id, { status: "done" });
  expect(await reconcileTaskThreads(done.bb, done.store.tasks, done.task.id)).toEqual([]);
  expect(done.store.tasks.listComments(done.task.id).some((comment) => comment.body.includes("parent fallback"))).toBe(false);

  const open = setup();
  open.add("thr_worker", true);
  expect(await reconcileTaskThreads(open.bb, open.store.tasks, open.task.id)).toMatchObject([{ threadId: "thr_parent", presetName: "Parent thread" }]);
  open.store.tasks.updateTask(open.task.id, { status: "in_review" });
  expect(open.store.tasks.listTaskThreads(open.task.id)).toHaveLength(1);
  open.store.tasks.updateTask(open.task.id, { status: "canceled" });
  expect(open.store.tasks.listTaskThreads(open.task.id)).toEqual([]);
});
