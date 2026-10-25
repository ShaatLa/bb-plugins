import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";
import plugin from "../server";
import { autoArchiveTasks } from "../lifecycle/task-archive";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});
function setup() {
  const host = createFakePluginHost({ pluginId: "agent-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({
    name: "Archive",
    prefix: "ARC",
    color: "blue",
  });
  registerTasksCli(host.bb, store, { name: "Agent Board", version: "0.8.1" });
  return { ...host, store, project };
}
function clock(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

it("filters inclusive UTC dates before newest-first pagination, including equal timestamps and cursor mismatches", async () => {
  const f = setup();
  clock("2026-09-01T12:00:00.000Z");
  const old = f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Old",
    status: "done",
  });
  clock("2026-10-01T00:00:00.000Z");
  f.store.tasks.setTaskArchived(old.id, true);
  const first = f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Same time",
    status: "done",
    description: "Find this content",
  });
  const second = f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Same time",
    status: "done",
  });
  clock("2026-10-01T23:59:59.999Z");
  f.store.tasks.setTaskArchived(first.id, true);
  f.store.tasks.setTaskArchived(second.id, true);
  clock("2026-10-02T00:00:00.000Z");
  const next = f.store.tasks.createTask({
    projectId: f.project.id,
    title: "Next day",
    status: "done",
  });
  f.store.tasks.setTaskArchived(next.id, true);
  const filters = {
    archive: "archived" as const,
    sort: "newest" as const,
    dateFrom: "2026-10-01",
    dateTo: "2026-10-01",
    limit: 1,
  };
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = f.store.tasks.listTasksPage({ ...filters, cursor });
    ids.push(...page.tasks.map((task) => task.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toEqual([second.id, first.id, old.id]);
  const page = f.store.tasks.listTasksPage(filters);
  expect(() =>
    f.store.tasks.listTasksPage({
      ...filters,
      dateField: "created",
      cursor: page.nextCursor!,
    }),
  ).toThrow("filters");
  expect(() =>
    f.store.tasks.listTasksPage({ ...filters, dateFrom: "2026-02-30" }),
  ).toThrow();
  expect(() =>
    f.store.tasks.listTasksPage({ ...filters, dateFrom: "2026-10-02" }),
  ).toThrow("Start date");
  const byCreated = f.store.tasks.listTasks({
    ...filters,
    dateField: "created",
  });
  expect(byCreated.map((task) => task.id)).toEqual([second.id, first.id]);
  expect(
    f.store.tasks
      .listTasks({ ...filters, search: "Find this content" })
      .map((task) => task.id),
  ).toEqual([first.id]);
  expect(
    f.store.tasks
      .listTasks({ ...filters, search: second.key })
      .map((task) => task.id),
  ).toEqual([second.id]);

  const run = await f.harness.runCli([
    "list",
    "--project",
    "ARC",
    "--archived",
    "--on",
    "2026-10-01",
    "--latest",
    "2",
    "--json",
  ]);
  expect(run.exitCode).toBe(0);
  expect(
    JSON.parse(run.stdout).tasks.map((task: { id: string }) => task.id),
  ).toEqual([second.id, first.id]);
  expect(JSON.parse(run.stdout).nextCursor).toBeTruthy();
  for (const args of [
    ["--on", "2026-10-01", "--from", "2026-10-01"],
    ["--on", "2026-02-30"],
    ["--from", "2026-10-02", "--to", "2026-10-01"],
  ]) {
    expect(
      (
        await f.harness.runCli([
          "list",
          "--project",
          "ARC",
          "--archived",
          ...args,
        ])
      ).exitCode,
    ).not.toBe(0);
  }
});

it("automatically archives only inactive completed families without unanswered questions or live work", async () => {
  const f = setup();
  clock("2026-10-01T12:00:00.000Z");
  const create = (title: string) =>
    f.store.tasks.createTask({
      projectId: f.project.id,
      title,
      status: "done",
    });
  const eligible = create("Eligible");
  const child = f.store.tasks.createTask({
    projectId: f.project.id,
    parentTaskId: eligible.id,
    title: "Child",
    status: "canceled",
  });
  const recentComment = create("Recent comment");
  const openQuestion = create("Unanswered question");
  const recentAnswer = create("Recent answer");
  const working = create("Agent still working");
  f.store.tasks.upsertTaskThread({
    taskId: working.id,
    threadId: "thr_working",
    presetName: "Agent",
    title: "Worker",
    liveStatus: "working",
  });
  const blocked = create("Unfinished child");
  f.store.tasks.createTask({
    projectId: f.project.id,
    parentTaskId: blocked.id,
    title: "Not done",
  });
  await f.harness.callRpc("createQuestion", {
    taskId: openQuestion.id,
    prompt: "Choose?",
    options: ["One", "Two"],
  });
  const { question } = (await f.harness.callRpc("createQuestion", {
    taskId: recentAnswer.id,
    prompt: "Decision?",
    options: ["One", "Two"],
  })) as { question: { id: string; options: { id: string }[] } };
  clock("2026-10-09T12:00:00.000Z");
  f.store.tasks.createComment({
    taskId: recentComment.id,
    kind: "user",
    authorName: "Owner",
    body: "Fresh context",
  });
  await f.harness.callRpc("answerQuestion", {
    questionId: question.id,
    revision: 1,
    selectedOptionIds: [question.options[0]!.id],
  });
  const fresh = create("Fresh task");
  clock("2026-10-10T12:00:00.000Z");
  expect(autoArchiveTasks(f.bb, f.store, 7)).toBe(2);
  for (const task of [eligible, child])
    expect(f.store.tasks.getTask(task.id)?.archivedAt).toBeTruthy();
  for (const task of [
    recentComment,
    openQuestion,
    recentAnswer,
    working,
    blocked,
    fresh,
  ])
    expect(f.store.tasks.getTask(task.id)?.archivedAt).toBeNull();
  expect(f.store.tasks.listComments(eligible.id).at(-1)?.body).toContain(
    "automatically archived",
  );
  expect(autoArchiveTasks(f.bb, f.store, 7)).toBe(0);
  f.store.tasks.setTaskArchived(eligible.id, false);
  expect(autoArchiveTasks(f.bb, f.store, 7)).toBe(0);
  expect(() => autoArchiveTasks(f.bb, f.store, 0)).toThrow("interval");
});

it("defaults automatic archival to off and reads the setting again on each hourly run", async () => {
  const host = createFakePluginHost({ pluginId: "agent-board" });
  hosts.push(host);
  await plugin(host.bb);
  const store = createStore(host.bb);
  clock("2026-10-01T12:00:00.000Z");
  const project = store.tasks.createProject({
    name: "Scheduled",
    prefix: "SCH",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Old completed",
    status: "done",
  });
  clock("2026-10-10T12:00:00.000Z");
  await host.harness.behavior.runSchedule("auto-archive-tasks");
  expect(store.tasks.getTask(task.id)?.archivedAt).toBeNull();
  await host.harness.behavior.setSettings({ autoArchiveAfterDays: "14" });
  await host.harness.behavior.runSchedule("auto-archive-tasks");
  expect(store.tasks.getTask(task.id)?.archivedAt).toBeNull();
  await host.harness.behavior.setSettings({ autoArchiveAfterDays: "7" });
  await host.harness.behavior.runSchedule("auto-archive-tasks");
  expect(store.tasks.getTask(task.id)?.archivedAt).toBeTruthy();
});
