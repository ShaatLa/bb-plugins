import { afterEach, describe, expect, it } from "vitest";
import { closureFixture, type ClosureFixture } from "./fixture";

const fixtures: ClosureFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.harness.dispose()));
});
/** A card closed while thr_a (child of thr_parent) works on it, with archiving off so the thread is only kept. */
async function closedWhileWorking(options: Parameters<typeof closureFixture>[0] = { projectSettings: { archiveThreadsOnClose: "off" } }) {
  const f = await closureFixture(options);
  fixtures.push(f);
  f.world.threads.set("thr_a", { parentThreadId: "thr_parent" });
  const task = f.card();
  f.link(task, "thr_a", { liveStatus: "working" });
  const { id } = await f.close(task);
  return { f, task, id };
}
const sentTo = (f: ClosureFixture, threadId: string) => f.world.sent.filter((entry) => entry.threadId === threadId);

describe("notice to a session that works inside a closed card", () => {
  it("sends the thread and its parent one notice each, once, after the close, the idle and a new turn", async () => {
    const { f, task } = await closedWhileWorking();
    await f.emit("thread.idle", "thr_a");
    expect(f.world.sent).toEqual([]);
    await f.emit("thread.active", "thr_a");
    await f.emit("thread.active", "thr_a");
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(sentTo(f, "thr_a")[0]!.text).toContain("EXA-1 is Done, but this session started new work while still linked to it.");
    expect(sentTo(f, "thr_a")[0]!.text).toContain("if EXA-1 is not finished, reopen it");
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
    expect(sentTo(f, "thr_parent")[0]!.text).toContain("@thread:thr_a started new work while still linked to it");
    // The 0.59.3 release still keeps the link off the card.
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([]);
  });

  it("retires a turn-bound intent on a new turn and notifies", async () => {
    const { f, id } = await closedWhileWorking({});
    expect(f.row(id, "thr_a")?.action).toBe("on_idle");
    await f.emit("thread.active", "thr_a");
    expect(f.row(id, "thr_a")).toMatchObject({ action: "kept", reason: "new turn after close" });
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(f.world.archived).toEqual([]);
  });

  it("retries only the recipient that failed on the next turn, and stops at two attempts", async () => {
    const { f, id } = await closedWhileWorking();
    f.world.failSend.add("thr_parent");
    await f.emit("thread.active", "thr_a");
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "sent", parentNotice: "failed", parentAttempts: 1 });
    f.world.failSend.clear();
    await f.emit("thread.active", "thr_a");
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
    expect(f.row(id, "thr_a")).toMatchObject({ parentNotice: "sent", parentAttempts: 2 });

    const capped = await closedWhileWorking();
    capped.f.world.failSend.add("thr_parent");
    for (let turn = 0; turn < 4; turn++) await capped.f.emit("thread.active", "thr_a");
    expect(capped.f.row(capped.id, "thr_a")).toMatchObject({ parentNotice: "failed", parentAttempts: 2, selfNotice: "sent" });
    expect(sentTo(capped.f, "thr_a")).toHaveLength(1);
  });

  it("marks an interrupted delivery unknown on restart and never resends it", async () => {
    const { f, id } = await closedWhileWorking();
    expect(f.store.tasks.closures.claimNotice(id, "thr_a", "self")).toBe(1);
    expect(f.store.tasks.closures.recoverOnStartup().unknownNotices).toBe(1);
    expect(f.row(id, "thr_a")?.selfNotice).toBe("unknown");
    await f.emit("thread.active", "thr_a");
    expect(sentTo(f, "thr_a")).toEqual([]);
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
  });

  it("does not duplicate a notice for a reentrant event", async () => {
    const { f } = await closedWhileWorking();
    await Promise.all([f.emit("thread.active", "thr_a"), f.emit("thread.active", "thr_a")]);
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
  });

  it("redirects the parent copy past an archived parent", async () => {
    const { f } = await closedWhileWorking();
    f.world.threads.set("thr_parent", { archivedAt: 1, parentThreadId: "thr_grand" });
    await f.emit("thread.active", "thr_a");
    expect(sentTo(f, "thr_parent")).toEqual([]);
    expect(sentTo(f, "thr_grand")).toHaveLength(1);
  });

  it("sends nothing for a card that was reopened", async () => {
    const { f, task } = await closedWhileWorking();
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    await f.emit("thread.active", "thr_a");
    expect(f.world.sent).toEqual([]);
  });
});
