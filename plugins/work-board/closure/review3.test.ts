import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses.js";
import { snapshotLateLink } from "../delegate/attach";
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

describe("C3.1 and C3.2: one holder predicate for the attach path and the report command", () => {
  const holders: Array<[string, (f: ClosureFixture, task: { id: string }) => void]> = [
    ["a legacy Attached worker (no origin)", (f, task) => { f.link(task, "thr_lead", { spawned: false, origin: null, presetName: "Attached" }); }],
    ["a legacy link labelled Parent thread (no origin)", (f, task) => { f.link(task, "thr_lead", { spawned: false, origin: null, presetName: "Parent thread" }); }],
    ["a Delegate worker named Parent thread", (f, task) => { f.link(task, "thr_lead", { spawned: true, presetName: "Parent thread" }); }],
  ];

  it.each(holders)("update --progress makes the child of %s a helper, not a worker", async (_name, arrange) => {
    const f = await setup();
    const task = f.card("Work");
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead" });
    arrange(f, task);
    expect(await f.harness.runCli(["update", "EXA-1", "--progress", "Note"], { threadId: "thr_caller" })).toMatchObject({ exitCode: 0 });
    expect(f.store.tasks.getTaskThreadByThreadId(task.id, "thr_caller")).toBeUndefined();
  });

  it.each(holders)("report from the child of %s neither attaches it nor replaces the card's current state", async (_name, arrange) => {
    const f = await setup();
    const task = f.card("Work");
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead" });
    arrange(f, task);
    const result = await f.harness.runCli(["report", "EXA-1", "--kind", "ready", "--body", "Done here", "--json"], { threadId: "thr_caller" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ stateUpdated: false, attached: false });
    expect(f.store.tasks.getTask(task.id)?.progressNote ?? null).toBeNull();
    expect(f.store.tasks.getTaskThreadByThreadId(task.id, "thr_caller")).toBeUndefined();
  });

  it("report from the child of a parent fallback link (origin parent) is the card's own session", async () => {
    const f = await setup();
    const task = f.card("Work");
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead" });
    f.link(task, "thr_lead", { spawned: false, origin: "parent", presetName: "Parent thread" });
    const result = await f.harness.runCli(["report", "EXA-1", "--kind", "ready", "--body", "Done here", "--json"], { threadId: "thr_caller" });
    expect(JSON.parse(result.stdout)).toMatchObject({ stateUpdated: true, attached: true });
  });
});

describe("C3.3: a late candidate whose checks are still running is pending, not promised", () => {
  it("reports it as pending in a close result that outlasts it", async () => {
    const f = await setup();
    const task = f.card();
    f.link(task, "thr_a");
    const archiveHold = gate();
    f.world.archiveGate = archiveHold.promise;
    f.store.tasks.updateTask(task.id, { status: "done" });
    const id = f.store.tasks.closures.currentId(task.id)!;
    const pending = f.store.closures.onClosed(id);
    await tick();
    // thr_a is archiving. A late spawn arrives and its child check blocks.
    const childHold = gate();
    f.world.childGate = childHold.promise;
    const late = f.link(task, "thr_late", { liveStatus: "working" });
    expect(snapshotLateLink(f.store.tasks, task.id, late, true, "delegate_spawn")).toBe(id);
    const settling = f.store.closures.lateLink(id, "thr_late");
    await tick();
    archiveHold.open();
    const out = await pending;
    expect(out).toEqual([
      { threadId: "thr_a", action: "archived", reason: null },
      { threadId: "thr_late", action: "on_idle", reason: "decision pending" },
    ]);
    childHold.open();
    await settling;
    expect(f.row(id, "thr_late")?.action).toBe("on_idle");
  });
});

describe("C3.4: the transport outcome is recorded as it happened", () => {
  it("records a notice appended to an editable queued message as sent even if the card reopened during the update", async () => {
    const f = await setup({ projectSettings: { archiveThreadsOnClose: "off" } });
    f.store.tasks.updateProject(f.project.id, { statuses: [...DEFAULT_TASK_STATUSES, { id: "shipped", name: "Shipped" }], workflowPolicy: { doneStatus: "shipped" } as never });
    const task = f.card();
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task, undefined, "shipped");
    const updates: unknown[] = [];
    const hold = gate();
    f.harness.sdk.stub("threads.queuedMessages.list", async () => [makeQueueEntry({ id: "queued_1", threadId: "thr_a", originPluginId: "work-board", state: "queued", content: [{ type: "text", text: "[bb message from plugin:work-board]\n\nEarlier", mentions: [] }] })]);
    f.harness.sdk.stub("threads.queuedMessages.update", async (args: unknown) => { updates.push(args); await hold.promise; return { ok: true }; });
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    // A policy edit makes the status open for a moment, under the same closure.
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: { doneStatus: "done" } as never });
    hold.open();
    await idle;
    expect(f.row(id, "thr_a")?.selfNotice).toBe("sent");
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: { doneStatus: "shipped" } as never });
    await f.turn("thr_a", () => f.edit("thr_a", "src/other.ts"));
    expect(updates).toHaveLength(1);
    expect(f.world.sent.filter((entry) => entry.threadId === "thr_a")).toEqual([]);
  });
});
