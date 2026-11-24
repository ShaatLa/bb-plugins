import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverWithReceipt, historyLimits, receiptPolling } from "../steer";
import { attentionMarker } from "./service";
import { goLive, MANAGER, setup } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const live = async () => { const f = setup(); fixtures.push(f); await goLive(f); return f; };
const sent = (f: ReturnType<typeof setup>) => f.threads.rows.map((row) => f.threads.text(row)).join("\n");
const settings = (f: ReturnType<typeof setup>) => f.call("getAttentionSettings", { projectId: f.tracker.id });
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

describe("recipient", () => {
  it("sends only to the Work Board manager: no other plugin is asked, an archived manager gets no parent fallback, and no manager means no claim", async () => {
    const f = await live();
    f.card("One");
    f.makeEligible();
    await f.service.drain();
    expect(f.attempts().at(-1)).toMatchObject({ recipient_thread_id: MANAGER, recipient_source: "manager" });
    // The manager's parent exists, yet it is not consulted.
    f.threads.threads.set(MANAGER, { archived: true, parent: "thr_parent" });
    f.card("Two");
    f.makeEligible();
    const count = f.attempts().length;
    await f.service.drain();
    expect(f.attempts()).toHaveLength(count);
    expect(f.threads.pluginCalls).toBe(0);
    // Nothing is sent to the parent either after the setting is cleared.
    f.db.prepare("UPDATE attention_manager SET manager=NULL").run();
    f.card("Three");
    f.makeEligible();
    await f.service.drain();
    expect(f.attempts()).toHaveLength(count);
    expect(f.threads.sends).toBe(1);
    expect(f.threads.pluginCalls).toBe(0);
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

  it("lets a batch claimed before a switch-off settle before notices are off", async () => {
    const f = await live();
    f.card("Racing");
    f.makeEligible();
    let release!: () => void;
    f.threads.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const drain = f.service.drain();
    while (f.attempts()[0]?.outcome !== "sending") await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await f.setMode("off")).switchingOff).toBe(true);
    release();
    await drain;
    await vi.waitFor(async () => expect((await settings(f)).state).toEqual({ effective: { mode: "off", generation: 2 }, switchingOff: false }));
    expect(f.attempts()[0].outcome).toBe("queued");
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
  it("shows a tolerated loss as waived_loss, never accepted, and retires its occurrence when notices turn off", async () => {
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
    await f.setMode("off");
    expect(f.occurrences(true).find((o) => o.task_id === task.id)).toMatchObject({ retired_reason: "mode off" });
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown", disposition: "waived_loss", disposition_at: expect.any(String) });
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

  it("offers Send again only while notices are on and the notice still has a card to send, and refuses it otherwise", async () => {
    const f = await live();
    const cleared = f.card("Cleared");
    const kept = f.card("Kept");
    f.makeEligible();
    f.threads.sendMode = "throw";
    await f.service.drain();
    const attempt = f.attempts()[0].attempt_id;
    const listed = async () => (await settings(f)).unresolvedAttempts.find((a: { attemptId: string }) => a.attemptId === attempt);
    expect((await listed()).canRetry).toBe(true);
    // One card is no longer stale: the other can still be sent.
    f.store.tasks.updateTask(cleared.id, { status: "todo" });
    expect((await listed()).canRetry).toBe(true);
    f.store.tasks.updateTask(kept.id, { status: "todo" });
    expect((await listed()).canRetry).toBe(false);
    await expect(f.call("resolveAttentionAttempt", { attemptId: attempt, disposition: "retry" })).rejects.toThrow(/Nothing in this notice can be sent again/);
    expect(f.attempts()[0].disposition).toBeNull();
    // Stale again, but its occurrences were retired by a switch off and on: still nothing to send again.
    f.store.tasks.updateTask(kept.id, { status: "in_progress" });
    await f.setMode("off");
    expect((await listed()).canRetry).toBe(false);
    await f.setMode("live");
    expect((await listed()).canRetry).toBe(false);
    await expect(f.call("resolveAttentionAttempt", { attemptId: attempt, disposition: "retry" })).rejects.toThrow(/Nothing in this notice/);
    // Accepting the loss still works.
    await f.call("resolveAttentionAttempt", { attemptId: attempt, disposition: "waived_loss" });
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown", disposition: "waived_loss" });
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
    const accepted = f.attempts().filter((a) => ["appended", "queued", "inline"].includes(a.outcome));
    expect(accepted).toHaveLength(2);
    expect(accepted.find((a) => a.attempt_id === first.attempt_id)).toMatchObject({ outcome: "inline", disposition: "retry" });
    const items = (attemptId: string) => f.db.prepare("SELECT occurrence_id FROM attention_attempt_items WHERE attempt_id=?").all(attemptId);
    expect(items(accepted[0].attempt_id)).toEqual(items(accepted[1].attempt_id));
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

  it("reports a definite rejection of the append as failed even when the readback fails, while a lost response stays unknown", async () => {
    const f = await seed();
    const limits = historyLimits.readTimeoutMs;
    historyLimits.readTimeoutMs = 50;
    try {
      f.threads.updateRejection = Object.assign(new Error("forbidden"), { status: 403 });
      f.threads.queueHangOnCall = f.threads.queueCalls + 2; // the readback after the rejected update never answers
      expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "failed", error: "forbidden" });
      f.threads.updateRejection = Object.assign(new Error("socket closed"), {});
      f.threads.queueHangOnCall = f.threads.queueCalls + 2;
      expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "unknown" });
    } finally { historyLimits.readTimeoutMs = limits; }
    expect(f.threads.sends).toBe(0);
  });

  it("reports any explicit 4xx on the append, with the row read back unchanged, as failed and writes nothing", async () => {
    const f = await seed();
    for (const status of [403, 413, 429, 418]) {
      f.threads.updateRejection = Object.assign(new Error(`rejected ${status}`), { status });
      expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "failed", error: `rejected ${status}` });
    }
    expect(f.threads.sends).toBe(0);
    // A 5xx is not a rejection: the write may have happened.
    f.threads.updateRejection = Object.assign(new Error("unavailable"), { status: 503 });
    expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "unknown" });
    // An error without a status stays ambiguous: the row may have changed under a lost response.
    f.threads.updateRejection = Object.assign(new Error("socket closed"), {});
    expect(await deliverWithReceipt(f.bb, MANAGER, "text", marker)).toMatchObject({ outcome: "unknown" });
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
