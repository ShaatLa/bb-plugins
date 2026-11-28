import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema, methods, type Proposal } from "./contract";
import { boardDisplayMigration, createStore, effectId, versionOne } from "./store";
import { reviewMigration } from "./reviews";
import { deliverReviews } from "./review-delivery";
import { createSweep, measureCommand, type Transport } from "./sweep";
import { createWorkBoard, type workBoardApi } from "./work-board";
import { boardStates } from "./states";
import { minute, occurrence, timeOn } from "./time";

const projectId = "proj_example", manager = "thr_example", other = "thr_other";
const reviewer = "thr_reviewer", replacement = "thr_replacement";
const database: Database.Database[] = [];
afterEach(() => { for (const db of database.splice(0)) db.close(); });
const metric = { definition: "Count missed checks", unit: "checks", baseline: 2, target: 0 };
const ref = (p: Proposal) => ({ projectId, proposalId: p.id, revision: p.revision });
function identity(store: ReturnType<typeof createStore>, p: Proposal, reviewerId = reviewer, version?: number) {
  return { reviewerId, links: store.links(projectId, p.id).map(link => link.taskId).sort(), executors: [], version };
}
function hypothesisIdentity(store: ReturnType<typeof createStore>, p: Proposal) {
  const round = store.reviews.approval(p, "hypothesis");
  return round ? identity(store, p, round.reviewerId, round.version) : undefined;
}
function requestReview(
  store: ReturnType<typeof createStore>, p: Proposal, stage: "hypothesis" | "result", reviewerId = reviewer,
) {
  const current = store.reviews.summary(p);
  const assigned = current.reviewerId === reviewerId ? current : store.reviews.assign({
    ...ref(p), reviewerId, generation: current.generation, reason: "Independent project reviewer",
  }, p.managerId, identity(store, p, reviewerId));
  return store.reviews.submit({ ...ref(p), generation: assigned.generation, baseVersion: current[stage]?.version ?? 0,
    submission: stage === "hypothesis" ? { stage } : { stage, conclusion: "The evidence supports the change",
      observationIds: store.events(projectId, p.id).events.filter(event => event.observation).map(event => event.seq) },
  }, p.managerId, identity(store, p, reviewerId), hypothesisIdentity(store, p));
}
function approve(store: ReturnType<typeof createStore>, p: Proposal, stage: "hypothesis" | "result") {
  const round = requestReview(store, p, stage);
  if (round.status === "approved") return identity(store, p, round.reviewerId, round.version);
  const verified = identity(store, p, round.reviewerId, round.version);
  store.reviews.decide({ projectId, proposalId: p.id, stage, version: round.version, generation: round.generation,
    verdict: "approved", feedback: "Evidence checked" }, round.reviewerId, verified, hypothesisIdentity(store, p));
  return verified;
}
function setup() {
  let clock = Date.parse("2026-10-30T12:00:00Z");
  const db = new Database(":memory:");
  database.push(db);
  db.exec(versionOne);
  db.exec(boardDisplayMigration);
  db.exec(reviewMigration);
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
  const measuring = (p: Proposal, checkAt = clock + minute, deadlineAt = clock + 8 * minute) => {
    const applied = store.transition({ ...ref(p), transition: { state: "applied", reason: "Fix deployed", deadlineAt } }, manager, approve(store, p, "hypothesis"));
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
  const kept = store.transition({ ...ref(observed), transition: { state: "kept", reason: "Pass" } }, "Owner",
    approve(store, observed, "result"), hypothesisIdentity(store, observed));
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
    updateDue: vi.fn() }, async proposal => hypothesisIdentity(store, proposal));
  const request = { ...ref(p), key: "create-fix", deadlineSource: true };
  await expect(board.create(request, manager)).rejects.toThrow("response lost");
  expect((await board.create(request, manager)).taskId).toBe(card.id);
  expect((await board.create(request, manager)).taskId).toBe(card.id);
  expect(new Set(create.mock.calls.map(([i]) => i.idempotencyKey)).size).toBe(1);
  await board.reconcile(projectId, store.config(projectId));
  expect(store.proposal(projectId, p.id).state).toBe("proposed");
  expect(store.links(projectId, p.id)[0]?.status).toContain("unavailable");
  await board.reconcile(projectId, store.config(projectId));
  expect(store.proposal(projectId, p.id).state).toBe("proposed");
  expect(store.links(projectId, p.id)[0]?.status).toContain("PR merged");
  const wire = transport();
  const sweep = createSweep(store, wire);
  await sweep.sweep();
  expect(wire.send).toHaveBeenCalledExactlyOnceWith(projectId, manager,
    expect.stringContaining("waiting in Proposed for independent hypothesis approval"), expect.any(Function));
  await board.reconcile(projectId, store.config(projectId));
  await sweep.sweep();
  expect(wire.send).toHaveBeenCalledTimes(1);
  approve(store, store.proposal(projectId, p.id), "hypothesis");
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
    projects: vi.fn().mockResolvedValue({ projects: [{ id: card.projectId }] }), updateDue }, async proposal => hypothesisIdentity(store, proposal));
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
    store.transition({ ...ref(initial), transition: { state: "applied", deadlineAt, reason: "Fix deployed" } }, manager, approve(store, initial, "hypothesis"));
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
    projects: vi.fn().mockResolvedValue({ projects: [{ id: card.projectId }] }), updateDue }, async proposal => hypothesisIdentity(store, proposal));
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
  expect(() => store.transition({ ...ref(edit), transition: { state: "kept", reason: "Observed target" } }, "BB client"))
    .toThrow("independent approval");
  approve(store, edit, "hypothesis");
  expect(store.transition({ ...ref(edit), transition: { state: "kept", reason: "Observed target" } }, "BB client",
    approve(store, edit, "result"), hypothesisIdentity(store, edit)).state).toBe("kept");
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
    updateDue: vi.fn() }, async proposal => hypothesisIdentity(store, proposal));
  const link = { ...ref(p), taskKey: card.key, deadlineSource: true };
  await expect(board.linkExisting(link, manager)).rejects.toThrow("outside");
  await board.linkExisting(link, manager);
  byKey.mockResolvedValueOnce({ task: { ...card, id: "task_other", key: "EXA-2" } });
  await expect(board.linkExisting({ ...link, taskKey: "EXA-2" }, manager)).rejects.toThrow("already has");
  card.status = "todo";
  approve(store, p, "hypothesis");
  await board.reconcile(projectId, store.config(projectId));
  expect(store.proposal(projectId, p.id).state).toBe("proposed");
  card.status = "complete";
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

it("applies display revisions by project and keeps the existing config body readable", () => {
  const { db, store } = setup();
  const baseline = db.prepare("SELECT body FROM config WHERE project=?").get(projectId);
  const defaults = boardStates.map(id => ({ id, name: id, visible: true, icon: "default", color: "default" }));
  const renamed = defaults.map(column => column.id === "measuring" ? { ...column, name: "  Collecting evidence  ", visible: false } : column);
  const first = store.boardDisplay(projectId), second = store.boardDisplay(projectId);
  expect(first).toEqual({ revision: 0, columns: null });
  expect(store.setBoardDisplay(projectId, { expectedRevision: first.revision, columns: renamed })).toMatchObject({
    ok: true, revision: 1,
  });
  const saved = store.boardDisplay(projectId);
  expect(saved.columns?.[2]).toMatchObject({ id: "measuring", name: "Collecting evidence", visible: false });
  for (const columns of [defaults, null]) {
    expect(store.setBoardDisplay(projectId, { expectedRevision: second.revision, columns })).toEqual({
      ok: false, code: "board_display_conflict", current: saved,
    });
  }
  expect(store.boardDisplay("proj_other")).toEqual({ revision: 0, columns: null });
  expect(db.prepare("SELECT body FROM config WHERE project=?").get(projectId)).toEqual(baseline);
  db.exec(boardDisplayMigration);
  const reloaded = createStore(db).boardDisplay(projectId);
  expect(reloaded).toEqual(saved);
  expect(store.setBoardDisplay(projectId, { expectedRevision: reloaded.revision, columns: null }))
    .toEqual({ ok: true, revision: 2, columns: null });
  expect(store.setBoardDisplay(projectId, { expectedRevision: 0, columns: defaults })).toMatchObject({ ok: false });
});

it("validates fixed status IDs, palette, Unicode names and stored text", () => {
  const { store } = setup();
  const defaults = boardStates.map(id => ({ id, name: id, visible: true, icon: "default", color: "default" }));
  const replace = (value: Record<string, unknown>) => [{ ...defaults[0], ...value }, ...defaults.slice(1)];
  for (const columns of [
    defaults.slice(1), replace({ id: "applied" }), replace({ id: "unknown" }),
    replace({ icon: "UnknownIcon" }), replace({ color: "#fff" }), replace({ name: " " }),
    replace({ name: "a".repeat(65) }), replace({ name: "  ＡＰＰＬＩＥＤ " }),
    replace({ name: "Status\n" }), replace({ name: "Sta\u202etus" }), replace({ visible: null }),
  ]) {
    expect(() => store.setBoardDisplay(projectId, { expectedRevision: 0, columns })).toThrow();
  }
  expect(() => store.setBoardDisplay(projectId, { expectedRevision: 0, columns: replace({ name: "-----BEGIN PRIVATE KEY-----" }) }))
    .toThrow("detected");
  expect(store.boardDisplay(projectId).revision).toBe(0);
});

it("counts hidden Measuring proposals with the list filters and preserves their deadlines", () => {
  const { store, add, measuring, advance } = setup();
  const p = measuring(add());
  measuring(add({ managerId: other }));
  advance(2 * minute);
  const columns = boardStates.map(id => ({ id, name: id, icon: "default", color: "default", visible: id !== "measuring" }));
  store.setBoardDisplay(projectId, { expectedRevision: 0, columns });
  const page = methods.list.input.parse({ projectId, state: "measuring", managerId: manager, overdue: true, limit: 1 });
  expect(store.list(page)).not.toHaveProperty("total");
  expect(store.list({ ...page, withTotal: true })).toMatchObject({
    total: 1, items: [{ overdue: true, proposal: { id: p.id, state: "measuring", checkAt: p.checkAt, deadlineAt: p.deadlineAt } }],
  });
  expect(store.list({ ...page, withTotal: true, offset: 1 })).toMatchObject({ total: 1, items: [] });
});

it("gates Applied on the approved content and records changes requested and Russian feedback", () => {
  const { store, add } = setup();
  const p = add({ links: ["https://example.com/b", "https://example.com/a"] });
  const applying = { state: "applied" as const, deadlineAt: store.now() + 20 * minute, reason: "Fix deployed" };
  expect(() => store.transition({ ...ref(p), transition: applying }, manager)).toThrow("independent approval");
  const first = requestReview(store, p, "hypothesis");
  const verdict = { projectId, proposalId: p.id, stage: "hypothesis" as const, version: first.version,
    generation: first.generation, verdict: "changes_requested" as const, feedback: "Уточните способ измерения" };
  expect(() => store.reviews.decide(verdict, manager, identity(store, p))).toThrow("assigned reviewer");
  expect(store.reviews.decide(verdict, reviewer, identity(store, p))).toMatchObject({ feedback: verdict.feedback });
  expect(() => store.reviews.decide(verdict, reviewer, identity(store, p))).toThrow("no longer pending");
  const revised = store.update({ ...ref(p), patch: { hypothesis: "Use a named owner and verify the results weekly" } }, manager);
  const ticket = approve(store, revised, "hypothesis");
  const rescheduled = store.update({ ...ref(revised), patch: {
    deadlineAt: store.now() + 8 * minute, links: [...revised.links].reverse(), metric: { ...revised.metric },
  } }, manager);
  expect(store.reviews.summary(rescheduled).hypothesis).toEqual({ version: 2, status: "approved" });
  expect(store.transition({ ...ref(rescheduled), transition: applying }, manager, ticket).state).toBe("applied");
  expect(store.reviews.approval(rescheduled, "hypothesis")?.version).toBe(2);
});

it("blocks author descendants and linked executors, and reassigns pending review explicitly", () => {
  const { store, add } = setup();
  const p = add();
  const child = "thr_child", root = "thr_intermediate", executor = "thr_executor";
  store.reviews.lineage(child, [root]);
  store.reviews.lineage(root, [manager]);
  store.reviews.lineage(child, [replacement]);
  const assign = (reviewerId: string, generation = 0) => ({
    ...ref(p), reviewerId, generation, reason: "Independent reviewer",
  });
  expect(() => store.reviews.assign(assign(child), manager, identity(store, p, child))).toThrow("independent");
  expect(() => store.reviews.assign(assign(executor), manager, { ...identity(store, p, executor), executors: [executor] }))
    .toThrow("independent");
  const first = requestReview(store, p, "hypothesis");
  expect(() => store.reviews.assign(assign(replacement, first.generation), other, identity(store, p, replacement)))
    .toThrow("manager thread");
  const changed = store.reviews.assign(assign(replacement, first.generation), manager, identity(store, p, replacement));
  expect(changed.hypothesis).toEqual({ version: 2, status: "pending" });
  expect(store.reviews.rounds(p).find(round => round.version === 1)?.status).toBe("superseded");
  expect(() => store.reviews.decide({ projectId, proposalId: p.id, stage: "hypothesis", version: first.version,
    generation: first.generation, verdict: "approved", feedback: "Old reviewer" }, reviewer, identity(store, p)))
    .toThrow("no longer pending");
  const second = add();
  expect(requestReview(store, second, "hypothesis", replacement)).toMatchObject({
    reviewerId: replacement, proposalId: second.id, version: 1,
  });
});

it("pins manual observations and requires a new hypothesis and result after a substantive edit", () => {
  const { store, add, measuring } = setup();
  const started = measuring(add());
  const manual = { note: "The checklist was followed for the full week.", evidence: ["https://example.com/evidence"] };
  const p = store.measure({ ...ref(started), observation: manual }, manager);
  const ticket = approve(store, p, "result");
  const first = store.reviews.approval(p, "result");
  expect(first?.snapshot).toMatchObject({ stage: "result", observations: [{ observation: manual }] });
  const additional = store.measure({ ...ref(p), observation: { value: 1 } }, manager);
  expect(store.reviews.approval(additional, "result")?.snapshot).toEqual(first?.snapshot);
  const replaced = requestReview(store, additional, "result");
  expect(replaced).toMatchObject({ version: 2, status: "pending" });
  expect(replaced.snapshot.stage === "result" && replaced.snapshot.observations).toHaveLength(2);
  expect(store.reviews.decide({ projectId, proposalId: p.id, stage: "result", version: replaced.version,
    generation: replaced.generation, verdict: "changes_requested", feedback: "Explain the extra missed check" },
  reviewer, identity(store, p), hypothesisIdentity(store, additional))).toMatchObject({ status: "changes_requested" });
  expect(() => store.transition({ ...ref(additional), transition: { state: "kept", reason: "Keep fix" } }, manager,
    ticket, hypothesisIdentity(store, additional))).toThrow("independent approval");
  const changed = store.update({ ...ref(additional), patch: { rollbackCondition: "Revert if another checklist is missed" } }, manager);
  expect(changed.state).toBe("measuring");
  expect(store.reviews.summary(changed).hypothesis?.status).toBe("superseded");
  expect(store.reviews.summary(changed).result?.status).toBe("superseded");
  expect(() => requestReview(store, changed, "result")).toThrow("independent approval");
  approve(store, changed, "hypothesis");
  const kept = store.transition({ ...ref(changed), transition: { state: "kept", reason: "Keep fix" } }, manager,
    approve(store, changed, "result"), hypothesisIdentity(store, changed));
  expect(kept.state).toBe("kept");
});

it("sends pending review requests, retries known delivery failures and escalates once", async () => {
  const { store, add, advance } = setup();
  const p = add();
  const request = requestReview(store, p, "hypothesis");
  const send = vi.fn<Transport["send"]>().mockResolvedValueOnce("retry").mockResolvedValueOnce("unreachable");
  const wire = transport({ send });
  await deliverReviews(store, wire, async () => true);
  expect(store.reviews.latest(p, "hypothesis")?.delivery).toBe("queued");
  await deliverReviews(store, wire, async () => true);
  expect(send).toHaveBeenCalledTimes(1);
  advance(minute);
  await deliverReviews(store, wire, async () => false);
  await deliverReviews(store, wire, async () => false);
  expect(store.reviews.latest(p, "hypothesis")).toMatchObject({ delivery: "unreachable", status: "pending" });
  expect(wire.notice).toHaveBeenCalledTimes(2);
  expect(wire.notice).toHaveBeenCalledWith(expect.objectContaining({ threadId: manager, title: "Proposal review is overdue" }));
  store.reviews.assign({ ...ref(p), reviewerId: replacement, generation: request.generation, reason: "Reviewer archived" },
    manager, identity(store, p, replacement));
  const active = transport();
  await deliverReviews(store, active, async () => true);
  expect(active.send).toHaveBeenCalledTimes(1);
  expect(active.send).toHaveBeenCalledWith(projectId, replacement, expect.stringContaining("hypothesis v2"), expect.any(Function));
});

it("retires pending reviews on emergency revert and rejects a late verdict", () => {
  const { store, add, measuring } = setup();
  const m = measuring(add());
  const p = store.measure({ ...ref(m), observation: { value: 4 } }, manager);
  const round = requestReview(store, p, "result");
  const reverted = store.transition({ ...ref(p), transition: { state: "reverted", reason: "Unexpected side effect", override: true } }, other);
  expect(store.events(projectId, p.id).events[0]).toMatchObject({ actor: other, state: "reverted" });
  expect(store.reviews.latest(reverted, "result")?.status).toBe("superseded");
  expect(() => store.reviews.decide({ projectId, proposalId: p.id, stage: "result",
    version: round.version, generation: round.generation, verdict: "approved", feedback: "Late" },
  reviewer, identity(store, p), hypothesisIdentity(store, p))).toThrow("no longer pending");
  expect(store.reviews.pending()).toEqual([]);
  expect(store.proposal(projectId, p.id).state).toBe("reverted");
});

it("upgrades existing experiments without changing their proposal bodies or requiring retrospective approval", () => {
  const { store, add, db, measuring } = setup();
  const p = measuring(add());
  const body = db.prepare("SELECT body FROM proposals WHERE project=? AND id=?").get(projectId, p.id);
  const previous = new Database(":memory:");
  database.push(previous);
  previous.exec(versionOne);
  previous.exec(boardDisplayMigration);
  const display = createStore(previous).setBoardDisplay(projectId, {
    expectedRevision: 0,
    columns: boardStates.map(id => ({ id, name: id, icon: "default", color: "default", visible: id !== "measuring" })),
  });
  const rows = db.prepare("SELECT * FROM entries").all() as Record<string, unknown>[];
  for (const row of rows) previous.prepare("INSERT INTO entries VALUES (@project,@id,@body)").run(row);
  previous.prepare("INSERT INTO proposals VALUES (@project,@id,@state,@manager,@updated,@deadline,@check_at,@metric_key,@body)")
    .run(db.prepare("SELECT * FROM proposals WHERE id=?").get(p.id));
  previous.exec(reviewMigration);
  const upgraded = createStore(previous, store.now);
  expect(display.ok).toBe(true);
  expect(upgraded.boardDisplay(projectId)).toMatchObject({ revision: 1, columns: expect.arrayContaining([
    expect.objectContaining({ id: "measuring", visible: false }),
  ]) });
  expect(previous.prepare("SELECT body FROM proposals WHERE project=? AND id=?").get(projectId, p.id)).toEqual(body);
  expect(upgraded.reviews.summary(p)).toMatchObject({ legacy: true, hypothesis: null });
  const measured = upgraded.measure({ ...ref(p), observation: { note: "Verified with the checklist", evidence: ["https://example.com/check"] } }, manager);
  expect(() => upgraded.transition({ ...ref(measured), transition: { state: "kept", reason: "Keep" } }, manager)).toThrow("independent approval");
  previous.exec(reviewMigration);
  expect(upgraded.transition({ ...ref(measured), transition: { state: "kept", reason: "Keep" } }, manager,
    approve(upgraded, measured, "result")).state).toBe("kept");
});

it("ignores obsolete delivery callbacks and recovers an interrupted send without repeating it", async () => {
  const { store, add } = setup();
  const p = add();
  const first = requestReview(store, p, "hypothesis");
  const inFlight = transport({ send: vi.fn<Transport["send"]>(async (_project, _thread, _message, wanted) => {
    store.reviews.assign({ ...ref(p), reviewerId: replacement, generation: first.generation, reason: "New reviewer" },
      manager, identity(store, p, replacement));
    expect(wanted()).toBe(false);
    return "obsolete";
  }) });
  await deliverReviews(store, inFlight, async () => true);
  const round = store.reviews.latest(p, "hypothesis")!;
  expect(round).toMatchObject({ version: 2, delivery: "queued", reviewerId: replacement });
  store.reviews.save({ ...round, delivery: "sending" });
  store.reviews.recover();
  const next = transport();
  await deliverReviews(store, next, async () => true);
  expect(store.reviews.latest(p, "hypothesis")?.delivery).toBe("uncertain");
  expect(next.send).not.toHaveBeenCalled();
  expect(next.notice).toHaveBeenCalledTimes(1);
});

it("withdraws obsolete review reminders and falls back to a notice when the linked fix is completed again", async () => {
  const { store, add } = setup();
  const p = add();
  const card = { taskId: "task_example", key: "EXA-1", status: "Done", deadlineSource: false,
    dueDate: null, syncedCheckAt: null, syncedDueDate: null, conflict: false };
  store.saveLink(p, card);
  const reminder = () => store.queue(projectId, p.id, p.obligation, "manager", store.now(), "review");
  const first = reminder();
  const wire = transport({ send: vi.fn<Transport["send"]>().mockResolvedValue("unreachable") });
  const sweep = createSweep(store, wire);
  store.saveLink(p, { ...card, status: "todo" });
  await sweep.sweep();
  expect(wire.send).not.toHaveBeenCalled();
  expect(store.effect(first.id)).toBeUndefined();

  store.saveLink(p, card);
  expect(reminder().inserted).toBe(1);
  await sweep.sweep();
  await sweep.sweep();
  await sweep.sweep();
  expect(wire.send).toHaveBeenCalledTimes(1);
  expect(wire.notice).toHaveBeenCalledOnce();
  expect(wire.notice).toHaveBeenCalledWith(expect.objectContaining({
    threadId: manager, title: "Linked fix is waiting for review", markdown: expect.stringContaining("independent hypothesis approval"),
  }));
});

it("opens a fresh review on reassignment while preserving the approval of a previous lifecycle stage", () => {
  const { store, add, measuring } = setup();
  const p = add();
  approve(store, p, "hypothesis");
  const assign = (proposal: Proposal) => ({
    ...ref(proposal), reviewerId: replacement, reason: "Replacement reviewer", generation: 1,
  });
  const changed = store.reviews.assign(assign(p), manager, identity(store, p, replacement));
  expect(changed.hypothesis).toEqual({ version: 2, status: "pending" });
  expect(store.reviews.rounds(p).find(round => round.version === 1)).toMatchObject({
    verdict: "approved", status: "superseded",
  });

  const applied = measuring(add());
  const observed = store.measure({ ...ref(applied), observation: { value: 0 } }, manager);
  approve(store, observed, "result");
  const next = store.reviews.assign(assign(observed), manager, identity(store, observed, replacement));
  expect(next.hypothesis).toEqual({ version: 1, status: "approved" });
  expect(next.result).toEqual({ version: 2, status: "pending" });
});
