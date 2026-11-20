import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses.js";
import { registerLifecycle } from "../lifecycle";
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
/** A project whose done status is a custom one, so closed-ness comes from the policy. */
function customDone(f: ClosureFixture) {
  f.store.tasks.updateProject(f.project.id, {
    statuses: [...DEFAULT_TASK_STATUSES, { id: "shipped", name: "Shipped" }],
    workflowPolicy: { doneStatus: "shipped" } as never,
  });
}

describe("turn binding", () => {
  it("a restart retires the pending intent: a later turn and idle archive nothing", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task);
    expect(f.row(id, "thr_a")?.action).toBe("on_idle");
    f.store.tasks.closures.recoverOnStartup();
    expect(f.row(id, "thr_a")).toMatchObject({ action: "kept", reason: "restarted before the turn ended" });
    await f.emit("thread.active", "thr_a");
    await f.emit("thread.idle", "thr_a");
    expect(f.world.archived).toEqual([]);
  });

  it("startup does not archive: registering the lifecycle retires every pending row", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task);
    await registerLifecycle(f.bb, f.store);
    expect(f.row(id, "thr_a")?.action).toBe("kept");
    expect(f.world.archived).toEqual([]);
  });

  it("keeps a thread that finishes its closing turn and starts unrelated work before the evaluation ends", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task, "thr_a");
    const hold = gate();
    f.world.getGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await tick();
    await f.emit("thread.active", "thr_a");
    hold.open();
    await idle;
    expect(f.row(id, "thr_a")).toMatchObject({ action: "kept", reason: "new turn after close" });
    expect(f.world.archived).toEqual([]);
    expect(f.comments(task).filter((body) => body.startsWith("Thread detached (automatic)"))).toHaveLength(1);
  });

  it.each([
    ["a manual detach", async (f: ClosureFixture, task: { id: string }) => { await f.harness.callRpc("taskThreadsDetach", { taskId: task.id, threadId: "thr_a" }); }],
    ["a detach and manual reattach", async (f: ClosureFixture, task: { id: string }) => {
      await f.harness.callRpc("taskThreadsDetach", { taskId: task.id, threadId: "thr_a" });
      await f.harness.callRpc("taskThreadsAttach", { taskId: task.id, threadId: "thr_a" });
    }],
  ])("keeps a thread after %s during the evaluation, and releases the card once", async (_name, change) => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task, "thr_a");
    const hold = gate();
    f.world.getGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await tick();
    f.world.getGate = null;
    await change(f, task);
    hold.open();
    await idle;
    expect(f.row(id, "thr_a")).toMatchObject({ action: "kept", reason: "link changed" });
    expect(f.world.archived).toEqual([]);
    expect(f.comments(task).filter((body) => /^Thread detached/.test(body))).toHaveLength(1);
  });

  it("keeps a thread when a policy edit or a project move turns the closed status open during the awaits", async () => {
    for (const change of [
      (f: ClosureFixture) => { f.store.tasks.updateProject(f.project.id, { workflowPolicy: { doneStatus: "done" } as never }); },
      (f: ClosureFixture, task: { id: string }) => {
        const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
        f.store.tasks.updateProject(other.id, { statuses: [...DEFAULT_TASK_STATUSES, { id: "shipped", name: "Shipped" }] });
        f.store.tasks.moveTaskToProject(task.id, other.id);
      },
    ]) {
      const f = await setup();
      customDone(f);
      const task = f.card();
      f.link(task, "thr_a");
      const hold = gate();
      f.world.getGate = hold.promise;
      f.store.tasks.updateTask(task.id, { status: "shipped" });
      const id = f.store.tasks.closures.currentId(task.id)!;
      const pending = f.store.closures.onClosed(id);
      await tick();
      change(f, task);
      hold.open();
      expect(await pending).toEqual([{ threadId: "thr_a", action: "kept", reason: "card reopened" }]);
      expect(f.world.archived).toEqual([]);
    }
  });

  it("through the registered lifecycle handler, a close then an idle during the evaluation archives and releases once", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task, "thr_a");
    await f.emit("thread.idle", "thr_a");
    expect(f.world.archived).toEqual(["thr_a"]);
    expect(f.row(id, "thr_a")?.action).toBe("archived");
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([]);
    const lines = f.comments(task);
    expect(lines.filter((body) => body.startsWith("Thread archived (automatic): @thread:thr_a — EXA-1 was closed"))).toHaveLength(1);
    expect(lines.filter((body) => body.startsWith("Thread detached"))).toEqual([]);
  });
});

describe("claimed archive attempts", () => {
  it("treats an archived event that arrives before the call resolves as its own: one line, one release, no fallback parent", async () => {
    const f = await setup();
    const task = f.card();
    f.world.threads.set("thr_a", { parentThreadId: "thr_parent" });
    f.link(task, "thr_a");
    const hold = gate();
    f.world.archiveGate = hold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    await tick();
    expect(f.row(id, "thr_a")?.action).toBe("archiving");
    await f.harness.emitThreadEvent("thread.archived", { thread: f.thread("thr_a", { archivedAt: 1, parentThreadId: "thr_parent" }) });
    hold.open();
    await pending;
    expect(f.row(id, "thr_a")?.action).toBe("archived");
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([]);
    const lines = f.comments(task);
    expect(lines.filter((body) => body.startsWith("Thread archived (automatic)"))).toHaveLength(1);
    expect(lines.filter((body) => /^Thread (detached|attached)/.test(body))).toEqual([]);
  });

  it("archives once when an idle and the close evaluation race", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a");
    const hold = gate();
    f.world.getGate = hold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    await tick();
    f.world.getGate = null;
    await f.emit("thread.idle", "thr_a");
    hold.open();
    await pending;
    expect(f.world.archived).toEqual(["thr_a"]);
    expect(f.comments(task).filter((body) => body.startsWith("Thread archived (automatic)"))).toHaveLength(1);
  });

  it("a failed archive keeps the thread and does not block a later manual archive", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a");
    f.world.failArchive = true;
    const { id, out } = await f.close(task);
    expect(out).toEqual([{ threadId: "thr_a", action: "kept", reason: "archive failed" }]);
    expect(f.row(id, "thr_a")?.action).toBe("kept");
    await f.harness.emitThreadEvent("thread.archived", { thread: f.thread("thr_a", { archivedAt: 1 }) });
    expect(f.comments(task).some((body) => body.startsWith("Thread detached (archived)"))).toBe(true);
  });

  it("an unknown outcome after a restart and an unarchive both make a later archive an ordinary one", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a");
    f.world.archiveGate = new Promise(() => undefined);
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    void f.store.closures.onClosed(id);
    await tick();
    expect(f.row(id, "thr_a")?.action).toBe("archiving");
    f.store.tasks.closures.recoverOnStartup();
    expect(f.row(id, "thr_a")).toMatchObject({ action: "kept", reason: "archive outcome unknown" });
    await f.harness.emitThreadEvent("thread.archived", { thread: f.thread("thr_a", { archivedAt: 1 }) });
    expect(f.comments(task).some((body) => body.startsWith("Thread detached (archived)"))).toBe(true);

    const second = await setup();
    const other = second.card();
    second.link(other, "thr_b");
    const closure = await second.close(other);
    expect(second.row(closure.id, "thr_b")?.action).toBe("archived");
    await second.harness.emitThreadEvent("thread.unarchived", { thread: second.thread("thr_b") });
    expect(second.row(closure.id, "thr_b")).toMatchObject({ action: "kept", reason: "unarchived" });
  });
});

describe("close path", () => {
  it("dispatches a direct write once, after the commit, and nothing for a rolled-back transaction", async () => {
    const f = await setup();
    const seen: string[] = [];
    f.store.tasks.onClosure((closureId) => { seen.push(closureId); });
    const first = f.card("First");
    f.store.tasks.updateTask(first.id, { status: "canceled" });
    expect(seen).toEqual([]);
    await tick();
    expect(seen).toEqual([f.store.tasks.closures.currentId(first.id)]);
    f.store.tasks.updateTask(first.id, { status: "done" });
    await tick();
    expect(seen).toHaveLength(1);

    const second = f.card("Second");
    expect(() => f.store.transaction(() => { f.store.tasks.updateTask(second.id, { status: "done" }); throw new Error("rolled back"); })).toThrow("rolled back");
    await tick();
    expect(seen).toHaveLength(1);
    expect(f.store.tasks.closures.currentId(second.id)).toBeNull();

    const third = f.card("Third");
    f.store.transaction(() => { f.store.tasks.updateTask(third.id, { status: "done" }); expect(seen).toHaveLength(1); });
    expect(seen).toHaveLength(2);
  });

  it("is the same for updateTask and updatePosition", async () => {
    const f = await setup();
    const seen: string[] = [];
    f.store.tasks.onClosure((closureId) => { seen.push(closureId); });
    const byUpdate = f.card("Update");
    const byMove = f.card("Move");
    f.store.tasks.updateTask(byUpdate.id, { status: "done" });
    f.store.tasks.updatePosition(byMove.id, { status: "canceled" });
    await tick();
    expect(seen).toEqual([f.store.tasks.closures.currentId(byUpdate.id), f.store.tasks.closures.currentId(byMove.id)]);
  });

  it("close, reopen, close: the first closure's pending archive does not fire", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const first = await f.close(task);
    expect(f.row(first.id, "thr_a")?.action).toBe("on_idle");
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    const second = await f.close(task);
    expect(second.id).not.toBe(first.id);
    await f.emit("thread.idle", "thr_a");
    // Only the current closure acts: one archive, and the first closure's intent is left untouched.
    expect(f.world.archived).toEqual(["thr_a"]);
    expect(f.row(first.id, "thr_a")?.action).toBe("on_idle");
    expect(f.row(second.id, "thr_a")?.action).toBe("archived");
  });

  it("archives the closer after its closing turn, and a duplicate idle archives nothing more", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const { out } = await f.close(task, "thr_a");
    expect(out).toEqual([{ threadId: "thr_a", action: "on_idle", reason: null }]);
    expect(f.world.archived).toEqual([]);
    await f.emit("thread.idle", "thr_a");
    await f.emit("thread.idle", "thr_a");
    expect(f.world.archived).toEqual(["thr_a"]);
  });

  it("a closed card whose custom done status turns open before the next turn sends no notice and re-attaches nothing", async () => {
    const f = await setup();
    customDone(f);
    const task = f.card();
    f.link(task, "thr_a", { spawned: false, origin: "delegate_existing", liveStatus: "working" });
    await f.close(task, undefined, "shipped");
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: { doneStatus: "done" } as never });
    await f.emit("thread.active", "thr_a", { parentThreadId: "thr_parent" });
    expect(f.world.sent).toEqual([]);

    // A custom done status never re-attaches a renamed session through title discovery.
    const other = f.card("Second");
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: { doneStatus: "shipped" } as never });
    f.store.tasks.updateTask(other.id, { status: "shipped" });
    await f.emit("thread.active", "thr_found", { title: "EXA-2 lead" });
    expect(f.store.tasks.listTaskThreads(other.id)).toEqual([]);
  });
});
