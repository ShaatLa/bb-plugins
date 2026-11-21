import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGER, setup as attentionSetup } from "../attention/fixtures";
import { registerTasksCli } from "../cli";
import { initializeTasksSchema } from "../db/schema";
import { gitSyncService } from "../git-sync/service";
import { createPlanStore } from "../plans/store";
import type { PlanAuthor } from "../shared/contract";
import { deliverWithReceipt, historyLimits, receiptPolling } from "../steer";
import { createGitSyncStore } from "../git-sync/store";
import { prLinkSchema, prSnapshotSchema } from "../shared/git-sync";
import { planDebtService } from "./service";
import { openPlanDebt } from "./store";

const owner: PlanAuthor = { kind: "person", threadId: null, name: "Owner" };
const author: PlanAuthor = { kind: "agent", threadId: "thr_author", name: "agent (thr_author)" };
const PR = "https://github.com/owner/repo/pull/7";
const HOUR = 3_600_000;

const fixtures: { dispose: () => unknown }[] = [];
const limits = { ...historyLimits };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => {
  Object.assign(historyLimits, limits); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

function setupDebt() {
  const f = attentionSetup();
  registerTasksCli(f.bb, f.store, { name: "Work Board", version: "test" });
  const { store, db, tracker, threads } = f;
  // Each send is its own request, so a test can tell one message from another.
  threads.sendMode = "inline";
  // Cards enter the work zone while planning is merely optional; `require()` then makes them debtors.
  store.tasks.updateProject(tracker.id, { planning: "optional" });
  const plans = createPlanStore(db, store.tasks);
  const service = planDebtService(f.bb, store.tasks);
  const fault = (status?: number) => Object.assign(new Error("rejected"), status ? { status } : {});
  /** Fails the sends to one thread: a definite rejection, or (no status) an ambiguous loss. */
  const send = threads.sdk.threads.send;
  const failSendsTo = (threadId: string, status?: number, afterLanding?: () => void) => {
    const control = { failing: true, calls: 0, restore: () => { control.failing = false; } };
    f.harness.sdk.stub("threads.send", async (args: { threadId: string }) => {
      if (!control.failing || args.threadId !== threadId) return send(args as never);
      control.calls++;
      // `afterLanding`: the message reaches the thread, the reply is lost.
      if (afterLanding) { await send(args as never); afterLanding(); }
      throw fault(status);
    });
    return control;
  };
  const card = (title: string, status = "in_progress") => store.tasks.createTask({ projectId: tracker.id, title, status });
  const require = () => store.tasks.updateProject(tracker.id, { planning: "required" });
  const executor = (taskId: string, threadId = "thr_worker") => {
    store.tasks.upsertTaskThread({ taskId, threadId, presetName: "Worker", title: "W", liveStatus: "working" });
    threads.threads.set(threadId, { status: "active" });
  };
  const withPlan = (taskId: string, state: "draft" | "in_review" | "approved") => {
    plans.save({ taskId, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    if (state === "in_review") plans.submit(taskId, author, null);
    if (state === "approved") plans.setState(taskId, "approved", owner);
  };
  const episodes = (taskId: string) => db.prepare<[string], { id: number; since: string; ended_at: string | null }>("SELECT * FROM plan_debt_episodes WHERE task_id = ? ORDER BY id").all(taskId);
  const open = (taskId: string) => openPlanDebt(db, taskId);
  const age = (hours: number) => db.prepare("UPDATE plan_debt_episodes SET since = ? WHERE ended_at IS NULL").run(new Date(Date.now() - hours * HOUR).toISOString());
  const notices = () => db.prepare<[], { trigger: string; destination: string; state: string; attempts: number }>("SELECT trigger, destination, state, attempts FROM plan_debt_notices ORDER BY rowid").all();
  const to = (threadId: string) => threads.requests.filter((request) => request.threadId === threadId).map((request) => request.text);
  const reminders = (threadId: string) => to(threadId).filter((text) => text.includes("Plan debt"));
  const call = (method: string, input?: unknown) => f.call(method, input);
  const cli = async (...args: string[]) => JSON.parse((await f.harness.runCli(args)).stdout);
  const ask = (taskId: string, extra: Record<string, unknown> = {}) => call("createQuestion", { taskId, kind: "decision", prompt: "Which one?", options: ["A", "B"], mode: "single", ...extra });
  const answer = (question: { id: string; revision: number; options: { id: string }[] }, pick = true) => call("answerQuestion", { questionId: question.id, revision: question.revision, selectedOptionIds: pick ? [question.options[0]!.id] : [], authorName: "Owner" });
  const allowRepository = () => call("setGitSyncConfig", { projectId: tracker.id, config: { repositories: ["owner/repo"] } });
  const result = { ...f, plans, service, card, require, executor, withPlan, episodes, open, age, notices, to, reminders, call, cli, ask, answer, allowRepository, failSendsTo };
  fixtures.push(result);
  return result;
}

describe("episodes", () => {
  it("opens when planning becomes required and closes when the plan is approved", () => {
    const f = setupDebt();
    const task = f.card("Debt");
    expect(f.episodes(task.id)).toEqual([]);
    f.require();
    expect(f.open(task.id)).toMatchObject({ planVersion: null, planState: null });
    f.withPlan(task.id, "draft");
    expect(f.open(task.id)).toMatchObject({ planVersion: 1, planState: "draft" });
    expect(f.episodes(task.id)).toHaveLength(1);
    f.plans.setState(task.id, "approved", owner);
    expect(f.open(task.id)).toBeNull();
    expect(f.episodes(task.id)).toMatchObject([{ ended_at: expect.any(String) }]);
  });

  it("starts a new episode each time approval is lost, even with no scan between the changes", () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.withPlan(task.id, "approved");
    f.require();
    expect(f.episodes(task.id)).toEqual([]);
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 1, body: "# Plan v2\n", summary: "Edit", author });
    f.plans.setState(task.id, "approved", owner);
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 2, body: "# Plan v3\n", summary: "Edit", author });
    expect(f.episodes(task.id).map((episode) => episode.ended_at !== null)).toEqual([true, false]);
  });

  it("follows a status change and a type change, and ignores archiving", () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.require();
    f.store.tasks.updateTask(task.id, { status: "todo" });
    expect(f.open(task.id)).toBeNull();
    // The gate would refuse the way back in, so the card re-enters through a project that does not require planning.
    f.store.tasks.updateProject(f.tracker.id, { planning: "optional" });
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    f.require();
    expect(f.open(task.id)).not.toBeNull();
    f.store.tasks.updateTask(task.id, { type: "epic" });
    expect(f.open(task.id)).toBeNull();
    f.store.tasks.updateTask(task.id, { type: "task" });
    expect(f.open(task.id)).not.toBeNull();
    // Only a closed card can be archived, and a closed card never has debt: archiving and restoring change nothing.
    f.store.tasks.updatePosition(task.id, { status: "done" });
    expect(f.open(task.id)).toBeNull();
    f.store.tasks.setTaskArchived(task.id, true);
    f.store.tasks.setTaskArchived(task.id, false);
    expect(f.open(task.id)).toBeNull();
    expect(f.episodes(task.id).map((episode) => episode.ended_at !== null)).toEqual([true, true, true]);
  });

  it("is never held by a closed card: Done is in the marked zone, yet closes the episode and is not backfilled", () => {
    const f = setupDebt();
    const done = f.card("Shipped", "done"), debt = f.card("Debt");
    f.withPlan(done.id, "draft");
    f.require();
    expect(f.store.tasks.getProject(f.tracker.id)!.statuses!.find((status) => status.id === "done")!.requiresApprovedPlan).toBe(true);
    expect(f.open(done.id)).toBeNull();
    expect(f.open(debt.id)).not.toBeNull();
    f.store.tasks.updatePosition(debt.id, { status: "done" });
    expect(f.open(debt.id)).toBeNull();
    expect(f.episodes(debt.id)).toMatchObject([{ ended_at: expect.any(String) }]);
    const version = f.db.prepare<[], { version: number }>("SELECT MAX(version) AS version FROM schema_version").get()!.version;
    f.db.exec(`DROP TABLE plan_debt_notices; DROP TABLE plan_debt_events; DROP TABLE plan_debt_episodes; DELETE FROM schema_version WHERE version >= ${version - 4};`);
    initializeTasksSchema(f.db);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM plan_debt_episodes").get()).toEqual({ n: 0 });
  });

  it("follows the project's planning and its status flags", () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.require();
    expect(f.open(task.id)).not.toBeNull();
    f.store.tasks.updateProject(f.tracker.id, { planning: "optional" });
    expect(f.open(task.id)).toBeNull();
    f.require();
    expect(f.open(task.id)).not.toBeNull();
    const statuses = f.store.tasks.getProject(f.tracker.id)!.statuses!;
    f.store.tasks.updateProject(f.tracker.id, { statuses: statuses.map((status) => (status.id === "in_progress" ? { ...status, requiresApprovedPlan: false } : status)) });
    expect(f.open(task.id)).toBeNull();
    f.store.tasks.updateProject(f.tracker.id, { statuses: statuses.map((status) => (status.id === "in_progress" ? { ...status, requiresApprovedPlan: true } : status)) });
    expect(f.open(task.id)).not.toBeNull();
  });

  it("backfills the debt that exists at install, dated at install", () => {
    const f = setupDebt();
    const debt = f.card("Debt"), fine = f.card("Fine"), early = f.card("Early", "todo");
    f.require();
    f.withPlan(fine.id, "approved");
    const version = f.db.prepare<[], { version: number }>("SELECT MAX(version) AS version FROM schema_version").get()!.version;
    f.db.exec(`DROP TABLE plan_debt_notices; DROP TABLE plan_debt_events; DROP TABLE plan_debt_episodes; DELETE FROM schema_version WHERE version >= ${version - 4};`);
    const before = Date.now();
    initializeTasksSchema(f.db);
    expect(f.open(debt.id)!.since >= new Date(before).toISOString()).toBe(true);
    expect(f.open(fine.id)).toBeNull();
    expect(f.open(early.id)).toBeNull();
  });

  it("repairs a missed sync on the scan", async () => {
    const f = setupDebt();
    const task = f.card("Debt"), other = f.card("Other");
    f.require();
    f.db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(task.id);
    f.db.prepare("DELETE FROM plan_debt_episodes WHERE task_id = ?").run(other.id);
    await f.service.scan();
    expect(f.open(task.id)).toBeNull();
    expect(f.open(other.id)).not.toBeNull();
  });
});

describe("the 24 h reminder", () => {
  it("goes to an active executor and the manager once, and not again on the next scan", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    await f.service.scan();
    expect(f.notices()).toEqual([]);
    f.age(25);
    await f.service.scan();
    await f.service.scan();
    expect(f.reminders("thr_worker")).toHaveLength(1);
    expect(f.reminders(MANAGER)).toHaveLength(1);
    expect(f.reminders("thr_worker")[0]).toContain("bb work-board plan submit ATT-1");
    // The same message for every role: the debt and the command to clear it.
    expect(f.reminders(MANAGER)[0]).toContain("bb work-board plan submit ATT-1");
    expect(f.reminders(MANAGER)[0]).not.toContain("reminded");
    expect(f.notices().map((row) => row.state)).toEqual(["sent", "sent"]);
  });

  it("retries only the destination that failed", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    const failing = f.failSendsTo(MANAGER, 400);
    await f.service.scan();
    expect(f.notices()).toMatchObject([{ destination: "thr_worker", state: "sent", attempts: 1 }, { destination: MANAGER, state: "failed", attempts: 1 }]);
    failing.restore();
    await f.service.scan();
    expect(f.notices()).toMatchObject([{ destination: "thr_worker", state: "sent", attempts: 1 }, { destination: MANAGER, state: "sent", attempts: 2 }]);
    expect(f.reminders("thr_worker")).toHaveLength(1);
  });

  it("sends one message to a manager that is also an executor", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id, MANAGER);
    f.require();
    f.age(25);
    await f.service.scan();
    expect(f.reminders(MANAGER)).toHaveLength(1);
    expect(f.reminders(MANAGER)[0]).toContain("Submit the plan for review");
  });

  it("leaves one notice and no pending lookup when the manager is a linked thread whose lookup fails", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id, MANAGER);
    f.require();
    f.age(25);
    const get = f.threads.sdk.threads.get;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => { if (args.threadId === MANAGER) throw new Error("host unreachable"); return get(args as never); });
    await f.service.scan();
    await f.service.scan();
    expect(f.reminders(MANAGER)).toHaveLength(1);
    expect(f.notices()).toMatchObject([{ destination: MANAGER, state: "sent" }]);
    expect((await f.cli("show", task.key, "--json")).planDebt.pendingLookups).toEqual([]);
  });

  it("keeps the wording of a retry when the link of its executor is gone, and does not change it for an idle linked manager", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    const failing = f.failSendsTo("thr_worker", 400);
    await f.service.scan();
    f.db.prepare("DELETE FROM task_threads WHERE thread_id = 'thr_worker'").run();
    failing.restore();
    await f.service.scan();
    expect(f.reminders("thr_worker")).toHaveLength(1);
    expect(f.reminders("thr_worker")[0]).toBe(f.reminders(MANAGER)[0]!.replace(/<!-- .* -->/, f.reminders("thr_worker")[0]!.match(/<!-- .* -->/)![0]));
  });

  it("tells only the executors when no manager is set", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.db.prepare("DELETE FROM attention_manager").run();
    f.require();
    f.age(25);
    await f.service.scan();
    expect(f.notices().map((row) => row.destination)).toEqual(["thr_worker"]);
  });

  it("sends once when scans overlap", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    await Promise.all([f.service.scan(), f.service.scan(), f.service.drain()]);
    expect(f.reminders("thr_worker")).toHaveLength(1);
    expect(f.reminders(MANAGER)).toHaveLength(1);
  });

  it("reminds again in a new episode", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    await f.service.scan();
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    f.plans.setState(task.id, "approved", owner);
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 1, body: "# Plan v2\n", summary: "Edit", author });
    f.age(25);
    await f.service.scan();
    expect(f.reminders("thr_worker")).toHaveLength(2);
    expect(f.notices().filter((row) => row.trigger === "24h")).toHaveLength(4);
  });

  it("stops the unsent rows when the episode closes", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    f.failSendsTo("thr_worker", 400);
    await f.service.scan();
    expect(f.notices().find((row) => row.destination === "thr_worker")).toMatchObject({ state: "failed" });
    f.withPlan(task.id, "approved");
    await f.service.scan();
    expect(f.notices().find((row) => row.destination === "thr_worker")).toMatchObject({ state: "failed", attempts: 1 });
    expect(f.reminders("thr_worker")).toHaveLength(0);
  });

  it("never resends an unknown send: it is searched for, and a late marker settles it as sent after one transport call", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    const lost = f.failSendsTo("thr_worker");
    await f.service.scan();
    const [unknown] = f.notices().filter((row) => row.destination === "thr_worker");
    expect(unknown).toMatchObject({ state: "unknown", attempts: 1 });
    // A restart: the row would have been left in `sending`, which is read as unknown too.
    f.db.prepare("UPDATE plan_debt_notices SET state = 'sending' WHERE destination = 'thr_worker'").run();
    await f.service.scan();
    await f.service.scan();
    expect(f.notices().find((row) => row.destination === "thr_worker")).toMatchObject({ state: "unknown", attempts: 1 });
    const shown = await f.cli("show", task.key, "--json");
    expect(shown.planDebt.notices).toMatchObject([{ destination: "thr_worker", state: "unknown", attempts: 1, lastError: expect.any(String) }]);
    const marker = f.db.prepare<[], { marker: string }>("SELECT marker FROM plan_debt_notices WHERE destination = 'thr_worker'").get()!.marker;
    f.threads.addRow("thr_worker", `Plan debt\n\n${marker}`);
    await f.service.scan();
    expect(f.notices().find((row) => row.destination === "thr_worker")).toMatchObject({ state: "sent", attempts: 1 });
    expect(lost.calls).toBe(1);
    expect((await f.cli("show", task.key, "--json")).planDebt.notices).toEqual([]);
  });
});

describe("a decision answered", () => {
  it("reminds the executor as its own message, apart from the answer to a distinct asker", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    const { question } = await f.ask(task.id, { askedByThread: "thr_asker" });
    await f.answer(question);
    expect(f.reminders("thr_worker")).toHaveLength(1);
    expect(f.reminders("thr_worker")[0]).toContain("a decision was answered on it");
    expect(f.to("thr_asker")).toHaveLength(1);
    expect(f.to("thr_asker")[0]).toContain("**Answer:** A");
    expect(f.reminders("thr_asker")).toEqual([]);
    expect(f.store.tasks.getTask(task.id)!.status).toBe("in_progress");
  });

  it("keeps the answer message unchanged when the asker is the executor", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    const { question } = await f.ask(task.id, { askedByThread: "thr_worker" });
    await f.answer(question);
    const texts = f.to("thr_worker");
    expect(texts).toHaveLength(2);
    expect(texts.filter((text) => text.includes("**Answer:** A") && !text.includes("Plan debt"))).toHaveLength(1);
    expect(f.reminders("thr_worker")).toHaveLength(1);
  });

  it("sends nothing for a check, a withdrawn answer, a cleared answer or an unchanged save", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    const check = (await f.ask(task.id, { kind: "check", prompt: "Verified?", options: [] })).question;
    const confirmed = await f.call("answerQuestion", { questionId: check.id, revision: check.revision, selectedOptionIds: [check.options[0].id], authorName: "Owner" });
    expect(f.reminders("thr_worker")).toEqual([]);
    expect(confirmed.question.revision).toBe(check.revision + 1);
    const { question } = await f.ask(task.id);
    const answered = (await f.answer(question)).question;
    expect(f.reminders("thr_worker")).toHaveLength(1);
    const same = await f.answer(answered);
    expect(same.notification).toBe("unchanged");
    const cleared = await f.answer(answered, false);
    expect(cleared.question.answeredBy).toBeNull();
    expect(f.reminders("thr_worker")).toHaveLength(1);
    expect(f.db.prepare("SELECT trigger FROM plan_debt_events").all()).toHaveLength(1);
  });

  it("retries a failed answer reminder from its row, for the failed destination only, after the 24 h reminder went out", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    await f.service.scan();
    const failing = f.failSendsTo("thr_worker", 400);
    const { question } = await f.ask(task.id);
    await f.answer(question);
    expect(f.notices().find((row) => row.trigger.startsWith("answer:"))).toMatchObject({ state: "failed", attempts: 1 });
    failing.restore();
    await f.service.drain();
    expect(f.notices().map((row) => [row.trigger.split(":")[0], row.destination, row.state, row.attempts])).toEqual([["24h", "thr_worker", "sent", 1], ["24h", MANAGER, "sent", 1], ["answer", "thr_worker", "sent", 2]]);
  });
});

describe("a PR link", () => {
  it("tells the executor when another caller confirms a link, once", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    await f.allowRepository();
    const first = await f.call("linkPr", { taskId: task.id, url: PR, role: "delivers" });
    expect(first.note).toContain("Plan debt");
    expect(f.reminders("thr_worker")).toHaveLength(1);
    expect(f.reminders("thr_worker")[0]).toContain("a PR was linked to it");
    const again = await f.call("linkPr", { taskId: task.id, url: PR, role: "delivers" });
    expect(again.note).toBeUndefined();
    expect(f.reminders("thr_worker")).toHaveLength(1);
  });

  it("sends nothing for an unconfirmed suggestion, and for a card without debt", async () => {
    const f = setupDebt();
    const task = f.card("Debt"), fine = f.card("Fine");
    f.executor(task.id);
    f.executor(fine.id, "thr_other");
    f.withPlan(fine.id, "approved");
    f.require();
    await f.allowRepository();
    gitSyncService(f.bb, f.store).remember(task.id, PR, "title");
    expect(f.reminders("thr_worker")).toEqual([]);
    await f.call("linkPr", { taskId: fine.id, url: PR, role: "delivers" });
    expect(f.reminders("thr_other")).toEqual([]);
    // Confirming the earlier suggestion is the trigger.
    const confirmed = await f.call("linkPr", { taskId: task.id, url: PR, role: "delivers" });
    expect(confirmed.note).toContain("Plan debt");
    expect(f.reminders("thr_worker")).toHaveLength(1);
  });
});

describe("surfaces", () => {
  it("shows the advisory and the debt on the card, and lists only cards with debt", async () => {
    const f = setupDebt();
    const debt = f.card("Debt"), fine = f.card("Fine");
    f.withPlan(fine.id, "approved");
    f.require();
    const shown = await f.cli("show", debt.key, "--json");
    expect(shown.planDebt).toMatchObject({ planVersion: null, planState: null, notices: [] });
    expect(shown.advisories).toMatchObject([{ kind: "plan-debt", taskKey: debt.key, planVersion: null }]);
    expect((await f.cli("show", fine.key, "--json")).planDebt).toBeNull();
    expect((await f.cli("show", fine.key, "--json")).advisories).toEqual([]);
    const text = (await f.harness.runCli(["show", debt.key])).stdout;
    expect(text).toContain(`Plan debt since ${shown.planDebt.since}: no plan. Submit it for review: bb work-board plan submit ${debt.key} --reviewer`);
    const listed = await f.cli("list", "--plan-debt", "--json");
    expect(listed.tasks.map((task: { key: string }) => task.key)).toEqual([debt.key]);
    expect((await f.cli("list", "--json")).tasks.length).toBeGreaterThan(1);
  });
});

describe("reminder delivery", () => {
  it("never lends a closed episode's reminder to a later episode of the same card", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    f.age(25);
    let release!: () => void;
    f.threads.sendGate = new Promise<void>((resolve) => { release = resolve; });
    const scanning = f.service.scan();
    await vi.waitFor(() => expect(f.threads.sends).toBe(1));
    // The first destination is slow: meanwhile the episode closes and a new one opens.
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    f.plans.setState(task.id, "approved", owner);
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 1, body: "# Plan v2\n", summary: "Edit", author });
    f.threads.sendGate = undefined;
    release();
    await scanning;
    expect(f.reminders(MANAGER)).toEqual([]);
    expect(f.episodes(task.id)).toHaveLength(2);
  });

  it("abandons a queued delivery whose guard no longer holds, before any queue update or send", async () => {
    const f = setupDebt();
    let release!: () => void;
    f.threads.sendGate = new Promise<void>((resolve) => { release = resolve; });
    let due = true;
    const first = deliverWithReceipt(f.bb, "thr_worker", "first", "<!-- m1 -->", { fresh: true });
    await vi.waitFor(() => expect(f.threads.sends).toBe(1));
    const second = deliverWithReceipt(f.bb, "thr_worker", "second", "<!-- m2 -->", { fresh: true, guard: () => due });
    due = false;
    f.threads.sendGate = undefined;
    release();
    await first;
    expect(await second).toMatchObject({ outcome: "failed" });
    expect(f.threads.sends).toBe(1);
  });

  it("accepts a guard only on a fresh send, so a guard never has a queue update between it and the send", () => {
    const f = setupDebt();
    // @ts-expect-error a guard without `fresh` could be overtaken by an append.
    void deliverWithReceipt(f.bb, "thr_x", "text", "<!-- m -->", { guard: () => true }).catch(() => undefined);
  });

  it("sends a decision reminder as its own queued message, leaving the answer's intact", async () => {
    const f = setupDebt();
    f.threads.sendMode = "queue";
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    const { question } = await f.ask(task.id, { askedByThread: "thr_worker" });
    await f.answer(question);
    const rows = f.threads.rows.filter((row) => row.threadId === "thr_worker").map((row) => f.threads.text(row));
    expect(rows).toHaveLength(2);
    const answerRow = rows.find((text) => text.includes("**Answer:** A"))!;
    expect(answerRow).not.toContain("Plan debt");
    expect(answerRow).not.toContain("work-board-plan-debt");
    const reminder = rows.find((text) => text.includes("Plan debt"))!;
    expect(reminder).toContain("<!-- work-board-plan-debt:");
    expect(reminder).not.toContain("**Answer:**");
    expect(f.notices()).toMatchObject([{ state: "sent" }]);
  });

  it("resumes the marker search of an unknown notice from its saved cursor, with one transport call", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.db.prepare("DELETE FROM attention_manager").run();
    f.require();
    f.age(25);
    historyLimits.passPages = 2;
    // The message lands, the reply is lost, and newer traffic then buries it beyond one search pass.
    const lost = f.failSendsTo("thr_worker", undefined, () => { for (let i = 0; i < 120; i++) f.threads.dispatch(`noise ${i}`, "thr_worker"); });
    await f.service.scan();
    const state = () => f.db.prepare<[], { state: string; cursor: string | null }>("SELECT state, cursor FROM plan_debt_notices").get()!;
    expect(state().state).toBe("unknown");
    for (let pass = 0; pass < 8 && state().state !== "sent"; pass++) await f.service.scan();
    expect(state().state).toBe("sent");
    expect(state().cursor).not.toBeNull();
    expect(lost.calls).toBe(1);
  });

  it("keeps an event retryable while an executor lookup fails, and delivers once the lookup works", async () => {
    const f = setupDebt();
    const task = f.card("Debt"), idle = f.card("Idle");
    f.executor(task.id, "thr_one");
    f.executor(task.id, "thr_two");
    f.db.prepare("DELETE FROM attention_manager").run();
    f.require();
    const { question } = await f.ask(task.id);
    const get = f.threads.sdk.threads.get;
    let outage = true;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => { if (outage && args.threadId === "thr_two") throw new Error("host unreachable"); return get(args as never); });
    await f.answer(question);
    // The thread that could be read was told; the unread one is not lost.
    expect(f.reminders("thr_one")).toHaveLength(1);
    expect(f.reminders("thr_two")).toEqual([]);
    expect(f.db.prepare<[], { expanded: number }>("SELECT expanded FROM plan_debt_events").get()).toEqual({ expanded: 0 });
    await f.service.scan();
    expect(f.reminders("thr_one")).toHaveLength(1);
    outage = false;
    await f.service.scan();
    expect(f.reminders("thr_two")).toHaveLength(1);
    expect(f.reminders("thr_one")).toHaveLength(1);
    expect(f.db.prepare<[], { expanded: number }>("SELECT expanded FROM plan_debt_events").get()).toEqual({ expanded: 1 });
    expect(idle.id).toBeTruthy();
  });

  it("fixes the recipients at the first expansion: a later manager or worker never receives the event, and the pending lookup is visible", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id, "thr_one");
    f.executor(task.id, "thr_two");
    f.require();
    f.age(25);
    const get = f.threads.sdk.threads.get;
    let outage = true;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => { if (outage && args.threadId === "thr_two") throw new Error("host unreachable"); return get(args as never); });
    await f.service.scan();
    expect(f.reminders(MANAGER)).toHaveLength(1);
    expect(f.reminders("thr_one")).toHaveLength(1);
    expect((await f.cli("show", task.key, "--json")).planDebt.pendingLookups).toMatchObject([{ trigger: "24h", threads: ["thr_two"] }]);
    // Between drains the manager is replaced and a new worker attaches.
    f.db.prepare("UPDATE attention_manager SET manager = 'thr_manager2'").run();
    f.executor(task.id, "thr_new");
    outage = false;
    await f.service.scan();
    expect(f.reminders("thr_two")).toHaveLength(1);
    expect(f.reminders("thr_manager2")).toEqual([]);
    expect(f.reminders("thr_new")).toEqual([]);
    expect(f.reminders(MANAGER)).toHaveLength(1);
    expect((await f.cli("show", task.key, "--json")).planDebt.pendingLookups).toEqual([]);
  });

  it("treats a thread the platform reports as gone as inactive, not as a failed lookup", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id, "thr_gone");
    f.db.prepare("DELETE FROM attention_manager").run();
    f.require();
    f.threads.getError = Object.assign(new Error("gone"), { code: "thread_not_found" });
    f.age(25);
    await f.service.scan();
    expect(f.db.prepare<[], { expanded: number }>("SELECT expanded FROM plan_debt_events").get()).toEqual({ expanded: 1 });
    expect(f.notices()).toEqual([]);
  });
});

describe("answer attachments and PR renames", () => {
  it("does not count an attachment added to an unchanged answer as a new answer", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    const { question } = await f.ask(task.id);
    const answered = (await f.answer(question)).question;
    expect(f.reminders("thr_worker")).toHaveLength(1);
    const attachment = f.store.tasks.createAttachment({ taskId: task.id, fileName: "note.txt", mime: "text/plain", sizeBytes: 1, blobPath: "blobs/note", isImage: false });
    const again = await f.call("answerQuestion", { questionId: answered.id, revision: answered.revision, selectedOptionIds: answered.selectedOptionIds, authorName: "Owner", attachmentIds: [attachment.id] });
    expect(again.question.revision).toBe(answered.revision + 1);
    expect(f.store.tasks.listAttachmentsForComment(again.commentId!)).toHaveLength(1);
    expect(f.reminders("thr_worker")).toHaveLength(1);
    expect(f.db.prepare("SELECT trigger FROM plan_debt_events").all()).toHaveLength(1);
  });

  it("keeps a confirmation across a repository rename: a snapshot refresh sends no second reminder", async () => {
    const f = setupDebt();
    const task = f.card("Debt");
    f.executor(task.id);
    f.require();
    await f.allowRepository();
    const first = await f.call("linkPr", { taskId: task.id, url: PR, role: "delivers" });
    expect(first.note).toBe("Plan debt: this card works without an approved plan; a reminder for its executors was recorded.");
    expect(f.reminders("thr_worker")).toHaveLength(1);
    const git = createGitSyncStore(f.db);
    const date = new Date().toISOString();
    const link = prLinkSchema.parse((await f.call("listPrLinks", { taskId: task.id })).links[0].link);
    const snapshot = prSnapshotSchema.parse({ repository: "owner/renamed", number: 7, remoteId: "1", url: "https://github.com/owner/renamed/pull/7", title: "Delivery", state: "open", headSha: "a".repeat(40), mergeSha: null, mergedAt: null, baseBranch: "main", updatedAt: date, observedAt: date, checks: [], requirementsKnown: false, ci: "no_checks", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [] });
    git.saveSnapshot(f.tracker.id, link, snapshot);
    expect((await f.call("listPrLinks", { taskId: task.id })).links[0].link).toMatchObject({ repository: "owner/renamed", confirmed: true });
    await f.service.drain();
    expect(f.db.prepare("SELECT trigger FROM plan_debt_events").all()).toHaveLength(1);
    expect(f.reminders("thr_worker")).toHaveLength(1);
  });
});
