import { afterEach, describe, expect, it, vi } from "vitest";
import { attachManualLink } from "../delegate/attach";
import { createScheduledStore } from "../scheduled/store";
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const PLAN = "# Plan\n\n## Steps\nAdd the table.\n\n## Risks\nNone known.\n";

describe("code review findings", () => {
  it("C1.1: a reviewer's new turn during the queue and child checks keeps it", async () => {
    const f = await setup();
    f.bb.storage.database().prepare("UPDATE projects SET planning = 'optional'").run();
    const task = f.card("Planned work");
    const run = async (args: string[], threadId: string) => expect(await f.harness.runCli(args, { threadId })).toMatchObject({ exitCode: 0 });
    await run(["plan", "set", "EXA-1", "--body", PLAN, "--base-version", "0", "--summary", "Initial"], "thr_author");
    f.world.threads.set("thr_reviewer", { parentThreadId: "thr_author", title: "EXA-1 plan reviewer" });
    await f.emit("thread.active", "thr_reviewer");
    await run(["plan", "submit", "EXA-1", "--reviewer", "thr_reviewer", "--dedicated-reviewer"], "thr_author");
    await run(["plan", "approve", "EXA-1", "--version", "1"], "thr_reviewer");
    const hold = gate();
    f.world.childGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_reviewer");
    await tick();
    await f.emit("thread.active", "thr_reviewer");
    hold.open();
    await idle;
    expect(f.world.archived).toEqual([]);
    expect(f.bb.storage.database().prepare("SELECT archive_state FROM task_plan_reviews").get()).toEqual({ archive_state: "kept" });
    void task;
  });

  it.each([
    ["the card is reopened", (f: ClosureFixture, task: { id: string }) => { f.store.tasks.updateTask(task.id, { status: "in_progress" }); }],
    ["a manual upsert reuses the link id", (f: ClosureFixture, task: { id: string }) => { f.link(task, "thr_a", { spawned: false, origin: "manual" }); }],
  ])("C1.2: the worker's link survives when %s during its idle check", async (_name, change) => {
    const f = await setup();
    const task = f.card();
    const original = f.link(task, "thr_a", { liveStatus: "working" });
    await f.close(task, "thr_a");
    const hold = gate();
    f.world.getGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await tick();
    await change(f, task);
    hold.open();
    await idle;
    expect(f.store.tasks.getTaskThread(original.id)).toBeTruthy();
    expect(f.comments(task).filter((body) => body.startsWith("Thread detached (automatic)"))).toEqual([]);
    expect(f.world.archived).toEqual([]);
  });

  it("C1.4: a second working worker that goes idle while the first one is checked is still decided", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    f.link(task, "thr_b", { liveStatus: "working" });
    const hold = gate();
    f.world.getGate = hold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    await tick();
    const idle = f.emit("thread.idle", "thr_b");
    await tick();
    hold.open();
    await idle;
    await pending;
    expect(f.world.archived).toEqual(["thr_b"]);
    expect(f.row(id, "thr_a")?.action).toBe("on_idle");
    expect(f.row(id, "thr_b")?.action).toBe("archived");
  });

  it("C1.5: the new turn that races the idle check notifies the thread and its parent at that turn's end when it changed files", async () => {
    const f = await setup();
    const task = f.card();
    f.world.threads.set("thr_a", { parentThreadId: "thr_parent" });
    f.link(task, "thr_a", { liveStatus: "working" });
    await f.close(task, "thr_a");
    const hold = gate();
    f.world.getGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await tick();
    f.world.getGate = null;
    await f.emit("thread.active", "thr_a");
    hold.open();
    await idle;
    expect(f.world.sent).toEqual([]);
    f.edit("thr_a");
    await f.emit("thread.idle", "thr_a");
    expect(f.world.sent.map((entry) => entry.threadId).sort()).toEqual(["thr_a", "thr_parent"]);
    expect(f.world.archived).toEqual([]);
  });

  it("C1.6: a reopen while the parent is being looked up sends the parent nothing", async () => {
    const f = await setup({ projectSettings: { archiveThreadsOnClose: "off" } });
    const task = f.card();
    f.world.threads.set("thr_a", { parentThreadId: "thr_parent" });
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task);
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const hold = gate();
    f.world.getGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.harness.sdk.callsTo("threads.get").length).toBeGreaterThan(0));
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    hold.open();
    await idle;
    expect(f.world.sent.filter((entry) => entry.threadId === "thr_parent")).toEqual([]);
    expect(f.row(id, "thr_a")?.parentNotice).toBe("failed");
  });

  it("C1.7: a working shared worker and a pinned closer are kept at the close, not promised an archive", async () => {
    const f = await setup();
    const task = f.card();
    const other = f.card("Other");
    f.link(task, "thr_shared", { liveStatus: "working" });
    f.link(other, "thr_shared", { spawned: false });
    f.link(task, "thr_closer", { liveStatus: "working" });
    f.world.threads.set("thr_closer", { pinnedAt: 1 });
    const { out } = await f.close(task, "thr_closer");
    expect(out).toEqual([
      { threadId: "thr_shared", action: "kept", reason: "linked to EXA-2" },
      { threadId: "thr_closer", action: "kept", reason: "pinned" },
    ]);
  });

  it("C1.8: the caller's attach never overwrites a link or makes a helper a worker, and needs the caller and a progress note", async () => {
    const f = await setup();
    const task = f.card("Closed work");
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead" });
    // Delegation links the caller between the preflight read and the write.
    const hold = gate();
    f.world.getGate = hold.promise;
    const run = f.harness.runCli(["update", "EXA-1", "--progress", "Working"], { threadId: "thr_caller" });
    await tick();
    f.link(task, "thr_caller");
    hold.open();
    expect(await run).toMatchObject({ exitCode: 0 });
    expect(f.origin(task.id, "thr_caller")).toEqual({ created_for_task: 1, link_origin: "delegate_spawn" });

    // The caller's parent acquires the card meanwhile: the caller is a helper.
    const second = f.card("Second");
    f.world.threads.set("thr_child", { parentThreadId: "thr_parent" });
    const gate2 = gate();
    f.world.getGate = gate2.promise;
    const run2 = f.harness.runCli(["update", "EXA-2", "--progress", "Working"], { threadId: "thr_child" });
    await tick();
    f.link(second, "thr_parent", { spawned: false, origin: "manual" });
    gate2.open();
    await run2;
    expect(f.store.tasks.getTaskThreadByThreadId(second.id, "thr_child")).toBeUndefined();

    // The write itself re-checks both conditions, whatever happened after the reads.
    const fourth = f.card("Fourth");
    f.link(fourth, "thr_caller");
    expect(attachManualLink(f.store.tasks, fourth.id, { threadId: "thr_caller", parentThreadId: "thr_lead", title: "Caller", liveStatus: "working" })).toBe(false);
    expect(f.origin(fourth.id, "thr_caller")).toEqual({ created_for_task: 1, link_origin: "delegate_spawn" });
    f.link(fourth, "thr_lead", { spawned: false, origin: "manual" });
    expect(attachManualLink(f.store.tasks, fourth.id, { threadId: "thr_helper", parentThreadId: "thr_lead", title: "Helper", liveStatus: "working" })).toBe(false);
    expect(f.store.tasks.getTaskThreadByThreadId(fourth.id, "thr_helper")).toBeUndefined();

    // The RPC attaches only the caller named by agentThreadId and only with a progress note.
    f.world.getGate = null;
    const third = f.card("Third");
    const refused = await f.harness.callRpc("updateTask", { taskId: third.id, attachCaller: true, priority: "high" }) as { attachWarning?: string; attached?: boolean };
    expect(refused.attachWarning).toContain("needs the calling thread and a progress note");
    expect(refused.attached).toBeUndefined();
    expect(f.store.tasks.listTaskThreads(third.id)).toEqual([]);
  });

  it("C1.9: a detach and reattach before the archive event leaves the new link to ordinary reconciliation", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a");
    const hold = gate();
    f.world.archiveGate = hold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    await tick();
    await f.harness.callRpc("taskThreadsDetach", { taskId: task.id, threadId: "thr_a" });
    await f.harness.callRpc("taskThreadsAttach", { taskId: task.id, threadId: "thr_a" });
    await f.harness.emitThreadEvent("thread.archived", { thread: f.thread("thr_a", { archivedAt: 1 }) });
    hold.open();
    await pending;
    const lines = f.comments(task);
    expect(lines.some((body) => body.startsWith("Thread detached (archived)"))).toBe(true);
    expect(lines.filter((body) => body.startsWith("Thread archived (automatic)"))).toHaveLength(1);
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([]);
  });

  it("C1.10: the target of an enabled schedule is never retired", async () => {
    const f = await setup();
    const scheduled = createScheduledStore(f.bb, f.store);
    scheduled.create({ projectId: f.project.id, title: "Daily", rule: { kind: "daily", time: "09:00", timezone: "UTC" }, target: { kind: "thread", threadId: "thr_a" } });
    f.bb.storage.database().prepare("UPDATE task_schedules SET enabled = 1").run();
    const task = f.card();
    f.link(task, "thr_a");
    const { out } = await f.close(task);
    expect(out).toEqual([{ threadId: "thr_a", action: "kept", reason: "scheduled executor" }]);
    expect(f.world.archived).toEqual([]);
  });

  it("C1.10: and neither is a plan reviewer that is a schedule's target", async () => {
    const f = await setup();
    f.bb.storage.database().prepare("UPDATE projects SET planning = 'optional'").run();
    f.card("Planned work");
    const scheduled = createScheduledStore(f.bb, f.store);
    scheduled.create({ projectId: f.project.id, title: "Daily", rule: { kind: "daily", time: "09:00", timezone: "UTC" }, target: { kind: "thread", threadId: "thr_reviewer" } });
    f.bb.storage.database().prepare("UPDATE task_schedules SET enabled = 1").run();
    const run = async (args: string[], threadId: string) => expect(await f.harness.runCli(args, { threadId })).toMatchObject({ exitCode: 0 });
    await run(["plan", "set", "EXA-1", "--body", PLAN, "--base-version", "0", "--summary", "Initial"], "thr_author");
    f.world.threads.set("thr_reviewer", { parentThreadId: "thr_author" });
    await run(["plan", "submit", "EXA-1", "--reviewer", "thr_reviewer", "--dedicated-reviewer"], "thr_author");
    await run(["plan", "approve", "EXA-1", "--version", "1"], "thr_reviewer");
    await f.emit("thread.idle", "thr_reviewer");
    expect(f.world.archived).toEqual([]);
  });
});
