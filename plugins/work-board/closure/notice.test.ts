import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeTasksSchema } from "../db/schema";
import { SAMPLE_TIMEOUT_MS } from "./environment";
import { closureFixture, gate, type ClosureFixture } from "./fixture";

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

describe("closed-card notice after a turn that changed files", () => {
  it("sends nothing for a turn that only answered, and one notice each to the thread and its parent for an edit, once", async () => {
    const { f, task } = await closedWhileWorking();
    await f.turn("thr_a");
    await f.turn("thr_a");
    expect(f.world.sent).toEqual([]);
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(sentTo(f, "thr_a").map((entry) => entry.text)).toEqual([
      expect.stringContaining("EXA-1 is Done. Files in this session's environment changed during a turn after EXA-1 closed. If this is work for another card, it is fine; if EXA-1 is not finished, reopen it."),
    ]);
    expect(sentTo(f, "thr_parent").map((entry) => entry.text)).toEqual([
      expect.stringContaining("EXA-1 is Done. Files in the environment of @thread:thr_a changed during a turn after EXA-1 closed. If this is work for another card, it is fine; if EXA-1 is not finished, reopen it."),
    ]);
    // Both recipients are done: a later turn reads no Git at all, and sends nothing.
    const reads = f.world.gitCalls.length;
    await f.turn("thr_a", () => f.edit("thr_a", "src/other.ts"));
    expect(f.world.gitCalls).toHaveLength(reads);
    expect(f.world.sent).toHaveLength(2);
    // The link is still released at the turn start.
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([]);
  });

  it("counts a commit, and a second edit of a dirty file with the same line counts", async () => {
    const committed = await closedWhileWorking();
    await committed.f.turn("thr_a", () => committed.f.commit("thr_a"));
    expect(sentTo(committed.f, "thr_a")).toHaveLength(1);

    const edited = await closedWhileWorking();
    edited.f.edit("thr_a");
    await edited.f.turn("thr_a");
    expect(edited.f.world.sent).toEqual([]);
    await edited.f.turn("thr_a", () => edited.f.edit("thr_a"));
    expect(sentTo(edited.f, "thr_a")).toHaveLength(1);
  });

  it("counts the first commit on an unborn branch", async () => {
    const { f } = await closedWhileWorking();
    f.world.git.set("env_thr_a", { head: null, files: new Map(), checkout: "unborn" });
    await f.turn("thr_a");
    expect(f.world.sent).toEqual([]);
    await f.turn("thr_a", () => f.commit("thr_a"));
    expect(sentTo(f, "thr_a")).toHaveLength(1);
  });

  it("reads Git once per event for several closed cards and sends one batched notice per recipient", async () => {
    const f = await closureFixture({ projectSettings: { archiveThreadsOnClose: "off" } });
    fixtures.push(f);
    for (const title of ["First", "Second"]) {
      const task = f.card(title);
      f.link(task, "thr_a", { liveStatus: "working" });
      await f.close(task);
    }
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(f.world.gitCalls.map((call) => call.method)).toEqual(["status", "files", "status", "files"]);
    expect(f.world.gitCalls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
    expect(sentTo(f, "thr_a").map((entry) => entry.text)).toEqual([
      expect.stringContaining("EXA-1 (Done), EXA-2 (Done): files in this session's environment changed during a turn after these cards closed. If this is work for another card, it is fine; reopen any that is not finished."),
    ]);
  });

  it("retires a turn-bound intent on a new turn and notifies at its end", async () => {
    const { f, id } = await closedWhileWorking({});
    expect(f.row(id, "thr_a")?.action).toBe("on_idle");
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(f.row(id, "thr_a")).toMatchObject({ action: "kept", reason: "new turn after close" });
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(f.world.archived).toEqual([]);
  });

  it("retries a failed parent copy at the end of a later turn that only answered, and stops at two attempts", async () => {
    const { f, id } = await closedWhileWorking();
    f.world.failSend.add("thr_parent");
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(f.row(id, "thr_a")).toMatchObject({ selfNotice: "sent", parentNotice: "failed", parentAttempts: 1, workSeen: true });
    f.world.failSend.clear();
    await f.turn("thr_a");
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
    expect(f.row(id, "thr_a")).toMatchObject({ parentNotice: "sent", parentAttempts: 2 });

    const capped = await closedWhileWorking();
    capped.f.world.failSend.add("thr_parent");
    await capped.f.turn("thr_a", () => capped.f.edit("thr_a"));
    for (let turn = 0; turn < 3; turn++) await capped.f.turn("thr_a");
    expect(capped.f.row(capped.id, "thr_a")).toMatchObject({ parentNotice: "failed", parentAttempts: 2, selfNotice: "sent" });
    expect(sentTo(capped.f, "thr_a")).toHaveLength(1);
  });

  it("delivers recorded work on the next pass after a crash before the first claim", async () => {
    const { f, id } = await closedWhileWorking();
    f.store.tasks.closures.recordWork([f.row(id, "thr_a")!]);
    f.store.tasks.closures.recoverOnStartup();
    await f.turn("thr_a");
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
  });

  it("marks an interrupted delivery unknown on restart and never resends it", async () => {
    const { f, id } = await closedWhileWorking();
    expect(f.store.tasks.closures.claimNotice(id, "thr_a", "self")).toBe(1);
    expect(f.store.tasks.closures.recoverOnStartup().unknownNotices).toBe(1);
    expect(f.row(id, "thr_a")?.selfNotice).toBe("unknown");
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(sentTo(f, "thr_a")).toEqual([]);
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
  });

  it("redirects the parent copy past an archived parent", async () => {
    const { f } = await closedWhileWorking();
    f.world.threads.set("thr_parent", { archivedAt: 1, parentThreadId: "thr_grand" });
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(sentTo(f, "thr_parent")).toEqual([]);
    expect(sentTo(f, "thr_grand")).toHaveLength(1);
  });

  it("sends nothing for a card reopened during the turn", async () => {
    const { f, task } = await closedWhileWorking();
    await f.turn("thr_a", () => {
      f.edit("thr_a");
      f.store.tasks.updateTask(task.id, { status: "in_progress" });
    });
    expect(f.world.sent).toEqual([]);
    expect(f.store.closures.liveComparisons()).toBe(0);
  });
});

describe("turn comparison ownership", () => {
  it("retires a comparison whose idle came before its baseline, and compares the next turn", async () => {
    const { f, id } = await closedWhileWorking();
    const hold = gate();
    f.world.gitGate = hold.promise;
    const active = f.emit("thread.active", "thr_a");
    await vi.waitFor(() => expect(f.world.gitCalls).toHaveLength(1));
    f.edit("thr_a");
    await f.emit("thread.idle", "thr_a");
    f.world.gitGate = null;
    hold.open();
    await active;
    // The idle retired the turn before its baseline arrived: the late baseline is not stored.
    expect(f.row(id, "thr_a")?.turnBaseline).toBe("retired");
    expect(f.world.sent).toEqual([]);
    await f.turn("thr_a", () => f.edit("thr_a", "src/other.ts"));
    expect(sentTo(f, "thr_a")).toHaveLength(1);
  });

  it("compares once for a duplicate idle", async () => {
    const { f } = await closedWhileWorking();
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    await Promise.all([f.emit("thread.idle", "thr_a"), f.emit("thread.idle", "thr_a")]);
    expect(f.world.gitCalls.map((call) => call.method)).toEqual(["status", "files", "status", "files"]);
    expect(sentTo(f, "thr_a")).toHaveLength(1);
    expect(sentTo(f, "thr_parent")).toHaveLength(1);
  });

  it("keeps the latch of the comparison in flight when a duplicate idle arrives, so a sibling edit meanwhile is not blamed", async () => {
    const { f } = await closedWhileWorking();
    f.world.threads.set("thr_b", { environmentId: "env_elsewhere", updatedAt: 0 });
    await f.emit("thread.active", "thr_a");
    const hold = gate();
    f.world.gitGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.world.gitCalls).toHaveLength(3));
    await f.emit("thread.idle", "thr_a");
    expect(f.store.closures.liveComparisons()).toBe(1);
    await f.emit("thread.active", "thr_b", { environmentId: "env_thr_a" });
    f.edit("thr_a");
    await f.emit("thread.idle", "thr_b", { environmentId: "env_thr_a" });
    f.world.gitGate = null;
    hold.open();
    await idle;
    expect(f.world.sent).toEqual([]);
    expect(f.store.closures.liveComparisons()).toBe(0);
  });

  it("does not record work from a late idle read once the next turn started", async () => {
    const { f, id } = await closedWhileWorking();
    await f.emit("thread.active", "thr_a");
    const hold = gate();
    f.world.gitGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.world.gitCalls).toHaveLength(3));
    f.world.gitGate = null;
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    hold.open();
    await idle;
    // The old read saw the new turn's edit, but its generation no longer owns the row.
    expect(f.row(id, "thr_a")?.workSeen).toBe(false);
    expect(f.world.sent).toEqual([]);
    await f.emit("thread.idle", "thr_a");
    expect(sentTo(f, "thr_a")).toHaveLength(1);
  });

  it.each(["thread.failed", "thread.deleted", "thread.archived"] as const)("retires the comparison on %s during a read", async (event) => {
    const { f, id } = await closedWhileWorking();
    // During the baseline read.
    const first = gate();
    f.world.gitGate = first.promise;
    const active = f.emit("thread.active", "thr_a");
    await vi.waitFor(() => expect(f.world.gitCalls).toHaveLength(1));
    await f.harness.emitThreadEvent(event, { thread: f.thread("thr_a") } as never);
    expect(f.store.closures.liveComparisons()).toBe(0);
    f.world.gitGate = null;
    first.open();
    await active;
    expect(f.row(id, "thr_a")?.turnBaseline).toBeNull();
    // During the final read.
    await f.emit("thread.active", "thr_a");
    f.edit("thr_a");
    const second = gate();
    f.world.gitGate = second.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.world.gitCalls).toHaveLength(5));
    await f.harness.emitThreadEvent(event, { thread: f.thread("thr_a") } as never);
    expect(f.store.closures.liveComparisons()).toBe(0);
    f.world.gitGate = null;
    second.open();
    await idle;
    expect(f.row(id, "thr_a")?.workSeen).toBe(false);
    expect(f.world.sent).toEqual([]);
  });

  it("drops a comparison a restart interrupted, while an uninterrupted turn still notifies", async () => {
    const { f, id } = await closedWhileWorking();
    const other = f.card("Other");
    f.world.threads.set("thr_b", { parentThreadId: "thr_parent" });
    f.link(other, "thr_b", { liveStatus: "working" });
    await f.close(other);
    await f.emit("thread.active", "thr_a");
    f.store.tasks.closures.recoverOnStartup();
    expect(f.row(id, "thr_a")?.turnBaseline).toBeNull();
    f.edit("thr_a");
    await f.emit("thread.idle", "thr_a");
    await f.turn("thr_b", () => f.edit("thr_b"));
    expect(sentTo(f, "thr_a")).toEqual([]);
    expect(sentTo(f, "thr_b")).toHaveLength(1);
  });
});

describe("other threads on the same environment", () => {
  it("sends nothing when a sibling was already running at the baseline", async () => {
    const { f } = await closedWhileWorking();
    f.world.threads.set("thr_b", { environmentId: "env_thr_a", status: "active" });
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(f.world.sent).toEqual([]);
  });

  it("sends nothing when an unlinked sibling started and finished between the samples", async () => {
    const { f } = await closedWhileWorking();
    f.world.threads.set("thr_b", { environmentId: "env_thr_a", updatedAt: 0 });
    await f.turn("thr_a", () => {
      f.edit("thr_a");
      f.world.threads.set("thr_b", { environmentId: "env_thr_a", updatedAt: Date.now() });
    });
    expect(f.world.sent).toEqual([]);
  });

  it("sends nothing when a sibling turn started on the environment, even if it moved elsewhere before the final listing", async () => {
    const { f } = await closedWhileWorking();
    f.world.threads.set("thr_b", { environmentId: "env_elsewhere", updatedAt: 0 });
    await f.turn("thr_a", async () => {
      await f.emit("thread.active", "thr_b", { environmentId: "env_thr_a" });
      f.edit("thr_a");
      await f.emit("thread.idle", "thr_b", { environmentId: "env_thr_a" });
    });
    expect(f.world.sent).toEqual([]);
  });

  it("sends nothing when the sibling listing fails", async () => {
    const { f } = await closedWhileWorking();
    await f.turn("thr_a", () => {
      f.edit("thr_a");
      f.world.listFail = true;
    });
    expect(f.world.sent).toEqual([]);
  });

  it("ignores a sibling that stays idle on another environment", async () => {
    const { f } = await closedWhileWorking();
    f.world.threads.set("thr_b", { environmentId: "env_elsewhere", status: "active", updatedAt: Date.now() });
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(sentTo(f, "thr_a")).toHaveLength(1);
  });
});

describe("unreadable Git never blames a turn, and never holds up an archive", () => {
  /** thr_a is kept under a closed card (not spawned for it) and, during its turn, closes a second card that archives it at the idle. */
  async function keptAndArchiving(overrides: Parameters<ClosureFixture["emit"]>[2] = {}) {
    const f = await closureFixture();
    fixtures.push(f);
    const kept = f.card("Kept");
    f.link(kept, "thr_a", { spawned: false, liveStatus: "working" });
    const { id } = await f.close(kept);
    await f.emit("thread.active", "thr_a", overrides);
    const archived = f.card("Archived");
    f.link(archived, "thr_a", { liveStatus: "working" });
    await f.close(archived, "thr_a");
    f.edit("thr_a");
    return { f, id };
  }

  const cases: Array<[string, (f: ClosureFixture) => void, Parameters<ClosureFixture["emit"]>[2]?]> = [
    ["the git plugin is missing or disabled at the end", (f) => { f.world.gitFail = true; }],
    ["the host is offline", (f) => { f.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("host offline"); }); }],
    ["HEAD has no SHA", (f) => { f.world.git.get("env_thr_a")!.head = null; }],
    ["the file list is truncated", (f) => { f.world.git.get("env_thr_a")!.truncated = true; }],
    ["the checkout is unknown", (f) => { f.world.git.get("env_thr_a")!.checkout = "unknown"; }],
  ];
  it.each(cases)("sends nothing when %s, and the archive completes", async (_label, breakGit) => {
    const { f } = await keptAndArchiving();
    breakGit(f);
    await f.emit("thread.idle", "thr_a");
    expect(f.world.archived).toEqual(["thr_a"]);
    expect(f.world.sent).toEqual([]);
  });

  it("sends nothing when the thread has no environment, and the archive completes", async () => {
    const { f } = await keptAndArchiving({ environmentId: null });
    await f.emit("thread.idle", "thr_a", { environmentId: null });
    expect(f.world.archived).toEqual(["thr_a"]);
    expect(f.world.gitCalls).toEqual([]);
    expect(f.world.sent).toEqual([]);
  });

  it("sends nothing when the baseline could not be read, and the archive completes", async () => {
    const f = await closureFixture();
    fixtures.push(f);
    const kept = f.card("Kept");
    f.link(kept, "thr_a", { spawned: false, liveStatus: "working" });
    const { id } = await f.close(kept);
    f.world.gitFail = true;
    await f.emit("thread.active", "thr_a");
    expect(f.row(id, "thr_a")?.turnBaseline).toBe("unknown");
    f.world.gitFail = false;
    const archived = f.card("Archived");
    f.link(archived, "thr_a", { liveStatus: "working" });
    await f.close(archived, "thr_a");
    f.edit("thr_a");
    await f.emit("thread.idle", "thr_a");
    expect(f.world.archived).toEqual(["thr_a"]);
    expect(f.world.sent).toEqual([]);
  });

  it("sends nothing when the environment switched between the turn start and its end, and the archive completes", async () => {
    const { f } = await keptAndArchiving();
    await f.emit("thread.idle", "thr_a", { environmentId: "env_switched" });
    expect(f.world.archived).toEqual(["thr_a"]);
    expect(f.world.sent).toEqual([]);
  });

  it("gives up a read that never answers at the 5 s deadline, and archives meanwhile", async () => {
    const { f } = await keptAndArchiving();
    expect(SAMPLE_TIMEOUT_MS).toBe(5000);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    try {
      let pending = 0;
      f.harness.sdk.stub("plugins.callRpc", (args: { signal: AbortSignal }) => new Promise((_, reject) => {
        pending++;
        args.signal.addEventListener("abort", () => reject(args.signal.reason));
      }));
      const idle = f.emit("thread.idle", "thr_a");
      await vi.waitFor(() => expect(f.world.archived).toEqual(["thr_a"]));
      expect(pending).toBe(1);
      expect(timeout).toHaveBeenCalledWith(5000);
      deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      await idle;
      expect(f.world.sent).toEqual([]);
    } finally {
      timeout.mockRestore();
    }
  });

  it("archives while the final Git read is still blocked", async () => {
    const { f } = await keptAndArchiving();
    const hold = gate();
    f.world.gitGate = hold.promise;
    const idle = f.emit("thread.idle", "thr_a");
    await vi.waitFor(() => expect(f.world.archived).toEqual(["thr_a"]));
    expect(f.world.sent).toEqual([]);
    hold.open();
    await idle;
    expect(sentTo(f, "thr_a")).toHaveLength(1);
  });
});

describe("schema", () => {
  it("adds the turn columns to existing closure rows with no comparison pending and no work recorded", async () => {
    const { f, id } = await closedWhileWorking();
    const db = f.bb.storage.database();
    const columns = ["turn_generation", "turn_baseline", "turn_baseline_at", "work_seen"];
    // The database as the previous release left it: the row exists, the columns and the migration do not.
    for (const column of columns) db.exec(`ALTER TABLE closure_threads DROP COLUMN ${column}`);
    // Version 48 is the migration that adds them.
    db.prepare("DELETE FROM schema_version WHERE version = 48").run();
    initializeTasksSchema(db);
    expect(db.prepare<[], { name: string }>("PRAGMA table_info(closure_threads)").all().map((column) => column.name)).toEqual(expect.arrayContaining(columns));
    expect(f.row(id, "thr_a")).toMatchObject({ turnGeneration: 0, turnBaseline: null, turnBaselineAt: null, workSeen: false });
    initializeTasksSchema(db);
    await f.turn("thr_a", () => f.edit("thr_a"));
    expect(sentTo(f, "thr_a")).toHaveLength(1);
  });
});
