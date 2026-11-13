import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(h => h.harness.dispose())); });
function setup() {
  const host = createFakePluginHost({ pluginId: "work-board", sdk: { threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: "active" }), send: async () => {} } } });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Typed", prefix: "TYP", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Typed questions" });
  return { ...host, store, task };
}
it("supports one-option decisions, default/custom check options and free text for both", async () => {
  const f = setup();
  const call = (args: string[]) => f.harness.runCli(args);
  const missing = await call(["question", "add", f.task.key, "--prompt", "Decide"]);
  expect(missing.exitCode).not.toBe(0);
  for (const kind of ["decision", "check"]) {
    const result = await call(["question", "add", f.task.key, "--kind", kind, "--prompt", "Choose", "--option", "Proceed", "--json"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const question = JSON.parse(result.stdout).question;
    expect(question).toMatchObject({ kind, options: [{ label: "Proceed" }] });
    const answer = await call(["question", "answer", f.task.key, "--question", question.id, "--revision", "1", "--text", "Custom answer", "--json"]);
    expect(answer.exitCode, answer.stderr).toBe(0);
    expect(JSON.parse(answer.stdout).question.answerText).toBe("Custom answer");
  }
  const result = await call(["question", "add", f.task.key, "--kind", "check", "--prompt", "Validate", "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).question.options.map((o: any) => o.label)).toEqual(["Confirmed", "Problem found"]);
});
it("stamps the CLI asker and delivers answers there before attached workers", async () => {
  const f = setup();
  f.store.tasks.upsertTaskThread({ taskId: f.task.id, threadId: "thr_worker", title: "Worker", presetName: "Attached", liveStatus: "idle" });
  const created = await f.harness.runCli(["question", "add", f.task.key, "--kind", "check", "--prompt", "Validate", "--json"], { threadId: "thr_asker" });
  expect(created.exitCode, created.stderr).toBe(0);
  const question = JSON.parse(created.stdout).question;
  expect(question.askedByThread).toBe("thr_asker");
  const answered = await f.harness.callRpc("answerQuestion", { questionId: question.id, revision: 1, selectedOptionIds: [question.options[0].id] });
  expect(answered).toMatchObject({ notification: "sent" });
  expect(f.harness.sdk.callsTo("threads.send").at(-1)?.[0]).toMatchObject({ threadId: "thr_asker", mode: "queue-if-active" });
  expect(await f.harness.callRpc("questionCounts", { taskIds: [f.task.id] })).toMatchObject({ counts: [{ unanswered: 0, checks: 0, decisions: 0, waitingOnOwner: false }] });
});
it("uses the same waiting counts for checks and falls back to an attached thread", async () => {
  const f = setup();
  f.store.tasks.upsertTaskThread({ taskId: f.task.id, threadId: "thr_worker", title: "Worker", presetName: "Attached", liveStatus: "idle" });
  const { question } = await f.harness.callRpc("createQuestion", { taskId: f.task.id, kind: "check", prompt: "Validate" }) as any;
  expect(question.askedByThread).toBeNull();
  expect(await f.harness.callRpc("questionCounts", { taskIds: [f.task.id] })).toMatchObject({ counts: [{ unanswered: 1, checks: 1, decisions: 0, waitingOnOwner: true }] });
  expect(f.store.tasks.listTasks({ waitingOnOwner: true }).map(t => t.id)).toEqual([f.task.id]);
  await f.harness.callRpc("answerQuestion", { questionId: question.id, revision: 1, answerText: "Needs work" });
  expect(f.harness.sdk.callsTo("threads.send").at(-1)?.[0]).toMatchObject({ threadId: "thr_worker" });
  expect(f.store.tasks.listTasks({ waitingOnOwner: true })).toEqual([]);
});
