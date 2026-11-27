import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema, methods, type Proposal } from "./contract";
import { createStore, effectId, versionOne } from "./store";
import { createSweep, measureCommand, type Transport } from "./sweep";
import { createWorkBoard, type workBoardApi } from "./work-board";
import { minute, occurrence, timeOn } from "./time";

const projectId = "proj_example", manager = "thr_example", other = "thr_other";
const database: Database.Database[] = [];
afterEach(() => { for (const db of database.splice(0)) db.close(); });
const metric = { definition: "Count missed checks", unit: "checks", baseline: 2, target: 0 };
function setup() {
  let clock = Date.parse("2026-10-30T12:00:00Z");
  const db = new Database(":memory:");
  database.push(db);
  db.exec(versionOne);
  const store = createStore(db, () => clock);
  store.setConfig(projectId, "managers", [manager, other]);
  store.setConfig(projectId, "defaultManager", manager);
  store.setConfig(projectId, "enabled", true);
  store.setConfig(projectId, "graceMinutes", 1);
  const add = (fields: Partial<Proposal> = {}) => store.addEntry(methods["entry.add"].input.parse({
    projectId, title: "Skipped check", failure: "One check was skipped", gap: "The checklist had no owner",
    proposal: { title: "Assign an owner", hypothesis: "Assignment prevents missed checks",
      deadlineAt: clock + 1 * minute, metric, rollbackCondition: "The owner cannot take the check", ...fields },
  }), manager).proposal!;
  const ref = (p: Proposal) => ({ projectId, proposalId: p.id, revision: p.revision });
  const measuring = (p: Proposal, checkAt = clock + minute, deadlineAt = clock + 8 * minute) => {
    const applied = store.transition({ ...ref(p), transition: { state: "applied", reason: "Fix deployed", deadlineAt } }, manager);
    return store.transition({ ...ref(applied), transition: { state: "measuring", reason: "Check results", checkAt, deadlineAt } }, manager);
  };
  return { db, store, add, ref, measuring, advance: (ms: number) => { clock += ms; }, setTime: (ms: number) => { clock = ms; } };
}
function transport(overrides: Partial<Transport> = {}) {
  return { send: vi.fn<Transport["send"]>().mockResolvedValue("sent"),
    measure: vi.fn<Transport["measure"]>().mockResolvedValue(0),
    notice: vi.fn<Transport["notice"]>().mockResolvedValue("notice_example"), ...overrides };
}

it("checks lifecycle, revision, project scope, secret guards and rollback evidence", () => {
  const { store, add, ref, measuring } = setup();
  const initial = add({ links: ["https://example.com/fix"] });
  expect(() => store.proposal("proj_other", initial.id)).toThrow("does not exist");
  expect(() => store.transition({ ...ref(initial), transition: { state: "kept", reason: "Pass" } }, manager)).toThrow("Cannot move");
  const p = measuring(initial);
  expect(() => store.transition({ ...ref(p), transition: { state: "kept", reason: "Pass" } }, manager)).toThrow("Record a measurement");
  expect(() => store.comment(projectId, p.id, manager, "comment", "-----BEGIN PRIVATE KEY-----")).toThrow("detected");
  const observed = store.measure({ ...ref(p), observation: { value: 0, note: "**Verified**" } }, manager);
  expect(() => store.transition({ ...ref(p), transition: { state: "kept", reason: "Pass" } }, "Owner")).toThrow("changed");
  const kept = store.transition({ ...ref(observed), transition: { state: "kept", reason: "Pass" } }, "Owner");
  expect(kept.deadlineAt).toBe(store.now());
  expect(kept.state).toBe("kept");
  expect(() => store.comment(projectId, kept.id, manager, "rollback", "Rolled back")).toThrow("reverted");

  const otherProposal = measuring(add());
  const reverted = store.transition({ ...ref(otherProposal), transition: { state: "reverted", reason: "Unusable", override: true } }, "Owner");
  expect(store.events(projectId, reverted.id).events[0]?.message).toContain("Urgent rollback decision");
  expect(store.comment(projectId, reverted.id, manager, "rollback", "Restored original checklist").kind).toBe("rollback");
});

it("reassigns an overdue proposal, preserves its links, and ignores effects for the previous manager", async () => {
  const { store, ref, add, advance } = setup();
  const p = add({ links: ["https://example.com/fix"] });
  const wire = transport();
  const sweep = createSweep(store, wire);
  advance(2 * minute);
  store.queue(projectId, p.id, p.obligation, "wake", store.now(), "decision");
  const next = store.update(methods["proposal.update"].input.parse({ ...ref(p), patch: { managerId: other } }), "Owner");
  expect(next.links).toEqual(p.links);
  expect(next.deadlineAt).toBe(p.deadlineAt);
  expect(store.list(methods.list.input.parse({ projectId, managerId: manager })).items).toHaveLength(0);
  expect(store.list(methods.list.input.parse({ projectId, managerId: other })).items).toHaveLength(1);
  await sweep.sweep();
  await sweep.sweep();
  expect(wire.send).toHaveBeenCalledTimes(2);
  expect(wire.send).toHaveBeenCalledWith(projectId, other, expect.stringContaining("deadline"), expect.any(Function));
  expect(wire.send).not.toHaveBeenCalledWith(projectId, manager, expect.anything(), expect.any(Function));
});

it("records exactly one script observation and asks for manual measurement after failure or interruption", async () => {
  const { store, add, measuring, advance } = setup();
  const p = measuring(add({ metric: { ...metric, command: "count" } }));
  const wire = transport();
  vi.mocked(wire.measure).mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("sensitive stdout"));
  const sweep = createSweep(store, wire);
  advance(minute);
  expect(store.digest(projectId).overdue).toBe(1);
  await Promise.all([sweep.sweep(), sweep.sweep()]);
  expect(store.digest(projectId).overdue).toBe(0);
  expect(wire.measure).toHaveBeenCalledTimes(1);
  expect(store.events(projectId, p.id).events.find(e => e.observation)?.observation).toEqual({ value: 0 });
  const fail = measuring(add({ metric: { ...metric, command: "count" } }));
  const interrupted = measuring(add({ metric: { ...metric, command: "count" } }));
  advance(minute);
  const effect = store.queue(projectId, interrupted.id, interrupted.obligation, "metric", store.now(), "check");
  store.claim(effect.id);
  createSweep(store, wire).recovery();
  await sweep.sweep();
  await sweep.sweep();
  expect(wire.measure).toHaveBeenCalledTimes(2);
  expect(wire.send).toHaveBeenCalledTimes(2);
  expect(store.events(projectId, fail.id).events.map(e => e.message).join()).not.toContain("sensitive stdout");
  expect(store.effect(effect.id)?.status).toBe("uncertain");
});

it("wakes, escalates in order, preserves acknowledgment, and retries a notice with the same key", async () => {
  const { store, add, advance } = setup();
  const p = add();
  const wire = transport();
  const sweep = createSweep(store, wire);
  advance(3 * minute);
  await sweep.sweep();
  expect(vi.mocked(wire.send).mock.calls.map(call => call[2].split("\n")[0])).toEqual([
    expect.stringContaining("deadline has arrived"), expect.stringContaining("is overdue"), expect.stringContaining("remains overdue"),
  ]);
  const requestId = effectId(projectId, p.id, p.obligation, "ownerAsk", "decision");
  const ack = { projectId, proposalId: p.id, effectId: requestId, questionId: "question_example" };
  expect(store.ack(ack, manager)).toEqual(store.ack(ack, manager));
  advance(minute);
  await sweep.sweep();
  expect(wire.notice).not.toHaveBeenCalled();

  const unserved = add();
  vi.mocked(wire.send).mockResolvedValue("unreachable");
  vi.mocked(wire.notice).mockRejectedValueOnce(new Error("response lost"));
  advance(minute);
  await sweep.sweep();
  await sweep.sweep();
  advance(3 * minute);
  await sweep.sweep();
  const noticeId = effectId(projectId, unserved.id, unserved.obligation, "ownerNotice", "decision");
  expect(vi.mocked(wire.notice).mock.calls.filter(([input]) => input.tickId === noticeId)).toHaveLength(2);
  expect(store.events(projectId, unserved.id).events.some(e => e.kind === "owner-notice")).toBe(true);
});

it("runs a bounded numeric command and rejects nonnumeric output", async () => {
  const catalog = JSON.stringify({ valid: { file: "/usr/bin/printf", cwd: "/tmp", args: ["0.5"] },
    invalid: { file: "/usr/bin/printf", cwd: "/tmp", args: ["**not numeric**"] } });
  await expect(measureCommand(catalog, "valid")).resolves.toBe(0.5);
  await expect(measureCommand(catalog, "invalid")).rejects.toThrow("finite number");
  await expect(measureCommand(catalog, "missing")).rejects.toThrow("not configured");
});

it("dispatches one review per local date, catches up and deduplicates submissions and acknowledgments", async () => {
  const { store, setTime, advance } = setup();
  store.setConfig(projectId, "timeZone", "America/New_York");
  store.setConfig(projectId, "scheduleTime", "01:30");
  store.setConfig(projectId, "scheduleSkill", "example-review");
  store.setConfig(projectId, "scheduleEnabled", true);
  const wire = transport();
  const list = () => store.listRuns(methods["run.list"].input.parse({ projectId })).items;
  const sweep = createSweep(store, wire);
  setTime(Date.parse("2026-11-01T05:30:00Z"));
  await sweep.sweep();
  expect(list()[0]?.occurrence).toBe("2026-11-01");
  const runId = list()[0]!.id;
  const args = methods["entry.add"].input.parse({ projectId, key: "example", runId, title: "Skipped check", failure: "Skipped",
    gap: "No owner", proposal: { title: "Assign owner", hypothesis: "Owner handles it", rollbackCondition: "Too slow", metric,
      deadlineAt: store.now() + minute } });
  expect(store.addEntry(args, manager)).toEqual(store.addEntry(args, manager));
  expect(() => store.addEntry(args, other)).toThrow("Only the scheduled manager");
  expect(store.finishRun({ projectId, runId, status: "completed" }, manager)).toEqual(store.finishRun({ projectId, runId, status: "completed" }, manager));
  advance(60 * minute);
  await createSweep(store, wire).sweep();
  expect(vi.mocked(wire.send).mock.calls.filter(call => call[2].startsWith("Run the project skill"))).toHaveLength(1);
  setTime(Date.parse("2026-11-04T19:00:00Z"));
  await sweep.sweep();
  expect(list().map(run => run.occurrence)).toEqual(["2026-11-04", "2026-11-01"]);
  expect(timeOn("2026-03-08", "02:30", "America/New_York")).toBe(Date.parse("2026-03-08T07:00:00Z"));
  expect(occurrence(Date.parse("2026-03-08T06:59:00Z"), configSchema.parse({
    timeZone: "America/New_York", scheduleTime: "02:30",
  }))).toBe("2026-03-07");
});

it("limits history to three calendar months without deleting older proposals", () => {
  const { store, add, ref, setTime } = setup();
  store.setConfig(projectId, "timeZone", "America/New_York");
  setTime(Date.parse("2026-02-28T14:59:59Z"));
  const old = add();
  store.transition({ ...ref(old), transition: { state: "withdrawn", reason: "Duplicate" } }, manager);
  setTime(Date.parse("2026-02-28T15:00:00Z"));
  const recent = add();
  store.transition({ ...ref(recent), transition: { state: "withdrawn", reason: "Merged elsewhere" } }, manager);
  setTime(Date.parse("2026-05-31T14:00:00Z"));
  const i = methods.list.input.parse({ projectId, view: "history", range: "quarter" });
  expect(store.list(i).items.map(row => row.proposal.id)).toEqual([recent.id]);
  expect(store.proposal(projectId, old.id).state).toBe("withdrawn");
});

it("recovers a fix create after response loss and applies a proposal once on confirmed merge", async () => {
  const { store, add, ref } = setup();
  store.setConfig(projectId, "boardProject", "board_example");
  const p = add();
  const card = { projectId: "board_example", id: "task_example", key: "EXA-1", dueDate: null, status: "todo" };
  const create = vi.fn<ReturnType<typeof workBoardApi>["create"]>()
    .mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({ ok: true, task: card });
  const read = vi.fn().mockResolvedValue({ task: card });
  const prs = vi.fn().mockResolvedValueOnce({ pullRequests: [], unavailableThreadIds: [manager] })
    .mockResolvedValue({ pullRequests: [{ state: "merged", url: "https://example.com/pull/1" }], unavailableThreadIds: [] });
  const board = createWorkBoard(store, { create, task: read, byKey: read, pullRequests: prs,
    projects: vi.fn().mockResolvedValue({ projects: [{ id: card.projectId, linkedBbProjectId: projectId, workflowPolicy: { doneStatus: null } }] }),
    updateDue: vi.fn() });
  const request = { ...ref(p), key: "create-fix", deadlineSource: true };
  await expect(board.create(request, manager)).rejects.toThrow("response lost");
  expect((await board.create(request, manager)).taskId).toBe(card.id);
  expect((await board.create(request, manager)).taskId).toBe(card.id);
  expect(new Set(create.mock.calls.map(([i]) => i.idempotencyKey)).size).toBe(1);
  await board.reconcile(projectId, store.config(projectId));
  expect(store.proposal(projectId, p.id).state).toBe("proposed");
  expect(store.links(projectId, p.id)[0]?.status).toContain("unavailable");
  await board.reconcile(projectId, store.config(projectId));
  await board.reconcile(projectId, store.config(projectId));
  expect(store.proposal(projectId, p.id).state).toBe("applied");
  expect(store.events(projectId, p.id).events.filter(e => e.state === "applied")).toHaveLength(1);
});

it("records a guarded due-date conflict and accepts explicit reconciliation", async () => {
  const { store, add, ref, measuring } = setup();
  store.setConfig(projectId, "boardProject", "board_example");
  const p = measuring(add(), Date.parse("2026-11-02T09:00:00Z"), Date.parse("2026-11-09T09:00:00Z"));
  const card = { projectId: "board_example", id: "task_example", key: "EXA-1", dueDate: "2026-11-01", status: "done" };
  const read = vi.fn(async () => ({ task: { ...card } }));
  const updateDue = vi.fn(async (_id: string, expected: string | null, due: string | null) => {
    expect(expected).toBe("2026-11-01");
    expect(due).toBe("2026-11-02");
    card.dueDate = "2026-11-03";
    return { ok: false as const, error: { code: "due_date_conflict", currentDueDate: card.dueDate } };
  });
  const board = createWorkBoard(store, { create: vi.fn(), task: read, byKey: read, pullRequests: vi.fn(),
    projects: vi.fn().mockResolvedValue({ projects: [{ id: card.projectId }] }), updateDue });
  await board.linkExisting({ ...ref(p), deadlineSource: true, taskKey: card.key }, manager);
  await board.reconcile(projectId, store.config(projectId));
  expect(store.links(projectId, p.id)[0]).toMatchObject({ conflict: true, dueDate: "2026-11-03" });
  await board.reconcile(projectId, store.config(projectId));
  expect(updateDue).toHaveBeenCalledTimes(1);
  await board.resolve({ ...ref(p), taskId: card.id, prefer: "card" });
  expect(store.proposal(projectId, p.id).checkAt).toBe(Date.parse("2026-11-03T09:00:00Z"));
  expect(store.links(projectId, p.id)[0]?.conflict).toBe(false);
});

it.each(["proposed", "applied", "measuring"] as const)("allows withdrawal from %s and stops its pending wake-ups", async state => {
  const { store, ref, add, measuring, advance } = setup();
  expect(() => add({ deadlineAt: store.now() })).toThrow("future");
  const initial = add();
  const deadlineAt = store.now() + 8 * minute;
  const proposal = state === "proposed" ? initial : state === "measuring" ? measuring(initial) :
    store.transition({ ...ref(initial), transition: { state: "applied", deadlineAt, reason: "Fix deployed" } }, manager);
  if (state === "applied") {
    expect(() => store.transition({ ...ref(proposal), transition: {
      state: "measuring", reason: "Check", checkAt: deadlineAt, deadlineAt,
    } }, manager)).toThrow("before the decision deadline");
  }
  store.queue(projectId, proposal.id, proposal.obligation, "wake", proposal.deadlineAt, "decision");
  const withdrawn = store.transition({ ...ref(proposal), transition: { state: "withdrawn", reason: "Duplicate" } }, manager);
  expect(withdrawn.state).toBe("withdrawn");
  expect(() => store.update({ ...ref(withdrawn), patch: { deadlineAt } }, manager)).toThrow("Closed");
  const wire = transport();
  advance(20 * minute);
  await createSweep(store, wire).sweep();
  expect(wire.send).not.toHaveBeenCalled();
});

it("escalates the decision after resolving an escalated measurement check", async () => {
  const { store, ref, add, measuring, advance } = setup();
  const p = measuring(add());
  const wire = transport();
  const worker = createSweep(store, wire);
  advance(3 * minute);
  await worker.sweep();
  const key = (phase: "check" | "decision") => effectId(projectId, p.id, p.obligation, "ownerAsk", phase);
  const ack = { projectId, proposalId: p.id, effectId: key("check"), questionId: "question_example" };
  expect(() => store.ack(ack, other)).toThrow("responsible manager");
  expect(store.events(projectId, p.id).events.find(e => e.kind === "escalation")?.message).toContain(key("check"));
  store.measure({ ...ref(p), observation: { value: 0 } }, manager);
  expect(() => store.ack(ack, manager)).toThrow("obsolete");
  advance(7 * minute);
  await worker.sweep();
  const asks = vi.mocked(wire.send).mock.calls.map(call => call[2]).filter(body => body.includes("before calling agent_hub_ask"));
  expect(asks).toHaveLength(2);
  expect(asks[0]).toContain(key("check"));
  expect(asks[1]).toContain(key("decision"));
  expect(wire.notice).not.toHaveBeenCalled();
});

it("backs off retryable wakes, recovers uncertain sends, and rechecks an obsolete wake before delivery", async () => {
  const { store, ref, add, advance } = setup();
  const p = add();
  const wire = transport();
  vi.mocked(wire.send).mockResolvedValueOnce("retry");
  advance(minute);
  await createSweep(store, wire).sweep();
  const wake = effectId(projectId, p.id, p.obligation, "wake", "decision");
  expect(store.effect(wake)).toMatchObject({ status: "pending", next: store.now() + minute });
  advance(minute / 2);
  await createSweep(store, wire).sweep();
  expect(vi.mocked(wire.send).mock.calls.filter(call => call[2].includes(wake))).toHaveLength(1);
  advance(minute / 2);
  await createSweep(store, wire).sweep();
  expect(store.effect(wake)?.status).toBe("sent");

  const crashed = add();
  const inFlight = store.queue(projectId, crashed.id, crashed.obligation, "wake", crashed.deadlineAt, "decision");
  store.claim(inFlight.id);
  const restarted = createSweep(store, wire);
  restarted.recovery();
  expect(store.effect(inFlight.id)?.status).toBe("uncertain");
  expect(store.events(projectId, crashed.id).events[0]?.message).toContain(inFlight.id);

  const obsolete = add();
  advance(minute);
  const obsoleteWake = effectId(projectId, obsolete.id, obsolete.obligation, "wake", "decision");
  vi.mocked(wire.send).mockImplementation(async (_project, _manager, message, wanted) => {
    if (!message.includes(obsoleteWake)) return "sent";
    store.update({ ...ref(obsolete), patch: { deadlineAt: store.now() + 5 * minute } }, manager);
    expect(wanted()).toBe(false);
    return "obsolete";
  });
  await restarted.sweep();
  expect(store.effect(obsoleteWake)?.status).toBe("failed");
  expect(vi.mocked(wire.send).mock.calls.some(call => call[2].includes(inFlight.id))).toBe(false);
});

it("keeps observations and concurrent edits when a Work Board date changes", async () => {
  const { store, add, ref, measuring } = setup();
  store.setConfig(projectId, "boardProject", "board_example");
  const p = measuring(add(), Date.parse("2026-11-02T09:00:00Z"), Date.parse("2026-11-09T09:00:00Z"));
  let card = { projectId: "board_example", id: "task_example", key: "EXA-1", dueDate: "2026-11-01", status: "done" };
  const byKey = vi.fn(async () => ({ task: { ...card } }));
  const task = vi.fn(async () => ({ task: { ...card } }));
  const updateDue = vi.fn<ReturnType<typeof workBoardApi>["updateDue"]>(async (_id, expected, due) => {
    expect(expected).toBe("2026-11-01");
    card = { ...card, dueDate: due! };
    return { ok: true, task: { ...card } };
  });
  const board = createWorkBoard(store, { create: vi.fn(), task, byKey, pullRequests: vi.fn(),
    projects: vi.fn().mockResolvedValue({ projects: [{ id: card.projectId }] }), updateDue });
  await board.linkExisting({ ...ref(p), taskKey: card.key, deadlineSource: true }, manager);
  await board.reconcile(projectId, store.config(projectId));
  expect(card.dueDate).toBe("2026-11-02");

  card.dueDate = "2026-11-03";
  task.mockImplementationOnce(async () => {
    const measured = store.measure({ ...ref(p), observation: { value: 0 } }, manager);
    store.update({ ...ref(measured), patch: { title: "An updated proposal title" } }, manager);
    return { task: { ...card } };
  });
  await board.reconcile(projectId, store.config(projectId));
  const edit = store.proposal(projectId, p.id);
  expect(edit).toMatchObject({ checkAt: Date.parse("2026-11-03T09:00:00Z"), title: "An updated proposal title", revision: p.revision + 3 });
  expect(store.measured(projectId, p.id)).toBe(true);
  expect(store.transition({ ...ref(edit), transition: { state: "kept", reason: "Observed target" } }, "BB client").state).toBe("kept");
});

it("uses the mapped Done status, keeps applied proposals on reopen, and rejects invalid links", async () => {
  const { store, add, ref } = setup();
  store.setConfig(projectId, "boardProject", "board_example");
  const p = add();
  const card = { projectId: "board_example", id: "task_example", key: "EXA-1", dueDate: null, status: "complete" };
  const task = vi.fn(async () => ({ task: { ...card } }));
  const byKey = vi.fn(async () => ({ task: { ...card } }));
  byKey.mockResolvedValueOnce({ task: { ...card, projectId: "board_other" } });
  const board = createWorkBoard(store, { create: vi.fn(), task, byKey,
    pullRequests: vi.fn().mockResolvedValue({ pullRequests: [], unavailableThreadIds: [] }),
    projects: vi.fn().mockResolvedValue({ projects: [{ id: card.projectId, workflowPolicy: { doneStatus: "complete" } }] }),
    updateDue: vi.fn() });
  const link = { ...ref(p), taskKey: card.key, deadlineSource: true };
  await expect(board.linkExisting(link, manager)).rejects.toThrow("outside");
  await board.linkExisting(link, manager);
  byKey.mockResolvedValueOnce({ task: { ...card, id: "task_other", key: "EXA-2" } });
  await expect(board.linkExisting({ ...link, taskKey: "EXA-2" }, manager)).rejects.toThrow("already has");
  await board.reconcile(projectId, store.config(projectId));
  expect(store.proposal(projectId, p.id).state).toBe("applied");
  card.status = "todo";
  await board.reconcile(projectId, store.config(projectId));
  expect(store.proposal(projectId, p.id).state).toBe("applied");
  expect(store.links(projectId, p.id)[0]?.status).toBe("todo");
});

it("skips occurrences covered at cutover and exposes an unfinished prior run without overlapping it", async () => {
  const { store, setTime } = setup();
  store.setConfig(projectId, "scheduleSkill", "example-review");
  store.setConfig(projectId, "scheduleCoveredThrough", "2026-10-30");
  store.setConfig(projectId, "scheduleEnabled", true);
  const wire = transport();
  const sweep = createSweep(store, wire);
  await sweep.sweep();
  expect(wire.send).not.toHaveBeenCalled();
  setTime(Date.parse("2026-10-31T02:00:00Z"));
  await sweep.sweep();
  const runs = () => store.listRuns(methods["run.list"].input.parse({ projectId })).items;
  expect(runs()[0]).toMatchObject({ occurrence: "2026-10-31", status: "sent", delayed: false });
  setTime(Date.parse("2026-11-01T02:00:00Z"));
  await createSweep(store, wire).sweep();
  expect(runs()).toHaveLength(1);
  expect(runs()[0]?.delayed).toBe(true);
  expect(() => store.finishRun({ projectId, runId: runs()[0]!.id, status: "failed" }, "BB client")).toThrow("manager thread");
  store.finishRun({ projectId, runId: runs()[0]!.id, status: "failed", note: "Previous manager stopped" }, "Local operator");
  await sweep.sweep();
  expect(runs().map(r => r.occurrence)).toEqual(["2026-11-01", "2026-10-31"]);
});

it("rejects command timeouts, oversized output, nonzero exits and relative executables", async () => {
  for (const settings of [
    { file: "/bin/sleep", cwd: "/tmp", args: ["4"], timeoutMs: 100 },
    { file: "/usr/bin/yes", cwd: "/tmp" },
    { file: "/usr/bin/false", cwd: "/tmp" },
    { file: "printf", cwd: "/tmp", args: ["0"] },
  ]) {
    await expect(measureCommand(JSON.stringify({ example: settings }), "example")).rejects.toThrow();
  }
});
