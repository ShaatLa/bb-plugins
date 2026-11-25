import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { navigationBadgeCounts } from "./badge";
import { registerTasksCli } from "../cli";
import { createStructuredStore } from "../structured/store";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses.js";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((h) => h.harness.dispose())); });

function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Guards", prefix: "EXA", color: "blue" });
  const structured = createStructuredStore(host.bb, store);
  const task = store.tasks.createTask({ projectId: project.id, title: "Card", status: "in_progress" });
  const ask = async (kind: "decision" | "check", prompt = "Proceed?") =>
    (await structured.handlers.createQuestion({ kind, askedByThread: null, taskId: task.id, prompt, options: kind === "decision" ? ["Yes", "No"] : [], mode: "single" })).question;
  const status = () => store.tasks.getTask(task.id)!.status;
  const agent = { taskId: task.id, agentThreadId: "thr_example" };
  return { ...host, store, project, task, structured, ask, status, agent };
}

describe("an agent cannot close a card while an owner question is open", () => {
  it.each(["done", "canceled"])("updateTask to %s throws with the question, its revision and the withdraw command", async (target) => {
    const f = setup();
    const question = await f.ask("decision");
    const refusal = f.harness.callRpc("updateTask", { ...f.agent, status: target });
    await expect(refusal).rejects.toThrow(`${f.task.key} cannot move to`);
    await expect(refusal).rejects.toThrow(`1 owner question is still open: ${question.id} rev ${question.revision} (decision) "Proceed?"`);
    await expect(refusal).rejects.toThrow(`question withdraw ${f.task.key} --question ${question.id} --revision ${question.revision} --reason "..."`);
    expect(f.status()).toBe("in_progress");
  });

  it("refuses a custom policy done status", async () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: [...DEFAULT_TASK_STATUSES, { id: "shipped", name: "Shipped" }], workflowPolicy: { doneStatus: "shipped" } as never });
    await f.ask("check");
    await expect(f.harness.callRpc("updateTask", { ...f.agent, status: "shipped" })).rejects.toThrow(/cannot move to Shipped: 1 owner question is still open/);
    expect(f.status()).toBe("in_progress");
  });

  it("lets the owner close the card, and an agent when questions are answered or deleted", async () => {
    const f = setup();
    const owner = await f.ask("decision");
    await f.harness.callRpc("updateTask", { taskId: f.task.id, status: "done" });
    expect(f.status()).toBe("done");
    await f.harness.callRpc("updateTask", { taskId: f.task.id, status: "in_progress" });
    const answered = await f.ask("decision");
    await f.structured.handlers.answerQuestion({ questionId: answered.id, revision: answered.revision, selectedOptionIds: [answered.options[0]!.id], authorName: "Owner" });
    await f.structured.handlers.deleteQuestion({ questionId: owner.id, revision: owner.revision });
    await f.harness.callRpc("updateTask", { ...f.agent, status: "done" });
    expect(f.status()).toBe("done");
  });

  it("clears Waiting on me and the needs-answer badge after a decision is withdrawn", async () => {
    const f = setup();
    const decision = await f.ask("decision");
    const badges = () => navigationBadgeCounts(f.bb, f.store, ["needs_answer", "waiting_on_owner"], Date.now()).counts;
    expect(badges()).toEqual({ needs_answer: 1, waiting_on_owner: 1 });
    await f.structured.handlers.withdrawQuestion({ taskId: f.task.id, questionId: decision.id, revision: 1, reason: "Review canceled", authorName: "Agent" });
    expect(badges()).toEqual({ needs_answer: 0, waiting_on_owner: 0 });
    expect(await f.structured.handlers.questionCounts({ taskIds: [f.task.id] })).toMatchObject({ counts: [{ unanswered: 0, decisions: 0, waitingOnOwner: false }] });
  });

  it("does not refuse a move between closed statuses", async () => {
    const f = setup();
    f.store.tasks.updateTask(f.task.id, { status: "done", authorName: "Owner" });
    await f.ask("check");
    await f.harness.callRpc("updateTask", { ...f.agent, status: "canceled" });
    expect(f.status()).toBe("canceled");
  });

  it("boardMove names every open question and leaves status and position unchanged", async () => {
    const f = setup();
    const decision = await f.ask("decision", "Which database?");
    const check = await f.ask("check", "Does Retry reload the list?");
    const positionBefore = f.store.tasks.getTask(f.task.id)!.position;
    const refusal = f.harness.callRpc("boardMove", { ...f.agent, status: "done" });
    await expect(refusal).rejects.toThrow("2 owner questions are still open");
    await expect(refusal).rejects.toThrow(`${decision.id} rev ${decision.revision} (decision) "Which database?"; ${check.id} rev ${check.revision} (check) "Does Retry reload the list?"`);
    for (const q of [decision, check]) await expect(refusal).rejects.toThrow(`question withdraw ${f.task.key} --question ${q.id} --revision ${q.revision} --reason "..."`);
    expect(f.status()).toBe("in_progress");
    expect(f.store.tasks.getTask(f.task.id)!.position).toBe(positionBefore);
    expect(f.store.tasks.listComments(f.task.id).filter((c) => c.kind === "system")).toEqual([]);
    await f.harness.callRpc("boardMove", { taskId: f.task.id, status: "done" });
    expect(f.status()).toBe("done");
  });

  it("refuses `update --status done` from an agent thread and lists the questions", async () => {
    const f = setup();
    const question = await f.ask("decision");
    const result = await f.harness.runCli(["update", f.task.key, "--status", "done"], { threadId: "thr_example" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(`${question.id} rev ${question.revision} (decision)`);
    expect(f.status()).toBe("in_progress");
  });
});

describe("Done after review", () => {
  it.each(["boardMove", "updateTask"])("%s checks an agent entering Done from work or cancellation", async method => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { doneRequiresReview: "on" });
    for (const status of ["in_progress", "canceled"]) {
      f.store.tasks.updateTask(f.task.id, { status });
      const before = f.store.tasks.getTask(f.task.id);
      const comments = f.store.tasks.listComments(f.task.id);
      await expect(f.harness.callRpc(method, { ...f.agent, status: "done" })).rejects.toThrow(/EXA-1 cannot move to Done.*--status in_review.*--verdict approve/);
      expect(f.store.tasks.getTask(f.task.id)).toEqual(before);
      expect(f.store.tasks.listComments(f.task.id)).toEqual(comments);
      await f.harness.callRpc(method, { taskId: f.task.id, status: "done" });
      expect(f.status()).toBe("done");
    }
  });

  it("refuses agent creation in Done and atomic family moves into a newly closed status", async () => {
    const f = setup();
    const tasks = f.store.tasks;
    const target = tasks.createProject({ name: "Destination", prefix: "DST", color: "blue" });
    tasks.updateProject(target.id, { doneRequiresReview: "on", workflowPolicy: { doneStatus: "in_progress" } as never });
    const ctx = { threadId: "thr_example" };
    const create = await f.harness.runCli(["create", "--project", target.prefix, "--title", "Card", "--status", "done"], ctx);
    expect(create.stderr).toContain("Create the card in another status");
    expect(tasks.listTasks({ projectId: target.id })).toHaveLength(0);
    await f.harness.callRpc("createTask", { projectId: target.id, title: "Panel card", status: "done" });
    tasks.updateTask(f.task.id, { status: "todo" });
    const child = tasks.createTask({ projectId: f.project.id, parentTaskId: f.task.id, title: "Child", status: "in_progress" });
    const move = await f.harness.runCli(["move", f.task.key, "--project", target.prefix], ctx);
    expect(move.stderr).toContain("whole family stays in EXA because of " + child.key);
    expect(tasks.getTask(f.task.id)?.projectId).toBe(f.project.id);
    expect(tasks.getTask(child.id)?.projectId).toBe(f.project.id);
    await f.harness.callRpc("moveTaskToProject", { taskId: f.task.id, projectId: target.id });
    expect(tasks.getTask(child.id)?.projectId).toBe(target.id);
  });

  it("offers only shared review roles for a project move and evaluates history under destination roles", async () => {
    const f = setup();
    const tasks = f.store.tasks;
    const target = tasks.createProject({ name: "Destination", prefix: "DST", color: "blue" });
    const policy = { doneStatus: "todo", reviewStatus: "inspection", testingStatus: "in_review" };
    tasks.updateProject(target.id, { doneRequiresReview: "on", workflowPolicy: policy as never,
      statuses: [...DEFAULT_TASK_STATUSES, { id: "inspection", name: "Inspection" }] });
    tasks.updateTask(f.task.id, { status: "todo" });
    const move = () => f.harness.callRpc("moveTaskToProject", { ...f.agent, projectId: target.id });
    await expect(move()).rejects.toThrow(/--status in_review/);
    tasks.updateProject(target.id, { workflowPolicy: { ...policy, testingStatus: "backlog" } as never });
    const refused = move();
    await expect(refused).rejects.toThrow(/--verdict approve/);
    await expect(refused).rejects.not.toThrow(/--status/);
    tasks.updateTask(f.task.id, { status: "backlog" });
    tasks.updateTask(f.task.id, { status: "todo" });
    const log = () => f.bb.storage.database().prepare("SELECT * FROM task_review_log WHERE task_id=? ORDER BY id").all(f.task.id);
    const before = log();
    await move();
    expect(tasks.getTask(f.task.id)?.projectId).toBe(target.id);
    expect(log()).toEqual(before);
  });

  it("reserves changing the switch for project settings", async () => {
    const f = setup();
    for (const ctx of [{}, { threadId: "thr_example" }]) {
      for (const args of [["config", "set", "doneRequiresReview", "on", "--project", "EXA"], ["project", "update", "EXA", "--done-requires-review", "on"]])
        expect((await f.harness.runCli(args, ctx)).stderr).toContain("done after review is changed by the owner in the project settings");
    }
    await f.harness.callRpc("updateProject", { projectId: f.project.id, doneRequiresReview: "on" });
    expect(f.harness.logEntries).toContainEqual({ level: "info", message: "done after review for EXA: off → on" });
    expect((await f.harness.runCli(["config", "get", "doneRequiresReview", "--project", "EXA"])).stdout).toContain("doneRequiresReview=on");
  });
});
