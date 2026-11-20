import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanReviewFlow, createStore, registerTasksApi } from "../api";
import plugin from "../server";
import type { PlanAuthor, TaskQuestion } from "../shared/contract";
import { createStructuredStore } from "../structured/store";
import { createPlanStore } from "./store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const author: PlanAuthor = { kind: "agent", threadId: "thr_author", name: "agent (thr_author)" };
const reviewerA: PlanAuthor = { kind: "agent", threadId: "thr_reviewer_a", name: "agent (thr_reviewer_a)" };
const owner: PlanAuthor = { kind: "person", threadId: null, name: "Owner" };
const BODY = "# Plan\n\n## Steps\nAdd the table.\n";

type SentCall = [{ threadId: string; input: Array<{ text: string }> }];
type WakeResult = { planWake?: { event: string; delivered: string; failed: string[]; hint: string | null } };

/** A project with planning on, one card, and a fake host whose threads (author, two reviewers) are all live. */
function setup() {
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }),
        send: async () => undefined,
      },
    },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  store.tasks.updateProject(project.id, { planning: "optional" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Planned work" });
  const db = host.bb.storage.database();
  const plans = createPlanStore(db, store.tasks);
  const flow = createPlanReviewFlow(host.bb, store);
  const call = <T = Record<string, any>>(method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, input as never) as Promise<T & { ok?: boolean; error?: { code: string; message: string } }>;
  const save = (body: string, baseVersion: number, by: PlanAuthor = author) => call("saveTaskPlan", { taskId: task.id, summary: "Edit", author: by, op: "replace", baseVersion, body });
  const submit = (reviewer: string, by: PlanAuthor = author) => call("submitTaskPlan", { taskId: task.id, author: by, reviewer });
  // `forget` drops the sends so far, so a test sees only what a later step sent.
  let forgotten = 0;
  const forget = () => void (forgotten = host.harness.sdk.callsTo("threads.send").length);
  const sent = () => (host.harness.sdk.callsTo("threads.send") as SentCall[]).slice(forgotten);
  const sentTo = (threadId: string) => sent().filter((entry) => entry[0].threadId === threadId).map((entry) => entry[0].input[0]!.text);
  const ask = (kind: "decision" | "check" = "decision") =>
    call<WakeResult & { question: TaskQuestion }>("createQuestion", { taskId: task.id, kind, prompt: "Which one?", options: kind === "decision" ? ["A", "B"] : [], mode: "single" });
  const answer = (question: TaskQuestion, pick: boolean = true) =>
    call<WakeResult & { question: TaskQuestion }>("answerQuestion", { questionId: question.id, revision: question.revision, selectedOptionIds: pick ? [question.options[0]!.id] : [], authorName: "Owner" });
  const reopen = (question: TaskQuestion) =>
    call<WakeResult & { question: TaskQuestion }>("updateQuestion", { questionId: question.id, revision: question.revision, prompt: question.prompt, mode: question.mode, options: question.options, reopen: true, authorName: "Owner" });
  const remove = (question: TaskQuestion) => call<WakeResult & { deleted: boolean }>("deleteQuestion", { questionId: question.id, revision: question.revision });
  const paused = async () => ((await call<{ paused: boolean }>("listPlanReviews", { taskId: task.id })).paused);
  /** A draft plan submitted to a thread reviewer, with the setup sends cleared out of the way. */
  const inReview = async (reviewer = "thr_reviewer_a", by: PlanAuthor = author) => {
    await save(BODY, 0, by);
    expect(await submit(reviewer, by)).toMatchObject({ ok: true });
    forget();
  };
  return { ...host, store, project, task, db, plans, flow, call, save, submit, sent, forget, sentTo, ask, answer, reopen, remove, paused, inReview };
}

const pausedText = /EXA-1 plan v1: review paused, waiting for the owner's decision\. Check `bb work-board plan reviews EXA-1` before acting\./;
const resumedText = /EXA-1 plan v1: the owner's decision is settled\. Read the decisions on the card, then judge whether the plan text still holds: approve it, or send feedback if it needs changes\./;

describe("review pause on an open owner decision", () => {
  it("wakes the reviewer on 0 → ≥1 and ≥1 → 0 only, for create, answer, withdraw, reopen and delete", async () => {
    const { inReview, ask, answer, reopen, remove, sentTo, paused, call, task } = setup();
    await inReview();
    expect(await paused()).toBe(false);
    // Create: the first open decision pauses; the wake text names the version and the command to check.
    const first = await ask();
    expect(first.planWake).toMatchObject({ event: "paused", delivered: "sent", failed: [] });
    expect(sentTo("thr_reviewer_a")).toHaveLength(1);
    expect(sentTo("thr_reviewer_a")[0]).toMatch(pausedText);
    expect(await paused()).toBe(true);
    // A check question never pauses, and a second decision is not a transition.
    expect((await ask("check")).planWake).toBeUndefined();
    const second = await ask();
    expect(second.planWake).toBeUndefined();
    expect(sentTo("thr_reviewer_a")).toHaveLength(1);
    // Answer: 2 → 1 is no transition; 1 → 0 resumes. A repeated identical answer is a no-op.
    expect((await answer(first.question)).planWake).toBeUndefined();
    const settled = await answer(second.question);
    expect(settled.planWake).toMatchObject({ event: "resumed", delivered: "sent", failed: [] });
    expect(sentTo("thr_reviewer_a")).toHaveLength(2);
    expect(sentTo("thr_reviewer_a")[1]).toMatch(resumedText);
    expect(await paused()).toBe(false);
    expect((await answer(settled.question)).planWake).toBeUndefined();
    expect(sentTo("thr_reviewer_a")).toHaveLength(2);
    // Withdrawing the last answer during the review pauses again; answering again resumes.
    const withdrawn = await answer(settled.question, false);
    expect(withdrawn.planWake).toMatchObject({ event: "paused" });
    expect(await paused()).toBe(true);
    const again = await answer(withdrawn.question);
    expect(again.planWake).toMatchObject({ event: "resumed" });
    // Reopen through updateQuestion pauses; a no-op update changes nothing; deleting the last open decision resumes.
    const reopened = await reopen(again.question);
    expect(reopened.planWake).toMatchObject({ event: "paused" });
    expect((await call<WakeResultOnly>("updateQuestion", { questionId: reopened.question.id, revision: reopened.question.revision, prompt: reopened.question.prompt, mode: reopened.question.mode, options: reopened.question.options, authorName: "Owner" })).planWake).toBeUndefined();
    expect((await remove(reopened.question)).planWake).toMatchObject({ event: "resumed" });
    expect(await paused()).toBe(false);
    // Eight transitions in total: pause, resume, pause, resume, pause, resume — and nothing else.
    expect(sentTo("thr_reviewer_a").map((text) => (resumedText.test(text) ? "resume" : pausedText.test(text) ? "pause" : "other"))).toEqual(["pause", "resume", "pause", "resume", "pause", "resume"]);
    expect(task.id).toBeTruthy();
  });

  it("sends one wake per transition: two decisions opened and settled, then a third on the same version", async () => {
    const { inReview, ask, answer, sentTo } = setup();
    await inReview();
    const a = await ask();
    const b = await ask();
    await answer(a.question);
    await answer(b.question);
    const c = await ask();
    await answer(c.question);
    const kinds = sentTo("thr_reviewer_a").map((text) => (resumedText.test(text) ? "resume" : pausedText.test(text) ? "pause" : "other"));
    expect(kinds).toEqual(["pause", "resume", "pause", "resume"]);
  });

  it("keeps working across a restart: the pause is read from the live decisions, and the next transition sends its own wake", async () => {
    const { inReview, ask, sentTo, bb, store, paused } = setup();
    await inReview();
    const opened = await ask();
    expect(sentTo("thr_reviewer_a")).toHaveLength(1);
    // A second store over the same database holds no state of the first one.
    const restarted = createStructuredStore(bb, createStore(bb));
    expect(await paused()).toBe(true);
    const settled = await restarted.handlers.answerQuestion({ questionId: opened.question.id, revision: opened.question.revision, selectedOptionIds: [opened.question.options[0]!.id], authorName: "Owner", attachmentIds: undefined, answerText: undefined });
    expect(settled.planWake).toMatchObject({ event: "resumed", delivered: "sent" });
    expect(sentTo("thr_reviewer_a")).toHaveLength(2);
    expect(store.tasks).toBeTruthy();
  });

  it("wakes nobody when the owner reviews", async () => {
    const { save, submit, ask, answer, sent } = setup();
    await save(BODY, 0);
    expect(await submit("owner")).toMatchObject({ ok: true });
    const opened = await ask();
    expect(opened.planWake).toBeUndefined();
    expect((await answer(opened.question)).planWake).toBeUndefined();
    expect(sent()).toEqual([]);
  });

  it("reports a failed wake as a result and still saves the question", async () => {
    const { inReview, ask, harness, call, task } = setup();
    await inReview();
    harness.sdk.stub("threads.send", async () => {
      throw new Error("queue is full");
    });
    const failed = await ask();
    expect(failed.planWake).toMatchObject({ event: "paused", delivered: "failed", failed: ["thr_reviewer_a"], hint: expect.stringContaining("thr_reviewer_a") });
    expect((await call<{ questions: unknown[] }>("listQuestions", { taskId: task.id })).questions).toHaveLength(1);
  });
});

describe("question commands", () => {
  it("print a failed wake as a separate line, and the plan commands show the pause", async () => {
    const host = createFakePluginHost({ pluginId: "work-board", sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }), send: async () => undefined } } });
    hosts.push(host);
    await plugin(host.bb);
    const { harness } = host;
    const cli = (...args: string[]) => harness.runCli(args);
    await cli("project", "create", "--name", "Example", "--prefix", "EXA");
    const { project } = (await harness.callRpc("getProjectByPrefix" as never, { prefix: "EXA" } as never).catch(() => ({ project: null }))) as { project: { id: string } | null };
    const projectId = project?.id ?? (host.bb.storage.database().prepare("SELECT id FROM projects").get() as { id: string }).id;
    await harness.callRpc("updateProject" as never, { projectId, planning: "optional" } as never);
    await cli("create", "--project", "EXA", "--title", "Planned work");
    await cli("plan", "set", "EXA-1", "--base-version", "0", "--summary", "Plan", "--body", BODY);
    await cli("plan", "submit", "EXA-1", "--reviewer", "thr_reviewer_a");
    harness.sdk.stub("threads.send", async () => {
      throw new Error("queue is full");
    });
    const added = await cli("question", "add", "EXA-1", "--prompt", "Which one?", "--option", "A", "--option", "B");
    expect(added, added.stderr).toMatchObject({ exitCode: 0 });
    expect(added.stdout).toContain('"prompt": "Which one?"');
    expect(added.stderr).toMatch(/The question is saved, but thr_reviewer_a could not be told that the plan review is paused on this decision; tell them yourself\./);
    expect((await cli("plan", "reviews", "EXA-1")).stdout).toContain("Waiting for the owner's decision");
    expect((await cli("plan", "show", "EXA-1")).stdout).toMatch(/^Plan v1 · in_review · waiting for the owner's decision · updated/);
    const shown = JSON.parse((await cli("show", "EXA-1", "--json")).stdout);
    expect(shown.plan.review).toEqual({ paused: true });
    const question = shown.questions[0] as { id: string; revision: number; options: Array<{ id: string }> };
    harness.sdk.stub("threads.send", async () => undefined);
    const answered = await cli("question", "answer", "EXA-1", "--question", question.id, "--revision", String(question.revision), "--answer", question.options[0]!.id);
    expect(answered.stdout).toBe(`Saved answer to ${question.id}`);
    expect(JSON.parse((await cli("show", "EXA-1", "--json")).stdout).plan.review).toEqual({ paused: false });
  });
});

describe("resume binding", () => {
  /** Settles the open decision while `during` runs in the gap between the commit and the delivery. */
  async function settleDuring(during: (ctx: ReturnType<typeof setup>) => void) {
    const ctx = setup();
    await ctx.inReview();
    const opened = await ctx.ask();
    ctx.forget();
    const publish = ctx.bb.realtime.publish.bind(ctx.bb.realtime);
    let fired = false;
    ctx.bb.realtime.publish = ((event: string, payload: unknown) => {
      // `comments:changed` is the last event before the wake is read and sent.
      if (event === "comments:changed" && !fired) {
        fired = true;
        during(ctx);
      }
      return publish(event as never, payload as never);
    }) as typeof ctx.bb.realtime.publish;
    const settled = await ctx.answer(opened.question);
    return { ...ctx, settled };
  }

  it("sends nothing when the owner overrode the review, the reviewer was changed or a newer draft was saved before the wake", async () => {
    const override = await settleDuring(({ plans, task }) => void plans.setState(task.id, "approved", owner));
    expect(override.settled.planWake).toBeUndefined();
    expect(override.sent()).toEqual([]);
    const reassign = await settleDuring(({ plans, task }) => void plans.submit(task.id, author, "thr_reviewer_b"));
    expect(reassign.settled.planWake).toBeUndefined();
    expect(reassign.sentTo("thr_reviewer_a")).toEqual([]);
    expect(reassign.sentTo("thr_reviewer_b")).toEqual([]);
    const draft = await settleDuring(({ plans, task }) => void plans.save({ taskId: task.id, op: "replace", baseVersion: 1, body: `${BODY}More.\n`, summary: "Edit", author }));
    expect(draft.settled.planWake).toBeUndefined();
    expect(draft.sent()).toEqual([]);
  });

  it("sends nothing when the decision is settled after the review ended", async () => {
    const overridden = setup();
    await overridden.inReview();
    const first = await overridden.ask();
    overridden.plans.setState(overridden.task.id, "approved", owner);
    expect((await overridden.answer(first.question)).planWake).toBeUndefined();
    const edited = setup();
    await edited.inReview();
    const second = await edited.ask();
    await edited.save(`${BODY}More.\n`, 1);
    expect((await edited.answer(second.question)).planWake).toBeUndefined();
    expect(edited.sentTo("thr_reviewer_a")).toHaveLength(1);
  });

  it("still wakes the reviewer of a plan written in the app, which has no author thread", async () => {
    const { inReview, ask, answer, sent, sentTo } = setup();
    await inReview("thr_reviewer_a", owner);
    const opened = await ask();
    expect(opened.planWake).toMatchObject({ event: "paused", delivered: "sent" });
    const settled = await answer(opened.question);
    // Nobody wrote it from a thread, so there is nobody to copy; that is not a failed delivery.
    expect(settled.planWake).toMatchObject({ event: "resumed", delivered: "sent", failed: [] });
    expect(sent().map((entry) => entry[0].threadId)).toEqual(["thr_reviewer_a", "thr_reviewer_a"]);
    expect(sentTo("thr_reviewer_a")[1]).toMatch(resumedText);
  });

  it("copies the author for information when a decision is settled", async () => {
    const { inReview, ask, answer, sentTo } = setup();
    await inReview();
    const opened = await ask();
    await answer(opened.question);
    expect(sentTo("thr_author")).toHaveLength(1);
    expect(sentTo("thr_author")[0]).toContain("For information; thr_reviewer_a acts on it. Do not act on it yourself.");
  });
});

type WakeResultOnly = WakeResult;

describe("guards while a decision is open", () => {
  it("refuses plan submit and a return to review while a decision is open, and allows them after the answer", async () => {
    const { save, submit, ask, answer, call, task, plans, store } = setup();
    await save(BODY, 0);
    const opened = await ask();
    // No review is waiting, so asking sent nothing; the plan still cannot go to review.
    const refused = await submit("thr_reviewer_a");
    expect(refused).toMatchObject({ ok: false, error: { code: "plan_state", message: `EXA-1 has an open owner decision (${opened.question.id}); submit after it is answered.` } });
    expect(await call("setTaskPlanState", { taskId: task.id, state: "in_review", author: owner })).toMatchObject({ ok: false, error: { message: expect.stringContaining("has an open owner decision") } });
    expect(plans.head(task.id)?.state).toBe("draft");
    expect(store.tasks.getTask(task.id)).toBeTruthy();
    await answer(opened.question);
    expect(await submit("thr_reviewer_a")).toMatchObject({ ok: true, outcome: "submitted" });
  });

  it("refuses reviewer approve and feedback while paused, and lets notes, dismissals and the owner through", async () => {
    const { inReview, ask, answer, flow, task, call, db, plans } = setup();
    await inReview();
    const noted = await flow.addNote({ taskId: task.id, by: reviewerA, version: 1, body: "Rename this." });
    expect(noted).toMatchObject({ ok: true });
    const opened = await ask();
    expect(plans.paused(task.id)).toBe(true);
    const refusal = { ok: false, error: { code: "plan_state", message: expect.stringContaining(`the owner has an open decision (${opened.question.id})`) } };
    expect(await flow.sendFeedback(task.id, reviewerA, 1)).toMatchObject(refusal);
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject(refusal);
    // Notes keep their own guards: the reviewer can still add, resolve and dismiss.
    expect(await flow.addNote({ taskId: task.id, by: reviewerA, version: 1, body: "One more." })).toMatchObject({ ok: true });
    expect(await flow.dismiss(task.id, reviewerA, 1, [2])).toMatchObject({ ok: true, removed: [2] });
    await answer(opened.question);
    expect(plans.paused(task.id)).toBe(false);
    expect(await flow.sendFeedback(task.id, reviewerA, 1)).toMatchObject({ ok: true });
    expect(db).toBeTruthy();
  });

  it("does not block the owner: an owner approval overrides a paused review", async () => {
    const { inReview, ask, call, task, plans } = setup();
    await inReview();
    await ask();
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: true });
    expect(plans.head(task.id)?.state).toBe("approved");
  });

  it("refuses a reviewer decision on a live open decision even when no wake ever ran", async () => {
    const { inReview, db, task, flow, plans } = setup();
    await inReview();
    // A decision that arrived without a transition, such as one imported with the card.
    const payload = { id: "q_imported", taskId: task.id, kind: "decision", askedByThread: null, prompt: "Which one?", steps: [], mode: "single", allowOther: true, options: [], selectedOptionIds: [], answeredBy: null, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [] };
    db.prepare("INSERT INTO task_questions (id, task_id, payload) VALUES (?, ?, ?)").run("q_imported", task.id, JSON.stringify(payload));
    expect(plans.paused(task.id)).toBe(true);
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: false, error: { message: expect.stringContaining("q_imported") } });
    // A question without a kind reads as a decision.
    db.prepare("UPDATE task_questions SET payload = json_remove(payload, '$.kind') WHERE id = 'q_imported'").run();
    expect(plans.paused(task.id)).toBe(true);
  });

  it("never pauses on a check question", async () => {
    const { inReview, ask, flow, task, plans, sent } = setup();
    await inReview();
    const check = await ask("check");
    expect(check.planWake).toBeUndefined();
    expect(plans.paused(task.id)).toBe(false);
    expect(sent()).toEqual([]);
    expect(await flow.approve(task.id, reviewerA, undefined, 1)).toMatchObject({ ok: true });
  });
});
