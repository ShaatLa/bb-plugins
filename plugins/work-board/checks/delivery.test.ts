import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiptPolling } from "../steer";
import { QUEUED_NOTICE_SEPARATOR } from "../steer";
import { checksTuning } from "./service";
import { cleanTempDirs, MANAGER, setup, type Fixture } from "./fixtures";

const fixtures: Fixture[] = [];
const make = async (fields: Record<string, unknown> = {}) => {
  const f = await setup(); fixtures.push(f); f.standard(); f.output("ACTION idle EXA-1", 1); f.enable(fields); return f;
};
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; checksTuning.lateSearchMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

const accepted = (f: Fixture) => f.attempts().filter((a) => ["queued", "appended", "inline"].includes(a.outcome as string));
const pendingId = (f: Fixture) => f.delivery()?.report_id as string | null;
/** A message that reaches the manager's queue without the plugin learning of it: the send whose response was lost. */
const land = (f: Fixture, attempt: Record<string, unknown>, thread = attempt.manager_thread_id as string) => f.threads.addRow(thread, `Needs attention\n\n${attempt.marker}`);
const unknownSend = (f: Fixture) => { f.threads.sendMode = "throw"; f.threads.sendError = undefined; };

describe("receipts", () => {
  it("confirms a send to an idle thread inline, with the accepted-input event as evidence", async () => {
    const f = await make();
    f.threads.sendMode = "inline";
    await f.tick();
    expect(accepted(f)).toMatchObject([{ outcome: "inline", inline_event_ref: expect.stringContaining(MANAGER) }]);
    expect(pendingId(f)).toBeNull();
    expect(f.service.status(f.tracker.id).lastDelivery).toMatchObject({ to: MANAGER, receipt: { mode: "inline" } });
  });

  it("queues a new row, then appends to it while it is still queued", async () => {
    const f = await make();
    await f.tick();
    f.output("ACTION idle EXA-2", 1);
    await f.tick();
    expect(accepted(f).map((a) => a.outcome)).toEqual(["queued", "appended"]);
    expect(f.threads.rows).toHaveLength(1);
    expect(f.sent()).toContain(QUEUED_NOTICE_SEPARATOR);
    expect(f.service.status(f.tracker.id).lastDelivery?.receipt).toMatchObject({ mode: "appended" });
  });

  it("treats an append whose update reply was lost as appended, found by re-reading the row", async () => {
    const f = await make();
    await f.tick();
    f.output("ACTION idle EXA-2", 1);
    f.threads.updateLost = true;
    await f.tick();
    expect(accepted(f).map((a) => a.outcome)).toEqual(["queued", "appended"]);
    expect(pendingId(f)).toBeNull();
    expect(f.threads.sends).toBe(1);
  });

  it("keeps an inline send without evidence open, searches on the next passes and accepts delayed evidence", async () => {
    const f = await make();
    f.threads.sendMode = "inline"; f.threads.acceptInline = false;
    await f.tick();
    const first = f.attempts()[0]!;
    expect(first).toMatchObject({ outcome: "sending", pending_since: expect.any(String) });
    await f.tick(); // no second attempt while the first may still be accepted
    expect(f.attempts()).toHaveLength(1);
    expect(f.runs()).toBe(1);
    const request = f.threads.requestOnly(`Needs attention\n\n${first.marker}`);
    await f.tick();
    expect(pendingId(f)).toBeTruthy(); // requested but not accepted yet
    f.threads.acceptRequest(request);
    await f.tick();
    expect(accepted(f)).toMatchObject([{ outcome: "inline" }]);
    expect(pendingId(f)).toBeNull();
  });
});

describe("definite failure and uncertainty", () => {
  it("returns a definite 403 to pending, pushes, and retries the current manager on the next tick", async () => {
    const f = await make();
    f.threads.sendMode = "throw"; f.threads.sendError = Object.assign(new Error("forbidden"), { status: 403 });
    await f.tick();
    expect(f.attempts()).toMatchObject([{ outcome: "failed" }]);
    const staged = pendingId(f);
    expect(staged).toBeTruthy();
    expect(f.pushes).toHaveLength(1);
    expect(f.service.status(f.tracker.id)).toMatchObject({ managerError: expect.stringContaining("forbidden"), failureStage: "delivery" });
    f.threads.sendMode = "queue"; f.setManager("thr_second");
    await f.tick();
    expect(f.attempts().at(-1)).toMatchObject({ outcome: "queued", manager_thread_id: "thr_second", report_id: staged });
    expect(f.runs()).toBe(1 + 1); // the pending report was delivered first, then the script ran again
  });

  it("treats a definite 403 on an append as failed, pushes, and appends on the next tick", async () => {
    const f = await make();
    await f.tick();
    f.output("ACTION idle EXA-2", 1);
    f.threads.updateRejection = Object.assign(new Error("forbidden"), { status: 403 });
    await f.tick();
    expect(f.attempts().at(-1)).toMatchObject({ outcome: "failed" });
    expect(f.pushes).toHaveLength(1);
    expect(pendingId(f)).toBeTruthy();
    f.threads.updateRejection = undefined;
    await f.tick();
    expect(accepted(f).map((a) => a.outcome)).toEqual(["queued", "appended"]);
  });

  it("keeps the database and the in-memory state unchanged when the commit of an acceptance fails, then recovers without a second send", async () => {
    const f = await make();
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick();
    f.threads.threads.set(MANAGER, {});
    f.db.exec("CREATE TRIGGER fail_promote BEFORE UPDATE ON checks_delivery BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(f.tick()).rejects.toThrow(/disk full/);
    expect(pendingId(f)).toBeTruthy();
    expect(f.attempts()).toMatchObject([{ outcome: "sending" }]);
    expect(f.state().lastReport).toBeUndefined();
    expect(f.state().deliveredAt).toBeUndefined();
    f.db.exec("DROP TRIGGER fail_promote");
    await f.tick();
    expect(f.threads.sends).toBe(1);
    expect(accepted(f)).toHaveLength(1);
    expect(f.state().lastReport).toMatchObject({ manager: MANAGER });
  });

  it("clears the delivery error and stage an acceptance resolves, on a disabled drain and under refresh backoff, and keeps an independent failure", async () => {
    const f = await make();
    f.threads.sendMode = "throw"; f.threads.sendError = Object.assign(new Error("forbidden"), { status: 403 });
    await f.tick();
    expect(f.service.status(f.tracker.id)).toMatchObject({ failureStage: "delivery", error: null, deliveryError: expect.stringContaining("forbidden") });
    f.service.setEnabled(f.tracker.id, false);
    f.threads.sendMode = "queue";
    await f.tick(); // the scheduler drains it in the background
    expect(f.service.status(f.tracker.id)).toMatchObject({ pending: null, failureStage: null, error: null, deliveryError: null, managerError: null });
    // Under a refresh backoff the same clearing holds, and an exit-2 report keeps its execution diagnostic.
    f.service.setEnabled(f.tracker.id, true);
    f.control.remote = "file:///nonexistent/example";
    f.threads.updateRejection = Object.assign(new Error("forbidden"), { status: 403 }); // the append is rejected
    await f.tick();
    expect(f.service.status(f.tracker.id)).toMatchObject({ failureStage: "delivery", pending: expect.anything() });
    f.threads.updateRejection = undefined;
    await f.tick();
    expect(f.service.status(f.tracker.id)).toMatchObject({ pending: null, deliveryError: null, failureStage: "refresh", error: expect.stringContaining("Checkout refresh failed") });
  });

  it("shows a terminal unknown as blocked, counts it apart from failures on the staged tick, and leaves the bytes", async () => {
    const f = await make();
    unknownSend(f);
    await f.tick();
    await f.tick();
    const status = f.service.status(f.tracker.id);
    expect(status).toMatchObject({ blocked: "blocked: delivery unknown, Retry needed", awaitingRetry: true, failureStage: "delivery" });
    expect(status.stats).toMatchObject({ deliveryUnknown: 1, deliveryFailures: 0 });
    const stagedTick = f.delivery()!.pending_tick;
    expect(f.db.prepare("SELECT delivery_unknown FROM checks_ticks WHERE tick=?").get(stagedTick)).toEqual({ delivery_unknown: 1 });
    expect((await f.harness.runCli(["checks", "status", "--project", "CHK"])).stdout).toContain("blocked: delivery unknown, Retry needed");
  });

  it("enters recovery on the stored thread after a lost write response, even after a manager change, and starts no second attempt", async () => {
    const f = await make();
    unknownSend(f);
    await f.tick();
    const first = f.attempts()[0]!;
    expect(first).toMatchObject({ outcome: "sending", manager_thread_id: MANAGER });
    f.setManager("thr_second"); f.threads.sendMode = "queue";
    f.threads.eventReads.length = 0;
    await f.tick();
    // No evidence, the whole history read: the attempt concludes unknown; the other manager is never asked.
    expect(f.attempts()).toHaveLength(1);
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown" });
    expect(new Set(f.threads.eventReads)).toEqual(new Set([MANAGER]));
    expect(f.threads.sends).toBe(1);
    expect(f.service.status(f.tracker.id).awaitingRetry).toBe(true);
    expect(f.pushes.at(-1)?.body).toContain("unknown");
    // Evidence on the old thread still confirms the old attempt.
    land(f, f.attempts()[0]!);
    await f.tick();
    expect(accepted(f).filter((a) => a.manager_thread_id === MANAGER)).toHaveLength(1);
    expect(pendingId(f)).toBeNull();
    // The same finding is new to the current manager, so it follows in the same pass.
    expect(accepted(f).map((a) => a.manager_thread_id)).toEqual([MANAGER, "thr_second"]);
  });

  it("gives an unreadable history up as unknown after five failed passes over thirty minutes, keeping the bytes", async () => {
    const f = await make();
    unknownSend(f);
    await f.tick();
    f.threads.eventsFail = true;
    for (let pass = 0; pass < 4; pass++) await f.tick();
    expect(f.attempts()[0]).toMatchObject({ outcome: "sending" });
    f.db.prepare("UPDATE checks_attempts SET recovery_cursor = json_set(recovery_cursor, '$.errors.since', ?)").run(new Date(Date.now() - 31 * 60_000).toISOString());
    await f.tick();
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown", error: expect.stringContaining("History unreadable") });
    expect(f.delivery()).toMatchObject({ pending_body: "ACTION idle EXA-1\n" });
    // Retry is the one owner action; a late receipt of the old attempt wins if it arrives first.
    f.threads.eventsFail = false;
    land(f, f.attempts()[0]!);
    await f.tick();
    expect(pendingId(f)).toBeNull();
  });

  it("recovers the acceptance-to-commit crash window from the queue instead of sending twice", async () => {
    const f = await make();
    unknownSend(f);
    await f.tick(); // the send went out but the commit never happened: attempt persisted, nothing acknowledged
    const attempt = f.attempts()[0]!;
    land(f, attempt);
    f.threads.sendMode = "queue";
    await f.tick();
    expect(f.threads.sends).toBe(1);
    expect(f.threads.rows).toHaveLength(1);
    expect(f.threads.text(f.threads.rows[0]!)).toContain(attempt.report_id as string);
    expect(accepted(f)).toHaveLength(1);
    expect(f.service.status(f.tracker.id).lastDelivery).toMatchObject({ reportId: attempt.report_id });
  });

  it("acknowledges only its own report when two reports share one queue row", async () => {
    const f = await make();
    unknownSend(f);
    await f.tick();
    const first = f.attempts()[0]!;
    land(f, first); // the first report's late receipt
    f.threads.sendMode = "queue";
    f.output("ACTION idle EXA-2", 1);
    await f.tick(); // delivers the first, then runs again: the second is appended to the same row
    f.threads.updateRejection = Object.assign(new Error("socket closed"), {});
    f.output("ACTION idle EXA-3", 1);
    await f.tick(); // the third cannot be appended: unknown, while the row holds only the earlier markers
    const third = f.attempts().at(-1)!;
    expect(third.outcome).toBe("sending");
    expect(f.threads.rows).toHaveLength(1);
    await f.tick();
    expect(pendingId(f)).toBe(third.report_id); // markers of earlier reports in the row acknowledge nothing
    f.threads.updateRejection = undefined;
    f.threads.rows[0]!.content = [{ type: "text", text: `${f.threads.text(f.threads.rows[0]!)}${QUEUED_NOTICE_SEPARATOR}${third.marker}`, mentions: [] }];
    await f.tick();
    expect(pendingId(f)).toBeNull();
    expect(f.service.status(f.tracker.id).lastDelivery).toMatchObject({ reportId: third.report_id });
    expect(accepted(f).map((a) => a.report_id)).toHaveLength(3);
  });
});

describe("retry", () => {
  const unknownReport = async (f: Fixture) => {
    unknownSend(f);
    await f.tick();
    await f.tick();
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown" });
    f.threads.sendMode = "queue";
  };

  it("sends the exact pending bytes once after Retry, and the superseded attempt's late receipt is then a no-op", async () => {
    const f = await make();
    await unknownReport(f);
    const staged = f.delivery()!;
    const first = f.attempts()[0]!;
    await expect(f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id })).resolves.toEqual({ ok: true });
    expect(f.attempts()[0]).toMatchObject({ outcome: "superseded" });
    await f.tick();
    expect(accepted(f)).toMatchObject([{ report_id: staged.report_id, outcome: "queued" }]);
    expect(f.threads.text(f.threads.rows[0]!)).toContain(staged.report_id as string);
    const before = f.service.status(f.tracker.id).stats.deliveries;
    land(f, first, MANAGER);
    await f.tick();
    expect(accepted(f)).toHaveLength(1);
    expect(f.service.status(f.tracker.id).stats.deliveries).toBe(before);
  });

  it("lets the first confirmed receipt win, including the superseded attempt's, and ignores the retry's", async () => {
    const f = await make({ snapshots: true });
    f.output("ACTION idle EXA-1", 1, '{"c":1}');
    await unknownReport(f);
    const first = f.attempts()[0]!;
    await f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id });
    unknownSend(f);
    await f.tick(); // the retry's attempt is itself unknown
    const retry = f.attempts()[1]!;
    expect(retry).toMatchObject({ outcome: "sending" });
    land(f, first);
    await f.tick();
    expect(accepted(f)).toMatchObject([{ attempt_id: first.attempt_id }]);
    expect(f.attempts()[1]).toMatchObject({ outcome: "superseded" });
    expect(f.attempts()).toHaveLength(2);
    expect(f.db.prepare("SELECT committed FROM checks_delivery").get()).toEqual({ committed: Buffer.from('{"c":1}') });
    land(f, retry);
    await f.tick();
    expect(accepted(f)).toHaveLength(1);
    expect(f.service.status(f.tracker.id).stats.deliveries).toBe(1);
  });

  it("delivers a one-shot finding the next run no longer prints", async () => {
    const f = await make();
    f.output("ANSWER EXA-7 owner: ship it", 1);
    await unknownReport(f);
    f.output("", 0); // the next run prints nothing
    await f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id });
    await f.tick();
    expect(f.sent()).toContain("ship it");
    expect(pendingId(f)).toBeNull();
  });

  it("refuses Retry unless the outcome is unknown", async () => {
    const f = await make();
    await expect(f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id })).rejects.toThrow(/No report is pending/);
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick();
    await expect(f.harness.callRpc("retryChecksReport", { projectId: f.tracker.id })).rejects.toThrow(/outcome is unknown/);
  });
});

describe("manager", () => {
  it("runs the script for an archived manager, keeps the report pending with a push, and delivers to a new manager", async () => {
    const f = await make();
    f.threads.threads.set(MANAGER, { archived: true, parent: "thr_parent" });
    await f.tick();
    expect(f.runs()).toBe(1);
    const staged = pendingId(f);
    expect(staged).toBeTruthy();
    expect(f.pushes).toEqual([{ title: "Sweep manager unreachable", body: expect.stringMatching(/^proj_example: Error: Manager missing, archived or deleted/) }]);
    expect(f.threads.sends).toBe(0); // the live parent is not a fallback
    expect(f.attempts()).toHaveLength(0);
    await f.tick();
    expect(f.runs()).toBe(1); // nothing new runs while a report is pending
    f.setManager("thr_second");
    await f.tick();
    expect(f.attempts()).toMatchObject([{ report_id: staged, manager_thread_id: "thr_second", outcome: "queued" }]);
  });

  it("stores the push failure apart from the manager error", async () => {
    const f = await make();
    f.control.pushFail = true;
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick();
    expect(f.service.status(f.tracker.id)).toMatchObject({ managerError: expect.stringContaining("archived"), pushError: expect.stringContaining("push unavailable") });
    expect(pendingId(f)).toBeTruthy();
  });

  it("with no manager and no open attempt keeps the bytes, tries a push and runs nothing; a configured manager then gets those exact bytes first", async () => {
    const f = await make();
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick();
    const staged = f.delivery()!;
    f.setManager(null);
    f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.refreshRetryAt', ?) WHERE tracker_id = ?").run(Date.now() + 3_600_000, f.tracker.id);
    const pushes = f.pushes.length;
    await f.tick();
    expect(f.pushes).toHaveLength(pushes + 1);
    expect(f.runs()).toBe(1);
    expect(f.attempts()).toHaveLength(0);
    expect(f.delivery()).toMatchObject({ report_id: staged.report_id, pending_body: staged.pending_body });
    expect(f.state().lastReport).toBeUndefined();
    f.setManager("thr_second"); f.threads.threads.set(MANAGER, {});
    await f.tick();
    expect(f.attempts()).toMatchObject([{ report_id: staged.report_id, outcome: "queued", manager_thread_id: "thr_second" }]);
    // The refresh backoff does not delay the retry above, and it still governs the next run.
    expect(f.runs()).toBe(1);
    expect(f.state().nextRun).toBe(f.state().refreshRetryAt);
  });

  it("starts no run while the manager is unset", async () => {
    const f = await make();
    f.setManager(null);
    await f.tick();
    expect(f.runs()).toBe(0);
    expect(f.state().error).toMatch(/Manager is unset/);
    expect(f.pushes).toHaveLength(0);
  });

  it("notices a manager that becomes unavailable between the run and the delivery", async () => {
    const f = await make();
    f.control.onProject = () => f.threads.threads.set(MANAGER, { archived: true });
    await f.tick();
    expect(f.runs()).toBe(1);
    expect(pendingId(f)).toBeTruthy();
    expect(f.service.status(f.tracker.id).managerError).toMatch(/archived/);
  });

  it("confirms an old attempt by evidence on its thread when the setting is unset, attributing the baseline to that manager", async () => {
    const f = await make();
    unknownSend(f);
    await f.tick();
    f.setManager(null);
    land(f, f.attempts()[0]!);
    await f.tick();
    expect(pendingId(f)).toBeNull();
    expect(f.state().lastReport).toMatchObject({ manager: MANAGER });
    expect(f.state().error).toMatch(/Manager is unset/);
  });

  it("notifies the new manager of the same finding after the old manager's delayed acceptance", async () => {
    const f = await make();
    unknownSend(f);
    await f.tick();
    f.setManager("thr_second"); f.threads.sendMode = "queue";
    land(f, f.attempts()[0]!); // manager A accepts late, after the switch to B
    await f.tick();
    expect(f.threads.rows.map((row) => row.threadId)).toEqual([MANAGER, "thr_second"]);
    expect(accepted(f).map((a) => a.manager_thread_id)).toEqual([MANAGER, "thr_second"]);
  });
});

describe("restart and manual runs", () => {
  it("retries a pending report before any rerun, across a restart", async () => {
    const f = await make();
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick();
    const staged = pendingId(f);
    const next = await f.harness.lifecycle.reload(async (bb) => {
      const { createStore, registerTasksApi } = await import("../api");
      const { registerChecks } = await import("./rpc");
      registerTasksApi(bb, createStore(bb)); registerChecks(bb);
    });
    const { checksService } = await import("./service");
    f.threads.threads.set(MANAGER, {});
    await checksService(next.bb).scheduledTick(f.tracker.id);
    const attempts = next.bb.storage.database().prepare("SELECT report_id, outcome FROM checks_attempts").all();
    expect(attempts).toEqual([{ report_id: staged, outcome: "queued" }]);
    expect(f.runs()).toBe(2);
    fixtures.splice(fixtures.indexOf(f), 1, { ...f, dispose: () => next.harness.dispose() } as Fixture);
  });

  it("never stages, delivers, promotes or counts on a manual run, dry-run included, and never retries a pending report", async () => {
    const f = await make({ snapshots: true });
    f.output("ACTION idle EXA-1", 1, '{"c":1}');
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick();
    f.threads.threads.set(MANAGER, {});
    const snapshot = () => ({ delivery: f.delivery(), state: f.state(), stats: { ...f.service.status(f.tracker.id).stats, since: 0 }, attempts: f.attempts() });
    const before = snapshot();
    const result = await f.harness.runCli(["checks", "run", "--project", "CHK", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!)).toMatchObject({ exitCode: 1, manual: true, output: "ACTION idle EXA-1\n" });
    expect(f.runs()).toBe(2);
    expect(f.threads.sends).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it("refuses a manual run while another run is active", async () => {
    const f = await make();
    const go = `${f.io}/go`;
    f.script(`while [ ! -e "${go}" ]; do sleep 0.1; done; echo done`);
    const first = f.service.manualRun(f.tracker.id);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(f.service.manualRun(f.tracker.id)).rejects.toThrow(/already running/);
    await f.tick(); // a due tick coalesces into the active run
    expect(f.state().tickId).toBeUndefined();
    await import("node:fs").then(({ writeFileSync }) => writeFileSync(go, ""));
    await expect(first).resolves.toMatchObject({ exitCode: 0, output: "done\n" });
  });
});
