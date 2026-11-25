import type { LinkOrigin } from "../db/types";
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
    /** Each environment's Git state as the fake `bb--git` reports it; a missing one is a clean checkout. */
    git: new Map<string, { head: string | null; files: Map<string, string>; truncated?: boolean; checkout?: "branch" | "unborn" | "unknown" }>(),
    /** `bb--git` is missing, disabled or offline: every call rejects. */
    gitFail: false,
    /** Every `bb--git` call waits for this. */
    gitGate: null as Promise<void> | null,
    gitCalls: [] as Array<{ method: string; environmentId: string; signal: unknown }>,
    /** The environment thread listing rejects. */
    listFail: false,
  };
  const host = createFakePluginHost({ pluginId: "work-board" });
  const { bb, harness } = host;
  // Each thread has an environment of its own unless the test shares one.
  const thread = (id: string, overrides: Partial<SdkThread> = {}) =>
    makeThreadResponse({ id, projectId: "proj_example", status: "idle", environmentId: `env_${id}`, ...world.threads.get(id), ...overrides });
  const gitState = (environmentId: string) => {
    if (!world.git.has(environmentId)) world.git.set(environmentId, { head: "a".repeat(40), files: new Map() });
    return world.git.get(environmentId)!;
  };
  /** Edits a file in the environment of a thread: a new revision, with the same line counts. */
  let revisions = 0;
  const edit = (threadId: string, path = "src/example.ts") => { gitState(thread(threadId).environmentId!).files.set(path, `rev_${++revisions}`); };
  const commit = (threadId: string) => { const state = gitState(thread(threadId).environmentId!); state.head = (++revisions).toString(16).padStart(40, "0"); state.files.clear(); state.checkout = "branch"; };
  // Response shapes follow `bb plugin rpc inspect bb--git` (status and files).
  harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; input: { keys?: string[]; environmentId?: string }; outputSchema: { parse: (value: unknown) => unknown }; signal?: AbortSignal }) => {
    if (args.pluginId !== "bb--git") throw new Error(`unexpected plugin ${args.pluginId}`);
    const environmentId = args.input.environmentId ?? args.input.keys![0]!;
    world.gitCalls.push({ method: args.method, environmentId, signal: args.signal });
    if (world.gitGate) await world.gitGate;
    if (world.gitFail) throw new Error("plugin unavailable");
    const state = gitState(environmentId);
    if (args.method === "status") {
      const checkout = state.checkout === "unknown" ? { kind: "unknown", reason: "not checked out" } : state.checkout === "unborn" ? { kind: "unborn", branchName: "main" } : { kind: "branch", branchName: "main", headSha: state.head };
      const workingTree = { insertions: 0, deletions: 0, lineStatsComplete: true, fileCount: state.files.size, files: [...state.files.keys()].map((path) => ({ path, status: "M", insertions: 1, deletions: 1 })), hasUncommittedChanges: state.files.size > 0, state: state.files.size ? "dirty_uncommitted" : "clean" };
      return args.outputSchema.parse({ [environmentId]: { outcome: "available", workspace: { workingTree, checkout, branch: { currentBranch: "main", defaultBranch: "main" }, mergeBase: null, allChanges: { insertions: 0, deletions: 0, lineStatsComplete: true, fileCount: state.files.size } } } });
    }
    if (args.method === "files") {
      const files = [...state.files].map(([path, revision]) => ({ path, previousPath: null, changeKind: "modified", additions: 1, deletions: 1, binary: false, origin: "tracked", loadMode: "auto", revision }));
      return args.outputSchema.parse({ outcome: "available", files, truncated: state.truncated ?? false, shortstat: "", mergeBaseRef: null, initialPatches: [] });
    }
    throw new Error(`unexpected method ${args.method}`);
  });
  harness.sdk.stub("threads.list", async ({ environmentId, archived }: { environmentId?: string; archived?: boolean }) => {
    if (world.listFail) throw new Error("list failed");
    return [...world.threads.keys()].map((id) => thread(id)).filter((entry) => entry.environmentId === environmentId && (entry.archivedAt != null) === Boolean(archived));
  });
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
  const link = (task: { id: string }, threadId: string, extra: { spawned?: boolean; liveStatus?: "idle" | "working" | "starting"; origin?: LinkOrigin | null; presetName?: string } = {}) => {
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
  /** A turn of the thread: it starts, `during` runs (an edit, a commit, nothing), and it ends. */
  const turn = async (threadId: string, during: () => void | Promise<void> = () => {}, overrides: Partial<SdkThread> = {}) => {
    await emit("thread.active", threadId, overrides);
    await during();
    await emit("thread.idle", threadId, overrides);
  };
  return { ...host, store, project, world, thread, card, link, close, emit, comments, row, origin, edit, commit, turn };
}

export type ClosureFixture = Awaited<ReturnType<typeof closureFixture>>;
