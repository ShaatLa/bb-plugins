import { dispatchMarker } from "./dispatch";
import { expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerTasksCli } from "../cli";
import { initializeTasksSchema } from "../db/schema";
import { createStore, registerTasksApi } from "../api";
import { activityService } from ".";

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
    const service = activityService(host.bb, store);
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
  const service = activityService(host.bb, store);
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
    const service = activityService(host.bb, store);
    service.queued(b.id, thread.id, "q");
    let result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)?.state).toBe("working");
    expect(result.get(b.id)?.state).toBe("working");
    body = dispatchMarker(a.id) + "\n# A";
    result = await service.metadata([a.id, b.id]);
    expect(result.get(a.id)).toMatchObject({ state: "working", sessions: [{ diagnostics: { explanation: expect.stringContaining("actively executing"), requestId: "r1", focusedTaskId: a.id } }] });
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
