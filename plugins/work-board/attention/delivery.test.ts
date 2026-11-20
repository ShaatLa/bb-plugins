import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverWithReceipt, receiptPolling } from "../steer";
import { attentionMarker } from "./service";
import { BB_PROJECT, goLive, MANAGER, setup } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const live = async () => { const f = setup(); fixtures.push(f); await goLive(f); return f; };
const sent = (f: ReturnType<typeof setup>) => f.threads.rows.map((row) => f.threads.text(row)).join("\n");
const modes = async (f: ReturnType<typeof setup>) => (await f.sweep("attention.modes", { projectId: BB_PROJECT })).kinds["stale-status"];
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

describe("recipient", () => {
  it("resolves the Work Board manager, then Sweep's, then an eligible parent, and claims nothing without one", async () => {
    const f = await live();
    f.card("One");
    f.makeEligible();
    await f.service.drain();
    expect(f.attempts().at(-1)).toMatchObject({ recipient_thread_id: MANAGER, recipient_source: "manager" });
    f.db.prepare("UPDATE attention_manager SET manager=NULL").run();
    f.threads.sweepManager = "thr_sweep";
    f.card("Two");
    f.makeEligible();
    await f.service.drain();
    expect(f.attempts().at(-1)).toMatchObject({ recipient_thread_id: "thr_sweep", recipient_source: "sweep_fallback" });
    f.threads.threads.set("thr_sweep", { archived: true, parent: "thr_parent" });
    f.card("Three");
    f.makeEligible();
    await f.service.drain();
    expect(f.attempts().at(-1)).toMatchObject({ recipient_thread_id: "thr_parent", recipient_source: "parent" });
    f.threads.sweepManager = null;
    const count = f.attempts().length;
    f.card("Four");
    f.makeEligible();
    await f.service.drain();
    expect(f.attempts()).toHaveLength(count);
  });

  it("records the manager setting with its time and previous value and shows it through config get", async () => {
    const f = await live();
    await f.call("updateAttentionManager", { projectId: f.tracker.id, manager: "thr_next" });
    const settings = await f.call("getAttentionSettings", { projectId: f.tracker.id });
    expect(settings).toMatchObject({ manager: "thr_next", managerPrevious: MANAGER, managerChangedAt: expect.any(String) });
    expect((await f.call("config.get", { projectId: f.tracker.id, key: "manager" })).values).toEqual({ manager: "thr_next" });
  });
});

describe("claims", () => {
  it("claims once for two overlapping drains", async () => {
    const f = await live();
    f.card("Once");
    f.makeEligible();
    await Promise.all([f.service.drainTracker(f.tracker.id), f.service.drainTracker(f.tracker.id)]);
    expect(f.attempts()).toHaveLength(1);
    expect(f.threads.sends).toBe(1);
  });

  it("reconciles a batch claimed before a rollback fence before the handback is ready", async () => {
    const f = await live();
    const task = f.card("Racing");
    f.makeEligible();
    let release!: () => void;
    f.threads.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const drain = f.service.drain();
    while (f.attempts()[0]?.outcome !== "sending") await new Promise((resolve) => setTimeout(resolve, 5));
    const rollback = f.setMode("shadow");
    while (!(await modes(f)).transition) await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await modes(f)).transition).toMatchObject({ state: "preparing", handback: null });
    release();
    await Promise.all([drain, rollback]);
    const transition = (await modes(f)).transition;
    expect(transition.state).toBe("ready");
    expect(f.attempts()[0].outcome).toBe("queued");
    expect(transition.handback.map((entry: { taskId: string }) => entry.taskId)).not.toContain(task.id);
  });

  it("claims nothing in a safety drain while an attempt is unknown", async () => {
    const f = await live();
    f.card("Unknown");
    f.makeEligible();
    f.threads.sendMode = "throw";
    await f.service.drain();
    expect(f.attempts().map((a) => a.outcome)).toEqual(["unknown"]);
    f.threads.sendMode = "queue";
    await f.service.drain();
    await f.service.drain();
    expect(f.attempts()).toHaveLength(1);
    expect(f.threads.sends).toBe(1);
  });

  it("retries after a restart that came after the claim but before transport", async () => {
    const f = await live();
    f.card("Interrupted");
    f.makeEligible();
    const id = f.occurrences()[0].id;
    f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES ('a1', ?, 'stale-status', 2, 'b1', ?, 'manager', '2000-01-01T00:00:00.000Z', 'claimed', 90)").run(f.tracker.id, MANAGER);
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('a1', ?)").run(id);
    await f.service.drain();
    expect(f.attempts().map((a) => a.outcome)).toEqual(["failed", "queued"]);
    expect(f.threads.sends).toBe(1);
  });

  it("never claims an occurrence whose signal is unknown", async () => {
    const f = await live();
    const task = f.card("Review", "in_review");
    f.linkPr(task.id, 1, "failed");
    f.makeEligible();
    await f.service.drain();
    expect(sent(f)).toContain("could not be read");
    expect(sent(f)).not.toContain("no open PR");
  });
});

describe("disposition", () => {
  it("shows a tolerated loss as waived_loss, never accepted, and hands it back at rollback", async () => {
    const f = await live();
    const task = f.card("Lost");
    f.makeEligible();
    f.threads.sendMode = "throw";
    await f.service.drain();
    await f.call("resolveAttentionAttempt", { attemptId: f.attempts()[0].attempt_id, disposition: "waived_loss" });
    f.threads.sendMode = "queue";
    await f.service.drain();
    expect(f.threads.sends).toBe(1);
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown", disposition: "waived_loss" });
    await f.setMode("shadow");
    expect((await modes(f)).transition.handback.map((entry: { taskId: string }) => entry.taskId)).toEqual([task.id]);
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" });
    expect(ledger.attempts[0]).toMatchObject({ outcome: "unknown", disposition: "waived_loss", dispositionAt: expect.any(String) });
  });

  it("records a delayed inline event during a drain and claims nothing for it", async () => {
    const f = await live();
    f.card("Inline");
    f.makeEligible();
    f.threads.sendMode = "inline";
    f.threads.acceptInline = false;
    await f.service.drain();
    expect(f.attempts().map((a) => a.outcome)).toEqual(["sending"]);
    f.threads.dispatch(f.threads.lastBody);
    await f.service.drain();
    expect(f.attempts()).toEqual([expect.objectContaining({ outcome: "inline", inline_event_ref: expect.any(String) })]);
    expect(f.threads.sends).toBe(1);
  });

  it("records evidence that arrives after an owner resolution, so a retried occurrence shows two accepted attempts", async () => {
    const f = await live();
    f.card("Twice");
    f.makeEligible();
    f.threads.sendMode = "throw";
    await f.service.drain();
    const first = f.attempts()[0];
    await f.call("resolveAttentionAttempt", { attemptId: first.attempt_id, disposition: "retry" });
    f.threads.sendMode = "queue";
    await f.service.drain();
    expect(f.attempts().map((a) => a.outcome)).toEqual(["unknown", "queued"]);
    f.threads.dispatch(`delayed ${attentionMarker(first.batch_id)}`);
    await f.service.recover(f.tracker.id);
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" });
    const accepted = ledger.attempts.filter((a: { outcome: string }) => ["appended", "queued", "inline"].includes(a.outcome));
    expect(accepted).toHaveLength(2);
    expect(accepted.find((a: { attemptId: string }) => a.attemptId === first.attempt_id)).toMatchObject({ outcome: "inline", disposition: "retry" });
    expect(accepted[0].occurrenceIds).toEqual(accepted[1].occurrenceIds);
  });

  it("appends a second batch to the queued notice of the first, giving two attempts with one queuedMessageId", async () => {
    const f = await live();
    f.card("First");
    f.makeEligible();
    await f.service.drain();
    f.card("Second");
    f.makeEligible();
    await f.service.drain();
    const attempts = f.attempts();
    expect(attempts.map((a) => a.outcome)).toEqual(["queued", "appended"]);
    expect(attempts[0].queued_message_id).toBe(attempts[1].queued_message_id);
    expect(f.threads.rows).toHaveLength(1);
  });

  it("settles a sending attempt from the persisted recipient's queue after a restart", async () => {
    const f = await live();
    const task = f.card("Crashed");
    const id = f.occurrences().find((o) => o.task_id === task.id).id;
    f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, transport_started_at, outcome, rev) VALUES ('a1', ?, 'stale-status', 2, 'batch-x', ?, 'manager', ?, ?, 'sending', 90)").run(f.tracker.id, MANAGER, new Date().toISOString(), new Date().toISOString());
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('a1', ?)").run(id);
    f.threads.addRow(MANAGER, `notice\n\n${attentionMarker("batch-x")}`);
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "queued", queued_message_id: expect.any(String), accepted_at: expect.any(String) });
  });
});

describe("deliverWithReceipt", () => {
  const marker = "<!-- work-board-attention:helper -->";
  const seed = async () => { const f = await live(); f.threads.addRow(MANAGER, "earlier notice"); return f; };

  it("resolves a lost update response with the row still queued to appended without a second write", async () => {
    const f = await seed();
    f.threads.updateLost = true;
    const receipt = await deliverWithReceipt(f.bb, MANAGER, "text", marker);
    expect(receipt).toMatchObject({ outcome: "appended", queuedMessageId: f.threads.rows[0]!.id });
    expect(f.threads.updates).toBe(1);
    expect(f.threads.sends).toBe(0);
  });

  it("resolves a lost response with the row already dispatched through the accepted-input event, with no resend", async () => {
    const f = await seed();
    f.threads.updateLost = true;
    f.threads.dispatchAfterUpdate = true;
    expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "inline", inlineEventRef: expect.any(String) });
    expect(f.threads.sends).toBe(0);
  });

  it("records unknown, with no second write, for a row that left the queue without the marker in the history", async () => {
    const f = await seed();
    f.threads.dropRowOnUpdate = true;
    expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "unknown" });
    expect(f.threads.sends).toBe(0);
    expect(f.threads.updates).toBe(1);
  });

  it("falls back to a new send only on an explicit precondition rejection", async () => {
    const f = await seed();
    f.threads.updateRejection = Object.assign(new Error("changed"), { status: 409 });
    expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "queued" });
    expect(f.threads.sends).toBe(1);
  });

  it("finds a send that landed but lost its response in the queue and does not send twice", async () => {
    const f = await live();
    f.threads.sendLandsThenThrows = true;
    expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "queued", queuedMessageId: expect.any(String) });
    expect(f.threads.sends).toBe(1);
  });

  it("reports an explicit send rejection as failed", async () => {
    const f = await live();
    f.threads.sendMode = "throw";
    f.threads.sendError = Object.assign(new Error("gone"), { status: 404 });
    expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "failed" });
  });
});
