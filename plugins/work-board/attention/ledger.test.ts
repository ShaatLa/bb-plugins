import { afterEach, describe, expect, it, vi } from "vitest";
import { createDependencyStore } from "../dependencies/store";
import { createStructuredStore } from "../structured/store";
import { getWorkflowPolicy } from "../shared/workflow-policy";
import { accept, goLive, setup } from "./fixtures";
import { GRACE_MS, scanTracker } from "./ledger";
import { POST_MERGE_REVIEW_GRACE_MS } from "./observe";

const fixtures: ReturnType<typeof setup>[] = [];
const make = async () => { const f = setup(); fixtures.push(f); await goLive(f); return f; };
afterEach(async () => { vi.useRealTimers(); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

const items = (f: ReturnType<typeof setup>, attemptId: string) => f.db.prepare<[string], { occurrence_id: string }>("SELECT occurrence_id FROM attention_attempt_items WHERE attempt_id=?").all(attemptId).map((row) => row.occurrence_id);
describe("ledger", () => {
  it("keeps two acceptances of one occurrence as two attempts and two batches appended to one message as two attempts with one queuedMessageId", async () => {
    const f = await make();
    f.card("Twice");
    const id = f.occurrences()[0].id;
    accept(f, id, "queued", "qm_1");
    accept(f, id, "inline", "qm_1");
    const other = f.card("Other");
    const otherId = f.occurrences().find((o) => o.task_id === other.id).id;
    accept(f, otherId, "appended", "qm_1");
    const attempts = f.attempts();
    expect(attempts.filter((a) => items(f, a.attempt_id).includes(id))).toHaveLength(2);
    const appended = attempts.filter((a) => a.queued_message_id === "qm_1");
    expect(appended.length).toBe(3);
    expect(new Set(appended.map((a) => a.batch_id)).size).toBe(3);
  });

  it("moves an old occurrence to a later revision when it clears, keeping its creation revision", async () => {
    const f = await make();
    const task = f.card("Old");
    const [first] = f.occurrences();
    f.store.tasks.updateTask(task.id, { status: "todo" });
    const later = f.occurrences(true).find((o) => o.id === first.id);
    expect(later).toMatchObject({ cleared_at: expect.any(String), created_rev: first.created_rev });
    expect(later.rev).toBeGreaterThan(first.rev);
  });

  it("journals every recompute that sees an unknown signal and the valid reading that ends it", async () => {
    const f = await make();
    const task = f.card("Review", "in_review");
    f.linkPr(task.id, 1, "failed");
    f.linkPr(task.id, 1, "failed");
    f.linkPr(task.id, 1, "open");
    const observations = f.db.prepare("SELECT signal, validity FROM attention_observations WHERE tracker_id=? ORDER BY rev").all(f.tracker.id) as { signal: string; validity: string }[];
    expect(observations.map((o) => [o.signal, o.validity])).toEqual([
      ["no_open_pr", "unknown"], ["closed_unmerged_pr", "unknown"], ["no_open_pr", "unknown"], ["closed_unmerged_pr", "unknown"], ["no_open_pr", "valid"], ["closed_unmerged_pr", "valid"],
    ]);
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

  it("clears no_active_thread when a question opens and starts a new occurrence after the last open one is answered, without the decision label", async () => {
    const f = await make();
    f.store.tasks.updateProject(f.tracker.id, { workflowPolicy: { ...getWorkflowPolicy(f.tracker), ownerDecisionLabel: null } });
    const card = f.card("Waiting");
    const first = f.occurrences().find((o) => o.task_id === card.id && o.signal === "no_active_thread");
    expect(first).toBeDefined();
    const questions = createStructuredStore(f.bb, f.store).handlers;
    const ask = async (prompt: string) => (await questions.createQuestion({ taskId: card.id, kind: "decision", askedByThread: null, prompt, steps: [], options: ["A", "B"], mode: "single" })).question;
    const one = await ask("Which one?");
    expect(f.occurrences().filter((o) => o.task_id === card.id)).toHaveLength(0);
    const two = await ask("And which other?");
    expect(f.occurrences().filter((o) => o.task_id === card.id)).toHaveLength(0);
    await questions.answerQuestion({ questionId: one.id, revision: one.revision, selectedOptionIds: [one.options[0]!.id], authorName: "You" });
    expect(f.occurrences().filter((o) => o.task_id === card.id)).toHaveLength(0);
    const withdrawnAt = Date.parse(first.first_seen_at) + 60 * 60_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(withdrawnAt);
    await questions.withdrawQuestion({ taskId: card.id, questionId: two.id, revision: two.revision, reason: "No longer needed", authorName: "You" });
    const second = f.occurrences().find((o) => o.task_id === card.id && o.signal === "no_active_thread");
    expect(second).toBeDefined();
    expect(second.id).not.toBe(first.id);
    expect(Date.parse(second.first_seen_at)).toBe(withdrawnAt);
    expect(Date.parse(second.eligible_at)).toBe(withdrawnAt + GRACE_MS);
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

  it("journals the Done-only no_merge_or_outcome but never sends it", async () => {
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

describe("post-merge grace", () => {
  it("opens no no_open_pr occurrence inside the grace, and one at the first reconciliation after it, held ten more minutes", async () => {
    const f = await make();
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const task = f.card("Merged", "todo");
    f.linkPr(task.id, 1, "merged");
    f.db.prepare("UPDATE git_pr_snapshots SET payload=json_set(payload, '$.mergedAt', ?) WHERE project_id=?").run(new Date(now - 60 * 60_000).toISOString(), f.tracker.id);
    f.store.tasks.updateTask(task.id, { status: "in_review" });
    const noOpenPr = () => f.occurrences().filter((o) => o.task_id === task.id && o.signal === "no_open_pr");
    scanTracker(f.db, f.tracker.id);
    expect(noOpenPr()).toEqual([]);
    // Only the clock moves: the ten-minute reconciliation sees the grace expire.
    const expiry = now - 60 * 60_000 + POST_MERGE_REVIEW_GRACE_MS;
    vi.setSystemTime(expiry - 1);
    scanTracker(f.db, f.tracker.id);
    expect(noOpenPr()).toEqual([]);
    vi.setSystemTime(expiry);
    scanTracker(f.db, f.tracker.id);
    scanTracker(f.db, f.tracker.id);
    expect(noOpenPr()).toEqual([expect.objectContaining({ first_seen_at: new Date(expiry).toISOString(), eligible_at: new Date(expiry + GRACE_MS).toISOString() })]);
  });
});
