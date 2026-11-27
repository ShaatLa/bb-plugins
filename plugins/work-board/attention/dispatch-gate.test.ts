import { expect, it, vi } from "vitest";
import { makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { registerLifecycle } from "../lifecycle";
import { setPauseMode, startManualPause } from "../pause/store";
import { notifyThread } from "../steer";
import { goLive, setup } from "./fixtures";
import { registerDispatchGate } from "./dispatch-gate";
import { syncCapacityWaits } from "./capacity-wait";

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

async function managerBatch(f: Fixture, count = 1) {
  await goLive(f);
  const cards = Array.from({ length: count }, (_, n) => f.card(`Card ${n}`));
  f.makeEligible();
  await f.service.drain();
  const row = f.threads.rows.find(r => r.threadId === "thr_manager" && r.content[0]!.text.includes("work-board-attention:"))!;
  expect(row).toBeDefined();
  return { cards, row };
}

it("rechecks every dispatch and withdraws a mixed batch when a card clears", async () => {
  const f = setup();
  const { cards, row } = await managerBatch(f, 2);
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const context = makeMessageDispatchHookContext({ thread: { id: "thr_manager" }, queuedMessages: [{ id: row.id, content: text(row.content[0]!.text), originPluginId: "work-board", senderThreadId: null }] });
  expect(await hook(context)).toMatchObject({ action: "wait", reason: "checking linked sessions" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(0));
  expect(await hook(context)).toEqual({ action: "proceed" });
  f.store.tasks.updateTask(cards[0]!.id, { status: "done" });
  const before = f.harness.recheckCount;
  expect(await hook(context)).toMatchObject({ action: "wait", reason: "checking linked sessions" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(before));
  expect(await hook(context)).toMatchObject({ action: "wait", reason: "removing a stale Work Board notice" });
  await vi.waitFor(() => expect(f.threads.rows).not.toContain(row));
  expect(f.db.prepare("SELECT state FROM attention_withdrawals").all()).toEqual([{ state: "done" }, { state: "done" }]);
  await f.service.drain();
  expect(f.threads.rows.some(r => r.threadId === "thr_manager" && r.content[0]!.text.includes(cards[1]!.key))).toBe(true);
  await f.dispose();
});

it("rejects a stale inline batch after a freshness check", async () => {
  const f = setup();
  const { cards, row } = await managerBatch(f);
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const context = makeMessageDispatchHookContext({ thread: { id: "thr_manager" }, input: { text: row.content[0]!.text }, originPluginId: "work-board" });
  f.store.tasks.updateTask(cards[0]!.id, { status: "done" });
  const before = f.harness.recheckCount;
  expect(await hook(context)).toMatchObject({ action: "wait" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(before));
  expect(await hook(context)).toMatchObject({ action: "reject" });
  await f.dispose();
});

it("keeps a stale batch waiting when deletion fails, even if its pause ends", async () => {
  const f = setup();
  const { cards, row } = await managerBatch(f);
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const context = makeMessageDispatchHookContext({ thread: { id: "thr_manager" }, queuedMessages: [{ id: row.id, content: text(row.content[0]!.text), originPluginId: "work-board", senderThreadId: null }] });
  startManualPause(f.db, cards[0]!.id, "Waiting", 60_000, "thr_example");
  f.threads.deleteFail = true;
  expect(await hook(context)).toMatchObject({ action: "wait" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(0));
  expect(await hook(context)).toMatchObject({ action: "wait", reason: "removing a stale Work Board notice" });
  await vi.waitFor(() => expect(f.threads.deletes).toBe(1));
  expect(f.db.prepare("SELECT state FROM attention_withdrawals").all()).toEqual([{ state: "pending" }]);
  f.db.prepare("UPDATE task_pauses SET applied=0").run();
  const before = f.harness.recheckCount;
  expect(await hook(context)).toMatchObject({ action: "wait" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(before));
  expect(await hook(context)).toMatchObject({ action: "wait", reason: "removing a stale Work Board notice" });
  await vi.waitFor(() => expect(f.threads.deletes).toBe(2));
  f.threads.deleteFail = false;
  await f.service.recover(f.tracker.id);
  expect(f.threads.rows).not.toContain(row);
  expect(f.db.prepare("SELECT state FROM attention_withdrawals").all()).toEqual([{ state: "done" }]);
  await f.dispose();
});

it("fails toward notification when a freshness read fails", async () => {
  const f = setup();
  const { cards, row } = await managerBatch(f);
  f.store.tasks.upsertTaskThread({ taskId: cards[0]!.id, threadId: "thr_worker", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  f.harness.sdk.stub("threads.list", async () => { throw new Error("offline"); });
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const context = makeMessageDispatchHookContext({ thread: { id: "thr_manager" }, queuedMessages: [{ id: row.id, content: text(row.content[0]!.text), originPluginId: "work-board", senderThreadId: null }] });
  const before = f.harness.recheckCount;
  expect(await hook(context)).toMatchObject({ action: "wait" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(before));
  expect(await hook(context)).toEqual({ action: "proceed" });
  await f.dispose();
});

it("withdraws when a linked session begins waiting just before delivery", async () => {
  const f = setup();
  const { cards, row } = await managerBatch(f);
  f.store.tasks.upsertTaskThread({ taskId: cards[0]!.id, threadId: "thr_worker", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  let waiting = false;
  f.harness.sdk.stub("threads.list", async () => [makeThreadResponse({ id: "thr_worker", status: "idle", queuedWork: waiting ? "waiting" : "none" } as never)] as never);
  f.harness.sdk.stub("threads.queuedMessages.list", async ({ threadId }) => threadId === "thr_worker" ? [{ state: "waiting", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } }] as never : f.threads.rows.filter(r => r.threadId === threadId) as never);
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const context = makeMessageDispatchHookContext({ thread: { id: "thr_manager" }, queuedMessages: [{ id: row.id, content: text(row.content[0]!.text), originPluginId: "work-board", senderThreadId: null }] });
  const before = f.harness.recheckCount;
  expect(await hook(context)).toMatchObject({ action: "wait" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(before));
  expect(await hook(context)).toEqual({ action: "proceed" });
  waiting = true;
  const second = f.harness.recheckCount;
  expect(await hook(context)).toMatchObject({ action: "wait", reason: "checking linked sessions" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(second));
  expect(f.occurrences()).toHaveLength(0);
  expect(await hook(context)).toMatchObject({ action: "wait", reason: "removing a stale Work Board notice" });
  await vi.waitFor(() => expect(f.threads.rows).not.toContain(row));
  await f.dispose();
});

it.each(["missing", "delivered", "unreadable"] as const)("recovers a pending withdrawal whose message is %s", async mode => {
  const f = setup();
  const { row } = await managerBatch(f);
  const attempt = f.attempts().find(a => a.batch_id && row.content[0]!.text.includes(a.batch_id));
  const ids = f.db.prepare<[string], { occurrence_id: string }>("SELECT occurrence_id FROM attention_attempt_items WHERE attempt_id=?").all(attempt.attempt_id);
  for (const id of ids) f.db.prepare("INSERT INTO attention_withdrawals VALUES (?,?,'pending',?,'stale batch')").run(attempt.attempt_id, id.occurrence_id, new Date().toISOString());
  if (mode === "delivered") f.threads.dispatchRow(row);
  else f.threads.rows.splice(f.threads.rows.indexOf(row), 1);
  if (mode === "unreadable") f.threads.eventsFail = true;
  await f.service.recover(f.tracker.id);
  const rows = f.db.prepare("SELECT state FROM attention_withdrawals").all();
  expect(rows).toEqual(mode === "delivered" ? [] : [{ state: mode === "missing" ? "done" : "pending" }]);
  if (mode === "missing") {
    await f.service.drain();
    expect(f.threads.rows.some(r => r.threadId === "thr_manager")).toBe(true);
  }
  await f.dispose();
});

it.each(["failed", "archived"] as const)("a pending lifecycle thread prevents a notice until it is %s", async terminal => {
  const f = setup();
  await goLive(f);
  await registerLifecycle(f.bb, f.store);
  const task = f.card("Pending");
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  const pending = makeThreadResponse({ id: "thr_worker", status: "pending" });
  await f.harness.emitThreadEvent("thread.created", { thread: pending });
  expect(f.occurrences()).toHaveLength(0);
  f.makeEligible();
  await f.service.drain();
  expect(f.threads.rows.filter(r => r.threadId === "thr_manager")).toHaveLength(0);
  if (terminal === "failed") await f.harness.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_worker", status: "error" }), error: "failed" });
  else {
    f.threads.threads.set("thr_worker", { archived: true });
    await f.harness.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_worker", status: "pending", archivedAt: 1 } as never) });
  }
  expect(f.occurrences().some(o => o.signal === "no_active_thread")).toBe(true);
  await f.dispose();
});

it("does not restore a link archived while the capacity read is in flight", async () => {
  const f = setup();
  await goLive(f);
  await registerLifecycle(f.bb, f.store);
  const task = f.card("Example");
  const link = f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_worker", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.harness.sdk.stub("threads.list", async () => { await barrier; return [makeThreadResponse({ id: "thr_worker", status: "idle", queuedWork: "waiting" } as never)] as never; });
  f.harness.sdk.stub("threads.queuedMessages.list", async () => [{ state: "waiting", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } }] as never);
  const pass = syncCapacityWaits(f.bb, f.store.tasks);
  f.threads.threads.set("thr_worker", { archived: true });
  await f.harness.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: "thr_worker", status: "idle", archivedAt: 1 } as never) });
  release();
  await pass;
  expect(f.store.tasks.getTaskThread(link.id)).toBeUndefined();
  expect(f.occurrences().some(o => o.signal === "no_active_thread")).toBe(true);
  await f.dispose();
});

it("withdraws an entirely stale multi-card batch without reclaiming any card", async () => {
  const f = setup();
  const { cards, row } = await managerBatch(f, 2);
  for (const card of cards) f.store.tasks.updateTask(card.id, { status: "done" });
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const ctx = makeMessageDispatchHookContext({ thread: { id: "thr_manager" }, queuedMessages: [{ id: row.id, content: text(row.content[0]!.text), originPluginId: "work-board", senderThreadId: null }] });
  expect(await hook(ctx)).toMatchObject({ action: "wait" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(0));
  expect(await hook(ctx)).toMatchObject({ action: "wait", reason: "removing a stale Work Board notice" });
  await vi.waitFor(() => expect(f.threads.rows).not.toContain(row));
  expect(f.db.prepare("SELECT state FROM attention_withdrawals").all()).toEqual([{ state: "done" }, { state: "done" }]);
  await f.service.drain();
  expect(f.threads.rows.filter(r => r.threadId === "thr_manager")).toHaveLength(0);
  await f.dispose();
});

it("does not reuse a single-batch proof for a dispatch with two batches", async () => {
  const f = setup();
  const { cards, row } = await managerBatch(f);
  f.store.tasks.upsertTaskThread({ taskId: cards[0]!.id, threadId: "thr_worker", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  f.threads.dispatchRow(row);
  f.card("Second");
  f.makeEligible();
  await f.service.drain();
  const second = f.threads.rows.find(r => r.threadId === "thr_manager" && r.id !== row.id)!;
  expect(second).toBeDefined();
  let waiting = false;
  let release!: () => void;
  let block = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.harness.sdk.stub("threads.list", async () => { if (block) await barrier; return [makeThreadResponse({ id: "thr_worker", status: "idle", queuedWork: waiting ? "waiting" : "none" } as never)] as never; });
  f.harness.sdk.stub("threads.queuedMessages.list", async () => [{ state: "waiting", waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "full" } }] as never);
  registerDispatchGate(f.bb);
  const hook = f.harness.registrations.hooks["message.dispatch"]!;
  const item = (r: typeof row) => ({ id: r.id, content: text(r.content[0]!.text), originPluginId: "work-board", senderThreadId: null });
  const context = (rows: typeof row[]) => makeMessageDispatchHookContext({ thread: { id: "thr_manager" }, queuedMessages: rows.map(item) });
  expect(await hook(context([row]))).toMatchObject({ action: "wait" });
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(0));
  block = true;
  expect(await hook(context([row, second]))).toMatchObject({ action: "wait", reason: "checking linked sessions" });
  waiting = true;
  release();
  await vi.waitFor(() => expect(f.harness.recheckCount).toBeGreaterThan(1));
  expect(await hook(context([row, second]))).toMatchObject({ action: "wait", reason: "removing a stale Work Board notice" });
  await vi.waitFor(() => expect(f.threads.rows).not.toContain(row));
  await f.dispose();
});
