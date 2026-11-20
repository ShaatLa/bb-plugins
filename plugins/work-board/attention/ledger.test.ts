import { afterEach, describe, expect, it } from "vitest";
import { createDependencyStore } from "../dependencies/store";
import { accept, BB_PROJECT, goLive, setup } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const make = async () => { const f = setup(); fixtures.push(f); await f.setMode("shadow"); return f; };
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

const ledger = (f: ReturnType<typeof setup>, sinceRev?: number) => f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status", ...(sinceRev === undefined ? {} : { sinceRev }) });
describe("ledger", () => {
  it("lists two acceptances of one occurrence as two attempts and two batches appended to one message as two attempts with one queuedMessageId", async () => {
    const f = await make();
    const task = f.card("Twice");
    const id = f.occurrences()[0].id;
    accept(f, id, "queued", "qm_1");
    accept(f, id, "inline", "qm_1");
    const other = f.card("Other");
    const otherId = f.occurrences().find((o) => o.task_id === other.id).id;
    accept(f, otherId, "appended", "qm_1");
    const result = await ledger(f);
    expect(result.attempts.filter((a: { occurrenceIds: string[] }) => a.occurrenceIds.includes(id))).toHaveLength(2);
    const appended = result.attempts.filter((a: { queuedMessageId: string }) => a.queuedMessageId === "qm_1");
    expect(appended.length).toBe(3);
    expect(appended.map((a: { batchId: string }) => a.batchId)).toHaveLength(new Set(appended.map((a: { batchId: string }) => a.batchId)).size);
    expect(task.id).toBeTruthy();
  });

  it("finds a later change to an old occurrence through sinceRev and pages by revision", async () => {
    const f = await make();
    const task = f.card("Old");
    const first = await ledger(f);
    expect(first.occurrences).toHaveLength(1);
    expect(first.nextRev).toBeGreaterThanOrEqual(first.occurrences[0].rev);
    expect((await ledger(f, first.nextRev)).occurrences).toEqual([]);
    f.store.tasks.updateTask(task.id, { status: "todo" });
    const later = await ledger(f, first.nextRev);
    expect(later.occurrences).toHaveLength(1);
    expect(later.occurrences[0]).toMatchObject({ occurrenceId: first.occurrences[0].occurrenceId, clearedAt: expect.any(String), createdRev: first.occurrences[0].createdRev });
    expect(later.occurrences[0].rev).toBeGreaterThan(first.occurrences[0].rev);
    f.card("A"); f.card("B");
    const page = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status", limit: 1 });
    expect(page.occurrences).toHaveLength(1);
    const rest = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status", sinceRev: page.nextRev, limit: 10 });
    expect(rest.occurrences.length + 1).toBe((await ledger(f)).occurrences.length);
  });

  it("journals every recompute that sees an unknown signal and the valid reading that ends it, and resolves keys with aliases", async () => {
    const f = await make();
    const task = f.card("Review", "in_review");
    f.linkPr(task.id, 1, "failed");
    f.linkPr(task.id, 1, "failed");
    f.linkPr(task.id, 1, "open");
    const result = await ledger(f);
    expect(result.observations.map((o: { signal: string; validity: string }) => [o.signal, o.validity])).toEqual([
      ["no_open_pr", "unknown"], ["closed_unmerged_pr", "unknown"], ["no_open_pr", "unknown"], ["closed_unmerged_pr", "unknown"], ["no_open_pr", "valid"], ["closed_unmerged_pr", "valid"],
    ]);
    expect(f.store.tasks.getTaskByKey(task.key)?.id).toBe(task.id);
    expect(await f.sweep("attention.resolveKeys", { projectId: BB_PROJECT, keys: [task.key, "ATT-999", "BAD"] })).toEqual({ resolved: { [task.key]: task.id }, unknown: ["ATT-999", "BAD"] });
  });
});

describe("scope", () => {
  it("retires a pending occurrence of an epic once it is labelled ongoing, while its member stays in scope", async () => {
    const f = await make();
    const epic = f.card("Epic", "in_progress", { type: "epic" });
    const member = f.card("Member", "in_progress", { epicId: epic.id });
    expect(f.occurrences().map((o) => o.task_id).sort()).toEqual([epic.id, member.id].sort());
    const label = f.store.tasks.createLabel({ projectId: f.tracker.id, name: "ongoing", color: "blue" });
    f.store.tasks.addTaskLabel(epic.id, label.id);
    expect(f.occurrences().map((o) => o.task_id)).toEqual([member.id]);
    expect(f.occurrences(true).find((o) => o.task_id === epic.id)).toMatchObject({ retired_reason: "ongoing" });
  });

  it("puts a card held by an unfinished blocker out of scope", async () => {
    const f = await make();
    const blocker = f.card("Blocker", "todo");
    const held = f.card("Held");
    expect(f.occurrences().map((o) => o.task_id)).toEqual([held.id]);
    createDependencyStore(f.db, f.store.tasks).add(held.id, blocker.id);
    expect(f.occurrences()).toHaveLength(0);
    expect(f.occurrences(true)[0]).toMatchObject({ retired_reason: "blocked" });
  });

  it("journals the Done-only no_merge_or_outcome in shadow but never sends it", async () => {
    const f = await make();
    const done = f.card("Done without outcome", "done");
    expect(f.occurrences()).toEqual([expect.objectContaining({ task_id: done.id, signal: "no_merge_or_outcome" })]);
  });
});

describe("validity", () => {
  const state = (f: Awaited<ReturnType<typeof make>>, taskId: string) => f.store.tasks.staleStatusObservations(f.tracker.id, [taskId])[0]!.signals;

  it("keeps no_open_pr a definite false when one PR is open and another failed to refresh", async () => {
    const f = await make();
    const task = f.card("Mixed", "in_review");
    f.linkPr(task.id, 1, "open");
    f.linkPr(task.id, 2, "failed");
    expect(state(f, task.id).no_open_pr).toEqual({ present: false, validity: "valid" });
    expect(f.occurrences().filter((o) => o.task_id === task.id)).toHaveLength(0);
  });

  it("creates pr_state_unavailable when only unavailable PRs exist, and still raises closed_unmerged_pr next to a failed one", async () => {
    const f = await make();
    const task = f.card("Unavailable", "in_review");
    f.linkPr(task.id, 1, "failed");
    // The earlier no_open_pr occurrence stays open: an unknown signal neither creates nor clears.
    expect(f.occurrences().filter((o) => o.task_id === task.id).map((o) => o.signal)).toEqual(["no_open_pr", "pr_state_unavailable"]);
    expect(state(f, task.id)).toMatchObject({ no_open_pr: { validity: "unknown" }, pr_state_unavailable: { present: true, validity: "valid" }, closed_unmerged_pr: { validity: "unknown" } });
    f.linkPr(task.id, 2, "closed");
    expect(f.occurrences().filter((o) => o.task_id === task.id).map((o) => o.signal).sort()).toEqual(["closed_unmerged_pr", "no_open_pr", "pr_state_unavailable"]);
  });

  it("gives a testing card with a merged PR and a failed refresh neither flag, while the same mix in review still reads unavailable", async () => {
    const f = await make();
    const testing = f.card("Testing", "in_testing");
    f.linkPr(testing.id, 1, "merged");
    f.linkPr(testing.id, 2, "failed");
    expect(state(f, testing.id)).toMatchObject({ no_open_pr: { present: false, validity: "valid" }, pr_state_unavailable: { present: false, validity: "valid" } });
    expect(f.occurrences().filter((o) => o.task_id === testing.id && ["no_open_pr", "pr_state_unavailable"].includes(o.signal))).toHaveLength(0);
    const review = f.card("Review", "in_review");
    f.linkPr(review.id, 3, "merged");
    f.linkPr(review.id, 4, "failed");
    expect(state(f, review.id).pr_state_unavailable).toEqual({ present: true, validity: "valid" });
  });
});

describe("in-transaction ledger", () => {
  it("closes an accepted occurrence at one commit and opens a new id with its own grace at the next, across a restart", async () => {
    const f = await make();
    const task = f.card("Flapping");
    const original = f.occurrences()[0];
    accept(f, original.id);
    f.makeEligible();
    f.store.tasks.updateTask(task.id, { status: "todo" });
    // Committed already: a restart here still finds the original closed, with its receipt kept.
    expect(f.db.prepare("SELECT cleared_at, retired_reason FROM manager_attention WHERE id=?").get(original.id)).toEqual({ cleared_at: expect.any(String), retired_reason: null });
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    const recurrence = f.occurrences()[0];
    expect(recurrence.id).not.toBe(original.id);
    expect(recurrence.eligible_at > new Date().toISOString()).toBe(true);
    expect(f.db.prepare("SELECT eligible_at FROM manager_attention WHERE id=?").get(original.id)).toEqual({ eligible_at: "2000-01-01T00:00:00.000Z" });
  });

  it("retires the dependent's accepted occurrence when its blocker flips back and gives a new id when it returns", async () => {
    const f = await make();
    const blocker = f.card("Blocker", "done");
    const dependent = f.card("Dependent");
    createDependencyStore(f.db, f.store.tasks).add(dependent.id, blocker.id);
    const original = f.occurrences().find((o) => o.task_id === dependent.id);
    expect(original).toBeTruthy();
    accept(f, original.id);
    f.store.tasks.updateTask(blocker.id, { status: "in_progress" });
    expect(f.occurrences().filter((o) => o.task_id === dependent.id)).toHaveLength(0);
    expect(f.db.prepare("SELECT cleared_at FROM manager_attention WHERE id=?").get(original.id)).toEqual({ cleared_at: expect.any(String) });
    f.store.tasks.updateTask(blocker.id, { status: "done" });
    const returned = f.occurrences().find((o) => o.task_id === dependent.id);
    expect(returned.id).not.toBe(original.id);
  });

  it("gives a PR-only clear and recurrence a new id", async () => {
    const f = await make();
    const task = f.card("Review", "in_review");
    f.linkPr(task.id, 1, "closed");
    const original = f.occurrences().find((o) => o.signal === "closed_unmerged_pr");
    accept(f, original.id);
    f.linkPr(task.id, 1, "open");
    expect(f.occurrences().find((o) => o.signal === "closed_unmerged_pr")).toBeUndefined();
    f.linkPr(task.id, 1, "closed");
    expect(f.occurrences().find((o) => o.signal === "closed_unmerged_pr").id).not.toBe(original.id);
  });

  it("sends a previously accepted signal that clears and returns within one second under a new id", async () => {
    const f = setup();
    fixtures.push(f);
    await goLive(f);
    const task = f.card("Quick");
    accept(f, f.occurrences()[0].id);
    f.store.tasks.updateTask(task.id, { status: "todo" });
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    f.makeEligible();
    await f.service.drain();
    expect(f.attempts().filter((a) => a.outcome !== "queued" || a.recipient_thread_id)).toHaveLength(2);
    expect(f.threads.rows.map((row) => f.threads.text(row)).join("\n")).toContain(task.key);
  });
});
