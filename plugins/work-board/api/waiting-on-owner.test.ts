import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";
import { createStructuredStore } from "../structured/store";
import { navigationBadgeCounts } from "./badge";
import { captureProject, archiveRecords } from "../archive/storage";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(h => h.harness.dispose())); });
function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Waiting", prefix: "WAIT", color: "blue" });
  const structured = createStructuredStore(host.bb, store);
  const task = (title: string, extra = {}) => store.tasks.createTask({ projectId: project.id, title, ...extra });
  const question = (taskId: string) => structured.handlers.createQuestion({ kind: "decision", askedByThread: null, taskId, prompt: "First line\nSecond line", options: ["Yes", "No"], mode: "single" });
  return { ...host, store, project, task, question };
}
it("filters waiting tasks before pagination, orders questions first and respects explicit sorts", async () => {
  const f = setup();
  const owner = f.task("Owner", { });
  await f.harness.callRpc("createQuestion", { taskId: owner.id, kind: "check", prompt: "Validate" });
  const older = f.task("Older question");
  const newer = f.task("Newer question");
  const quiet = f.task("Quiet");
  const done = f.task("Done", { status: "done", });
  const canceled = f.task("Canceled", { status: "canceled", });
  const archived = f.task("Archived", { status: "done", });
  f.store.tasks.setTaskArchived(archived.id, true);
  f.bb.storage.database().prepare("UPDATE tasks SET status='todo' WHERE id=?").run(archived.id);
  const template = f.task("Hidden template", { });
  f.bb.storage.database().prepare("INSERT INTO task_scheduled_sources(task_id, schedule_id, schedule_title, role) VALUES (?, '00000000-0000-0000-0000-000000000000', 'Hidden', 'template')").run(template.id);
  for (const task of [older, newer, done, canceled, archived]) await f.question(task.id);
  f.bb.storage.database().prepare("UPDATE task_questions SET payload=json_set(payload, '$.createdAt', ?) WHERE task_id=?").run("2026-01-01T00:00:00Z", older.id);
  f.bb.storage.database().prepare("UPDATE task_questions SET payload=json_set(payload, '$.createdAt', ?) WHERE task_id=?").run("2026-02-01T00:00:00Z", newer.id);
  f.bb.storage.database().prepare("UPDATE task_questions SET payload=json_set(payload, '$.createdAt', ?) WHERE task_id=?").run("2025-01-01T00:00:00Z", owner.id);
  const input = { waitingOnOwner: true, projectId: f.project.id, limit: 1 };
  const first = f.store.tasks.listTasksPage(input);
  const second = f.store.tasks.listTasksPage({ ...input, cursor: first.nextCursor! });
  const third = f.store.tasks.listTasksPage({ ...input, cursor: second.nextCursor! });
  expect([first.tasks[0].id, second.tasks[0].id, third.tasks[0].id]).toEqual([newer.id, older.id, owner.id]);
  expect(third.nextCursor).toBeNull();
  const explicit = f.store.tasks.listTasksPage({ ...input, sort: "newest", limit: 10 });
  expect(explicit.tasks.map(t => t.id)).toEqual([owner, older, newer].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(t => t.id));
  expect(navigationBadgeCounts(f.bb, f.store, ["waiting_on_owner"], Date.now())).toEqual({ count: 3, counts: { waiting_on_owner: 3 } });
  const list = await f.harness.runCli(["list", "--waiting-on-owner", "--project", "WAIT", "--limit", "1", "--json"]);
  expect(list.exitCode).toBe(0);
  expect(JSON.parse(list.stdout).tasks[0]).toMatchObject({ id: newer.id, waitingOnOwner: true });
  const show = await f.harness.runCli(["show", newer.key, "--json"]);
  expect(JSON.parse(show.stdout).task.waitingOnOwner).toBe(true);
  expect(JSON.parse((await f.harness.runCli(["show", quiet.key, "--json"])).stdout).task.waitingOnOwner).toBe(false);
  const allRows = JSON.parse((await f.harness.runCli(["list", "--json"])).stdout).tasks;
  expect(allRows.find((row: { id: string }) => row.id === quiet.id).waitingOnOwner).toBe(false);
  expect((await f.harness.runCli(["list", "--waiting-on-owner", "--project", "WAIT"])).stdout).toContain(newer.title);
  expect((await f.harness.runCli(["show", newer.key])).stdout).toContain("Waiting on you: First line");
  expect((await f.harness.runCli(["show", owner.key])).stdout).toContain("Waiting on you: Validate");
  expect(JSON.stringify(await archiveRecords(f.store, captureProject(f.bb, f.store, f.project.id), async () => {}))).not.toContain("waitingOnOwner");
});
it.each([false, true])("upgrades badge settings once (saved=%s), preserving later removal", async saved => {
  const f = setup();
  if (saved) await f.bb.storage.kv.set("navigation-badge:criteria", ["owner"]);
  expect(await f.harness.callRpc("getNavigationBadgeCriteria", null)).toEqual({ criteria: saved ? ["waiting_on_owner"] : ["open", "waiting_on_owner"] });
  await f.harness.callRpc("setNavigationBadgeCriteria", { criteria: ["waiting_on_owner"] });
  expect(await f.harness.callRpc("getNavigationBadgeCriteria", null)).toEqual({ criteria: ["waiting_on_owner"] });
});
it.each(["text", "json"])("warns on question add in %s without preventing creation", async mode => {
  const f = setup();
  for (const [status, progressNote, warn] of [["backlog", null, true], ["todo", null, true], ["todo", "Need access", false], ["in_progress", null, false]] as const) {
    const task = f.task("Question", { status });
    if (progressNote) f.store.tasks.updateTask(task.id, { progressNote, authorName: "Owner" });
    const result = await f.harness.runCli(["question", "add", task.key, "--prompt", "Proceed?", "--option", "Yes", "--option", "No", ...(mode === "json" ? ["--json"] : [])]);
    expect(result.exitCode).toBe(0);
    const warnings = mode === "json" ? JSON.parse(result.stdout).warnings.join("\n") : result.stderr;
    expect(warnings.includes("with no Current state")).toBe(warn);
    expect((await f.harness.callRpc("listQuestions", { taskId: task.id }) as any).questions).toHaveLength(1);
  }
});

it("warns on long or multi-link question prompts and still saves them", async () => {
  const f = setup();
  const task = f.task("Acceptance", { status: "in_progress" });
  for (const [prompt, warn] of [["Is http://a.test right?", false], ["x".repeat(301), true], ["Compare http://a.test and http://b.test?", true]] as const) {
    const result = await f.harness.runCli(["question", "add", task.key, "--kind", "check", "--prompt", prompt, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).warnings.join("\n").includes("one decision or one check")).toBe(warn);
  }
  expect((await f.harness.callRpc("listQuestions", { taskId: task.id }) as any).questions).toHaveLength(3);
});

it("excludes tasks without questions", () => {
  const f = setup();
  const older = f.task("Older owner action", { });
  const newer = f.task("Newer owner action", { });
  f.bb.storage.database().prepare("UPDATE tasks SET updated_at=? WHERE id=?").run("2026-01-01T00:00:00Z", older.id);
  f.bb.storage.database().prepare("UPDATE tasks SET updated_at=? WHERE id=?").run("2026-02-01T00:00:00Z", newer.id);
  expect(f.store.tasks.listTasksPage({ waitingOnOwner: true }).tasks.map(t => t.id)).toEqual([]);
});
