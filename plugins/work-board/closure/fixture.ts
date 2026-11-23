import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { registerDelegation } from "../delegate";
import { registerLifecycle } from "../lifecycle";

type SdkThread = ReturnType<typeof makeThreadResponse>;

/** A deferred gate: reads that wait on it stay pending until `open` is called. */
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** A project with the whole plugin wired to a fake bb whose threads, queues and archive calls the test controls. */
export async function closureFixture(options: { projectSettings?: Record<string, unknown> } = {}) {
  const world = {
    threads: new Map<string, Partial<SdkThread>>(),
    queue: new Map<string, number>(),
    children: new Map<string, number>(),
    archived: [] as string[],
    unarchived: [] as string[],
    sent: [] as Array<{ threadId: string; text: string }>,
    failSend: new Set<string>(),
    failArchive: false,
    failGet: false,
    getGate: null as Promise<void> | null,
    archiveGate: null as Promise<void> | null,
    childGate: null as Promise<void> | null,
    queuedGate: null as Promise<void> | null,
  };
  const host = createFakePluginHost({ pluginId: "work-board" });
  const { bb, harness } = host;
  const thread = (id: string, overrides: Partial<SdkThread> = {}) =>
    makeThreadResponse({ id, projectId: "proj_example", status: "idle", ...world.threads.get(id), ...overrides });
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    if (world.getGate) await world.getGate;
    if (world.failGet) throw new Error("read failed");
    return thread(threadId);
  });
  harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => {
    if (world.archiveGate) await world.archiveGate;
    if (world.failArchive) throw new Error("archive failed");
    world.archived.push(threadId);
    return { ok: true, archivedThreadIds: [threadId] };
  });
  harness.sdk.stub("threads.unarchive", async ({ threadId }: { threadId: string }) => { world.unarchived.push(threadId); return { ok: true }; });
  harness.sdk.stub("threads.queue.list", async ({ threadId }: { threadId: string }) => Array.from({ length: world.queue.get(threadId) ?? 0 }, () => ({})));
  harness.sdk.stub("threads.childSummary", async ({ threadId }: { threadId: string }) => { if (world.childGate) await world.childGate; return { nonDeletedChildCount: 0, unarchivedDescendantCount: world.children.get(threadId) ?? 0 }; });
  harness.sdk.stub("threads.queuedMessages.list", async () => { if (world.queuedGate) await world.queuedGate; return []; });
  harness.sdk.stub("threads.send", async ({ threadId, input }: { threadId: string; input: Array<{ text: string }> }) => {
    if (world.failSend.has(threadId)) throw new Error("send failed");
    world.sent.push({ threadId, text: input[0]!.text });
    return { delivery: "sent" };
  });

  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  registerDelegation(bb, store);
  await registerLifecycle(bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue", linkedBbProjectId: "proj_example" });
  if (options.projectSettings) store.tasks.updateProject(project.id, options.projectSettings);

  const card = (title = "Card", status: "backlog" | "todo" | "in_progress" = "in_progress") => store.tasks.createTask({ projectId: project.id, title, status });
  /** A link as Work Board's own spawn writes it (or any other writer, with `spawned: false`). */
  const link = (task: { id: string }, threadId: string, extra: { spawned?: boolean; liveStatus?: "idle" | "working" | "starting"; origin?: "delegate_spawn" | "delegate_existing" | "discovery" | "manual" | "parent" | null; presetName?: string } = {}) => {
    const spawned = extra.spawned ?? true;
    return store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId,
      presetName: extra.presetName ?? "Preset",
      title: threadId,
      liveStatus: extra.liveStatus ?? "idle",
      linkOrigin: extra.origin === undefined ? (spawned ? "delegate_spawn" : "delegate_existing") : extra.origin,
      createdForTask: spawned,
    });
  };
  /** Closes the card and waits for the evaluation the commit started. */
  const close = async (task: { id: string }, closer?: string, status = "done") => {
    store.tasks.updateTask(task.id, { status, closerThreadId: closer ?? null });
    const id = store.tasks.closures.currentId(task.id)!;
    return { id, out: await store.closures.onClosed(id) };
  };
  const emit = (type: "thread.active" | "thread.idle", threadId: string, overrides: Partial<SdkThread> = {}) =>
    type === "thread.active"
      ? harness.emitThreadEvent("thread.active", { thread: thread(threadId, { status: "active", runtime: { displayStatus: "active" }, ...overrides }) })
      : harness.emitThreadEvent("thread.idle", { thread: thread(threadId, overrides), lastAssistantText: null });
  const comments = (task: { id: string }) => store.tasks.listComments(task.id).map((comment) => comment.body);
  const row = (closureId: string, threadId: string) => store.tasks.closures.row(closureId, threadId);
  const origin = (taskId: string, threadId: string) =>
    bb.storage.database().prepare<[string, string], { created_for_task: number; link_origin: string | null }>("SELECT created_for_task, link_origin FROM task_threads WHERE task_id = ? AND thread_id = ?").get(taskId, threadId);
  return { ...host, store, project, world, thread, card, link, close, emit, comments, row, origin };
}

export type ClosureFixture = Awaited<ReturnType<typeof closureFixture>>;
