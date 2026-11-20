import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanReviewFlow, createStore, registerTasksApi } from "../api";
import type { PlanAuthor, PlanNote } from "../shared/contract";
import { buildAnchor, markdownPlainText } from "../shared/plan-anchor";
import { createPlanStore } from "./store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const author: PlanAuthor = { kind: "agent", threadId: "thr_author", name: "agent (thr_author)" };
const reviewerA: PlanAuthor = { kind: "agent", threadId: "thr_reviewer_a", name: "agent (thr_reviewer_a)" };
const reviewerB: PlanAuthor = { kind: "agent", threadId: "thr_reviewer_b", name: "agent (thr_reviewer_b)" };
const owner: PlanAuthor = { kind: "person", threadId: null, name: "Owner" };
// "Add the table." occurs in both sections; "Roll it out slowly." only once.
const BODY = "# Plan\n\n## Steps\nAdd the table.\nRoll it out slowly.\n\n## Risks\nAdd the table.\nNone known.\n";

type Thread = ReturnType<typeof makeThreadResponse>;
type SentCall = [{ threadId: string; input: Array<{ text: string }> }];

/** One project with planning on, one task, and a fake bb whose threads are the ones named in `threads`. */
function setup(threads: Record<string, Partial<Thread>> = {}) {
  const known: Record<string, Partial<Thread>> = { thr_author: {}, thr_reviewer_a: {}, thr_reviewer_b: {}, thr_submitter: {}, ...threads };
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (!(threadId in known)) throw new Error(`Thread not found: ${threadId}`);
          return makeThreadResponse({ id: threadId, status: "active", ...known[threadId] });
        },
        send: async () => undefined,
      },
    },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  // Planning is the owner's setting, so the fixture sets it through the store, not through any agent path.
  store.tasks.updateProject(project.id, { planning: "optional" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Planned work" });
  const db = host.bb.storage.database();
  const plans = createPlanStore(db, store.tasks);
  const flow = createPlanReviewFlow(host.bb, store);
  const call = <T = Record<string, any>>(method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, input as never) as Promise<T & { ok?: boolean; error?: { code: string; message: string } }>;
  const save = (body: string, baseVersion: number, by: PlanAuthor = author) => call("saveTaskPlan", { taskId: task.id, summary: "Edit", author: by, op: "replace", baseVersion, body });
  const submit = (reviewer?: string, by: PlanAuthor = author) => call("submitTaskPlan", { taskId: task.id, author: by, ...(reviewer ? { reviewer } : {}) });
  const sent = () => host.harness.sdk.callsTo("threads.send") as SentCall[];
  const sentTo = (threadId: string) => sent().filter((entry) => entry[0].threadId === threadId).map((entry) => entry[0].input[0]!.text);
  const systemComments = () => store.tasks.listComments(task.id).filter((entry) => entry.kind === "system").map((entry) => entry.body);
  const reviews = () => plans.captureReviews(task.id);
  const notes = async () => ((await call<{ notes: PlanNote[] }>("listPlanNotes", { taskId: task.id })).notes);
  const note = (by: PlanAuthor, version: number, input: Record<string, unknown> = {}) => flow.addNote({ taskId: task.id, by, version, body: "Please change this.", ...input } as Parameters<typeof flow.addNote>[0]);
  return { ...host, store, project, task, db, plans, flow, call, save, submit, sent, sentTo, systemComments, reviews, notes, note, known };
}

describe("submit", () => {
  it("needs a reviewer on the first submit and refuses self-review, unknown, archived and deleted threads", async () => {
    const { save, submit, task, systemComments, plans } = setup({ thr_archived: { archivedAt: 1 }, thr_deleted: { deletedAt: 1 } });
    await save(BODY, 0);
    expect(await submit()).toMatchObject({ ok: false, error: { code: "plan_invalid", message: expect.stringContaining("--reviewer owner") } });
    // The author, and any thread that wrote a version, cannot review its own plan.
    expect(await submit("thr_author")).toMatchObject({ ok: false, error: { message: expect.stringContaining("wrote or submitted this plan") } });
    await save(`${BODY}Extra.\n`, 1, reviewerB);
    expect(await submit("thr_reviewer_b")).toMatchObject({ ok: false, error: { message: expect.stringContaining("wrote or submitted this plan") } });
    expect(await submit("thr_unknown")).toMatchObject({ ok: false, error: { message: expect.stringContaining("does not exist") } });
    expect(await submit("thr_deleted")).toMatchObject({ ok: false, error: { message: expect.stringContaining("different --reviewer") } });
    expect(await submit("thr_archived")).toMatchObject({ ok: false, error: { message: expect.stringContaining("bb thread unarchive thr_archived") } });
    await expect(submit("not a thread")).rejects.toThrow(/validation/);
    expect(plans.head(task.id)?.state).toBe("draft");
    expect(systemComments().filter((text) => text.includes("submitted for review"))).toEqual([]);
  });

  it("wakes the reviewer itself and returns the delivery outcome", async () => {
    const { save, submit, sentTo, sent, task, systemComments, plans, store } = setup();
    // A linked worker thread must never get the invitation.
    store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", presetName: "Default", title: "Work", liveStatus: "working" });
    await save(BODY, 0);
    const result = await submit("thr_reviewer_a");
    expect(result).toMatchObject({ ok: true, outcome: "submitted", delivered: "sent", deliveryHint: null, plan: { state: "in_review", reviewer: { kind: "thread", threadId: "thr_reviewer_a" }, reviewVersion: 1 } });
    expect(sent().map((entry) => entry[0].threadId)).toEqual(["thr_reviewer_a"]);
    const text = sentTo("thr_reviewer_a")[0]!;
    expect(text).toContain("EXA-1 · plan v1 submitted for your review");
    expect(text).toContain('bb work-board plan note EXA-1 --version 1 --body "…"');
    expect(text).toContain("bb work-board plan approve EXA-1 --version 1");
    expect(text).toContain("You have not decided on an earlier version: review the whole plan.");
    expect(systemComments()).toContain("Plan v1 submitted for review by thr_reviewer_a");
    expect(plans.head(task.id)?.reviewVersion).toBe(1);
  });

  it("reports a failed wake and re-sends it on a repeated submit without a new event", async () => {
    const { save, submit, harness, sentTo, systemComments, reviews } = setup();
    await save(BODY, 0);
    harness.sdk.stub("threads.send", async () => {
      throw new Error("queue is full");
    });
    const failed = await submit("thr_reviewer_a");
    expect(failed).toMatchObject({ ok: true, outcome: "submitted", delivered: "failed", deliveryHint: expect.stringContaining("plan submit EXA-1 --reviewer thr_reviewer_a") });
    const firstRow = reviews();
    harness.sdk.stub("threads.send", async () => undefined);
    const again = await submit("thr_reviewer_a");
    expect(again).toMatchObject({ ok: true, outcome: "resent", delivered: "sent" });
    // The failed attempt and the repeat are the only two sends.
    expect(sentTo("thr_reviewer_a")).toHaveLength(2);
    // The same pending row, the same submitted_at, and no second event in the log.
    expect(reviews()).toEqual(firstRow);
    expect(systemComments().filter((text) => text.includes("submitted for review"))).toHaveLength(1);
    // Without --reviewer the repeat goes to the reviewer of the latest attempt.
    expect(await submit()).toMatchObject({ ok: true, outcome: "resent" });
  });

  it("reassigns to a different reviewer with one system line and a wake", async () => {
    const { save, submit, sentTo, systemComments, reviews, plans, task } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await submit("thr_reviewer_a");
    const result = await submit("thr_reviewer_b");
    expect(result).toMatchObject({ ok: true, outcome: "reassigned", delivered: "sent", plan: { state: "in_review", reviewer: { threadId: "thr_reviewer_b" } } });
    expect(systemComments()).toContain("Plan: review of v1 reassigned to thr_reviewer_b");
    expect(sentTo("thr_reviewer_b")).toHaveLength(1);
    // A retry and then a reassignment give exactly two rows, and only the replacement is pending.
    expect(reviews().map((row) => [row.version, row.reviewer.threadId, row.outcome])).toEqual([[1, "thr_reviewer_a", "reassigned"], [1, "thr_reviewer_b", "pending"]]);
    expect(plans.head(task.id)?.reviewer.threadId).toBe("thr_reviewer_b");
  });

  it("accepts only a draft: a plan with changes requested needs a new version first", async () => {
    const { save, submit, flow, task, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    expect(await submit("thr_reviewer_a")).toMatchObject({ ok: false, error: { code: "plan_state", message: expect.stringContaining("revise it and save a new version") } });
  });
});

describe("version binding", () => {
  it("returns the plan to draft when a version is saved during review, and refuses decisions on a stale version", async () => {
    const { save, submit, flow, task, note, plans, reviews } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    expect((await save(`${BODY}More.\n`, 1)).plan).toMatchObject({ version: 2, state: "draft" });
    expect(reviews().map((row) => row.outcome)).toEqual(["superseded"]);
    // After v2 was saved, a decision on v1 is refused; so is one on v2 before it is submitted.
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: false, error: { code: "plan_state" } });
    expect(await note(reviewerA, 1)).toMatchObject({ ok: false });
    expect(await flow.approve(task.id, reviewerA, undefined, 2)).toMatchObject({ ok: false, error: { code: "plan_state" } });
    await submit("thr_reviewer_a");
    // After v2 was submitted, the v1 decision is stale.
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: false, error: { code: "plan_conflict", message: expect.stringContaining("You reviewed v1") } });
    expect(await flow.approve(task.id, reviewerA, undefined, 2)).toMatchObject({ ok: true, plan: { state: "approved" } });
    expect(plans.head(task.id)?.version).toBe(2);
  });

  it("refuses a reviewer decision after the owner decided", async () => {
    const { save, submit, flow, task, call, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: true, plan: { state: "approved" } });
    expect(await flow.sendFeedback(task.id, reviewerA, 1)).toMatchObject({ ok: false, error: { code: "plan_state", message: expect.stringContaining("not in review") } });
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: false, error: { code: "plan_state" } });
  });
});

describe("identity", () => {
  it("refuses reviewer commands for any other thread and without a thread id", async () => {
    const { save, submit, flow, task, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    expect(await note(reviewerB, 1)).toMatchObject({ ok: false, error: { message: expect.stringContaining("not the reviewer") } });
    expect(await note(author, 1)).toMatchObject({ ok: false });
    expect(await note({ kind: "person", threadId: null, name: "cli" }, 1)).toMatchObject({ ok: false, error: { message: expect.stringContaining("no thread id") } });
    expect(await flow.approve(task.id, reviewerB, undefined, 1)).toMatchObject({ ok: false });
    expect(await flow.sendFeedback(task.id, reviewerB, 1)).toMatchObject({ ok: false });
    expect(await flow.dismiss(task.id, reviewerB, 1, [1])).toMatchObject({ ok: false });
    expect(await flow.setState(task.id, reviewerB, 1, [1], "resolved")).toMatchObject({ ok: false });
  });

  it("does not let an author field on the owner RPCs, or the note RPC, act as the reviewer", async () => {
    const { save, submit, call, task, notes, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    // The owner RPCs act as the owner whatever the author field says: they send only the owner's drafts.
    expect(await call("sendPlanFeedback", { taskId: task.id, author: reviewerA })).toMatchObject({ ok: false, error: { message: expect.stringContaining("no draft notes") } });
    expect((await notes())[0]).toMatchObject({ state: "draft", authorKind: "thread", authorThread: "thr_reviewer_a" });
    // The note RPC cannot name a thread author at all.
    await expect(call("createPlanNote", { taskId: task.id, kind: "general", body: "x", authorKind: "thread", authorThread: "thr_reviewer_a" })).rejects.toThrow();
    // An owner approval over the reviewer's draft is the owner's override and is logged as the owner.
    const approved = await call("approvePlan", { taskId: task.id, author: reviewerA });
    expect(approved).toMatchObject({ ok: true });
  });
});

describe("anchoring", () => {
  it("resolves a repeated quote by section, and refuses an ambiguous or missing quote", async () => {
    const { save, submit, note, notes } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    const ambiguous = await note(reviewerA, 1, { quote: "Add the table." });
    expect(ambiguous).toMatchObject({ ok: false, error: { message: expect.stringMatching(/occurs 2 times in the plan; name its section with --section/) } });
    expect(await note(reviewerA, 1, { quote: "Add the table.", section: "Steps" })).toMatchObject({ ok: true, note: { exact: "Add the table.", headingPath: "Plan > Steps" } });
    expect(await note(reviewerA, 1, { quote: "Add the table.", section: "Risks" })).toMatchObject({ ok: true, note: { headingPath: "Plan > Risks" } });
    expect(await note(reviewerA, 1, { quote: "Nothing like this" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("0 matches") } });
    expect(await note(reviewerA, 1, { quote: "Roll it out slowly.", section: "Risks" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("0 matches") } });
    expect(await note(reviewerA, 1, { quote: "Add the table.", section: "Missing" })).toMatchObject({ ok: false, error: { message: expect.stringContaining("not found") } });
    expect(await note(reviewerA, 1, { quote: "!!!" })).toMatchObject({ ok: false });
    // The same section can hold the quote twice: that is ambiguous within one section.
    await save("# Plan\n\n## Steps\nAdd the table.\nAdd the table.\nThen stop.\n", 1);
    await submit("thr_reviewer_a");
    expect(await note(reviewerA, 2, { quote: "Add the table.", section: "Steps" })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/occurs 2 times in section "Plan > Steps"; quote a longer passage/) } });
    expect(await note(reviewerA, 2, { quote: "Add the table.\nAdd the table." , section: "Steps" })).toMatchObject({ ok: true });
    expect((await notes()).map((entry) => [entry.number, entry.kind])).toEqual([[1, "comment"], [2, "comment"], [3, "comment"]]);
  });

  it("stores the anchor the UI's own buildAnchor makes for the matched range, and a general note without a quote", async () => {
    const { save, submit, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    const result = await note(reviewerA, 1, { quote: "Add the table.", section: "Risks" });
    const plain = markdownPlainText(BODY);
    const at = plain.lastIndexOf("Add the table.");
    const expected = buildAnchor(plain, at, at + "Add the table.".length)!;
    expect(result).toMatchObject({ ok: true, note: { exact: expected.exact, prefix: expected.prefix, suffix: expected.suffix, madeOnVersion: 1, authorKind: "thread" } });
    expect(expected.prefix.length).toBeLessThanOrEqual(32);
    expect(expected.suffix).toBe("\nNone known.\n");
    expect(await note(reviewerA, 1, { body: "Overall: add a rollback." })).toMatchObject({ ok: true, note: { kind: "general", exact: null, prefix: null } });
  });
});

describe("reassignment and replacement", () => {
  it("lets B send or dismiss A's unsent drafts, keeping their author, then approve", async () => {
    const { save, submit, flow, task, note, notes, sentTo, reviews } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1, { quote: "Roll it out slowly." });
    await note(reviewerA, 1, { body: "A general draft." });
    // A never sends; the review is reassigned to B.
    await submit("thr_reviewer_b");
    // B sends A's drafts as one batch to the plan author: each note keeps A as its author.
    const sentResult = await flow.sendFeedback(task.id, reviewerB, 1);
    expect(sentResult).toMatchObject({ ok: true, notes: 2, plan: { state: "changes_requested" } });
    expect((await notes()).map((entry) => [entry.number, entry.state, entry.authorThread])).toEqual([[1, "sent", "thr_reviewer_a"], [2, "sent", "thr_reviewer_a"]]);
    expect(sentTo("thr_author")[0]).toContain("changes requested by agent (thr_reviewer_b)");
    expect(reviews().map((row) => [row.reviewer.threadId, row.outcome, row.decidedBy])).toEqual([["thr_reviewer_a", "reassigned", "agent (thr_author)"], ["thr_reviewer_b", "changes_requested", "thr_reviewer_b"]]);

    // A second round: B dismisses A's draft instead and approves.
    await save(`${BODY}Revised.\n`, 1);
    await submit("thr_reviewer_b");
    await flow.setState(task.id, reviewerB, 2, [1, 2], "resolved");
    expect(await flow.approve(task.id, reviewerB, undefined, 2)).toMatchObject({ ok: true });
  });

  it("lets B dismiss A's unsent draft instead of sending it, then approve", async () => {
    const { save, submit, flow, task, note, notes } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1, { body: "A's draft that B does not share." });
    await submit("thr_reviewer_b");
    expect(await flow.approve(task.id, reviewerB, undefined, 1)).toMatchObject({ ok: false, error: { message: expect.stringContaining("N1 (draft)") } });
    expect(await flow.dismiss(task.id, reviewerB, 1, [1])).toMatchObject({ ok: true, removed: [1] });
    expect(await notes()).toEqual([]);
    expect(await flow.approve(task.id, reviewerB, undefined, 1)).toMatchObject({ ok: true, plan: { state: "approved" } });
  });

  it("lets a reviewer create a draft, dismiss it and approve the same version", async () => {
    const { save, submit, flow, task, note, notes, systemComments } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1, { body: "A finding that turns out wrong." });
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: false, error: { message: expect.stringContaining("N1 (draft)") } });
    expect(await flow.dismiss(task.id, reviewerA, 1, [1])).toMatchObject({ ok: true, removed: [1] });
    expect(await notes()).toEqual([]);
    expect(systemComments().some((text) => text.includes("dismiss"))).toBe(false);
    expect(await flow.approve(task.id, reviewerA, "Looks fine.", 1)).toMatchObject({ ok: true, plan: { state: "approved" } });
    // Dismissed numbers can be reused: unsent drafts are not history.
    expect(await flow.dismiss(task.id, reviewerA, 1, [1])).toMatchObject({ ok: false });
  });

  it("refuses to dismiss a sent note or an owner's note, and never touches the owner's drafts", async () => {
    const { save, submit, flow, call, task, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await call("createPlanNote", { taskId: task.id, kind: "general", body: "Owner's own draft." });
    await note(reviewerA, 1, { body: "Reviewer draft." });
    expect(await flow.dismiss(task.id, reviewerA, 1, [1])).toMatchObject({ ok: false, error: { message: expect.stringContaining("owner's note") } });
    expect(await flow.setState(task.id, reviewerA, 1, [1], "resolved")).toMatchObject({ ok: false, error: { message: expect.stringContaining("owner's note") } });
    expect(await flow.dismiss(task.id, reviewerA, 1, [9])).toMatchObject({ ok: false, error: { message: expect.stringContaining("no note N9") } });
    await flow.sendFeedback(task.id, reviewerA, 1);
    expect(await flow.dismiss(task.id, reviewerA, 1, [2])).toMatchObject({ ok: false });
  });
});

describe("resubmission", () => {
  it("refuses an unchanged resubmit after changes were requested, and a delayed approval of that version", async () => {
    const { save, submit, flow, task, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    expect(await submit("thr_reviewer_a")).toMatchObject({ ok: false });
    // The delayed approval of v1 still finds the plan in changes_requested.
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: false, error: { code: "plan_state" } });
    await save(`${BODY}Revised.\n`, 1);
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: false });
  });
});

describe("convergence", () => {
  it("refuses approval with drafts or unresolved reviewer notes and succeeds once they are resolved", async () => {
    const { save, submit, flow, call, task, note, notes } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    await save(`${BODY}Revised.\n`, 1);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Done.", addressed: true, author });
    await submit("thr_reviewer_a");
    expect(await flow.approve(task.id, reviewerA, undefined, 2)).toMatchObject({ ok: false, error: { message: expect.stringContaining("N1 (addressed)") } });
    await note(reviewerA, 2, { body: "One more." });
    expect(await flow.approve(task.id, reviewerA, undefined, 2)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/N1 \(addressed\), N2 \(draft\)/) } });
    await flow.dismiss(task.id, reviewerA, 2, [2]);
    expect(await flow.setState(task.id, reviewerA, 2, [1], "resolved")).toMatchObject({ ok: true });
    expect(await flow.approve(task.id, reviewerA, undefined, 2)).toMatchObject({ ok: true, plan: { state: "approved" } });
    expect((await notes())[0]).toMatchObject({ state: "resolved" });
  });

  it("lets a replacement reviewer resolve the previous reviewer's notes and approve", async () => {
    const { save, submit, flow, call, task, note } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    await save(`${BODY}Revised.\n`, 1);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Fixed.", addressed: true, author });
    await submit("thr_reviewer_b");
    expect(await flow.approve(task.id, reviewerB, undefined, 2)).toMatchObject({ ok: false });
    expect(await flow.setState(task.id, reviewerB, 2, [1], "resolved")).toMatchObject({ ok: true });
    expect(await flow.approve(task.id, reviewerB, undefined, 2)).toMatchObject({ ok: true });
    // Reopening takes a note back to a draft that goes out with the next feedback.
  });

  it("reopens a resolved reviewer note as a draft", async () => {
    const { save, submit, flow, call, task, note, notes } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    await save(`${BODY}Revised.\n`, 1);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Fixed.", addressed: true, author });
    await submit("thr_reviewer_a");
    await flow.setState(task.id, reviewerA, 2, [1], "resolved");
    expect(await flow.setState(task.id, reviewerA, 2, [1], "draft")).toMatchObject({ ok: true });
    expect((await notes())[0]).toMatchObject({ state: "draft" });
  });
});

describe("owner override", () => {
  it("sends only each actor's own drafts, scopes the counts, and lets the owner approve despite the reviewer's drafts", async () => {
    const { save, submit, flow, call, task, note, notes, sentTo } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await call("createPlanNote", { taskId: task.id, kind: "general", body: "Owner draft." });
    await note(reviewerA, 1, { body: "Reviewer draft." });
    // The owner's counts do not include the reviewer's draft.
    expect((await call<{ plan: { noteCounts: unknown } }>("getTaskPlan", { taskId: task.id })).plan.noteCounts).toEqual({ draft: 1, open: 0, addressed: 0, resolved: 0 });
    const ownerFeedback = await call("sendPlanFeedback", { taskId: task.id, author: owner });
    expect(ownerFeedback).toMatchObject({ ok: true, notes: 1 });
    expect((await notes()).map((entry) => [entry.number, entry.authorKind, entry.state])).toEqual([[1, "person", "sent"], [2, "thread", "draft"]]);
    // That ended the thread review: the reviewer's command is refused by the state check.
    expect(await flow.sendFeedback(task.id, reviewerA, 1)).toMatchObject({ ok: false, error: { code: "plan_state" } });
    await save(`${BODY}Revised.\n`, 1);
    await submit("thr_reviewer_a");
    const reviewerFeedback = await flow.sendFeedback(task.id, reviewerA, 2);
    expect(reviewerFeedback).toMatchObject({ ok: true, notes: 1 });
    expect((await notes()).map((entry) => [entry.number, entry.state])).toEqual([[1, "sent"], [2, "sent"]]);
    expect(sentTo("thr_author").join("\n")).toContain("Owner draft.");
    // With the reviewer's drafts open, the owner can still approve.
    await save(`${BODY}Again.\n`, 2);
    await submit("thr_reviewer_a");
    await note(reviewerA, 3, { body: "Late draft." });
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: true, plan: { state: "approved" } });
  });
});

describe("messages", () => {
  it("name the actor, and the feedback message holds a runnable resubmit command for the assigned reviewer", async () => {
    const { save, submit, flow, call, task, note, sentTo } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1, { quote: "Roll it out slowly." });
    await flow.sendFeedback(task.id, reviewerA, 1);
    const feedback = sentTo("thr_author").at(-1)!;
    expect(feedback).toContain("EXA-1 · plan v1: changes requested by agent (thr_reviewer_a)");
    expect(feedback).toContain("bb work-board plan submit EXA-1 --reviewer thr_reviewer_a");
    expect(feedback).toContain("Notes on v1 (1), in plan order:");
    await save(`${BODY}Revised.\n`, 1);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Done.", addressed: true, author });
    await submit("thr_reviewer_a");
    await flow.setState(task.id, reviewerA, 2, [1], "resolved");
    await flow.approve(task.id, reviewerA, "Good.", 2);
    expect(sentTo("thr_author").at(-1)).toContain("EXA-1 · plan v2 approved by agent (thr_reviewer_a)");
    expect(sentTo("thr_author").at(-1)).toContain("Note from agent (thr_reviewer_a): Good.");
    // The owner's override reads "the owner", and an owner feedback names the assigned reviewer in the command.
    await save(`${BODY}Third.\n`, 2);
    await submit("thr_reviewer_b");
    await call("createPlanNote", { taskId: task.id, kind: "general", body: "Owner says no." });
    await call("sendPlanFeedback", { taskId: task.id, author: owner });
    expect(sentTo("thr_author").at(-1)).toContain("changes requested by the owner");
    expect(sentTo("thr_author").at(-1)).toContain("plan submit EXA-1 --reviewer thr_reviewer_b");
  });
});

describe("review history", () => {
  it("keeps a row per attempt and sets its outcome on a new version, feedback and approval", async () => {
    const { save, submit, flow, call, task, note, reviews } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await save(`${BODY}Two.\n`, 1);
    await submit("thr_reviewer_a");
    await note(reviewerA, 2);
    await flow.sendFeedback(task.id, reviewerA, 2);
    await save(`${BODY}Three.\n`, 2);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Done.", addressed: true, author });
    await submit("thr_reviewer_a");
    await flow.setState(task.id, reviewerA, 3, [1], "resolved");
    await flow.approve(task.id, reviewerA, undefined, 3);
    expect(reviews().map((row) => [row.version, row.reviewer.threadId, row.outcome, row.decidedBy, row.decidedAt !== null])).toEqual([
      [1, "thr_reviewer_a", "superseded", "agent (thr_author)", true],
      [2, "thr_reviewer_a", "changes_requested", "thr_reviewer_a", true],
      [3, "thr_reviewer_a", "approved", "thr_reviewer_a", true],
    ]);
    expect((await call<{ reviews: unknown[] }>("listPlanReviews", { taskId: task.id })).reviews).toHaveLength(3);
  });

  it("gives an archived reviewer the unarchive hint and a deleted one the reassign hint, keeping its id in the history", async () => {
    const { save, submit, known, reviews, sentTo } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    known.thr_reviewer_a = { archivedAt: 5 };
    const archived = await submit("thr_reviewer_a");
    expect(archived).toMatchObject({ ok: true, outcome: "resent", delivered: "failed", deliveryHint: expect.stringContaining("bb thread unarchive thr_reviewer_a") });
    expect(archived.deliveryHint).toContain("plan submit EXA-1 --reviewer thr_reviewer_a");
    known.thr_reviewer_a = { deletedAt: 5 };
    const deleted = await submit("thr_reviewer_a");
    expect(deleted).toMatchObject({ delivered: "failed", deliveryHint: expect.stringContaining("different --reviewer") });
    expect(reviews()[0]!.reviewer.threadId).toBe("thr_reviewer_a");
    // Reassigning away from the unusable thread works.
    expect(await submit("thr_reviewer_b")).toMatchObject({ ok: true, outcome: "reassigned", delivered: "sent" });
    expect(sentTo("thr_reviewer_a")).toHaveLength(1);
  });

  it("closes a pending thread review on an owner decision, and adds no row for a draft or a legacy in-review plan", async () => {
    const { save, submit, call, task, reviews, db, store } = setup();
    // An owner decision on a draft with no attempt: only the task log, no invented row.
    await save(BODY, 0);
    await call("createPlanNote", { taskId: task.id, kind: "general", body: "Early note." });
    await call("sendPlanFeedback", { taskId: task.id, author: owner });
    expect(reviews()).toEqual([]);
    // A pending thread review is closed by the owner's override.
    await save(`${BODY}Two.\n`, 1);
    await submit("thr_reviewer_a");
    await call("approvePlan", { taskId: task.id, author: owner });
    expect(reviews().map((row) => [row.reviewer.threadId, row.outcome, row.decidedBy])).toEqual([["thr_reviewer_a", "approved", "Owner"]]);
    // A legacy in_review plan (no reviewer, no attempt row) is approved by the owner, still without a row.
    const other = store.tasks.createTask({ projectId: task.projectId, title: "Legacy" });
    db.prepare("INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name) VALUES (?, 'markdown', 1, '# Plan', 'in_review', ?, 'agent', NULL, 'agent')").run(other.id, new Date().toISOString());
    db.prepare("INSERT INTO task_plan_versions (task_id, version, body, base_version, op, summary, author_kind, author_thread, author_name, created_at) VALUES (?, 1, '# Plan', 0, 'create', 'x', 'agent', NULL, 'agent', ?)").run(other.id, new Date().toISOString());
    expect(await call("approvePlan", { taskId: other.id, author: owner })).toMatchObject({ ok: true, plan: { state: "approved", reviewer: { kind: "owner" } } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_plan_reviews WHERE task_id = ?").get(other.id)).toEqual({ n: 0 });
  });
});

describe("routing of results", () => {
  it("sends a resubmission to the latest reviewer even from another session, with the diff range and the blocking-note count", async () => {
    const { save, submit, flow, call, task, note, sentTo } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    await save(`${BODY}Revised.\n`, 1);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Done.", addressed: true, author });
    const resubmitted = await submit(undefined, { kind: "agent", threadId: "thr_submitter", name: "agent (thr_submitter)" });
    expect(resubmitted).toMatchObject({ ok: true, outcome: "submitted", delivered: "sent", plan: { reviewer: { threadId: "thr_reviewer_a" } } });
    const wake = sentTo("thr_reviewer_a").at(-1)!;
    expect(wake).toContain("You last decided on v1. What changed: bb work-board plan diff EXA-1 --from 1 --to 2");
    expect(wake).toContain("Reviewer notes that block approval: 1 (bb work-board plan notes EXA-1 --all)");
  });

  it("asks a replacement reviewer for a full review with the inherited notes counted, and does the same when the owner decided its attempt", async () => {
    const { save, submit, flow, call, task, note, sentTo } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    await save(`${BODY}Revised.\n`, 1);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Done.", addressed: true, author });
    await submit("thr_reviewer_b");
    const wake = sentTo("thr_reviewer_b").at(-1)!;
    expect(wake).toContain("You have not decided on an earlier version: review the whole plan.");
    expect(wake).not.toContain("plan diff");
    expect(wake).toContain("Reviewer notes that block approval: 1");
    // B's only attempt is decided by the owner: a later wake still asks for the whole plan.
    await call("approvePlan", { taskId: task.id, author: owner });
    await save(`${BODY}Third.\n`, 2);
    await submit("thr_reviewer_b");
    expect(sentTo("thr_reviewer_b").at(-1)).toContain("review the whole plan");
  });

  it("gives the submitter the actionable message and the version's author an informational copy, once each", async () => {
    const { save, submit, flow, task, note, sentTo } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a", { kind: "agent", threadId: "thr_submitter", name: "agent (thr_submitter)" });
    await note(reviewerA, 1);
    await flow.sendFeedback(task.id, reviewerA, 1);
    expect(sentTo("thr_submitter")).toHaveLength(1);
    expect(sentTo("thr_submitter")[0]).toContain("YOUR PLAN WAS NOT APPROVED");
    expect(sentTo("thr_author")).toHaveLength(1);
    expect(sentTo("thr_author")[0]).toContain("For information; thr_submitter acts on it.");
    expect(sentTo("thr_author")[0]).not.toContain("YOUR PLAN WAS NOT APPROVED");
    expect(sentTo("thr_author")[0]).toContain("EXA-1 · plan v1: changes requested by agent (thr_reviewer_a)");
  });

  it("reaches the version's author for a threadless submit and for an owner decision on a draft, never the task's worker", async () => {
    const { save, submit, call, task, flow, note, sentTo, sent, store } = setup();
    store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_author", presetName: "Default", title: "Work", liveStatus: "working" });
    await save(BODY, 0);
    await submit("thr_reviewer_a", { kind: "person", threadId: null, name: "cli" });
    await note(reviewerA, 1);
    const result = await flow.sendFeedback(task.id, reviewerA, 1);
    expect(result).toMatchObject({ ok: true, delivered: "sent", threadId: "thr_author", deliveries: [{ role: "actor", delivered: "sent", threadId: "thr_author" }] });
    expect(sentTo("thr_author")).toHaveLength(1);
    // An owner decision on a draft with no attempt also reaches the author.
    const fresh = store.tasks.createTask({ projectId: task.projectId, title: "Second" });
    await call("saveTaskPlan", { taskId: fresh.id, summary: "Edit", author, op: "replace", baseVersion: 0, body: BODY });
    await call("createPlanNote", { taskId: fresh.id, kind: "general", body: "Early." });
    expect(await call("sendPlanFeedback", { taskId: fresh.id, author: owner })).toMatchObject({ ok: true, delivered: "sent", threadId: "thr_author" });
    expect(sent().every((entry) => entry[0].threadId === "thr_author" || entry[0].threadId === "thr_reviewer_a")).toBe(true);
  });

  it("sends an archived submitter's result to its parent, and one actionable message when both recipients end up the same thread", async () => {
    const { save, submit, flow, task, note, sentTo } = setup({ thr_submitter: { archivedAt: 1, parentThreadId: "thr_author" } });
    await save(BODY, 0);
    await submit("thr_reviewer_a", { kind: "agent", threadId: "thr_submitter", name: "agent (thr_submitter)" });
    await note(reviewerA, 1);
    const result = await flow.sendFeedback(task.id, reviewerA, 1);
    expect(sentTo("thr_author")).toHaveLength(1);
    expect(sentTo("thr_author")[0]).toContain("YOUR PLAN WAS NOT APPROVED");
    expect(sentTo("thr_submitter")).toHaveLength(0);
    expect(result).toMatchObject({ ok: true, delivered: "sent", deliveries: [{ role: "actor", threadId: "thr_author" }] });
  });

  it("keeps the decision when a delivery fails and names the thread that was not reached", async () => {
    const { save, submit, flow, task, note, harness, reviews, systemComments, notes } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a", { kind: "agent", threadId: "thr_submitter", name: "agent (thr_submitter)" });
    await note(reviewerA, 1);
    harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_author") throw new Error("thread is gone");
      return undefined;
    });
    const result = await flow.sendFeedback(task.id, reviewerA, 1);
    expect(result).toMatchObject({ ok: true, delivered: "failed", plan: { state: "changes_requested" } });
    expect((result as { deliveries: unknown[] }).deliveries).toEqual([{ role: "actor", delivered: "sent", threadId: "thr_submitter" }, { role: "copy", delivered: "failed", threadId: "thr_author" }]);
    // The decision, its history row and its log line are saved once.
    expect(reviews()).toHaveLength(1);
    expect(systemComments().filter((text) => text.includes("changes requested by"))).toHaveLength(1);
    expect((await notes())[0]).toMatchObject({ state: "sent" });
  });
});

describe("upgrade", () => {
  it("lets the owner approve an existing in-review plan at once (no reviewer, legacy notes are the owner's)", async () => {
    const { call, task, db } = setup();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name) VALUES (?, 'markdown', 1, '# Plan', 'in_review', ?, 'agent', 'thr_author', 'agent')").run(task.id, now);
    db.prepare("INSERT INTO task_plan_versions (task_id, version, body, base_version, op, summary, author_kind, author_thread, author_name, created_at) VALUES (?, 1, '# Plan', 0, 'create', 'x', 'agent', 'thr_author', 'agent', ?)").run(task.id, now);
    db.prepare("INSERT INTO task_plan_notes (id, task_id, number, kind, made_on_version, body, state, author_name, created_at, updated_at) VALUES ('01HZZZZZZZZZZZZZZZZZZZZZN1', ?, 1, 'general', 1, 'Legacy', 'resolved', 'You', ?, ?)").run(task.id, now, now);
    const head = (await call<{ plan: { reviewer: unknown; reviewVersion: unknown } }>("getTaskPlan", { taskId: task.id })).plan;
    expect(head).toMatchObject({ reviewer: { kind: "owner", threadId: null }, reviewVersion: null });
    expect((await call<{ notes: PlanNote[] }>("listPlanNotes", { taskId: task.id })).notes[0]).toMatchObject({ authorKind: "person", authorThread: null });
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: true, plan: { state: "approved" } });
  });
});

describe("fixes found in review", () => {
  const submitter: PlanAuthor = { kind: "agent", threadId: "thr_submitter", name: "agent (thr_submitter)" };
  const writer: PlanAuthor = { kind: "agent", threadId: "thr_writer", name: "agent (thr_writer)" };

  it("routes a decision on a later, never submitted version to that version's author, not to the earlier submitter", async () => {
    const { save, submit, call, task, sentTo } = setup({ thr_writer: {} });
    await save(BODY, 0);
    await submit("thr_reviewer_a", submitter);
    await save(`${BODY}Second.\n`, 1, writer);
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: true, plan: { version: 2 }, deliveries: [{ role: "actor", threadId: "thr_writer" }] });
    expect(sentTo("thr_writer")).toHaveLength(1);
    expect(sentTo("thr_writer")[0]).toContain("plan v2 approved by the owner");
    expect(sentTo("thr_submitter")).toEqual([]);
  });

  it("delivers an owner's state change through the shared path, returns the outcome and sends nothing for a repeated state", async () => {
    const { save, submit, call, task, sentTo, sent } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a", submitter);
    const approved = await call("setTaskPlanState", { taskId: task.id, state: "approved", author: owner });
    expect(approved).toMatchObject({ ok: true, plan: { state: "approved" }, deliveries: [{ role: "actor", delivered: "sent", threadId: "thr_submitter" }, { role: "copy", delivered: "sent", threadId: "thr_author" }] });
    expect(sentTo("thr_submitter").at(-1)).toContain("EXA-1 · plan v1 approved by the owner");
    expect(sentTo("thr_author").at(-1)).toContain("For information; thr_submitter acts on it.");
    const count = sent().length;
    expect(await call("setTaskPlanState", { taskId: task.id, state: "approved", author: owner })).toMatchObject({ ok: true, deliveries: [] });
    expect(sent()).toHaveLength(count);
    const changes = await call("setTaskPlanState", { taskId: task.id, state: "changes_requested", author: owner });
    expect(changes).toMatchObject({ ok: true, plan: { state: "changes_requested" }, deliveries: [{ role: "actor", threadId: "thr_submitter" }, { role: "copy" }] });
    expect(sentTo("thr_submitter").at(-1)).toContain("changes requested by the owner");
    expect(sentTo("thr_submitter").at(-1)).toContain("plan submit EXA-1 --reviewer thr_reviewer_a");
    // Setting in_review sends nothing.
    const before = sent().length;
    await call("setTaskPlanState", { taskId: task.id, state: "in_review", author: owner });
    expect(sent()).toHaveLength(before);
  });

  it("keeps a sent note, its reply and its number when it is reopened and then dismissed", async () => {
    const { save, submit, flow, call, task, note, notes } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    await note(reviewerA, 1, { body: "Sent once." });
    await flow.sendFeedback(task.id, reviewerA, 1);
    await save(`${BODY}Revised.\n`, 1);
    await call("replyPlanNote", { taskId: task.id, number: 1, body: "Handled.", addressed: true, author });
    await submit("thr_reviewer_a");
    await flow.setState(task.id, reviewerA, 2, [1], "resolved");
    await flow.setState(task.id, reviewerA, 2, [1], "draft");
    expect(await flow.dismiss(task.id, reviewerA, 2, [1])).toMatchObject({ ok: false, error: { message: expect.stringContaining("sent before and reopened") } });
    expect(await notes()).toEqual([expect.objectContaining({ number: 1, state: "draft", reply: "Handled.", sentInVersion: 1 })]);
    // The next note does not reuse the number; a never-sent draft is still dismissible.
    expect(await note(reviewerA, 2, { body: "Fresh." })).toMatchObject({ ok: true, note: { number: 2 } });
    expect(await flow.dismiss(task.id, reviewerA, 2, [2])).toMatchObject({ ok: true });
  });

  it("keeps an unreachable copy recipient in the results with its own outcome and original id", async () => {
    const { save, submit, flow, task, note, sentTo } = setup({ thr_gone: { archivedAt: 1 } });
    await save(BODY, 0, { kind: "agent", threadId: "thr_gone", name: "agent (thr_gone)" });
    await submit("thr_reviewer_a", submitter);
    await note(reviewerA, 1);
    const result = await flow.sendFeedback(task.id, reviewerA, 1);
    expect(result).toMatchObject({ ok: true, delivered: "no_thread" });
    expect((result as { deliveries: unknown[] }).deliveries).toEqual([{ role: "actor", delivered: "sent", threadId: "thr_submitter" }, { role: "copy", delivered: "no_thread", threadId: "thr_gone" }]);
    expect(sentTo("thr_submitter")).toHaveLength(1);
  });

  it("does not let a bare resubmit that overlaps an explicit reassignment send the plan back to the old reviewer", async () => {
    const { save, submit, harness, plans, task, sentTo, reviews, known } = setup();
    await save(BODY, 0);
    await submit("thr_reviewer_a");
    expect(sentTo("thr_reviewer_a")).toHaveLength(1);
    // The lookup of the old reviewer hangs until the reassignment has committed.
    let release!: () => void;
    const hang = new Promise<void>((resolve) => (release = resolve));
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_reviewer_a") await hang;
      return makeThreadResponse({ id: threadId, status: "active", ...known[threadId] });
    });
    const bare = submit();
    await Promise.resolve();
    expect(await submit("thr_reviewer_b")).toMatchObject({ ok: true, outcome: "reassigned" });
    release();
    expect(await bare).toMatchObject({ ok: false, error: { code: "plan_conflict", message: expect.stringContaining("changed while you resubmitted") } });
    expect(plans.head(task.id)?.reviewer.threadId).toBe("thr_reviewer_b");
    expect(sentTo("thr_reviewer_a")).toHaveLength(1);
    expect(reviews().map((row) => [row.reviewer.threadId, row.outcome])).toEqual([["thr_reviewer_a", "reassigned"], ["thr_reviewer_b", "pending"]]);
  });

  it("refuses a section path longer than the note limit and leaves the task readable and exportable", async () => {
    const { save, submit, note, notes, store, project, host } = setupLong();
    await save(`# ${"A".repeat(200)}\n\n## ${"B".repeat(200)}\n\n### ${"C".repeat(200)}\nText to quote here.\n`, 0);
    await submit("thr_reviewer_a");
    expect(await note(reviewerA, 1, { quote: "Text to quote here.", section: "C".repeat(200) })).toMatchObject({ ok: false, error: { message: expect.stringContaining("longer than 500 characters") } });
    expect(await notes()).toEqual([]);
    expect(await note(reviewerA, 1, { quote: "Text to quote here." })).toMatchObject({ ok: true });
    expect(await notes()).toHaveLength(1);
    const { captureProject } = await import("../archive/storage");
    expect(() => captureProject(host.bb, store, project.id)).not.toThrow();
  });
});

function setupLong() {
  const base = setup();
  return { ...base, host: base };
}
