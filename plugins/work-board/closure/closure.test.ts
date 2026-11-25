import { afterEach, describe, expect, it } from "vitest";
import { closureFixture, gate, type ClosureFixture } from "./fixture";

const fixtures: ClosureFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.harness.dispose()));
});
async function setup(options?: Parameters<typeof closureFixture>[0]) {
  const f = await closureFixture(options);
  fixtures.push(f);
  return f;
}

describe("provenance: what Work Board may archive", () => {
  it("archives only threads Work Board spawned (preset delegate, fresh scheduled run)", async () => {
    const f = await setup();
    const task = f.card();
    // Preset delegate: the real writer.
    const preset = f.store.tasks.createPreset({ name: "Worker", providerId: "claude-code", modelId: "m", reasoningLevel: "high", serviceTier: null, permissionMode: "full", environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "", builtin: false });
    f.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_spawned" }));
    await f.harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });
    expect(f.origin(task.id, "thr_spawned")).toEqual({ created_for_task: 1, link_origin: "delegate_spawn" });
    // Existing thread, manual attach, title discovery and legacy (no origin) links are never candidates.
    f.harness.sdk.stub("threads.send", async () => ({ delivery: "sent" }));
    await f.harness.callRpc("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
    await f.harness.callRpc("taskThreadsAttach", { taskId: task.id, threadId: "thr_manual" });
    await f.emit("thread.active", "thr_renamed", { title: "EXA-1 renamed lead" });
    f.link(task, "thr_legacy", { origin: null, spawned: false });
    expect(f.origin(task.id, "thr_existing")).toEqual({ created_for_task: 0, link_origin: "delegate_existing" });
    expect(f.origin(task.id, "thr_manual")).toEqual({ created_for_task: 0, link_origin: "manual" });
    expect(f.origin(task.id, "thr_renamed")).toEqual({ created_for_task: 0, link_origin: "discovery" });
    expect(f.origin(task.id, "thr_legacy")).toEqual({ created_for_task: 0, link_origin: null });

    const { out } = await f.close(task);
    expect(Object.fromEntries(out.map((entry) => [entry.threadId, entry.action]))).toEqual({
      thr_spawned: "archived", thr_existing: "kept", thr_manual: "kept", thr_renamed: "kept", thr_legacy: "kept",
    });
    expect(f.world.archived).toEqual(["thr_spawned"]);
    expect(out.find((entry) => entry.threadId === "thr_manual")?.reason).toBe("not created by Work Board");
  });

  it("marks a parent fallback link as a parent link that is never archived", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_child", { origin: "delegate_existing", spawned: false });
    f.world.threads.set("thr_child", { archivedAt: 1, parentThreadId: "thr_parent" });
    f.world.threads.set("thr_parent", {});
    await f.harness.emitThreadEvent("thread.archived", { thread: f.thread("thr_child", { archivedAt: 1, parentThreadId: "thr_parent" }) });
    expect(f.origin(task.id, "thr_parent")).toEqual({ created_for_task: 0, link_origin: "parent" });
  });

  it("uses the preserved worker origin when closing former results", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_spawned", { spawned: true, origin: "scheduled_spawn" });
    f.link(task, "thr_reused", { spawned: false, origin: "scheduled_existing" });
    const { out } = await f.close(task);
    expect(out).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "thr_spawned", action: "archived" }),
      expect.objectContaining({ threadId: "thr_reused", action: "kept" }),
    ]));
  });
});

describe("pre-archive re-check keeps the thread on any doubt", () => {
  const cases: Array<[string, string, (f: ClosureFixture, task: { id: string }) => void | Promise<void>]> = [
    ["a live grandchild under an archived child", "has live child threads", (f) => { f.world.children.set("thr_a", 1); }],
    ["queued input", "has queued input", (f) => { f.world.queue.set("thr_a", 1); }],
    ["assigned reviewer of an open plan", "reviewer of an open plan", (f) => {
      const other = f.card("Other");
      f.bb.storage.database().prepare("INSERT INTO task_plans (task_id, version, body, state, updated_at, author_kind, author_name, reviewer_kind, reviewer_thread) VALUES (?, 1, 'Plan', 'in_review', ?, 'agent', 'agent', 'thread', 'thr_a')").run(other.id, new Date().toISOString());
    }],
    ["pinned", "pinned", (f) => { f.world.threads.set("thr_a", { pinnedAt: 1 }); }],
    ["another open card", "linked to EXA-2", (f) => { f.link(f.card("Second"), "thr_a", { spawned: false }); }],
    ["an SDK read error", "could not verify", (f) => { f.world.failGet = true; }],
  ];
  it.each(cases)("keeps a thread with %s", async (_name, reason, arrange) => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a");
    await arrange(f, task);
    const { out } = await f.close(task);
    expect(out).toEqual([{ threadId: "thr_a", action: "kept", reason }]);
    expect(f.world.archived).toEqual([]);
  });

  it("keeps a thread when the card is reopened, the setting turns off or a new link appears during the awaits", async () => {
    const during = async (change: (f: ClosureFixture, task: { id: string }) => void | Promise<void>, reason: string) => {
      const f = await setup();
      const task = f.card();
      f.link(task, "thr_a");
      const hold = gate();
      f.world.getGate = hold.promise;
      f.store.tasks.updateTask(task.id, { status: "done" });
      const id = f.store.tasks.closures.currentId(task.id)!;
      const pending = f.store.closures.onClosed(id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await change(f, task);
      hold.open();
      expect(await pending).toEqual([{ threadId: "thr_a", action: "kept", reason }]);
      expect(f.world.archived).toEqual([]);
    };
    await during((f, task) => { f.store.tasks.updateTask(task.id, { status: "in_progress" }); }, "card reopened");
    await during((f) => { f.store.tasks.updateProject(f.project.id, { archiveThreadsOnClose: "off" }); }, "archiving off");
    await during((f) => { f.link(f.card("Second"), "thr_a", { spawned: false }); }, "linked to EXA-2");
  });
});

describe("snapshot", () => {
  it("lists a manual link next to a worker that finishes during the evaluation, and evaluates a link written after the close", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_worker", { liveStatus: "working" });
    f.link(task, "thr_manual", { spawned: false, origin: "manual", liveStatus: "idle" });
    const hold = gate();
    f.world.getGate = hold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    // The worker's link is deleted while the evaluation waits; the snapshot already holds it.
    await f.harness.emitThreadEvent("thread.deleted", { thread: f.thread("thr_worker", { deletedAt: 1 }) });
    hold.open();
    const out = await pending;
    expect(out.map((entry) => entry.threadId).sort()).toEqual(["thr_manual", "thr_worker"]);
    expect(out.find((entry) => entry.threadId === "thr_manual")).toMatchObject({ action: "kept", reason: "not created by Work Board" });

    // A spawn link written after the close gets its own row and is settled.
    f.world.getGate = null;
    const preset = f.store.tasks.createPreset({ name: "Late", providerId: "claude-code", modelId: "m", reasoningLevel: "high", serviceTier: null, permissionMode: "full", environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "", builtin: false });
    f.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_late" }));
    await f.harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });
    expect(f.row(id, "thr_late")?.action).toBe("on_idle");
  });

  it("upgrades a discovery row to a spawn candidate", async () => {
    const f = await setup();
    // Title discovery wrote a kept row; the authoritative spawn link upgrades it.
    const task = f.card();
    f.link(task, "thr_found", { spawned: false, origin: "discovery", presetName: "Auto attached", liveStatus: "working" });
    f.store.tasks.updateTask(task.id, { status: "done" });
    const closure = f.store.tasks.closures.currentId(task.id)!;
    await f.store.closures.onClosed(closure);
    expect(f.row(closure, "thr_found")?.action).toBe("kept");
    const preset = f.store.tasks.createPreset({ name: "Spawn", providerId: "claude-code", modelId: "m", reasoningLevel: "high", serviceTier: null, permissionMode: "full", environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "", builtin: false });
    f.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_found" }));
    await f.harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });
    expect(f.store.tasks.closures.rows(closure)).toHaveLength(1);
    expect(f.row(closure, "thr_found")?.action).toBe("on_idle");
  });
});

