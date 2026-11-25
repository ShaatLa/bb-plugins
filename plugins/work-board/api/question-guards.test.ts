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
