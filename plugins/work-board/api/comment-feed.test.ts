import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { attachmentSchema, tasksRpcContract } from "../shared/contract";
import { createStore, registerTasksApi } from ".";

type Host = ReturnType<typeof createFakePluginHost>;
const hosts: Host[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.harness.dispose())); });

type Thread = ReturnType<typeof makeThreadResponse>;
interface Options {
  threads?: Record<string, Partial<Thread>>;
  listFails?: () => boolean;
  getFails?: () => boolean;
}

function setup(options: Options = {}) {
  const stats = { inFlight: 0, maxInFlight: 0 };
  const threads = options.threads ?? {};
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        // Like the host: list serves live threads (archived only on request) and omits deleted/unknown ids.
        list: async (args?: { threadIds?: readonly string[]; archived?: boolean }) => {
          if (options.listFails?.()) throw new Error("list unavailable");
          return (args?.threadIds ?? []).flatMap((id) => {
            const thread = threads[id];
            if (!thread || thread.deletedAt != null) return [];
            return (thread.archivedAt != null) === (args?.archived === true) ? [makeThreadResponse({ id, ...thread })] : [];
          });
        },
        get: async ({ threadId }: { threadId: string }) => {
          stats.inFlight += 1;
          stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          stats.inFlight -= 1;
          if (options.getFails?.()) throw new Error("host unavailable");
          const thread = threads[threadId];
          if (!thread) throw Object.assign(new Error("thread_not_found"), { code: "thread_not_found" });
          return makeThreadResponse({ id: threadId, ...thread });
        },
      },
      providers: { list: async () => [{ id: "codex", displayName: "Codex", logoUrl: null }] },
    },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Feed", prefix: "FED", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Card" });
  const comment = (kind: "agent" | "system" | "user", threadId: string | null, body = `${kind} ${threadId}`) =>
    store.tasks.createComment({ taskId: task.id, kind, authorName: kind, threadId, body });
  const call = (method: string, input: unknown) => host.harness.callRpc(method as never, input as never) as Promise<any>;
  return { host, store, task, comment, call, stats };
}

describe("comment feed RPCs", () => {
  it("keeps legacy responses exactly as before unless the revision is requested", async () => {
    const { task, comment, call } = setup({ threads: { thr_a: { providerId: "codex" } } });
    const stored = comment("agent", "thr_a");
    const legacyComments = z.object({ comments: z.array(z.unknown()) }).strict();
    const legacyAttachments = z.object({ attachments: z.array(attachmentSchema) }).strict();
    legacyComments.parse(await call("listComments", { taskId: task.id }));
    legacyComments.parse(await call("listComments", { taskId: task.id, resolveMetadata: false }));
    legacyAttachments.parse(await call("listAttachments", { commentsOfTaskId: task.id }));
    legacyAttachments.parse(await call("listAttachments", { taskId: task.id }));
    legacyAttachments.parse(await call("listAttachments", { commentId: stored.id }));
    const withRevision = await call("listComments", { taskId: task.id, withRevision: true });
    expect(typeof withRevision.revision).toBe("string");
    expect(() => legacyComments.parse(withRevision)).toThrow(); // the legacy shape really is strict
    expect(typeof (await call("listAttachments", { commentsOfTaskId: task.id, withRevision: true })).revision).toBe("string");
  });

  it("changes the revision for comment, comment-attachment and notified-count changes only", async () => {
    const { task, store, comment, call } = setup();
    const first = comment("user", null);
    const token = async () => (await call("commentsRevision", { taskId: task.id })).revision as string;
    const joined = async () => {
      const c = await call("listComments", { taskId: task.id, withRevision: true, resolveMetadata: false });
      const a = await call("listAttachments", { commentsOfTaskId: task.id, withRevision: true });
      return `${c.revision}|${a.revision}`;
    };
    const base = await token();
    expect(await joined()).toBe(base);
    await call("updateTask", { taskId: task.id, title: "Renamed" });
    store.tasks.createAttachment({ taskId: task.id, fileName: "t.txt", mime: "text/plain", sizeBytes: 1, blobPath: "t", isImage: false });
    expect(await token()).toBe(base);
    comment("user", null);
    const afterComment = await token();
    expect(afterComment).not.toBe(base);
    const attachment = store.tasks.createAttachment({ commentId: first.id, fileName: "c.txt", mime: "text/plain", sizeBytes: 1, blobPath: "c", isImage: false });
    const afterAttachment = await token();
    expect(afterAttachment).not.toBe(afterComment);
    store.tasks.deleteAttachment(attachment.id);
    expect(await token()).not.toBe(afterAttachment);
    const beforeNotify = await token();
    store.tasks.updateComment(first.id, { notifiedCount: 2 });
    expect(await token()).not.toBe(beforeNotify);
    expect(await joined()).toBe(await token());
  });

  it("resolves thread metadata with batched lists and matches the default listComments", async () => {
    const { task, comment, call, host } = setup({
      threads: {
        thr_live: { title: "Live work", providerId: "codex" },
        thr_archived: { title: "Old work", providerId: "codex", archivedAt: 1 },
        thr_deleted: { title: "Gone work", providerId: "codex", deletedAt: 1 },
        thr_side: { title: "Side", providerId: "codex", originKind: "fork", originPluginId: "side-chat", visibility: "hidden" },
      },
    });
    for (const id of ["thr_live", "thr_archived", "thr_deleted", "thr_side", "thr_unknown", "thr_live"]) comment("agent", id);
    comment("system", "thr_live"); // a system row may reuse a worker's thread id
    const result = await call("listCommentThreads", { taskId: task.id });
    expect(result.complete).toBe(true);
    const byThread = new Map<string, any>(result.threads.map((thread: any) => [thread.threadId, thread]));
    expect([...byThread.keys()].sort()).toEqual(["thr_archived", "thr_deleted", "thr_live", "thr_side"]);
    expect(byThread.get("thr_live").threadTitle).toBe("Live work");
    expect(byThread.get("thr_archived").threadTitle).toBe("Old work");
    expect(byThread.get("thr_deleted").threadTitle).toBe("Gone work");
    expect(byThread.get("thr_side").threadTitle).toBeNull();
    expect(byThread.get("thr_live").provider).toMatchObject({ id: "codex", name: "Codex" });
    // Active list, archived list, then get only for the ids no list returned (deleted, unknown).
    expect(host.harness.sdk.callsTo("threads.list")).toHaveLength(2);
    expect(host.harness.sdk.callsTo("threads.get").map(([args]: any) => args.threadId).sort()).toEqual(["thr_deleted", "thr_unknown"]);
    const listed = tasksRpcContract.listComments.output.parse(await call("listComments", { taskId: task.id }));
    for (const entry of listed.comments) {
      const meta = entry.kind === "agent" && entry.threadId ? byThread.get(entry.threadId) : undefined;
      expect(entry.threadTitle).toBe(meta?.threadTitle ?? null);
      expect(entry.provider).toEqual(meta?.provider ?? null);
    }
    expect(listed.comments.find((entry) => entry.kind === "system")?.threadTitle).toBeNull();
  });

  it("checks every list-omitted id with get, a few at a time", async () => {
    const threads: Record<string, Partial<Thread>> = { thr_reachable: { title: "Reachable", providerId: "codex", deletedAt: 1 } };
    const { task, comment, call, stats } = setup({ threads });
    for (let i = 0; i < 30; i += 1) comment("agent", `thr_miss${i}`);
    comment("agent", "thr_reachable"); // after 30 not-found misses
    const result = await call("listCommentThreads", { taskId: task.id });
    expect(result.complete).toBe(true);
    expect(result.threads.map((thread: any) => thread.threadId)).toEqual(["thr_reachable"]);
    expect(stats.maxInFlight).toBeLessThanOrEqual(5);
    expect(stats.maxInFlight).toBeGreaterThan(1);
  });

  it("flags a failed lookup as incomplete and recovers on the next read", async () => {
    let down = true;
    const { task, comment, call } = setup({
      threads: { thr_a: { title: "Worker", providerId: "codex" } },
      listFails: () => down,
      getFails: () => down,
    });
    comment("agent", "thr_a");
    const failed = await call("listCommentThreads", { taskId: task.id });
    expect(failed).toEqual({ threads: [], complete: false });
    down = false;
    const recovered = await call("listCommentThreads", { taskId: task.id });
    expect(recovered.complete).toBe(true);
    expect(recovered.threads[0]).toMatchObject({ threadId: "thr_a", threadTitle: "Worker" });
  });

  it("chunks a large thread set into lists of at most 200", async () => {
    const threads: Record<string, Partial<Thread>> = {};
    const { task, comment, call, host } = setup({ threads });
    for (let i = 0; i < 450; i += 1) { threads[`thr_${i}`] = { title: `T${i}`, providerId: "codex" }; comment("agent", `thr_${i}`); }
    const result = await call("listCommentThreads", { taskId: task.id });
    expect(result.threads).toHaveLength(450);
    const lists = host.harness.sdk.callsTo("threads.list") as any[][];
    expect(lists.map(([args]) => args.threadIds.length)).toEqual([200, 200, 50]);
    expect(host.harness.sdk.callsTo("threads.get")).toHaveLength(0);
  });
});
