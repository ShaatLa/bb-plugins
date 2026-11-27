import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MANAGER, setup } from "../attention/fixtures";
import { historyLimits, receiptPolling } from "../steer";
import { drainPauseExpiryNotices } from "./expiry";
import { endPauses, recordExpiredManualPause, startManualPause, startSignalPause } from "./store";
import { sweepPauseSignals } from "./signals";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const fixtures: { dispose: () => unknown }[] = [];
const limits = { ...historyLimits };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { Object.assign(historyLimits, limits); vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

function fixture() {
  const f = setup();
  fixtures.push(f);
  const { db, bb, threads } = f;
  f.threads.sendMode = "inline";
  const task = f.card("Example");
  const warn = vi.spyOn(bb.log, "warn");
  /** Sets a manual pause by `setter` and lets it expire; the sweep records the notice and delivers it. */
  const expire = async (setter = "thr_setter", reason = "waiting for a release") => {
    const row = startManualPause(db, task.id, reason, MINUTE, setter);
    db.prepare("UPDATE task_pauses SET until='2000-01-01T00:00:00.000Z' WHERE id=?").run(row.id);
    await sweep();
    return row;
  };
  const sweep = async () => { await sweepPauseSignals(bb); await drainPauseExpiryNotices(bb); };
  const notice = () => db.prepare<[], { state: string; attempts: number; recipient: string | null; next_at: string | null; last_error: string | null }>("SELECT state,attempts,recipient,next_at,last_error FROM pause_expiry_notices").get()!;
  const notices = () => db.prepare<[], { n: number }>("SELECT count(*) AS n FROM pause_expiry_notices").get()!.n;
  const to = (threadId: string) => threads.requests.filter((request) => request.threadId === threadId && request.text.includes("manual pause")).map((request) => request.text);
  const comments = () => db.prepare<[string], { body: string }>("SELECT body FROM comments WHERE task_id=? AND kind='system' AND body LIKE '%expired at%' ORDER BY rowid").all(task.id).map((row) => row.body);
  const age = (ms: number) => db.prepare("UPDATE pause_expiry_notices SET attempted_at=?").run(new Date(Date.now() - ms).toISOString());
  const due = () => db.prepare("UPDATE pause_expiry_notices SET next_at=NULL").run();
  return { ...f, task, expire, sweep, notice, notices, to, comments, age, due, warn };
}

it("sends one notice to the live setter, with the reason, the set time and the expiry, and never repeats it", async () => {
  const f = fixture();
  const pause = await f.expire();
  const [text] = f.to("thr_setter");
  expect(f.to("thr_setter")).toHaveLength(1);
  expect(text).toContain(`[${f.task.key}](/plugins/work-board/work-board/task/${f.task.key})`);
  expect(text).toContain("expired at 2000-01-01T00:00:00.000Z");
  expect(text).toContain("waiting for a release");
  expect(text).toContain(`Set by thr_setter at ${pause.started_at}`);
  expect(text).not.toContain("still active");
  expect(text).not.toContain("You get this because");
  expect(f.notice()).toMatchObject({ state: "sent", attempts: 1, recipient: "thr_setter" });
  await f.sweep(); await f.sweep();
  expect(f.to("thr_setter")).toHaveLength(1);
  expect(f.threads.sends).toBe(1);
  expect(f.comments()).toEqual([]);
});

it("goes to the live parent of an archived setter, and on to the grandparent", async () => {
  const f = fixture();
  f.threads.threads.set("thr_setter", { archived: true, parent: "thr_parent" });
  f.threads.threads.set("thr_parent", { parent: "thr_grand" });
  await f.expire();
  expect(f.to("thr_parent")).toHaveLength(1);
  expect(f.to("thr_parent")[0]).toContain("You get this because thr_setter is archived or gone.");
  expect(f.to("thr_setter")).toHaveLength(0);
  f.db.prepare("DELETE FROM pause_expiry_notices").run();
  f.threads.requests.length = 0;
  f.threads.threads.set("thr_parent", { archived: true, parent: "thr_grand" });
  await f.expire();
  expect(f.to("thr_grand")).toHaveLength(1);
  expect(f.to("thr_parent")).toHaveLength(0);
});

it("goes to the manager when no thread of the chain is live, the setter is gone or the setter is the owner", async () => {
  const f = fixture();
  f.threads.threads.set("thr_setter", { archived: true });
  await f.expire();
  expect(f.to(MANAGER)[0]).toContain("archived or gone and no live parent was found");
  f.db.prepare("DELETE FROM pause_expiry_notices").run();
  f.threads.requests.length = 0;
  const real = f.threads.sdk.threads.get;
  f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => { if (args.threadId === "thr_missing") throw Object.assign(new Error("gone"), { code: "thread_not_found" }); return real(args); });
  await f.expire("thr_missing");
  expect(f.to(MANAGER)).toHaveLength(1);
  f.db.prepare("DELETE FROM pause_expiry_notices").run();
  f.threads.requests.length = 0;
  await f.expire("owner");
  expect(f.to(MANAGER)).toHaveLength(1);
  expect(f.to(MANAGER)[0]).toContain("set by the owner");
});

it("writes one card comment when there is no live thread and no manager, and does nothing more later", async () => {
  const f = fixture();
  f.db.prepare("DELETE FROM attention_manager").run();
  f.threads.threads.set("thr_setter", { archived: true });
  await f.expire();
  expect(f.notice().state).toBe("on_card");
  expect(f.comments()).toHaveLength(1);
  expect(f.comments()[0]).toContain("waiting for a release");
  await f.sweep(); await f.sweep();
  expect(f.comments()).toHaveLength(1);
  expect(f.threads.sends).toBe(0);
});

it("never resends a row interrupted before the send, and shows it on the card after an hour", async () => {
  const f = fixture();
  await f.expire();
  f.threads.requests.length = 0; f.threads.sends = 0;
  f.db.prepare("UPDATE pause_expiry_notices SET state='sending', attempted_at=?").run(new Date().toISOString());
  await f.sweep(); await f.sweep();
  expect(f.notice().state).toBe("unknown");
  expect(f.threads.sends).toBe(0);
  expect(f.comments()).toEqual([]);
  f.age(61 * MINUTE);
  await f.sweep(); await f.sweep();
  expect(f.notice().state).toBe("unknown_on_card");
  expect(f.comments()).toHaveLength(1);
  expect(f.comments()[0]).toContain("Delivery could not be confirmed; check that thread.");
  expect(f.comments()[0]).toContain("thr_setter");
  expect(f.threads.sends).toBe(0);
});

it("settles a row whose message was accepted before the restart without a second message or a card comment", async () => {
  const f = fixture();
  await f.expire();
  const marker = `<!-- work-board-pause-expiry:${(f.db.prepare("SELECT pause_id FROM pause_expiry_notices").get() as { pause_id: string }).pause_id} -->`;
  f.threads.requests.length = 0; f.threads.accepted.length = 0; f.threads.sends = 0;
  f.db.prepare("UPDATE pause_expiry_notices SET state='sending', attempted_at=?").run(new Date(Date.now() - MINUTE).toISOString());
  f.threads.dispatch(`The manual pause ... ${marker}`, "thr_setter");
  await f.sweep();
  expect(f.notice().state).toBe("sent");
  expect(f.threads.sends).toBe(0);
  expect(f.comments()).toEqual([]);
});

it("keeps a late-accepted notice from being resent, shows it at one hour and settles it when the marker appears", async () => {
  const f = fixture();
  f.threads.acceptInline = false;
  await f.expire();
  expect(f.notice().state).toBe("unknown");
  await f.sweep(); await f.sweep();
  expect(f.threads.sends).toBe(1);
  f.age(61 * MINUTE);
  await f.sweep();
  expect(f.notice().state).toBe("unknown_on_card");
  expect(f.comments()).toHaveLength(1);
  f.age(70 * MINUTE);
  f.threads.dispatch(f.threads.lastBody, "thr_setter");
  await f.sweep();
  expect(f.notice().state).toBe("sent");
  await f.sweep();
  expect(f.threads.sends).toBe(1);
  expect(f.to("thr_setter")).toHaveLength(1);
  expect(f.comments()).toHaveLength(1);
});

it("retries a definite rejection with a doubling backoff, tells the card at the third failure, and re-resolves the recipient", async () => {
  const f = fixture();
  f.threads.sendMode = "throw";
  f.threads.sendError = Object.assign(new Error("rejected"), { status: 400 });
  const waits: number[] = [];
  const wait = () => Date.parse(f.notice().next_at!) - Date.now();
  await f.expire();
  waits.push(wait());
  // Not yet due: the sweep leaves the row alone.
  await f.sweep();
  expect(f.notice().attempts).toBe(1);
  f.due(); await f.sweep(); waits.push(wait());
  expect(f.comments()).toEqual([]);
  f.threads.threads.set("thr_setter", { archived: true, parent: "thr_parent" });
  f.due(); await f.sweep(); waits.push(wait());
  expect(f.notice()).toMatchObject({ state: "failed_on_card", attempts: 3, recipient: "thr_parent" });
  expect(waits.map((ms) => Math.round(ms / MINUTE))).toEqual([1, 2, 4]);
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(f.comments()).toHaveLength(1);
  // The retries go on, with the card told only once and the wait capped at an hour.
  for (let i = 0; i < 8; i++) { f.due(); await f.sweep(); }
  expect(f.comments()).toHaveLength(1);
  expect(Math.round(wait() / MINUTE)).toBe(60);
  f.threads.sendMode = "inline";
  f.due(); await f.sweep();
  expect(f.notice().state).toBe("sent");
  expect(f.to("thr_parent")).toHaveLength(1);
});

it("names the other applied pauses on the card in the notice", async () => {
  const f = fixture();
  const first = startManualPause(f.db, f.task.id, "waiting", MINUTE, "thr_setter");
  startSignalPause(f.db, f.task.id, "background", "thr_other", "Running", true);
  // The expiry pass alone: the sweep itself would end a background pause of a project with automatic pauses off.
  f.db.transaction(() => { endPauses(f.db, f.task.id, "expired", "system", { signal: "manual" }); recordExpiredManualPause(f.db, first, "2000-01-01T00:00:00.000Z"); })();
  await drainPauseExpiryNotices(f.bb);
  expect(f.to("thr_setter")[0]).toContain("Other pauses on the card are still active: background.");
  f.db.prepare("DELETE FROM pause_expiry_notices").run();
  f.threads.requests.length = 0;
  // Expired and delivered later: a new manual pause set before the delivery is named too.
  f.threads.sendGate = new Promise(() => undefined);
  const pause = startManualPause(f.db, f.task.id, "again", MINUTE, "thr_setter");
  f.db.prepare("UPDATE task_pauses SET until='2000-01-01T00:00:00.000Z' WHERE id=?").run(pause.id);
  await sweepPauseSignals(f.bb);
  f.threads.sendGate = undefined;
  startManualPause(f.db, f.task.id, "newer", HOUR, "thr_setter");
  f.db.prepare("UPDATE pause_expiry_notices SET state='pending'").run();
  await drainPauseExpiryNotices(f.bb);
  expect(f.to("thr_setter")[0]).toContain("still active: manual.");
});

it("sends no notice for a pause ended by resume or an extension, nor for an expired background pause", async () => {
  const f = fixture();
  startManualPause(f.db, f.task.id, "First", HOUR, "thr_setter");
  startManualPause(f.db, f.task.id, "Extended", 2 * HOUR, "thr_setter");
  f.db.transaction(() => endPauses(f.db, f.task.id, "resume", "owner"))();
  startSignalPause(f.db, f.task.id, "background", "thr_other", "Running", true);
  f.db.prepare("UPDATE task_pauses SET until='2000-01-01T00:00:00.000Z'").run();
  await f.sweep();
  expect(f.notices()).toBe(0);
  expect(f.threads.sends).toBe(0);
});
