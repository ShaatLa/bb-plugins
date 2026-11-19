import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import type { PlanAuthor, PlanNote } from "../shared/contract";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const agent: PlanAuthor = { kind: "agent", threadId: "thr_plan", name: "agent (thr_plan)" };
const owner: PlanAuthor = { kind: "person", threadId: null, name: "Owner" };
const BODY = "# Plan\n\n## Steps\nAdd the new table.\nRoll it out slowly.\n\n### Rollback\nDrop the table.\n";

type Thread = ReturnType<typeof makeThreadResponse>;
function setup(threads: Record<string, Partial<Thread>> = { thr_plan: {} }) {
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active", ...(threads[threadId] ?? {}) }), send: async () => undefined } },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Planned work" });
  const call = <T = Record<string, any>>(method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, input as never) as Promise<T & { ok?: boolean; error?: { code: string; message: string } }>;
  const save = (input: Record<string, unknown>) => call("saveTaskPlan", { taskId: task.id, summary: "Edit", author: agent, op: "replace", ...input });
  const note = async (input: Record<string, unknown>) => (await call<{ note: PlanNote }>("createPlanNote", { taskId: task.id, ...input })).note;
  const comment = (text: string, extra: Record<string, unknown> = {}) => note({ kind: "comment", exact: text, prefix: "", suffix: "", headingPath: "Steps", body: "Please change.", ...extra });
  const states = async () => ((await call<{ notes: PlanNote[] }>("listPlanNotes", { taskId: task.id })).notes).map((entry) => `${entry.number}:${entry.state}`);
  const systemComments = () => store.tasks.listComments(task.id).filter((entry) => entry.kind === "system").map((entry) => entry.body);
  const sent = () => host.harness.sdk.callsTo("threads.send") as Array<[{ threadId: string; input: Array<{ text: string }> }]>;
  return { ...host, store, task, call, save, note, comment, states, systemComments, sent };
}

describe("plan notes", () => {
  it("numbers notes per task and keeps general notes free of an anchor", async () => {
    const { call, save, comment, note, task } = setup();
    expect(await call("createPlanNote", { taskId: task.id, kind: "general", body: "Early." })).toMatchObject({ ok: false, error: { code: "plan_invalid", message: expect.stringContaining("no plan") } });
    await save({ baseVersion: 0, body: BODY });
    const first = await comment("Add the new table.", { prefix: "Steps\n", suffix: "\nRoll" });
    const remove = await note({ kind: "remove", exact: "Drop the table.", prefix: "", suffix: "", headingPath: "Steps > Rollback" });
    const general = await note({ kind: "general", body: "Add rollback steps." });
    expect([first.number, remove.number, general.number]).toEqual([1, 2, 3]);
    expect(first).toMatchObject({ state: "draft", madeOnVersion: 1, authorName: "You", kind: "comment", exact: "Add the new table.", headingPath: "Steps", sentInVersion: null });
    expect(remove).toMatchObject({ kind: "remove", body: "" });
    expect(general).toMatchObject({ kind: "general", exact: null, prefix: null, suffix: null, headingPath: null });
  });

  it("refuses unusable notes", async () => {
    const { call, save, task, comment, store } = setup();
    await save({ baseVersion: 0, body: BODY });
    const refused = (input: Record<string, unknown>) => call("createPlanNote", { taskId: task.id, ...input });
    expect(await refused({ kind: "comment", exact: "x", body: "  " })).toMatchObject({ ok: false, error: { code: "plan_invalid" } });
    expect(await refused({ kind: "comment", body: "No quote." })).toMatchObject({ ok: false, error: { code: "plan_invalid" } });
    expect(await refused({ kind: "general", body: "x", exact: "quote" })).toMatchObject({ ok: false, error: { code: "plan_invalid" } });
    expect(await refused({ kind: "general", body: "" })).toMatchObject({ ok: false, error: { code: "plan_invalid" } });
    expect(await refused({ kind: "general", body: "x", madeOnVersion: 5 })).toMatchObject({ ok: false, error: { code: "plan_invalid" } });
    expect(await refused({ kind: "general", body: `leak ghp_${"a".repeat(36)}` })).toMatchObject({ ok: false, error: { code: "secret_detected" } });
    expect((await comment("Add the new table.")).state).toBe("draft");
    store.tasks.updateTask(task.id, { status: "done" });
    store.tasks.setTaskArchived(task.id, true);
    expect(await refused({ kind: "general", body: "x" })).toMatchObject({ ok: false, error: { code: "plan_archived" } });
  });

  it("edits and deletes drafts only, then walks draft → sent → addressed → resolved and back", async () => {
    const { call, save, comment, states, note, systemComments } = setup();
    await save({ baseVersion: 0, body: BODY });
    const one = await comment("Add the new table.");
    const two = await note({ kind: "general", body: "Global." });
    expect(await call("updatePlanNote", { noteId: one.id, body: "Better wording." })).toMatchObject({ ok: true, note: { body: "Better wording." } });
    expect(await call("updatePlanNote", { noteId: one.id, body: " " })).toMatchObject({ ok: false, error: { code: "plan_invalid" } });
    expect(await call("deletePlanNote", { noteId: two.id })).toEqual({ ok: true });
    expect(await states()).toEqual(["1:draft"]);
    expect(await call("replyPlanNote", { taskId: one.taskId, number: 1, body: "Early", author: agent })).toMatchObject({ ok: false, error: { code: "plan_state", message: expect.stringContaining("not been sent") } });

    expect(await call("sendPlanFeedback", { taskId: one.taskId, author: owner })).toMatchObject({ ok: true, notes: 1, plan: { state: "changes_requested" } });
    expect(systemComments()).toContain("Plan v1: changes requested by Owner · 1 note");
    expect(await states()).toEqual(["1:sent"]);
    expect(await call("updatePlanNote", { noteId: one.id, body: "Late edit" })).toMatchObject({ ok: false, error: { code: "plan_state" } });
    expect(await call("deletePlanNote", { noteId: one.id })).toMatchObject({ ok: false, error: { code: "plan_state" } });
    expect(await call("setPlanNoteState", { noteId: one.id, state: "draft" })).toMatchObject({ ok: false, error: { code: "plan_state" } });
    expect(await call("sendPlanFeedback", { taskId: one.taskId, author: owner })).toMatchObject({ ok: false, error: { code: "plan_state" } });

    expect(await call("replyPlanNote", { taskId: one.taskId, number: 1, body: "Working on it.", author: agent })).toMatchObject({ ok: true, note: { state: "sent", reply: "Working on it.", replyBy: agent.name, addressedInVersion: null } });
    await save({ baseVersion: 1, body: `${BODY}\nMore.\n` });
    expect(await call("replyPlanNote", { taskId: one.taskId, number: 1, body: "Done in v2.", addressed: true, author: agent })).toMatchObject({ ok: true, note: { state: "addressed", addressedInVersion: 2, reply: "Done in v2." } });
    expect(await call("replyPlanNote", { taskId: one.taskId, number: 9, body: "x", author: agent })).toMatchObject({ ok: false, error: { message: expect.stringContaining("no note N9") } });

    expect(await call("setPlanNoteState", { noteId: one.id, state: "resolved" })).toMatchObject({ ok: true, note: { state: "resolved" } });
    expect(await call("replyPlanNote", { taskId: one.taskId, number: 1, body: "x", author: agent })).toMatchObject({ ok: false, error: { code: "plan_state" } });
    expect(await call("setPlanNoteState", { noteId: one.id, state: "draft" })).toMatchObject({ ok: true, note: { state: "draft", sentInVersion: null, sentAt: null, addressedInVersion: null, reply: "Done in v2." } });
    expect(await call("sendPlanFeedback", { taskId: one.taskId, author: owner })).toMatchObject({ ok: true, notes: 1 });
    expect(await states()).toEqual(["1:sent"]);
  });

  it("counts notes by state, keeps them across plan versions and re-anchors nothing on the server", async () => {
    const { call, save, comment, note, task } = setup();
    await save({ baseVersion: 0, body: BODY });
    await comment("Add the new table.");
    await note({ kind: "general", body: "Global." });
    await call("sendPlanFeedback", { taskId: task.id, author: owner });
    await comment("Drop the table.");
    expect((await call<{ noteCounts: unknown }>("listTaskPlanVersions", { taskId: task.id })).noteCounts).toEqual({ draft: 1, open: 2, addressed: 0, resolved: 0 });
    await save({ baseVersion: 1, body: "# Plan\n\nRewritten.\n" });
    const after = await call<{ notes: PlanNote[] }>("listPlanNotes", { taskId: task.id });
    expect(after.notes.map((entry) => [entry.number, entry.madeOnVersion, entry.state])).toEqual([[1, 1, "sent"], [2, 1, "sent"], [3, 1, "draft"]]);
    expect((await call<{ plan: { noteCounts: unknown } }>("getTaskPlan", { taskId: task.id })).plan.noteCounts).toEqual({ draft: 1, open: 2, addressed: 0, resolved: 0 });
  });
});

describe("send feedback and approve", () => {
  it("sends one message with every draft note in plan order, to the plan author's thread", async () => {
    const { call, save, comment, note, task, sent, systemComments, harness } = setup();
    await save({ baseVersion: 0, body: BODY });
    await note({ kind: "general", body: "Add rollback steps." });
    await comment("Drop the table.", { kind: "remove", body: "", headingPath: "Steps > Rollback" });
    await comment("Add the new table.", { body: "Behind a flag." });
    const result = await call("sendPlanFeedback", { taskId: task.id, author: owner });
    expect(result).toMatchObject({ ok: true, delivered: "sent", threadId: "thr_plan", notes: 3, plan: { state: "changes_requested" } });
    expect(sent()).toHaveLength(1);
    const { threadId, input } = sent()[0]![0];
    expect(threadId).toBe("thr_plan");
    const text = input[0]!.text;
    expect(text.startsWith("EXA-1 · plan v1: changes requested by the owner\n\nYOUR PLAN WAS NOT APPROVED.")).toBe(true);
    expect(text).toContain("Owner's notes on v1 (3), in plan order:");
    expect(text.indexOf("N3 · Comment")).toBeLessThan(text.indexOf("N2 · Remove"));
    expect(text.indexOf("N2 · Remove")).toBeLessThan(text.indexOf("N1 · General"));
    expect(text).toContain('N3 · Comment · section "Steps"\n> Add the new table.\nBehind a flag.');
    expect(systemComments()).toContain("Plan v1: changes requested by Owner · 3 notes");
    expect(harness.realtimeSignals).toEqual(expect.arrayContaining([{ channel: "comments:changed", payload: { taskId: task.id } }]));
  });

  it("falls back to the task's own thread when the plan author's thread is archived, and reports no_thread", async () => {
    const archived = setup({ thr_plan: { archivedAt: 1 }, thr_task: {} });
    await archived.save({ baseVersion: 0, body: BODY });
    archived.store.tasks.upsertTaskThread({ taskId: archived.task.id, threadId: "thr_task", presetName: "Default", title: "Work", liveStatus: "working" });
    await archived.note({ kind: "general", body: "Global." });
    expect(await archived.call("sendPlanFeedback", { taskId: archived.task.id, author: owner })).toMatchObject({ delivered: "sent", threadId: "thr_task" });

    const none = setup();
    await none.save({ baseVersion: 0, body: BODY, author: { kind: "person", threadId: null, name: "Someone" } });
    await none.note({ kind: "general", body: "Global." });
    expect(await none.call("sendPlanFeedback", { taskId: none.task.id, author: owner })).toMatchObject({ ok: true, delivered: "no_thread", threadId: null, plan: { state: "changes_requested" } });
    expect(none.sent()).toHaveLength(0);
  });

  it("uses the question target (latest agent comment) when no session is linked", async () => {
    const { save, store, task, note, call, sent } = setup({ thr_other: {} });
    await save({ baseVersion: 0, body: BODY, author: { kind: "person", threadId: null, name: "Someone" } });
    store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Agent", threadId: "thr_other", body: "Hello" });
    await note({ kind: "general", body: "Global." });
    expect(await call("sendPlanFeedback", { taskId: task.id, author: owner })).toMatchObject({ delivered: "sent", threadId: "thr_other" });
    expect(sent()[0]![0].threadId).toBe("thr_other");
  });

  it("keeps the notes sent when delivery fails", async () => {
    const { save, note, call, task, states, harness } = setup();
    await save({ baseVersion: 0, body: BODY });
    await note({ kind: "general", body: "Global." });
    harness.sdk.stub("threads.send", async () => {
      throw new Error("thread is gone");
    });
    expect(await call("sendPlanFeedback", { taskId: task.id, author: owner })).toMatchObject({ ok: true, delivered: "failed", threadId: "thr_plan", plan: { state: "changes_requested" } });
    expect(await states()).toEqual(["1:sent"]);
    expect(harness.logEntries).toContainEqual({ level: "warn", message: expect.stringContaining("thread is gone") });
  });

  it("approves only without drafts, writes a comment and tells the agent, with the note when given", async () => {
    const { call, save, note, task, systemComments, sent } = setup();
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: false });
    await save({ baseVersion: 0, body: BODY });
    await note({ kind: "general", body: "Global." });
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: false, error: { code: "plan_state", message: expect.stringContaining("1 draft note") } });
    await call("sendPlanFeedback", { taskId: task.id, author: owner });
    const approved = await call("approvePlan", { taskId: task.id, author: owner, note: "Go ahead." });
    expect(approved).toMatchObject({ ok: true, delivered: "sent", threadId: "thr_plan", plan: { state: "approved" } });
    expect(systemComments()).toContain("Plan v1: approved by Owner · note: Go ahead.");
    expect(sent().at(-1)![0].input[0]!.text).toBe(
      "EXA-1 · plan v1 approved by the owner\n\nStart the work as planned. The approved plan is v1: any new version returns it to draft and needs a new review.\nPlan: [EXA-1 plan](/plugins/work-board/work-board/task/EXA-1/plan)\n\nOwner's note: Go ahead.",
    );
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: false, error: { code: "plan_state" } });
    await save({ baseVersion: 1, body: `${BODY}\nMore.\n` });
    expect((await call<{ plan: { state: string } }>("getTaskPlan", { taskId: task.id })).plan.state).toBe("draft");
    expect(await call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: true, plan: { state: "approved", version: 2 } });
    expect(sent().at(-1)![0].input[0]!.text).not.toContain("Owner's note");
  });
});
