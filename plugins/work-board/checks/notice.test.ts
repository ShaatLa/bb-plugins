import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { receiptPolling } from "../steer";
import { choosePayload, classifyNoticeError, NOTICE_MAX_BYTES } from "./notice";
import { checksService, checksTuning } from "./service";
import { BB_PROJECT, cleanTempDirs, MANAGER, setup, type Fixture } from "./fixtures";

const fixtures: Fixture[] = [];
/** A runner whose notice receiver is on; tests break the manager as they need to. */
const make = async (fields: Record<string, unknown> = {}) => {
  const f = await setup(); fixtures.push(f); f.standard(); f.output("ACTION idle EXA-1", 1); await f.enable(fields); f.control.hub.enabled = true; return f;
};
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; checksTuning.lateSearchMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

type Db = Fixture["db"];
const rows = (db: Db) => db.prepare<[], Record<string, any>>("SELECT * FROM checks_notice_attempts ORDER BY started_at, rowid").all();
const ticks = (db: Db) => db.prepare<[], Record<string, any>>("SELECT * FROM checks_ticks ORDER BY at, rowid").all();
const pending = (f: Fixture) => f.delivery()?.report_id as string | null;
const coded = (code: string, status: number) => Object.assign(new Error(code), { code, status });
const archive = (f: Fixture) => f.threads.threads.set(MANAGER, { archived: true });
const recover = (f: Fixture) => f.threads.threads.set(MANAGER, {});
/** A report staged while the receiver is off: it stays pending and is pushed, as it did before notices. */
const stagePending = async (f: Fixture) => {
  f.control.hub.enabled = false; archive(f);
  await f.tick();
  f.control.hub.enabled = true; f.pushes.length = 0;
};
const land = (f: Fixture, attempt: Record<string, unknown>) => f.threads.addRow(attempt.manager_thread_id as string, `Needs attention\n\n${attempt.marker}`);
const unknownReport = async (f: Fixture) => {
  f.threads.sendMode = "throw"; f.threads.sendError = undefined;
  await f.tick();
  await f.tick();
  expect(f.attempts()[0]).toMatchObject({ outcome: "unknown" });
  f.threads.sendMode = "queue";
};
/** A service restart: the old runner stops, a new one reads the same database. */
const restart = async (f: Fixture) => {
  const next = await f.harness.lifecycle.reload(async (bb) => {
    const { createStore, registerTasksApi } = await import("../api");
    const { registerChecks } = await import("./rpc");
    registerTasksApi(bb, createStore(bb)); registerChecks(bb);
  });
  fixtures.splice(fixtures.indexOf(f), 1, { ...f, dispose: () => next.harness.dispose() } as Fixture);
  return { db: next.bb.storage.database(), tick: () => checksService(next.bb).scheduledTick(f.tracker.id), service: checksService(next.bb), rpc: (method: string, input: unknown) => next.harness.callRpc(method, input) as Promise<any> };
};

describe("classifying a failed call", () => {
  it("counts only a coded invalid_input or unknown_method as definite", () => {
    expect(classifyNoticeError(coded("invalid_input", 400))).toBe("refused");
    expect(classifyNoticeError(coded("unknown_method", 404))).toBe("unavailable");
    for (const error of [coded("invalid_output", 502), coded("handler_error", 500), coded("transport_error", 503), Object.assign(new Error("not found"), { status: 404 }), new Error("503"), new ZodError([]), new DOMException("aborted", "AbortError"), new DOMException("timed out", "TimeoutError")]) {
      expect(classifyNoticeError(error)).toBe("possible");
    }
  });

  it("keeps the row open for an uncoded 404 and a 5xx on the first call", async () => {
    for (const error of [Object.assign(new Error("not found"), { status: 404 }), coded("handler_error", 500)]) {
      const f = await make();
      archive(f);
      f.control.hub.before = () => { throw error; };
      await f.tick();
      expect(rows(f.db)).toMatchObject([{ outcome: "sending" }]);
      expect(f.pushes).toHaveLength(0);
    }
  });
});

describe("the payload", () => {
  it("uses the formatted body when it fits and the raw body when only that fits", () => {
    expect(choosePayload("formatted", "raw")).toEqual({ markdown: "formatted" });
    expect(choosePayload("x".repeat(NOTICE_MAX_BYTES + 1), "raw")).toEqual({ markdown: "raw" });
    expect(choosePayload("é".repeat(NOTICE_MAX_BYTES / 2 + 1), "raw")).toEqual({ markdown: "raw" });
    expect(choosePayload("x".repeat(NOTICE_MAX_BYTES + 1), "y".repeat(NOTICE_MAX_BYTES + 1))).toMatchObject({ tooLarge: expect.stringContaining("too large") });
  });

  it("sends the raw staged body when the formatted one is over the limit", async () => {
    const f = await make();
    await stagePending(f);
    const raw = "x".repeat(NOTICE_MAX_BYTES - 5);
    f.db.prepare("UPDATE checks_delivery SET pending_body=?").run(raw);
    await f.tick();
    // The rerun after the acceptance may stage the next report; only the first call is under test.
    expect(f.control.hub.calls[0]!.markdown).toBe(raw);
    expect(rows(f.db)[0]).toMatchObject({ outcome: "accepted" });
  });

  it("writes a refused row directly, and never a sending one, when neither body fits, then pushes", async () => {
    const f = await make();
    await stagePending(f);
    f.db.exec("CREATE TABLE seen (outcome TEXT); CREATE TRIGGER seen_notice AFTER INSERT ON checks_notice_attempts BEGIN INSERT INTO seen VALUES (NEW.outcome); END;");
    f.db.prepare("UPDATE checks_delivery SET pending_body=?").run("x".repeat(NOTICE_MAX_BYTES + 1));
    await f.tick();
    expect(f.db.prepare("SELECT outcome FROM seen").all()).toEqual([{ outcome: "refused" }]);
    expect(rows(f.db)).toMatchObject([{ outcome: "refused", error: expect.stringContaining("too large") }]);
    expect(f.control.hub.calls).toHaveLength(0);
    expect(f.pushes).toHaveLength(1);
    expect(pending(f)).toBeTruthy();
  });
});

describe("immediate success", () => {
  it.each(["unset", "archived", "failed"] as const)("delivers as a notice once with the manager %s, without a Work Board push", async (mode) => {
    const f = await make({ snapshots: true });
    f.output("ACTION idle EXA-1", 1, '{"c":1}');
    if (mode === "unset") { await stagePending(f); f.setManager(null); }
    else if (mode === "archived") archive(f);
    else { f.threads.sendMode = "throw"; f.threads.sendError = Object.assign(new Error("forbidden"), { status: 403 }); }
    await f.tick();
    const all = ticks(f.db);
    const stagedTick = all[0]!.tick;
    const manager = mode === "unset" ? null : MANAGER;
    expect(rows(f.db)).toMatchObject([{ outcome: "accepted", tick_id: stagedTick, notice_id: "ans_example1", manager_thread_id: manager }]);
    expect(f.control.hub.calls).toHaveLength(1);
    expect(f.control.hub.calls[0]).toMatchObject({ source: "work-board", tickId: stagedTick, projectId: BB_PROJECT, title: expect.stringContaining("manager unavailable (CHK)") });
    expect(f.control.hub.calls[0]!.threadId).toBe(manager ?? undefined);
    expect(pending(f)).toBeNull();
    expect(f.db.prepare("SELECT committed FROM checks_delivery").get()).toEqual({ committed: Buffer.from('{"c":1}') });
    expect(f.pushes).toHaveLength(0);
    expect(f.threads.rows).toHaveLength(0);
    const status = f.service.status(f.tracker.id);
    expect(status.lastDelivery).toMatchObject({ to: "agent-hub", receipt: { mode: "notice", id: "ans_example1" }, tickId: stagedTick });
    expect(status.fallbackReason).toBeTruthy();
    const last = all.at(-1)!;
    expect([last.delivered, last.notices]).toEqual([1, 1]);
    expect(f.state().lastReport).toEqual(expect.objectContaining({ fingerprint: expect.any(String) }));
    expect("manager" in f.state().lastReport).toBe(mode !== "unset");
    expect(f.state()).toMatchObject({ deliveryError: null, receipt: { mode: "notice" } });
  });

  it("counts per tick: the failed delivery on its staged tick, the notice on the tick that accepts it", async () => {
    const f = await make();
    await stagePending(f);
    await f.tick();
    expect(ticks(f.db).map((t) => [t.executed, t.delivered, t.delivery_failed, t.notices, t.delivery_unknown])).toEqual([[1, 0, 1, 0, 0], [1, 1, 0, 1, 0]]);
    expect(f.service.status(f.tracker.id).stats).toMatchObject({ deliveries: 1, notices: 1, deliveryFailures: 1 });
  });
});

describe("crash and lost reply", () => {
  it("writes the row before the call: a stopped runner is replayed by a new one with zero manager sends", async () => {
    const f = await make();
    archive(f);
    let stored!: () => void;
    const hold = new Promise<void>((resolve) => { stored = resolve; });
    f.control.hub.after = async (_reply, signal) => { stored(); await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("runner stopped")), { once: true })); };
    const running = f.tick().catch(() => "stopped");
    await hold;
    expect(rows(f.db)).toMatchObject([{ outcome: "sending" }]);
    const next = await restart(f);
    await running;
    f.control.hub.after = undefined; recover(f);
    await next.tick();
    expect(rows(next.db)).toMatchObject([{ outcome: "accepted", notice_id: "ans_example1" }]);
    expect(f.control.hub.calls).toHaveLength(2);
    expect(f.control.hub.items.size).toBe(1);
    expect(f.threads.sends).toBe(0);
    expect(next.service.status(f.tracker.id).stats).toMatchObject({ deliveries: 1, notices: 1 });
  });

  it("replays a row stopped before its first call, and the reply that creates the item is accepted at once", async () => {
    const f = await make();
    await stagePending(f);
    const staged = f.delivery()!;
    f.db.prepare("INSERT INTO checks_notice_attempts (attempt_id, tracker_id, report_id, tick_id, bb_project_id, manager_thread_id, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 'sending')")
      .run("att_example", f.tracker.id, staged.report_id, staged.pending_tick, BB_PROJECT, MANAGER, new Date().toISOString());
    recover(f);
    expect(f.control.hub.calls).toHaveLength(0);
    await f.tick();
    expect(f.control.hub.calls).toHaveLength(1);
    expect(rows(f.db)).toMatchObject([{ attempt_id: "att_example", outcome: "accepted" }]);
    expect(pending(f)).toBeNull();
    expect(f.threads.sends).toBe(0);
    expect(f.service.status(f.tracker.id).stats).toMatchObject({ deliveries: 1, notices: 1 });
  });

  it.each([
    ["a transport error", () => { throw new Error("connection reset"); }],
    ["a malformed success", () => ({ id: 5 })],
  ])("accepts the replay of a lost reply once, with no manager dispatch in between (%s)", async (_name, lose) => {
    const f = await make();
    archive(f);
    f.control.hub.after = lose;
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "sending", passes: 1 }]);
    expect(f.pushes).toHaveLength(0);
    expect(ticks(f.db)[0]).toMatchObject({ delivery_failed: 0 });
    recover(f);
    await f.tick(); // still failing: the fence holds although the manager is usable again
    expect(f.threads.sends).toBe(0);
    expect(rows(f.db)).toMatchObject([{ outcome: "sending", passes: 2 }]);
    f.control.hub.after = undefined;
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "accepted" }]);
    expect(f.control.hub.items.size).toBe(1);
    expect(f.threads.sends).toBe(0);
    expect(f.service.status(f.tracker.id).stats).toMatchObject({ deliveries: 1, notices: 1 });
  });

  it("rolls back a local commit failure after acceptance without a push, and accepts the replay once", async () => {
    const f = await make();
    archive(f);
    f.db.exec("CREATE TRIGGER block_promote BEFORE UPDATE ON checks_delivery WHEN NEW.report_id IS NULL BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    await expect(f.tick()).rejects.toThrow(/disk full/);
    expect(rows(f.db)).toMatchObject([{ outcome: "sending" }]);
    expect(f.control.hub.items.size).toBe(1);
    expect(f.pushes).toHaveLength(0);
    expect(pending(f)).toBeTruthy();
    expect(f.state().deliveryError).toMatch(/disk full/);
    f.db.exec("DROP TRIGGER block_promote");
    recover(f);
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "accepted" }]);
    expect(f.control.hub.items.size).toBe(1);
    expect(f.threads.sends).toBe(0);
    expect(f.state()).toMatchObject({ receipt: { mode: "notice" }, deliveryError: null });
    expect(f.service.status(f.tracker.id).stats).toMatchObject({ deliveries: 1, notices: 1 });
  });
});

describe("replays that prove nothing", () => {
  it("keeps the fence through a missing method, a refusal and a disabled receiver, ends as unknown once across a restart, and Retry dispatches to the manager", async () => {
    const f = await make();
    archive(f);
    f.control.hub.after = () => { throw new Error("connection reset"); };
    await f.tick(); // pass 1: stored, reply lost
    f.db.prepare("UPDATE checks_notice_attempts SET first_error_at=?").run(new Date(Date.now() - 3_600_000).toISOString());
    f.control.hub.after = undefined; recover(f);
    for (const refuse of [() => { throw coded("unknown_method", 404); }, () => { throw coded("invalid_input", 400); }]) {
      f.control.hub.before = refuse;
      await f.tick();
      expect(rows(f.db)).toMatchObject([{ outcome: "sending" }]);
    }
    f.control.hub.before = undefined; f.control.hub.enabled = false;
    await f.tick(); // pass 4
    expect(rows(f.db)).toMatchObject([{ outcome: "sending", passes: 4 }]);
    expect(f.threads.sends).toBe(0);
    expect(f.pushes).toHaveLength(0);

    const next = await restart(f);
    await next.tick(); // pass 5 reaches the bounds, on the new runner
    expect(rows(next.db)).toMatchObject([{ outcome: "unknown", passes: 5 }]);
    expect(ticks(next.db)[0]).toMatchObject({ delivery_unknown: 1, delivery_failed: 0 });
    expect(f.pushes).toHaveLength(1);
    expect(next.service.status(f.tracker.id)).toMatchObject({ awaitingRetry: true, blocked: expect.stringContaining("Retry"), deliveryError: expect.stringContaining("Agent Hub may already have it") });
    await next.tick(); // an unknown row is replayed as late evidence: nothing is counted or pushed again
    expect(f.pushes).toHaveLength(1);
    expect(f.threads.sends).toBe(0);
    expect(ticks(next.db).reduce((sum, t) => sum + t.delivery_unknown, 0)).toBe(1);

    await expect(next.rpc("retryChecksReport", { projectId: f.tracker.id })).resolves.toEqual({ ok: true });
    expect(rows(next.db)).toMatchObject([{ outcome: "superseded" }]);
    await next.tick();
    expect(f.threads.sends).toBe(1);
    expect(f.threads.text(f.threads.rows[0]!)).toContain("Needs attention");
    expect(next.db.prepare("SELECT report_id FROM checks_delivery").get()).toEqual({ report_id: null });
    expect(next.db.prepare("SELECT outcome FROM checks_attempts").all()).toEqual([{ outcome: "queued" }]);
  });

  it("accepts an unknown row when a later replay is answered", async () => {
    const f = await make();
    archive(f);
    f.control.hub.after = () => { throw new Error("connection reset"); };
    await f.tick();
    f.db.prepare("UPDATE checks_notice_attempts SET passes=4, first_error_at=?").run(new Date(Date.now() - 3_600_000).toISOString());
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "unknown" }]);
    f.control.hub.after = undefined;
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "accepted" }]);
    expect(pending(f)).toBeNull();
    expect(f.service.status(f.tracker.id).stats).toMatchObject({ deliveries: 1, notices: 1, deliveryUnknown: 1 });
  });
});

describe("first-call refusals", () => {
  it("stores an invalid_input refusal before the push and never resends that report, across a restart", async () => {
    const f = await make();
    archive(f);
    f.control.hub.before = () => { throw coded("invalid_input", 400); };
    const seen: string[][] = [];
    const push = f.pushes.push.bind(f.pushes);
    f.pushes.push = (...items) => { seen.push(rows(f.db).map((r) => r.outcome)); return push(...items); };
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "refused" }]);
    expect(seen).toEqual([["refused"]]);
    expect(ticks(f.db)[0]).toMatchObject({ delivery_failed: 1 });
    expect(pending(f)).toBeTruthy();
    const next = await restart(f);
    await next.tick();
    expect(f.control.hub.calls).toHaveLength(1);
    expect(rows(next.db)).toHaveLength(1);
  });

  it("marks a missing method unavailable, pushes, and opens a new row once the receiver is upgraded", async () => {
    const f = await make();
    archive(f);
    f.control.hub.before = () => { throw coded("unknown_method", 404); };
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "unavailable" }]);
    expect(f.pushes).toHaveLength(1);
    f.control.hub.before = undefined;
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "unavailable" }, { outcome: "accepted" }]);
    expect(pending(f)).toBeNull();
    expect(f.pushes).toHaveLength(1);
  });

  it("writes no row and keeps today's behaviour (pending, pushed, counted) when Agent Hub is not enabled", async () => {
    const f = await make();
    f.control.hub.enabled = false; archive(f);
    await f.tick();
    expect(rows(f.db)).toHaveLength(0);
    expect(f.control.hub.calls).toHaveLength(0);
    expect(f.pushes).toHaveLength(1);
    expect(ticks(f.db)[0]).toMatchObject({ delivery_failed: 1 });
    expect(pending(f)).toBeTruthy();
  });
});

describe("the manager route stays untouched", () => {
  it("never opens a notice for a manager attempt that is pending or unknown", async () => {
    const f = await make();
    f.threads.sendMode = "inline"; f.threads.acceptInline = false;
    await f.tick();
    await f.tick();
    expect(f.attempts()[0]).toMatchObject({ outcome: "sending" });
    expect(rows(f.db)).toHaveLength(0);
    const g = await make();
    g.threads.sendMode = "throw"; g.threads.sendError = undefined;
    await g.tick();
    await g.tick();
    expect(g.attempts()[0]).toMatchObject({ outcome: "unknown" });
    expect(rows(g.db)).toHaveLength(0);
    expect(f.control.hub.calls).toHaveLength(0);
    expect(g.control.hub.calls).toHaveLength(0);
  });
});

describe("late manager evidence and a notice", () => {
  it("lets a late manager receipt acknowledge nothing once the notice was accepted", async () => {
    const f = await make();
    await unknownReport(f);
    const first = f.attempts()[0]!;
    await f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id });
    archive(f);
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "accepted" }]);
    land(f, first);
    await f.tick();
    expect(f.attempts().map((a) => a.outcome)).toEqual(["superseded"]);
    expect(f.service.status(f.tracker.id)).toMatchObject({ lastDelivery: { to: "agent-hub", receipt: { mode: "notice" } }, stats: { deliveries: 1, notices: 1 } });
  });

  it("lets a late manager receipt win while the notice is still sending, and supersedes the notice", async () => {
    const f = await make({ snapshots: true });
    f.output("ACTION idle EXA-1", 1, '{"c":1}');
    await unknownReport(f);
    const first = f.attempts()[0]!;
    await f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id });
    archive(f);
    f.control.hub.after = () => { throw new Error("connection reset"); };
    await f.tick();
    expect(rows(f.db)).toMatchObject([{ outcome: "sending" }]);
    land(f, first);
    await f.tick();
    expect(f.attempts()[0]).toMatchObject({ outcome: "queued" });
    expect(rows(f.db)).toMatchObject([{ outcome: "superseded" }]);
    expect(f.db.prepare("SELECT committed FROM checks_delivery").get()).toEqual({ committed: Buffer.from('{"c":1}') });
    expect(f.service.status(f.tracker.id)).toMatchObject({ lastDelivery: { receipt: { mode: "queued" } }, stats: { deliveries: 1, notices: 0 } });
    const calls = f.control.hub.calls.length;
    await f.tick();
    expect(f.control.hub.calls).toHaveLength(calls);
  });
});

describe("reset and status", () => {
  it("clears the tracker's notice rows together with its attempts", async () => {
    const f = await make();
    await unknownReport(f);
    await f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id });
    archive(f);
    await f.tick();
    expect(rows(f.db)).toHaveLength(1);
    await f.service.setEnabled(f.tracker.id, false);
    f.service.reset(f.tracker.id);
    expect(rows(f.db)).toHaveLength(0);
    expect(f.attempts()).toHaveLength(0);
  });

  it("serves a notice receipt and a legacy manager receipt through the status schema, the JSON and the text of the CLI", async () => {
    const f = await make();
    await f.tick(); // a legacy route: a queued manager receipt
    const legacy = await f.harness.callRpc("getChecksStatus", { projectId: f.tracker.id }) as any;
    expect(legacy.lastDelivery).toMatchObject({ to: MANAGER, receipt: { mode: "queued" } });
    f.output("ACTION idle EXA-2", 1);
    archive(f);
    await f.tick();
    const status = await f.harness.callRpc("getChecksStatus", { projectId: f.tracker.id }) as any;
    expect(status).toMatchObject({ lastDelivery: { to: "agent-hub", receipt: { mode: "notice" } }, stats: { deliveries: 2, notices: 1 }, fallbackReason: expect.any(String) });
    const json = await f.harness.runCli(["checks", "status", "--project", "CHK", "--json"]);
    expect(JSON.parse(json.stdout!)).toMatchObject({ lastDelivery: { receipt: { mode: "notice" } }, stats: { notices: 1 } });
    const text = await f.harness.runCli(["checks", "status", "--project", "CHK"]);
    expect(text.stdout).toMatch(/Last delivery\s+.* to agent-hub \(notice\)/);
    expect(text.stdout).toMatch(/Fallback reason\s+\S/);
    expect(text.stdout).toContain("2 delivered (1 as notice)");
  });
});
