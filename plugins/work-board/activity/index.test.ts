import { dispatchMarker } from "./dispatch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerTasksCli } from "../cli";
import { initializeTasksSchema } from "../db/schema";
import { createStore, registerTasksApi } from "../api";
import { activityService } from ".";

// Only Date is faked: samples are shared for a ~1s TTL, so tests move the clock explicitly.
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); });
const later = (ms = 1_100) => vi.setSystemTime(Date.now() + ms);
// Legacy scenarios mutate SDK state between calls and expect fresh samples each time.
const uncached = <T extends { metadata: (...args: never[]) => Promise<unknown> }>(service: T): T => ({ ...service, metadata: async (...args: never[]) => { later(); return service.metadata(...args); } });

it("follows live attached sessions on every linked card without requiring request scope", async () => {
  const host = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(host.bb);
    const project = store.tasks.createProject({ name: "Activity", prefix: "ACT", color: "blue" });
    const a = store.tasks.createTask({ projectId: project.id, title: "A" });
    const b = store.tasks.createTask({ projectId: project.id, title: "B" });
    for (const task of [a, b]) store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_shared", title: "Shared", presetName: task.id === b.id ? "Parent thread" : "Attached", liveStatus: "idle" });
    const thread = makeThreadResponse({ id: "thr_shared", status: "active", runtime: { displayStatus: "active" } });
    let pending = false, eventsUnavailable = false, offline = false;
    host.harness.sdk.stub("threads.list", async () => { if (offline) throw new Error("offline"); return [thread] as never; });
    host.harness.sdk.stub("threads.events.list", async ({ types }: { types?: readonly string[] }) => {
      if (eventsUnavailable) throw new Error("events unavailable");
      return (types?.includes("client/turn/requested") ? [] : [{ type: "turn/input/accepted", seq: 10, scope: { kind: "turn", turnId: "t1" }, data: { clientRequestId: "req" } }]) as never;
    });
    host.harness.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "i1", turnId: "t1", status: "pending" }] as never : []);
    host.harness.sdk.stub("threads.queuedMessages.list", async () => [{ id: "q1" }] as never);
    const service = uncached(activityService(host.bb, store));
    service.queued(b.id, thread.id, "q1");
    let result = await service.metadata([a.id, b.id]);
    for (const id of [a.id, b.id]) expect(result.get(id)).toMatchObject({ state: "working", workingCount: 1, diagnostics: { hasWorked: true, complete: true } });
    expect(host.harness.sdk.callsTo("threads.list")).toHaveLength(1);
    pending = true;
    result = await service.metadata([a.id, b.id]);
    for (const id of [a.id, b.id]) expect(result.get(id)).toMatchObject({ state: "waiting-owner", sessions: [{ diagnostics: { interactionIds: ["i1"] } }] });
    pending = false;
    thread.status = "idle"; thread.runtime.displayStatus = "idle";
    result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)?.state).toBe("attached");
    expect(result.get(b.id)).toMatchObject({ state: "queued", sessions: [{ diagnostics: { queueIds: ["q1"] } }] });
    thread.status = "active"; thread.runtime.displayStatus = "waiting-for-host";
    expect((await service.metadata([a.id])).get(a.id)?.state).toBe("attached");
    thread.status = "idle"; thread.runtime.displayStatus = "active";
    expect((await service.metadata([a.id])).get(a.id)?.state).toBe("attached");
    thread.status = "active"; eventsUnavailable = true;
    expect((await service.metadata([a.id])).get(a.id)).toMatchObject({ state: "working", diagnostics: { complete: false } });
    store.tasks.updateTask(a.id, { status: "done" });
    expect((await service.metadata([a.id])).get(a.id)).toMatchObject({ state: "working", terminalWarning: true });
    thread.status = "error"; thread.runtime.displayStatus = "error";
    expect((await service.metadata([a.id])).get(a.id)).toMatchObject({ state: "error", hasFailure: true });
    offline = true;
    expect((await service.metadata([a.id])).get(a.id)).toMatchObject({ state: "attached", diagnostics: { complete: false } });
    offline = false;
    host.harness.sdk.stub("threads.list", async () => []);
    expect((await service.metadata([b.id])).get(b.id)).toMatchObject({ state: "abandoned", diagnostics: { inactiveSessions: [{ threadId: "thr_shared", reason: "missing" }] } });
    const fresh = store.tasks.createTask({ projectId: project.id, title: "Unattached" });
    expect((await service.metadata([fresh.id])).get(fresh.id)?.state).toBeNull();
  } finally { await host.harness.dispose(); }
});

it("keeps queued messages scoped to each linked card and thread", async () => {
  const host = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(host.bb);
    const project = store.tasks.createProject({ name: "Queues", prefix: "QUE", color: "blue" });
    const a = store.tasks.createTask({ projectId: project.id, title: "A" });
    const b = store.tasks.createTask({ projectId: project.id, title: "B" });
    for (const task of [a, b]) store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_queue", title: "Worker", presetName: "Attached", liveStatus: "idle" });
    host.harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "thr_queue", status: "idle", runtime: { displayStatus: "idle" } })] as never);
    host.harness.sdk.stub("threads.queuedMessages.list", async () => [{ id: "qa" }] as never);
    const service = activityService(host.bb, store);
    service.queued(a.id, "thr_queue", "qa");
    service.queued(b.id, "thr_queue", "qb");
    const result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)).toMatchObject({ state: "queued", sessions: [{ diagnostics: { queueIds: ["qa"] } }] });
    expect(result.get(b.id)).toMatchObject({ state: "attached", sessions: [{ diagnostics: { queueIds: [] } }] });
    expect(host.bb.storage.database().prepare("SELECT queue_id FROM task_activity_queue").all()).toEqual([{ queue_id: "qa" }]);
  } finally { await host.harness.dispose(); }
});

it("recognizes historical per-card agent work without treating attachment as work", async () => {
  const host = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "History", prefix: "HIS", color: "blue" });
  const worked = store.tasks.createTask({ projectId: project.id, title: "Worked" });
  const assigned = store.tasks.createTask({ projectId: project.id, title: "Only assigned", status: "in_progress" });
  store.tasks.createComment({ taskId: worked.id, kind: "agent", threadId: "thr_old", authorName: "Agent", body: "Implemented the change" });
  store.tasks.createComment({ taskId: assigned.id, kind: "system", threadId: "thr_old", authorName: "Work Board", body: "Thread attached" });
  const db = host.bb.storage.database();
  db.exec("DROP TRIGGER task_activity_agent_comment; DROP TABLE task_activity_claims; DROP TABLE task_activity_queue; DROP TABLE task_activity_history; DELETE FROM schema_version WHERE version=17");
  initializeTasksSchema(db);
  const service = uncached(activityService(host.bb, store));
  expect((await service.metadata([worked.id, assigned.id])).get(worked.id)?.state).toBe("abandoned");
  expect((await service.metadata([assigned.id])).get(assigned.id)?.state).toBeNull();
  store.tasks.createComment({ taskId: assigned.id, kind: "agent", threadId: "thr_new", authorName: "Agent", body: "Investigated this card" });
  expect((await service.metadata([assigned.id])).get(assigned.id)?.state).toBe("abandoned");
  await host.harness.dispose();
});

it("keeps request diagnostics without letting claims or unrelated inputs suppress live activity", async () => {
  const host = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(host.bb);
    const project = store.tasks.createProject({ name: "Auto", prefix: "AUT", color: "blue" });
    const a = store.tasks.createTask({ projectId: project.id, title: "A" });
    const b = store.tasks.createTask({ projectId: project.id, title: "B" });
    for (const task of [a, b]) store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_auto", title: "Shared", presetName: "Attached", liveStatus: "working" });
    const thread = makeThreadResponse({ id: "thr_auto", status: "active", runtime: { displayStatus: "active" } });
    let turn = "turn-1", request = "r1", body = "Unrelated work", pending = false, queued = true, completed = false;
    host.harness.sdk.stub("threads.get", async () => thread);
    host.harness.sdk.stub("threads.list", async () => [thread] as never);
    host.harness.sdk.stub("threads.events.list", async ({ types }: { types?: readonly string[] }) => (types?.includes("client/turn/requested") ? [
      { type: "client/turn/requested", seq: 11, data: { requestId: "newer-unaccepted", input: [{ type: "text", text: dispatchMarker(b.id) + "\n# B" }] } },
      { type: "client/turn/requested", seq: 9, data: { requestId: request, input: [{ type: "text", text: body }] } },
    ] : [{ type: completed ? "turn/completed" : "turn/input/accepted", seq: 10, scope: { kind: "turn", turnId: turn }, data: { clientRequestId: request } }]) as never);
    host.harness.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "interaction-1", turnId: turn, status: "pending" }] as never : []);
    host.harness.sdk.stub("threads.queuedMessages.list", async () => queued ? [{ id: "q" }] as never : []);
    const service = uncached(activityService(host.bb, store));
    service.queued(b.id, thread.id, "q");
    let result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)?.state).toBe("working");
    expect(result.get(b.id)?.state).toBe("working");
    // An accepted request is immutable, so a changed header only counts under a new request id.
    body = dispatchMarker(a.id) + "\n# A"; request = "r1b";
    result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)).toMatchObject({ state: "working", sessions: [{ diagnostics: { explanation: expect.stringContaining("actively executing"), requestId: "r1b", focusedTaskId: a.id } }] });
    expect(result.get(b.id)?.state).toBe("working");
    expect(host.bb.storage.database().prepare("SELECT task_id FROM task_activity_history WHERE task_id=?").get(a.id)).toBeDefined();
    pending = true;
    expect((await service.metadata([a.id])).get(a.id)?.state).toBe("waiting-owner");
    pending = false; queued = false; turn = "turn-2"; request = "r2"; body = dispatchMarker(b.id) + "\n# B";
    result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)?.state).toBe("working");
    expect(result.get(b.id)?.state).toBe("working");
    await service.stop(b.id, thread.id);
    expect((await service.metadata([b.id])).get(b.id)?.state).toBe("working");
    await service.start(b.id, thread.id);
    expect((await service.metadata([b.id])).get(b.id)?.state).toBe("working");
    turn = "turn-3"; request = "r3"; body = "A different task without a dispatch header";
    expect((await service.metadata([b.id])).get(b.id)?.state).toBe("working");
    body = dispatchMarker(a.id) + "\n# A";
    await service.start(b.id, thread.id);
    expect((await service.metadata([a.id])).get(a.id)?.state).toBe("working");
    request = "r4";
    result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)?.state).toBe("working");
    expect(result.get(b.id)?.state).toBe("working");
    completed = true;
    expect((await service.metadata([a.id])).get(a.id)?.state).toBe("working");
    thread.status = "idle"; thread.runtime.displayStatus = "idle";
    expect((await service.metadata([a.id])).get(a.id)?.state).toBe("attached");
  } finally { await host.harness.dispose(); }
});

it("exposes abandonment evidence consistently in RPC, CLI JSON and human output", async () => {
  const host = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(host.bb);
    registerTasksApi(host.bb, store);
    registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
    const project = store.tasks.createProject({ name: "Explain", prefix: "WHY", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Find the cause" });
    store.tasks.createComment({ taskId: task.id, kind: "agent", threadId: "thr_archived", authorName: "Worker", body: "Investigated the task" });
    store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_archived", title: "Old worker", presetName: "Attached", liveStatus: "idle" });
    const thread = makeThreadResponse({ id: "thr_archived", archivedAt: Date.parse("2026-11-04T12:00:00.000Z") });
    host.harness.sdk.stub("threads.list", async () => [thread] as never);
    host.harness.sdk.stub("threads.get", async () => thread);
    const rpc = await host.harness.callRpc("listTaskCardMeta", { taskIds: [task.id] }) as { metadata: { activity: unknown }[] };
    expect(rpc.metadata[0]!.activity).toMatchObject({ state: "abandoned", diagnostics: { hasWorked: true, complete: true, inactiveSessions: [{ threadId: "thr_archived", reason: "archived" }] } });
    const json = await host.harness.runCli(["show", task.key, "--json"]);
    expect(json.exitCode, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).activity).toMatchObject({ state: "abandoned", diagnostics: { hasWorked: true, complete: true } });
    expect(JSON.parse(json.stdout).comments).toContainEqual(expect.objectContaining({ kind: "agent", threadId: "thr_archived" }));
    const shown = await host.harness.runCli(["show", task.key]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("Activity: Abandoned");
    expect(shown.stdout).toContain("Previous work is recorded");
    expect(shown.stdout).toContain("@thread:thr_archived");
  } finally { await host.harness.dispose(); }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** Cards each linked to `threadOf(i)`; counts SDK reads and the largest number of simultaneous sampling reads. */
async function fixture(cards: number, threadOf: (index: number) => string, options: { delay?: boolean } = {}) {
  const host = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Shared", prefix: "SHR", color: "blue" });
  const tasks = Array.from({ length: cards }, () => store.tasks.createTask({ projectId: project.id, title: "Card" }));
  tasks.forEach((task, index) => store.tasks.upsertTaskThread({ taskId: task.id, threadId: threadOf(index), title: "Worker", presetName: "Attached", liveStatus: "working" }));
  const threads = new Map([...new Set(tasks.map((_, index) => threadOf(index)))].map((id) => [id, makeThreadResponse({ id, status: "active", runtime: { displayStatus: "active" } })]));
  const state = { turn: "turn1", request: "req1", pending: false, failEvents: false, failHistory: false, failInteractions: false, queue: [] as string[], batches: [] as string[][], history: 0, accepted: 0, interactions: 0, inflight: 0, peak: 0, historyIds: [] as string[] };
  const track = async <T>(run: () => T | Promise<T>) => {
    state.peak = Math.max(state.peak, ++state.inflight);
    try { if (options.delay) await new Promise((resolve) => setTimeout(resolve, 0)); return await run(); } finally { state.inflight--; }
  };
  host.harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds: string[] }) => { state.batches.push([...threadIds]); return threadIds.map((id) => threads.get(id)!) as never; });
  host.harness.sdk.stub("threads.events.list", async ({ threadId, types }: { threadId: string; types?: readonly string[] }) => track(() => {
    if (types?.includes("client/turn/requested")) {
      state.history++; state.historyIds.push(threadId);
      if (state.failHistory) throw new Error("history unavailable");
      // Stands in for large request events: the accepted request carries the dispatch header for the first card.
      return [{ type: "client/turn/requested", seq: 9, data: { requestId: state.request, input: [{ type: "text", text: dispatchMarker(tasks[0]!.id) + "\n" + "x".repeat(8192) }] } }] as never;
    }
    state.accepted++;
    if (state.failEvents) throw new Error("events unavailable");
    return [{ type: "turn/input/accepted", seq: 10, scope: { kind: "turn", turnId: state.turn }, data: { clientRequestId: state.request } }] as never;
  }));
  host.harness.sdk.stub("threads.interactions.list", async () => track(() => {
    state.interactions++;
    if (state.failInteractions) throw new Error("interactions unavailable");
    return (state.pending ? [{ id: "owner-1", turnId: state.turn, status: "pending" }] : []) as never;
  }));
  host.harness.sdk.stub("threads.queuedMessages.list", async () => track(() => state.queue.map((id) => ({ id })) as never));
  return { host, store, tasks, threads, state, service: activityService(host.bb, store) };
}
const reads = ({ state }: Fixture) => state.batches.length + state.accepted + state.interactions + state.history;

it("shares simultaneous metadata reads between consumers and isolates their results", async () => {
  // Baseline before sharing: two consumers x 10 cards x 5 threads = 32 SDK calls, 10 history reads, 4.16 MB of history.
  const f = await fixture(10, (index) => `thr_${index % 5}`);
  try {
    f.state.pending = true;
    const ids = f.tasks.map((task) => task.id);
    const [first, second, subset] = await Promise.all([f.service.metadata(ids), f.service.metadata(ids), f.service.metadata(ids.slice(0, 3))]);
    expect(f.state).toMatchObject({ accepted: 5, interactions: 5, history: 5 });
    expect(f.state.batches).toHaveLength(1);
    expect(reads(f)).toBe(16);
    expect(first.get(ids[0]!)).toMatchObject({ state: "waiting-owner", sessions: [{ diagnostics: { interactionIds: ["owner-1"], focusedTaskId: ids[0] } }] });
    expect(second).toEqual(first);
    // Mutating one consumer's result cannot leak into another consumer or a later call.
    first.get(ids[0]!)!.sessions[0]!.diagnostics!.interactionIds.push("tampered");
    expect(second.get(ids[0]!)!.sessions[0]!.diagnostics!.interactionIds).toEqual(["owner-1"]);
    expect(subset.get(ids[0]!)!.sessions[0]!.diagnostics!.interactionIds).toEqual(["owner-1"]);
    expect((await f.service.metadata(ids)).get(ids[0]!)!.sessions[0]!.diagnostics!.interactionIds).toEqual(["owner-1"]);
    expect(reads(f)).toBe(16);
  } finally { await f.host.harness.dispose(); }
});

it("joins overlapping task sets so every thread is requested once", async () => {
  const f = await fixture(5, (index) => `thr_${index}`);
  try {
    const ids = f.tasks.map((task) => task.id);
    await Promise.all([f.service.metadata(ids.slice(0, 3)), f.service.metadata(ids.slice(2))]);
    expect(f.state.batches).toEqual([["thr_0", "thr_1", "thr_2"], ["thr_3", "thr_4"]]);
    expect(f.state).toMatchObject({ accepted: 5, interactions: 5, history: 5 });
  } finally { await f.host.harness.dispose(); }
});

it("expires runtime and owner interactions but keeps attribution of an unchanged accepted request", async () => {
  const f = await fixture(2, () => "thr_one");
  try {
    const ids = f.tasks.map((task) => task.id);
    expect((await f.service.metadata(ids)).get(ids[0]!)?.state).toBe("working");
    f.state.pending = true;
    expect((await f.service.metadata(ids)).get(ids[0]!)?.state).toBe("working"); // still inside the TTL
    expect(f.state.interactions).toBe(1);
    later();
    const owner = await f.service.metadata(ids);
    expect(owner.get(ids[1]!)).toMatchObject({ state: "waiting-owner", sessions: [{ diagnostics: { focusedTaskId: ids[0] } }] });
    expect(f.state).toMatchObject({ accepted: 2, interactions: 2, history: 1 }); // repeated history: one read
    for (let i = 0; i < 3; i++) { later(); await f.service.metadata(ids); }
    expect(f.state.history).toBe(1);
    // A later turn is a different accepted request and is read again.
    f.state.pending = false; f.state.turn = "turn2"; f.state.request = "req2"; later();
    expect((await f.service.metadata(ids)).get(ids[0]!)).toMatchObject({ state: "working", sessions: [{ diagnostics: { requestId: "req2", interactionIds: [] } }] });
    expect(f.state.history).toBe(2);
    // The runtime itself also refreshes after expiry.
    f.threads.get("thr_one")!.status = "idle"; f.threads.get("thr_one")!.runtime.displayStatus = "idle"; later();
    expect((await f.service.metadata(ids)).get(ids[0]!)?.state).toBe("attached");
  } finally { await f.host.harness.dispose(); }
});

it("sees a newly queued message immediately instead of deleting it from a stale sample", async () => {
  const f = await fixture(1, () => "thr_queue");
  try {
    const [task] = f.tasks;
    f.threads.get("thr_queue")!.status = "idle"; f.threads.get("thr_queue")!.runtime.displayStatus = "idle";
    f.service.queued(task!.id, "thr_queue", "q0");
    f.state.queue = ["q0"];
    expect((await f.service.metadata([task!.id])).get(task!.id)?.state).toBe("queued");
    f.state.queue = ["q0", "q1"];
    f.service.queued(task!.id, "thr_queue", "q1"); // inside the TTL: the cached [q0] sample is invalidated
    const result = await f.service.metadata([task!.id]);
    expect(result.get(task!.id)).toMatchObject({ state: "queued", sessions: [{ diagnostics: { queueIds: ["q0", "q1"] } }] });
    expect(f.host.bb.storage.database().prepare("SELECT queue_id FROM task_activity_queue ORDER BY queue_id").all()).toEqual([{ queue_id: "q0" }, { queue_id: "q1" }]);
  } finally { await f.host.harness.dispose(); }
});

it("keeps verified Working and queue records when an optional read fails, and retries without poisoning", async () => {
  const f = await fixture(2, () => "thr_flaky");
  try {
    const ids = f.tasks.map((task) => task.id);
    const queueRows = () => f.host.bb.storage.database().prepare("SELECT queue_id FROM task_activity_queue").all();
    f.service.queued(ids[0]!, "thr_flaky", "gone"); // the SDK queue no longer has it, so a complete sample removes it
    f.state.failEvents = true;
    const failed = await Promise.all([f.service.metadata(ids), f.service.metadata(ids)]);
    for (const result of failed) for (const id of ids) expect(result.get(id)).toMatchObject({ state: "working", diagnostics: { complete: false } });
    expect(queueRows()).toEqual([{ queue_id: "gone" }]);
    expect(f.state.accepted).toBe(1); // simultaneous failures share one read
    f.state.failEvents = false; // retry inside the TTL: the failure was not cached
    expect((await f.service.metadata(ids)).get(ids[0]!)).toMatchObject({ state: "working", diagnostics: { complete: true } });
    expect(queueRows()).toEqual([]);
    // Interactions failing keeps Working but is reported incomplete, then recovers.
    later(); f.state.failInteractions = true;
    expect((await f.service.metadata(ids)).get(ids[1]!)).toMatchObject({ state: "working", diagnostics: { complete: false } });
    f.state.failInteractions = false;
    expect((await f.service.metadata(ids)).get(ids[1]!)).toMatchObject({ state: "working", diagnostics: { complete: true } });
    // A failed history read is retried (not cached) while the accepted sample is reused.
    f.state.request = "req-history"; f.state.failHistory = true; later();
    expect((await f.service.metadata(ids)).get(ids[0]!)).toMatchObject({ state: "working", diagnostics: { complete: false } });
    const acceptedReads = f.state.accepted;
    f.state.failHistory = false;
    expect((await f.service.metadata(ids)).get(ids[0]!)).toMatchObject({ state: "working", diagnostics: { complete: true }, sessions: [{ diagnostics: { focusedTaskId: ids[0] } }] });
    expect(f.state.accepted).toBe(acceptedReads);
  } finally { await f.host.harness.dispose(); }
});

it("bounds sampling concurrency, list batches and cache growth", async () => {
  const n = 300;
  const f = await fixture(n, (index) => `thr_${index}`, { delay: true });
  try {
    const ids = f.tasks.map((task) => task.id);
    await Promise.all([f.service.metadata(ids), f.service.metadata(ids)]);
    expect(f.state.peak).toBeGreaterThan(1);
    expect(f.state.peak).toBeLessThanOrEqual(4); // global limit across both simultaneous calls
    expect(Math.max(...f.state.batches.map((batch) => batch.length))).toBeLessThanOrEqual(200);
    expect(f.state.accepted).toBe(n);
    // Caches hold at most 256 entries: recent threads are still shared, the oldest were dropped.
    const acceptedBefore = f.state.accepted, listsBefore = f.state.batches.length;
    await f.service.metadata(ids.slice(200));
    expect(f.state.accepted).toBe(acceptedBefore);
    expect(f.state.batches).toHaveLength(listsBefore);
    await f.service.metadata(ids.slice(0, 20));
    expect(f.state.accepted).toBe(acceptedBefore + 20);
    expect(f.state.history).toBe(n + 20);
  } finally { await f.host.harness.dispose(); }
});
