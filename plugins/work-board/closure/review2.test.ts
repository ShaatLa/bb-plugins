import { afterEach, describe, expect, it, vi } from "vitest";
import { closedThreadsBlock } from "./format";
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
const PLAN = "# Plan\n\n## Steps\nAdd the table.\n";

describe("C2.1: the caller's attach is validated against the card as it is after the SDK reads", () => {
  it("does not attach to a card archived during the reads", async () => {
    const f = await setup();
    const task = f.card("Closed work");
    f.store.tasks.updateTask(task.id, { status: "done" });
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead" });
    const hold = gate();
    f.world.getGate = hold.promise;
    const run = f.harness.runCli(["update", "EXA-1", "--progress", "Note"], { threadId: "thr_caller" });
    await tick();
    f.store.tasks.setTaskArchived(task.id, true);
    hold.open();
    await run;
    expect(f.store.tasks.getTaskThreadByThreadId(task.id, "thr_caller")).toBeUndefined();
  });

  it("does not log another user's concurrent edit as the caller's", async () => {
    const f = await setup();
    const task = f.card("Work");
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead" });
    const hold = gate();
    f.world.getGate = hold.promise;
    const run = f.harness.runCli(["update", "EXA-1", "--progress", "Note"], { threadId: "thr_caller" });
    await tick();
    f.store.tasks.updateTask(task.id, { priority: "high" });
    hold.open();
    await run;
    expect(f.comments(task).filter((body) => body.startsWith("Priority changed"))).toEqual([]);
  });
});

describe("C2.2: the caller's role is read from one SDK read and the recorded link origin", () => {
  const attachedAfter = async (arrange: (f: ClosureFixture, task: { id: string }) => void) => {
    const f = await setup();
    const task = f.card("Work");
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead" });
    arrange(f, task);
    expect(await f.harness.runCli(["update", "EXA-1", "--progress", "Note"], { threadId: "thr_caller" })).toMatchObject({ exitCode: 0 });
    return f.store.tasks.getTaskThreadByThreadId(task.id, "thr_caller") !== undefined;
  };
  it("makes a helper of a child of the card holder, even when the holder's preset is called Parent thread", async () => {
    expect(await attachedAfter((f, task) => { f.link(task, "thr_lead", { spawned: false, origin: "manual" }); })).toBe(false);
    expect(await attachedAfter((f, task) => { f.link(task, "thr_lead", { spawned: true, presetName: "Parent thread" }); })).toBe(false);
  });
  it("attaches the child of a parent fallback link, which holds nothing", async () => {
    expect(await attachedAfter((f, task) => { f.link(task, "thr_lead", { spawned: false, origin: "parent", presetName: "Parent thread" }); })).toBe(true);
  });
});

describe("C2.3: the close result promises an archive only for sessions that pass every disqualifier known at the close", () => {
  it.each([
    ["queued input", "has queued input", (f: ClosureFixture) => { f.world.queue.set("thr_a", 1); }],
    ["a live child", "has live child threads", (f: ClosureFixture) => { f.world.children.set("thr_a", 1); }],
    ["a failed read", "could not verify", (f: ClosureFixture) => { f.world.failGet = true; }],
  ])("keeps a working session with %s", async (_name, reason, arrange) => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    arrange(f);
    const { out } = await f.close(task);
    expect(out).toEqual([{ threadId: "thr_a", action: "kept", reason }]);
    expect(closedThreadsBlock("EXA-1", out)).not.toContain("Do not reuse");
  });

  it("keeps a working session that got another open card during the reads", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const hold = gate();
    f.world.getGate = hold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    await tick();
    f.link(f.card("Second"), "thr_a", { spawned: false });
    hold.open();
    expect(await pending).toEqual([{ threadId: "thr_a", action: "kept", reason: "linked to EXA-2" }]);
  });
});

describe("C2.4: the close result is the state after the evaluation, including an idle decision that overlaps it", () => {
  it("reports a worker an idle archived during the evaluation as archived", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    f.link(task, "thr_b", { liveStatus: "working" });
    const hold = gate();
    const archiveHold = gate();
    f.world.childGate = hold.promise;
    f.world.archiveGate = archiveHold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    let resolved = false;
    const pending = f.store.closures.onClosed(id).then((result) => { resolved = true; return result; });
    await tick();
    const idle = f.emit("thread.idle", "thr_b");
    await tick();
    hold.open();
    await tick();
    // The idle decision for thr_b is still archiving: the close result waits for it instead of reporting it half done.
    expect(f.row(id, "thr_b")?.action).toBe("archiving");
    expect(resolved).toBe(false);
    archiveHold.open();
    const out = await pending;
    await idle;
    expect(out).toEqual([
      { threadId: "thr_a", action: "on_idle", reason: null },
      { threadId: "thr_b", action: "archived", reason: null },
    ]);
    expect(f.world.archived).toEqual(["thr_b"]);
  });

  it("never tells the session to start fresh while a decision is pending", () => {
    expect(closedThreadsBlock("EXA-1", [{ threadId: "thr_x", action: "on_idle", reason: "decision pending" }])).toBe("EXA-1 closed.\nPending: thr_x (decision pending).");
  });
});

describe("C2.5: a notice is dropped inside the delivery when the card was reopened", () => {
  it("sends nothing when the card is reopened while the queue read is blocked", async () => {
    const f = await setup({ projectSettings: { archiveThreadsOnClose: "off" } });
    const task = f.card();
    f.world.threads.set("thr_a", { parentThreadId: "thr_parent" });
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task);
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const hold = gate();
    f.world.queuedGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.harness.sdk.callsTo("threads.queuedMessages.list").length).toBeGreaterThan(0));
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    hold.open();
    await idle;
    expect(f.world.sent).toEqual([]);
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "failed", parentNotice: "failed" });
  });
});

describe("C2.6: the archive event only bypasses reconciliation for the link the archive was decided for", () => {
  it("reconciles a link a manual upsert reused in place", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a");
    const hold = gate();
    f.world.archiveGate = hold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    await tick();
    f.link(task, "thr_a", { spawned: false, origin: "manual" });
    await f.harness.emitThreadEvent("thread.archived", { thread: f.thread("thr_a", { archivedAt: 1 }) });
    hold.open();
    await pending;
    expect(f.comments(task).some((body) => body.startsWith("Thread detached (archived)"))).toBe(true);
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([]);
  });
});

describe("C2.7: only a reviewer whose archive intent was armed is watched", () => {
  it.each([
    ["an ordinary review", { dedicated: false }],
    ["a project with the setting off", { dedicated: true, setting: "off" }],
  ])("costs no SQL on later events of %s", async (_name, options: { dedicated: boolean; setting?: string }) => {
    const f = await setup(options.setting ? { projectSettings: { archiveReviewerOnApproval: options.setting } } : undefined);
    f.bb.storage.database().prepare("UPDATE projects SET planning = 'optional'").run();
    f.card("Planned work");
    const run = async (args: string[], threadId: string) => expect(await f.harness.runCli(args, { threadId })).toMatchObject({ exitCode: 0 });
    await run(["plan", "set", "EXA-1", "--body", PLAN, "--base-version", "0", "--summary", "Initial"], "thr_author");
    f.world.threads.set("thr_reviewer", { parentThreadId: "thr_author" });
    await run(["plan", "submit", "EXA-1", "--reviewer", "thr_reviewer", ...(options.dedicated ? ["--dedicated-reviewer"] : [])], "thr_author");
    await run(["plan", "approve", "EXA-1", "--version", "1"], "thr_reviewer");
    const statements: string[] = [];
    const db = f.bb.storage.database();
    const prepare = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", { configurable: true, writable: true, value(source: string) { statements.push(source); return prepare(source); } });
    await f.emit("thread.active", "thr_reviewer");
    await f.emit("thread.idle", "thr_reviewer");
    expect(statements.filter((sql) => /task_plan_reviews|closure_threads/.test(sql))).toEqual([]);
  });
});
