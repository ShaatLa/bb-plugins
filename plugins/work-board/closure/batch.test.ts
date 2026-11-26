import { afterEach, describe, expect, it, vi } from "vitest";
import { closureFixture, gate, type ClosureFixture } from "./fixture";
import { CLOSED_CARD_WINDOW_MS } from "./service";

const fixtures: ClosureFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.harness.dispose()));
});
const HOUR = 60 * 60 * 1000;

async function setup() {
  const f = await closureFixture({ projectSettings: { archiveThreadsOnClose: "off" } });
  fixtures.push(f);
  f.world.threads.set("thr_a", { parentThreadId: "thr_parent" });
  const info = vi.spyOn(f.bb.log, "info");
  const logged = () => info.mock.calls.map((call) => String(call[0]));
  /** Closes a card with thr_a linked to it. */
  const closed = async (title: string, status = "done") => {
    const task = f.card(title);
    f.link(task, "thr_a", { liveStatus: "working" });
    const { id } = await f.close(task, undefined, status);
    return { task, id };
  };
  /** A card thr_a is still working on, in the given status. */
  const open = (title: string, status: string) => {
    const task = f.card(title);
    f.link(task, "thr_a", { liveStatus: "working" });
    if (status !== "in_progress") f.store.tasks.updateTask(task.id, { status });
    return task;
  };
  /** Moves a closure's close time `hours` into the past. */
  const age = (id: string, hours: number) =>
    f.bb.storage.database().prepare("UPDATE task_closures SET closed_at = ? WHERE id = ?").run(new Date(Date.now() - hours * HOUR).toISOString(), id);
  const to = (threadId: string) => f.world.sent.filter((entry) => entry.threadId === threadId).map((entry) => entry.text);
  return { f, closed, open, age, to, logged };
}

describe("rule 1: another open card explains the turn", () => {
  for (const status of ["in_progress", "backlog", "in_review"]) {
    it(`sends nothing while the thread is linked to an open card in ${status}, and names it in the log`, async () => {
      const { f, closed, open, to, logged } = await setup();
      const first = await closed("One");
      const second = await closed("Two");
      open("Three", status);
      await f.turn("thr_a", () => f.edit("thr_a"));
      expect(f.world.sent).toEqual([]);
      expect(logged()).toContain("No closed-card notice for thr_a: it is working on EXA-3");
      expect(f.row(first.id, "thr_a")).toMatchObject({ workSeen: false, selfNotice: "none" });
      expect(f.row(second.id, "thr_a")).toMatchObject({ workSeen: false, parentNotice: "none" });
      expect(to("thr_parent")).toEqual([]);
    });
  }

  it("counts the other open cards in the log line", async () => {
    const { f, closed, open, logged } = await setup();
    await closed("One");
    open("Two", "in_progress");
    open("Three", "backlog");
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(logged()).toContain("No closed-card notice for thr_a: it is working on EXA-2 (and 1 more open card)");
  });

  it("still tells a thread whose only card closed, and then keeps editing", async () => {
    const { f, closed, age, to } = await setup();
    const { id } = await closed("One");
    age(id, 2);
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toHaveLength(1);
    expect(to("thr_parent")).toHaveLength(1);
  });

  it("retires a failed notice when the thread now has an open card, and sends nothing to either recipient", async () => {
    const { f, closed, open } = await setup();
    const { id } = await closed("One");
    f.world.failSend.add("thr_parent");
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "sent", parentNotice: "failed", workSeen: true });
    f.world.failSend.clear();
    open("Two", "in_progress");
    await f.turn("thr_a");
    expect(f.row(id, "thr_a")).toMatchObject({ workSeen: false, parentNotice: "failed" });
    expect(f.world.sent).toHaveLength(1);
  });
});

describe("rule 2: only recent closures", () => {
  it("skips a closure older than 24 h with its reason and compares one 23 h old", async () => {
    const { f, closed, age, to, logged } = await setup();
    const stale = await closed("Old");
    const fresh = await closed("Recent");
    age(stale.id, 25);
    age(fresh.id, 23);
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(logged()).toContain("No closed-card notice for thr_a: closed more than 24 h ago (EXA-1)");
    expect(f.row(stale.id, "thr_a")).toMatchObject({ workSeen: false, selfNotice: "none" });
    expect(to("thr_a")).toEqual([expect.stringContaining("EXA-2 is Done.")]);
    expect(to("thr_a")[0]).not.toContain("EXA-1");
    expect(CLOSED_CARD_WINDOW_MS).toBe(24 * HOUR);
  });

  it("retires a failed notice whose closure has passed 24 h, and sends nothing", async () => {
    const { f, closed, age } = await setup();
    const { id } = await closed("One");
    f.world.failSend.add("thr_a");
    f.world.failSend.add("thr_parent");
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "failed", workSeen: true });
    f.world.failSend.clear();
    age(id, 30);
    await f.turn("thr_a");
    expect(f.row(id, "thr_a")).toMatchObject({ workSeen: false });
    expect(f.world.sent).toEqual([]);
  });
});

describe("rule 3: one notice per recipient per turn", () => {
  it("sends one message to the thread and one to its parent for three closed cards, and marks every row sent", async () => {
    const { f, closed, to } = await setup();
    const ids = [(await closed("One")).id, (await closed("Two", "canceled")).id, (await closed("Three")).id];
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toEqual([expect.stringContaining("EXA-1 (Done), EXA-2 (Canceled), EXA-3 (Done): files in this session's environment changed during a turn after these cards closed. If this is work for another card, it is fine; reopen any that is not finished.")]);
    expect(to("thr_parent")).toEqual([expect.stringContaining("EXA-1 (Done), EXA-2 (Canceled), EXA-3 (Done): files in the environment of @thread:thr_a changed during a turn after these cards closed.")]);
    for (const id of ids) expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "sent", parentNotice: "sent" });
  });

  it("marks every row of a failed batch failed, retries one batch, and never resends an unknown outcome", async () => {
    const { f, closed, to } = await setup();
    const ids = [(await closed("One")).id, (await closed("Two")).id, (await closed("Three")).id];
    f.world.failSend.add("thr_a");
    await f.turn("thr_a", () => f.edit("thr_a"));
    for (const id of ids) expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "failed", selfAttempts: 1, parentNotice: "sent" });
    f.world.failSend.clear();
    await f.turn("thr_a");
    expect(to("thr_a")).toEqual([expect.stringContaining("EXA-1 (Done), EXA-2 (Done), EXA-3 (Done)")]);
    expect(to("thr_parent")).toHaveLength(1);
    // An unknown outcome is not part of any batch.
    const other = await closed("Four");
    f.store.tasks.closures.claimNotice(other.id, "thr_a", "self");
    f.store.tasks.closures.recoverOnStartup();
    expect(f.row(other.id, "thr_a")).toMatchObject({ selfNotice: "unknown" });
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toHaveLength(1);
    expect(to("thr_parent")[1]).toContain("EXA-4 is Done.");
    expect(to("thr_parent")).toHaveLength(2);
  });

  it("leaves a row another holder claimed out of the batch", async () => {
    const { f, closed, to } = await setup();
    const one = await closed("One");
    await closed("Two");
    expect(f.store.tasks.closures.claimNotice(one.id, "thr_a", "self")).toBe(1);
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toEqual([expect.stringContaining("EXA-2 is Done.")]);
    expect(f.row(one.id, "thr_a")).toMatchObject({ selfNotice: "sending" });
    expect(to("thr_parent")).toEqual([expect.stringContaining("EXA-1 (Done), EXA-2 (Done)")]);
  });

  it("drops a card reopened while the parent was being resolved, and sends the rest", async () => {
    const { f, closed, to } = await setup();
    const one = await closed("One");
    await closed("Two");
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const hold = gate();
    f.world.getGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(to("thr_a")).toHaveLength(1));
    f.store.tasks.updateTask(one.task.id, { status: "in_progress" });
    hold.open();
    await idle;
    expect(to("thr_parent")).toEqual([expect.stringContaining("EXA-2 is Done.")]);
  });

  it("drops a card reopened inside the serialized delivery, and sends nothing when it was the only row", async () => {
    const { f, closed, to } = await setup();
    const one = await closed("One");
    const two = await closed("Two");
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const hold = gate();
    f.world.queuedGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.harness.sdk.callsTo("threads.queuedMessages.list").length).toBeGreaterThan(0));
    f.store.tasks.updateTask(one.task.id, { status: "in_progress" });
    hold.open();
    await idle;
    expect(to("thr_a")).toEqual([expect.stringContaining("EXA-2 is Done.")]);
    expect(f.row(two.id, "thr_a")).toMatchObject({ selfNotice: "sent" });
    expect(f.row(one.id, "thr_a")).toMatchObject({ selfNotice: "failed" });
  });

  it("keeps a card reopened before the delivery out of the body merged into a queued notice", async () => {
    const { f, closed } = await setup();
    const one = await closed("One");
    await closed("Two");
    await closed("Three");
    const hold = gate();
    const queued = { id: "q1", content: [{ type: "text", text: "[bb message from plugin:work-board]\n\nEarlier", mentions: [] }], originPluginId: "work-board", state: "queued", editable: true, updatedAt: 1 };
    f.harness.sdk.stub("threads.queuedMessages.list", async ({ threadId }: { threadId: string }) => { await hold.promise; return threadId === "thr_a" ? [queued] as never : []; });
    const updates: string[] = [];
    f.harness.sdk.stub("threads.queuedMessages.update", async (request: never) => {
      updates.push((request as { input: Array<{ text: string }> }).input[0]!.text);
      return queued as never;
    });
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.harness.sdk.callsTo("threads.queuedMessages.list").length).toBeGreaterThan(0));
    f.store.tasks.updateTask(one.task.id, { status: "in_progress" });
    hold.open();
    await idle;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("EXA-2 (Done), EXA-3 (Done)");
    expect(updates[0]).not.toContain("EXA-1");
  });
});

describe("one attempt per turn", () => {
  it("makes one transport attempt for a failed delivery with a concurrent duplicate idle, and retries on the next turn", async () => {
    const { f, closed, to } = await setup();
    const { id } = await closed("One");
    f.world.failSend.add("thr_a");
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    await Promise.all([f.emit("thread.idle", "thr_a"), f.emit("thread.idle", "thr_a")]);
    // One transport attempt for the thread (the parent copy is its own recipient).
    expect(f.harness.sdk.callsTo("threads.send").filter((call) => JSON.stringify(call).includes('"threadId":"thr_a"'))).toHaveLength(1);
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "failed", selfAttempts: 1 });
    f.world.failSend.clear();
    await f.turn("thr_a");
    expect(to("thr_a")).toHaveLength(1);
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "sent", selfAttempts: 2 });
  });

  it("returns a duplicate idle at once, without notifying, while the first one is still comparing", async () => {
    const { f, closed, to } = await setup();
    const { id } = await closed("One");
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const hold = gate();
    f.world.gitGate = hold.promise;
    const first = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.world.gitCalls.length).toBeGreaterThan(2));
    await f.emit("thread.idle", "thr_a");
    expect(f.world.sent).toEqual([]);
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "none" });
    f.world.gitGate = null;
    hold.open();
    await first;
    expect(to("thr_a")).toHaveLength(1);
    expect(to("thr_parent")).toHaveLength(1);
  });

  it("makes one batch per turn for rows created at different times, with unequal turn generations", async () => {
    const { f, closed, to } = await setup();
    await closed("One");
    await f.turn("thr_a");
    await f.turn("thr_a");
    await closed("Two");
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toEqual([expect.stringContaining("EXA-1 (Done), EXA-2 (Done)")]);
    expect(to("thr_parent")).toHaveLength(1);
  });

  it("runs a later turn while the previous delivery is in flight, and sends no row twice", async () => {
    const { f, closed, to } = await setup();
    await closed("One");
    await closed("Two");
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const hold = gate();
    f.world.queuedGate = hold.promise;
    const first = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.harness.sdk.callsTo("threads.queuedMessages.list").length).toBeGreaterThan(0));
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a", "src/other.ts");
    const second = f.emit("thread.idle", "thr_a");
    hold.open();
    await Promise.all([first, second]);
    expect(to("thr_a")).toHaveLength(1);
    expect(to("thr_parent")).toHaveLength(1);
  });

  it("keeps rows in sending when recording a delivered batch fails, and never resends them", async () => {
    const { f, closed, age, to } = await setup();
    const { id } = await closed("One");
    age(id, 2);
    const finish = vi.spyOn(f.store.tasks.closures, "finishNotices").mockImplementation((_rows, _who, state) => {
      if (state === "sent") throw new Error("database is locked");
    });
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toHaveLength(1);
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "sending" });
    finish.mockRestore();
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toHaveLength(1);
  });

  it("never takes a real idle for a duplicate after its turn token was evicted", async () => {
    const { f, closed, age, to } = await setup();
    const { id } = await closed("One");
    age(id, 2);
    await f.turn("thr_a");
    // Enough other turns to evict thr_a's entries from both token maps.
    for (let i = 0; i < 1100; i++) await f.store.closures.turnStarted({ id: `thr_other${i}`, environmentId: null, parentThreadId: null } as never, []);
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(to("thr_a")).toHaveLength(1);
  });

  it("keeps every row in sending after a crash around the transport, and sends nothing for them on the next turn", async () => {
    const { f, closed } = await setup();
    const ids = [(await closed("One")).id, (await closed("Two")).id];
    for (const id of ids) {
      f.store.tasks.closures.claimNotice(id, "thr_a", "self");
      f.store.tasks.closures.claimNotice(id, "thr_a", "parent");
    }
    f.store.tasks.closures.recordWork(ids.map((id) => f.row(id, "thr_a")!));
    await f.turn("thr_a");
    for (const id of ids) expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "sending", parentNotice: "sending" });
    expect(f.world.sent).toEqual([]);
  });
});
