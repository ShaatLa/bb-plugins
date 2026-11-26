import { expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerLifecycle } from "../lifecycle";
import { setPauseMode, startManualPause } from "../pause/store";
import { notifyThread } from "../steer";
import { goLive, setup } from "./fixtures";
import { registerDispatchGate } from "./dispatch-gate";

type Fixture = ReturnType<typeof setup>;
const THREAD = "thr_example";
const text = (body: string) => [{ type: "text" as const, text: body, mentions: [] as [] }];

/** A live card in progress with a linked executor thread and its reminder queued as a Work Board row. */
async function reminded(f: Fixture, title = "Example") {
  await goLive(f);
  const task = f.card(title);
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: THREAD, title: "Worker", presetName: "Agent", liveStatus: "idle" });
  f.harness.sdk.stub("threads.list", async () => [{ ...makeThreadResponse({ id: THREAD, status: "idle" }), activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } }]);
  setPauseMode(f.db, f.tracker.id, "on");
  f.makeEligible();
  await f.service.drain();
  const row = f.threads.rows.find((candidate) => candidate.threadId === THREAD && candidate.content[0]!.text.includes("work-board-executor:"))!;
  expect(row).toBeDefined();
  return { task, row };
}

function gate(f: Fixture) {
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const rowOf = (row: { id: string; content: { text: string }[]; originPluginId: string | null }, senderThreadId: string | null = null) => ({ id: row.id, content: text(row.content[0]!.text), originPluginId: row.originPluginId, senderThreadId });
  const queued = (rows: ReturnType<typeof rowOf>[], attempt: "start-turn" | "join-turn" = "start-turn") => hook(makeMessageDispatchHookContext({ thread: { id: THREAD }, attempt, queuedMessages: rows }));
  const inline = (body: string, originPluginId: string | null, attempt: "start-turn" | "join-turn" = "start-turn", senderThreadId: string | null = null) => hook(makeMessageDispatchHookContext({ thread: { id: THREAD }, attempt, input: { text: body }, originPluginId, senderThreadId }));
  const user = (body = "please continue") => f.threads.addRow(THREAD, body, "user-origin");
  return { hook, rowOf, queued, inline, user };
}
const pauses = (f: Fixture) => f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM task_pauses").get()!.n;
const lastEnd = (f: Fixture) => f.db.prepare("SELECT end_reason FROM pause_log WHERE event='end' ORDER BY id DESC").get();
const wait = (reason = "removing a stale Work Board reminder") => ({ action: "wait", reason, sendAt: expect.any(Number) });
const delay = (decision: unknown) => (decision as { sendAt: number }).sendAt - Date.now();

it("deletes a queued reminder whose card was paused, never delivers it, and keeps the pause", async () => {
  const f = setup();
  const { task, row } = await reminded(f);
  const g = gate(f);
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  const rechecks = f.harness.recheckCount;
  expect(await g.queued([g.rowOf(row)])).toMatchObject(wait());
  await vi.waitFor(() => expect(f.threads.rows).toHaveLength(0));
  await vi.waitFor(() => expect(f.harness.recheckCount).toBe(rechecks + 1));
  // The re-attempt finds nothing to deliver; the pause and the card state are untouched, and no occurrence opens again.
  expect(pauses(f)).toBe(1);
  await f.service.drain();
  expect(f.occurrences()).toHaveLength(0);
  expect(f.threads.rows).toHaveLength(0);
  await f.dispose();
});

it("holds a reminder-only group while its deletion fails, with growing waits, then deletes it", async () => {
  const f = setup();
  const { task, row } = await reminded(f);
  const g = gate(f);
  const warn = vi.spyOn(f.bb.log, "warn");
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  f.threads.deleteFail = true;
  const waits: number[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const decision = await g.queued([g.rowOf(row)]);
    expect(decision).toMatchObject(wait());
    waits.push(Math.round(delay(decision) / 1000));
    await vi.waitFor(() => expect(f.threads.deletes).toBe(attempt));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(attempt));
  }
  expect(waits.map((seconds) => Math.round(seconds / 5) * 5)).toEqual([5, 30, 300, 1800, 1800]);
  expect(warn.mock.calls[0]![0]).toMatch(/^stale_reminder_delete_failed card=\S+ thread=thr_example/);
  expect(f.threads.rows).toHaveLength(1);
  f.threads.deleteFail = false;
  await g.queued([g.rowOf(row)]);
  await vi.waitFor(() => expect(f.threads.rows).toHaveLength(0));
  await f.dispose();
});

it.each(["start-turn", "join-turn"] as const)("drops only the stale reminder from a group with a user row (%s) and delivers the user row", async (attempt) => {
  const f = setup();
  const { task, row } = await reminded(f);
  const g = gate(f);
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  const user = g.user();
  const rechecks = f.harness.recheckCount;
  const decision = await g.queued([g.rowOf(row), g.rowOf(user)], attempt);
  expect(decision).toMatchObject(wait());
  expect(Math.round(delay(decision) / 1000)).toBe(5);
  await vi.waitFor(() => expect(f.harness.recheckCount).toBe(rechecks + 1));
  expect(f.threads.rows.map((candidate) => candidate.id)).toEqual([user.id]);
  expect(pauses(f)).toBe(1);
  // The re-attempt carries the user row alone.
  expect(await g.queued([g.rowOf(user)], attempt)).toEqual({ action: "proceed" });
  expect(pauses(f)).toBe(attempt === "start-turn" ? 0 : 1);
  if (attempt === "start-turn") expect(lastEnd(f)).toEqual({ end_reason: "turn_started" });
  await f.dispose();
});

it.each(["start-turn", "join-turn"] as const)("never proceeds while a stale reminder cannot be deleted from a group with real input (%s)", async (attempt) => {
  const f = setup();
  const { task, row } = await reminded(f);
  const g = gate(f);
  const warn = vi.spyOn(f.bb.log, "warn");
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  const user = g.user();
  f.threads.deleteFail = true;
  const waits: number[] = [];
  for (let n = 1; n <= 3; n++) {
    const decision = await g.queued([g.rowOf(row), g.rowOf(user)], attempt);
    expect(decision).toMatchObject(wait());
    waits.push(Math.round(delay(decision) / 5000) * 5);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(n));
  }
  expect(waits).toEqual([5, 30, 30]);
  expect(pauses(f)).toBe(1);
  f.threads.deleteFail = false;
  await g.queued([g.rowOf(row), g.rowOf(user)], attempt);
  await vi.waitFor(() => expect(f.threads.rows.map((candidate) => candidate.id)).toEqual([user.id]));
  expect(await g.queued([g.rowOf(user)], attempt)).toEqual({ action: "proceed" });
  await f.dispose();
});

it("lets a valid reminder through without ending any pause on the thread's cards", async () => {
  const f = setup();
  const { row } = await reminded(f);
  const g = gate(f);
  const other = f.card("Other");
  f.store.tasks.upsertTaskThread({ taskId: other.id, threadId: THREAD, title: "Worker", presetName: "Agent", liveStatus: "idle" });
  startManualPause(f.db, other.id, "Waiting", 60_000, "thr_example");
  expect(await g.queued([g.rowOf(row)])).toEqual({ action: "proceed" });
  expect(await g.inline(row.content[0]!.text, "work-board")).toEqual({ action: "proceed" });
  expect(pauses(f)).toBe(1);
  await f.dispose();
});

it("removes only the stale reminder of two cards and lets the valid one through", async () => {
  const f = setup();
  const first = await reminded(f, "First");
  const second = f.card("Second");
  f.store.tasks.upsertTaskThread({ taskId: second.id, threadId: THREAD, title: "Worker", presetName: "Agent", liveStatus: "idle" });
  f.makeEligible();
  await f.service.drain();
  const rows = f.threads.rows.filter((candidate) => candidate.content[0]!.text.includes("work-board-executor:"));
  expect(rows).toHaveLength(2);
  const g = gate(f);
  startManualPause(f.db, first.task.id, "Waiting", 60_000, "thr_example");
  const stale = rows.find((candidate) => candidate.id === first.row.id)!;
  const valid = rows.find((candidate) => candidate.id !== first.row.id)!;
  const rechecks = f.harness.recheckCount;
  expect(await g.queued([g.rowOf(stale), g.rowOf(valid)])).toMatchObject(wait());
  await vi.waitFor(() => expect(f.harness.recheckCount).toBe(rechecks + 1));
  expect(f.threads.rows.filter((candidate) => candidate.threadId === THREAD).map((candidate) => candidate.id)).toEqual([valid.id]);
  expect(await g.queued([g.rowOf(valid)])).toEqual({ action: "proceed" });
  expect(pauses(f)).toBe(1);
  await f.dispose();
});

it("rejects an inline reminder whose card was paused in between", async () => {
  const f = setup();
  const { task, row } = await reminded(f);
  const g = gate(f);
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  expect(await g.inline(row.content[0]!.text, "work-board")).toEqual({ action: "reject", message: expect.stringContaining("stale reminder") });
  expect(pauses(f)).toBe(1);
  await f.dispose();
});

it("treats a reminder as stale when its card is paused with the occurrence still open, closed or archived", async () => {
  const f = setup();
  const { task, row } = await reminded(f);
  const g = gate(f);
  const body = row.content[0]!.text;
  const reject = expect.objectContaining({ action: "reject" });
  f.db.prepare("INSERT INTO task_pauses(id,task_id,source,signal,thread_id,reason,started_at,until,applied) VALUES ('p1',?,'manual','manual','thr_example','x',?,?,1)").run(task.id, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  expect(await g.inline(body, "work-board")).toEqual(reject);
  f.db.prepare("DELETE FROM task_pauses").run();
  expect(await g.inline(body, "work-board")).toEqual({ action: "proceed" });
  f.db.prepare("UPDATE tasks SET archived_at=? WHERE id=?").run(new Date().toISOString(), task.id);
  expect(await g.inline(body, "work-board")).toEqual(reject);
  f.db.prepare("UPDATE tasks SET archived_at=NULL, status='done' WHERE id=?").run(task.id);
  expect(await g.inline(body, "work-board")).toEqual(reject);
  await f.dispose();
});

it.each([
  ["a user message", { origin: null as string | null, sender: null as string | null }],
  ["a manager's thread tell", { origin: null, sender: "thr_manager" }],
  ["an Agent Hub answer", { origin: "agent-hub", sender: null }],
])("ends the pauses of the thread's cards when %s starts a turn, inline or queued, but not when it joins one", async (_name, { origin, sender }) => {
  const f = setup();
  const { task } = await reminded(f);
  const g = gate(f);
  const start = () => startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  start();
  expect(await g.inline("hello", origin, "join-turn", sender)).toEqual({ action: "proceed" });
  expect(pauses(f)).toBe(1);
  expect(await g.inline("hello", origin, "start-turn", sender)).toEqual({ action: "proceed" });
  expect(pauses(f)).toBe(0);
  expect(lastEnd(f)).toEqual({ end_reason: "turn_started" });
  start();
  const row = f.threads.addRow(THREAD, "hello", origin ?? "user-origin");
  expect(await g.queued([g.rowOf(row, sender)])).toEqual({ action: "proceed" });
  expect(pauses(f)).toBe(0);
  await f.dispose();
});

it("a turn that starts without admitted input, and a thread.active event, end no pause", async () => {
  const f = setup();
  const { task } = await reminded(f);
  await registerLifecycle(f.bb, f.store);
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  await f.harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: THREAD, status: "active" }) });
  f.store.tasks.updateTaskThreadStatus(f.store.tasks.listTaskThreads(task.id)[0]!.id, "working");
  expect(pauses(f)).toBe(1);
  await f.dispose();
});

it("the busy-executor sequence ends with the pause kept and no new occurrence", async () => {
  const f = setup();
  const { task, row } = await reminded(f);
  const g = gate(f);
  // The agent pauses the card in the turn the reminder waits behind; the thread then goes idle and bb drains the row.
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  await g.queued([g.rowOf(row)]);
  await vi.waitFor(() => expect(f.threads.rows).toHaveLength(0));
  await f.service.drain();
  f.makeEligible();
  await f.service.drain();
  expect(pauses(f)).toBe(1);
  expect(f.occurrences(true).filter((occurrence) => !occurrence.cleared_at)).toHaveLength(0);
  expect(f.threads.rows).toHaveLength(0);
  await f.dispose();
});

it("keeps a reminder as its own queue row and merges nothing into it", async () => {
  const f = setup();
  await goLive(f);
  const other = f.threads.addRow(THREAD, "[bb message from plugin:work-board]\n\nearlier notice");
  const task = f.card("Example");
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: THREAD, title: "Worker", presetName: "Agent", liveStatus: "idle" });
  f.harness.sdk.stub("threads.list", async () => [{ ...makeThreadResponse({ id: THREAD, status: "idle" }), activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 } }]);
  setPauseMode(f.db, f.tracker.id, "on");
  f.makeEligible();
  await f.service.drain();
  expect(f.threads.rows).toHaveLength(2);
  expect(f.threads.updates).toBe(0);
  expect(f.threads.rows[0]!.id).toBe(other.id);
  expect(f.threads.rows[1]!.content[0]!.text).toContain("If the card is already paused, nothing is needed.");
  await notifyThread(f.bb, THREAD, "later notice");
  expect(f.threads.updates).toBe(0);
  expect(f.threads.rows).toHaveLength(3);
  await f.dispose();
});

it("generates no reminder while the card is paused", async () => {
  const f = setup();
  await goLive(f);
  const task = f.card("Example");
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: THREAD, title: "Worker", presetName: "Agent", liveStatus: "idle" });
  setPauseMode(f.db, f.tracker.id, "on");
  startManualPause(f.db, task.id, "Waiting", 60_000, "thr_example");
  f.makeEligible();
  await f.service.drain();
  expect(f.occurrences()).toHaveLength(0);
  expect(f.threads.rows).toHaveLength(0);
  await f.dispose();
});

it("holds an attempt carrying a reminder when the gate cannot read its database, and lets others through", async () => {
  const f = setup();
  const { row } = await reminded(f);
  const g = gate(f);
  const user = g.user();
  const prepare = vi.spyOn(f.db, "prepare").mockImplementation(() => { throw new Error("database is locked"); });
  try {
    expect(await g.queued([g.rowOf(row), g.rowOf(user)])).toMatchObject(wait("Work Board cannot check a reminder"));
    expect(await g.queued([g.rowOf(user)])).toEqual({ action: "proceed" });
    expect(await g.inline("hello", null)).toEqual({ action: "proceed" });
  } finally { prepare.mockRestore(); }
  await f.dispose();
});
