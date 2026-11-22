// @vitest-environment jsdom
// The real detail view and real useTasksQuery over the real API on a fake plugin host: what the activity feed costs
// and shows after realtime events.
import { cleanup } from "@testing-library/react";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../../api/index.js";
import { publishAttachmentChanged } from "../../attachments/index.js";
import { tasksRpcContract } from "../../shared/contract.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { useTasksQuery } from "../../shell/data.js";

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as never;
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as never;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const app = await loadPluginApp(() => import("../../app"));
afterEach(cleanup);
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
const FEED_METHODS = ["listComments", "commentsRevision", "listCommentThreads"];

async function mount(options: { block?: string } = {}) {
  let threadsDown = false;
  let release: () => void = () => {};
  const blocked = options.block ? new Promise<void>((resolve) => (release = resolve)) : null;
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        list: async (args?: { threadIds?: readonly string[]; archived?: boolean }) => {
          if (threadsDown) throw new Error("host unavailable");
          return args?.archived ? [] : (args?.threadIds ?? []).map((id) => makeThreadResponse({ id, title: `Worker ${id}`, providerId: "codex" }));
        },
        get: async () => { throw new Error("host unavailable"); },
      },
      providers: { list: async () => [{ id: "codex", displayName: "Codex", logoUrl: null }] },
    },
  });
  const events: Array<{ channel: string; payload: unknown }> = [];
  const publish = bb.realtime.publish.bind(bb.realtime);
  (bb.realtime as { publish: unknown }).publish = (channel: string, payload: unknown) => {
    events.push({ channel, payload });
    return publish(channel as never, payload as never);
  };
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Feed", prefix: "FED", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Card" });
  const comments = Array.from({ length: 6 }, (_, i) =>
    store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "agent", threadId: "thr_a", body: `Progress ${i}` }),
  );
  const log: Array<{ method: string; input: any }> = [];
  const failNext = new Set<string>();
  const hold: { gate: Promise<void> | null } = { gate: null };
  const rpc: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const method of Object.keys(tasksRpcContract)) {
    rpc[method] = async (input) => {
      log.push({ method, input });
      if (method === options.block) await blocked;
      if (failNext.delete(method)) throw new Error(`${method} failed`);
      const result = await harness.callRpc(method as never, input as never);
      // Holds the first matching response after the database was read, as a slow link would.
      if (method === "listComments" && hold.gate) { const gate = hold.gate; hold.gate = null; await gate; }
      return result;
    };
  }
  const slot = renderSlot(app.navPanels[0]!, { subPath: `task/${task.key}` }, { rpc: rpc as never });
  const feedCalls = () => log.filter((entry) => FEED_METHODS.includes(entry.method) || (entry.method === "listAttachments" && "commentsOfTaskId" in entry.input));
  const replay = async (action: () => Promise<unknown> | unknown) => {
    events.length = 0;
    const before = log.length;
    await action();
    for (const event of [...events]) await slot.behavior.emitRealtime(event.channel, event.payload);
    await settle();
    return log.slice(before).filter((entry) => FEED_METHODS.includes(entry.method) || (entry.method === "listAttachments" && "commentsOfTaskId" in entry.input)).map((entry) => entry.method);
  };
  return {
    bb, harness, store, task, comments, slot, log, failNext, hold, replay, feedCalls, release,
    setThreadsDown: (down: boolean) => { threadsDown = down; },
    emit: async (...channels: string[]) => { for (const channel of channels) await slot.behavior.emitRealtime(channel, { taskId: task.id, projectId: project.id }); await settle(); },
    dispose: async () => { cleanup(); await harness.dispose(); },
  };
}

describe("activity feed over realtime events", () => {
  it("opens with one comments read, then resolves thread titles", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await t.slot.findAllByText(/Worker thr_a/);
    expect(t.feedCalls().map((entry) => entry.method)).toEqual(["listComments", "listAttachments", "listCommentThreads"]);
    await t.dispose();
  });

  it("an unrelated task edit costs one revision call and leaves the feed alone", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await settle();
    const calls = await t.replay(() => t.harness.callRpc("updateTask", { taskId: t.task.id, title: "Renamed card" } as never));
    expect(calls).toEqual(["commentsRevision"]);
    expect(t.slot.queryByText("Progress 5")).not.toBeNull();
    await t.dispose();
  });

  it("a new comment reloads and renders", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await settle();
    const calls = await t.replay(() => t.harness.callRpc("createComment", { taskId: t.task.id, body: "Fresh owner note", notify: false } as never));
    expect(calls).toContain("listComments");
    await t.slot.findByText("Fresh owner note");
    await t.dispose();
  });

  it("a comment attachment (tasks:changed only) shows up through the changed token", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await settle();
    await t.replay(() => {
      const attachment = t.store.tasks.createAttachment({ commentId: t.comments[5]!.id, fileName: "report.txt", mime: "text/plain", sizeBytes: 10, blobPath: "x/report.txt", isImage: false });
      publishAttachmentChanged(t.bb, t.store.tasks, attachment);
    });
    await t.slot.findByText("report.txt");
    await t.dispose();
  });

  it("an overwrite under the same ids, batched with tasks:changed, replaces the shown body", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await settle();
    t.bb.storage.database().prepare("UPDATE comments SET body = 'Overwritten body' WHERE id = ?").run(t.comments[5]!.id);
    await t.emit("tasks:changed", "comments:changed");
    await t.slot.findByText("Overwritten body");
    await t.dispose();
  });

  it("a reconnect after a missed overwrite reloads the feed without a replayed event", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await settle();
    // The overwrite happens while the view is disconnected: no event reaches it.
    await t.slot.behavior.setRealtimeConnectionState("reconnecting");
    t.bb.storage.database().prepare("UPDATE comments SET body = 'Overwritten body' WHERE id = ?").run(t.comments[5]!.id);
    await t.slot.behavior.setRealtimeConnectionState("connected");
    await settle();
    await t.slot.findByText("Overwritten body");
    await t.dispose();
  });

  it("a reconnect reloads the feed even while a read from before the disconnect is held", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await settle();
    let release: () => void = () => {};
    t.hold.gate = new Promise<void>((resolve) => (release = resolve));
    // A load reads the old body and its response stays pending.
    await t.slot.behavior.emitRealtime("comments:changed", { taskId: t.task.id });
    await settle(150);
    await t.slot.behavior.setRealtimeConnectionState("reconnecting");
    t.bb.storage.database().prepare("UPDATE comments SET body = 'Overwritten body' WHERE id = ?").run(t.comments[5]!.id);
    await t.slot.behavior.setRealtimeConnectionState("connected");
    await settle();
        release();
    await settle();
    await t.slot.findByText("Overwritten body");
    await t.dispose();
  });

  it("a failed forced reload leaves no stale snapshot for the next ordinary refresh", async () => {
    const t = await mount();
    await t.slot.findByText("Progress 5");
    await settle();
    t.bb.storage.database().prepare("UPDATE comments SET body = 'Overwritten body' WHERE id = ?").run(t.comments[5]!.id);
    t.failNext.add("listAttachments");
    await t.emit("comments:changed");
    expect(t.slot.queryByText("Overwritten body")).toBeNull();
    await t.emit("tasks:changed");
    await t.slot.findByText("Overwritten body");
    await t.dispose();
  });

  it("retries only the thread metadata after a failed lookup, on the same revision", async () => {
    const t = await mount();
    t.setThreadsDown(true);
    await t.slot.findByText("Progress 5");
    await settle();
    expect(t.slot.queryAllByText(/Worker thr_a/)).toHaveLength(0);
    t.setThreadsDown(false);
    const before = t.feedCalls().length;
    await t.emit("tasks:changed");
    await t.slot.findAllByText(/Worker thr_a/);
    expect(t.feedCalls().slice(before).map((entry) => entry.method)).toEqual(["commentsRevision", "listCommentThreads"]);
    await t.dispose();
  });

  it("shows the bodies without waiting for thread metadata and without a serial revision call", async () => {
    const t = await mount({ block: "listCommentThreads" });
    await t.slot.findByText("Progress 5");
    expect(t.slot.queryAllByText(/Worker thr_a/)).toHaveLength(0);
    expect(t.feedCalls().map((entry) => entry.method)).toEqual(["listComments", "listAttachments", "listCommentThreads"]);
    t.release();
    await t.slot.findAllByText(/Worker thr_a/);
    await t.dispose();
  });
});

describe("shared reads across a refresh generation", () => {
  it("a reconnect does not join a read that began before the disconnect", async () => {
    let served = "old";
    let release: () => void = () => {};
    let holdNext = false;
    const calls: string[] = [];
    function Probe() {
      const query = useTasksQuery<string>(async (rpc) => ((await rpc.call("getTask", { taskId: "T1" } as never)) as unknown as { value: string }).value, ["tasks:changed"], []);
      return <p>shown: {query.data ?? "none"}</p>;
    }
    const slot = renderSlot(
      { id: "probe", component: () => <TasksRefreshProvider><Probe /></TasksRefreshProvider> } as never,
      {},
      {
        rpc: {
          getTask: async () => {
            calls.push(served);
            const value = served;
            if (holdNext) { holdNext = false; await new Promise<void>((resolve) => (release = resolve)); }
            return { value };
          },
        } as never,
      },
    );
    await slot.findByText("shown: old");
    await settle();
    holdNext = true;
    await slot.behavior.emitRealtime("tasks:changed", { taskId: "T1", projectId: "P1" });
    await settle(150);
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    served = "new";
    await slot.behavior.setRealtimeConnectionState("connected");
    await settle();
    release();
    await settle();
    await slot.findByText("shown: new");
    expect(calls).toEqual(["old", "old", "new"]);
    cleanup();
  });
});
