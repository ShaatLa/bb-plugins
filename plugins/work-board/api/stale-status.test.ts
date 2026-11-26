import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";
import { initializeTasksSchema, MIGRATIONS } from "../db/schema";
import { staleRows } from "../attention/observe";
import { captureStatements } from "../test-capture";

it("reports recorded diagnostics, filters before pagination, and never moves tasks", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Diagnostics", prefix: "DIA", color: "blue" });
  const create = (title: string, status: "todo" | "in_progress" | "in_review" | "done") => store.tasks.createTask({ projectId: project.id, title, status });
  create("normal", "todo");
  const progress = create("progress", "in_progress");
  const review = create("review", "in_review");
  const done = create("done", "done");
  store.tasks.createComment({ taskId: done.id, kind: "user", authorName: "Owner", body: "ordinary comment" });
  const db = bb.storage.database();
  db.prepare<[string, string, string]>("INSERT INTO task_pr_links VALUES (?, ?, ?)").run(review.id, "x", JSON.stringify({ excluded: true }));
  db.prepare<[string, string, string]>("INSERT INTO git_pr_snapshots(project_id,identity,payload) VALUES (?, ?, ?)").run(project.id, "x", JSON.stringify({ state: "open" }));
  const page = await harness.callRpc("listTasks", { projectId: project.id, staleStatus: true, limit: 1 }) as any;
  expect(page.tasks).toHaveLength(1);
  expect(page.staleStatusFlags[0].flags).toHaveLength(1);
  const next = await harness.callRpc("listTasks", { projectId: project.id, staleStatus: true, limit: 1, cursor: page.nextCursor }) as any;
  expect(next.tasks[0].id).not.toBe(page.tasks[0].id);
  expect(store.tasks.staleStatusFlags().get(review.id)).toEqual(["no_open_pr"]);
  expect(store.tasks.staleStatusFlags().get(progress.id)).toEqual(["no_active_thread"]);
  const holder = create("holder", "in_review");
  db.prepare<[string, string]>("INSERT INTO task_dependencies (task_id, blocking_task_id) VALUES (?, ?)").run(progress.id, holder.id);
  expect(store.tasks.staleStatusFlags().has(progress.id)).toBe(false);
  store.tasks.updateTask(holder.id, { status: "canceled" });
  expect(store.tasks.staleStatusFlags().has(progress.id)).toBe(false);
  store.tasks.updateTask(holder.id, { status: "done" });
  expect(store.tasks.staleStatusFlags().get(progress.id)).toEqual(["no_active_thread"]);
  db.prepare<[string]>("DELETE FROM tasks WHERE id = ?").run(holder.id);
  expect(store.tasks.staleStatusFlags().get(done.id)).toEqual(["no_merge_or_outcome"]);
  const list = await harness.runCli(["list", "--project", "DIA", "--stale-status", "--json"]);
  expect(list.exitCode, list.stderr).toBe(0);
  expect(JSON.parse(list.stdout).tasks).toHaveLength(3);
  const human = await harness.runCli(["list", "--project", "DIA"]);
  expect(human.stdout).toContain("no_open_pr");
  const comment = await harness.runCli(["comment", done.key, "--kind", "outcome", "--body", "Completed", "--json"]);
  expect(comment.exitCode, comment.stderr).toBe(0);
  expect(store.tasks.staleStatusFlags().has(done.id)).toBe(false);
  const show = await harness.runCli(["show", done.key, "--json"]);
  expect(show.exitCode, show.stderr).toBe(0);
  expect(JSON.parse(show.stdout).staleStatusFlags).toEqual([]);
  expect(store.tasks.getTask(progress.id)?.status).toBe("in_progress");
  expect(store.tasks.getTask(review.id)?.status).toBe("in_review");
  await harness.dispose();
});

it("grandfathers existing done comments only until the task leaves done", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Legacy", prefix: "LEG", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Legacy", status: "done" });
  store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Agent", body: "Finished" });
  const db = bb.storage.database();
  db.exec("DROP TRIGGER legacy_done_tasks_leave; DROP TABLE legacy_done_tasks; DELETE FROM schema_version WHERE version=24");
  initializeTasksSchema(db);
  expect(store.tasks.staleStatusFlags().has(task.id)).toBe(false);
  store.tasks.updateTask(task.id, { status: "todo" });
  store.tasks.updateTask(task.id, { status: "done" });
  expect(store.tasks.staleStatusFlags().get(task.id)).toEqual(["no_merge_or_outcome"]);
  await harness.dispose();
});

it("uses configured status IDs and distinguishes unavailable and closed PR snapshots", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Custom", prefix: "CUS", color: "blue" });
  store.tasks.updateProject(project.id, { workflowPolicy: { bugfixStatus: null, doneStatus: "done", inProgressStatus: "todo", reviewStatus: "in_review", testingStatus: null, planningStatus: null, earlyStatuses: [], ownerDecisionLabel: null } });
  const progress = store.tasks.createTask({ projectId: project.id, title: "Working", status: "todo" });
  store.tasks.upsertTaskThread({ taskId: progress.id, threadId: "thr_worker", title: "Worker", presetName: "agent", liveStatus: "working" });
  const review = store.tasks.createTask({ projectId: project.id, title: "PR", status: "in_review" });
  const db = bb.storage.database();
  db.prepare<[string, string, string]>("INSERT INTO task_pr_links VALUES (?, ?, ?)").run(review.id, "pr", JSON.stringify({ excluded: false }));
  expect(store.tasks.staleStatusFlags([progress.id, review.id]).get(progress.id)).toBeUndefined();
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toEqual(["pr_state_unavailable"]);
  db.prepare<[string, string, string]>("INSERT INTO git_pr_snapshots(project_id,identity,payload) VALUES (?, ?, ?)").run(project.id, "pr", JSON.stringify({ state: "closed" }));
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toEqual(["no_open_pr", "closed_unmerged_pr"]);
  db.prepare<[string, string, string]>("UPDATE git_pr_snapshots SET payload=?, error='sync unavailable' WHERE project_id=? AND identity=?").run(JSON.stringify({ state: "merged" }), project.id, "pr");
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toEqual(["no_open_pr"]);
  // Testing after the merge is expected; testing with no PR at all is still flagged.
  store.tasks.updateProject(project.id, { workflowPolicy: { bugfixStatus: null, doneStatus: "done", inProgressStatus: "todo", reviewStatus: "in_review", testingStatus: "in_testing", planningStatus: null, earlyStatuses: [], ownerDecisionLabel: null } });
  const statuses = [...(store.tasks.getProject(project.id)!.statuses ?? [])];
  if (!statuses.some((status) => status.id === "in_testing")) store.tasks.updateProject(project.id, { statuses: [...statuses, { id: "in_testing", name: "In testing" }] });
  const testing = store.tasks.createTask({ projectId: project.id, title: "QA", status: "in_testing" });
  expect(store.tasks.staleStatusFlags([testing.id]).get(testing.id)).toEqual(["no_open_pr"]);
  db.prepare<[string, string, string]>("INSERT INTO task_pr_links VALUES (?, ?, ?)").run(testing.id, "pr", JSON.stringify({ excluded: false }));
  expect(store.tasks.staleStatusFlags([testing.id]).has(testing.id)).toBe(false);
  db.prepare<[string, string, string]>("UPDATE git_pr_snapshots SET payload=?, error='sync unavailable' WHERE project_id=? AND identity=?").run(JSON.stringify({ state: "closed" }), project.id, "pr");
  // A refresh that failed leaves its cached payload behind, but that is no longer a known answer: the board reads it as unavailable, like the ledger.
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toEqual(["pr_state_unavailable"]);
  db.prepare<[string, string, string]>("UPDATE git_pr_snapshots SET payload=?, error=NULL WHERE project_id=? AND identity=?").run(JSON.stringify({ state: "draft" }), project.id, "pr");
  expect(store.tasks.staleStatusFlags([review.id]).has(review.id)).toBe(false);
  const done = store.tasks.createTask({ projectId: project.id, title: "Merged", status: "done" });
  store.tasks.createComment({ taskId: done.id, kind: "agent", authorName: "Agent", body: "Merged", evidence: { kind: "merge", pr: 1, head: "a".repeat(40), merge: "b".repeat(40) } });
  expect(store.tasks.staleStatusFlags([done.id]).has(done.id)).toBe(false);
  await harness.dispose();
});

it("scopes the raw rows by ids and by project together, and an empty id list selects nothing", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const a = store.tasks.createProject({ name: "First", prefix: "FST", color: "blue" });
  const b = store.tasks.createProject({ name: "Second", prefix: "SND", color: "red" });
  const inA = store.tasks.createTask({ projectId: a.id, title: "A", status: "in_progress" });
  const inB = store.tasks.createTask({ projectId: b.id, title: "B", status: "in_progress" });
  const db = bb.storage.database();
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
  expect(ids(staleRows(db, [inA.id, inB.id]))).toEqual([inA.id, inB.id].sort());
  expect(ids(staleRows(db, [inA.id, inB.id], a.id))).toEqual([inA.id]);
  expect(ids(staleRows(db, [inA.id], b.id))).toEqual([]);
  expect(staleRows(db, [])).toEqual([]);
  expect(ids(staleRows(db, undefined, b.id))).toEqual([inB.id]);
  expect(ids(staleRows(db))).toEqual([inA.id, inB.id].sort());
  // The ID-scoped read seeks tasks by key instead of scanning them: EXPLAIN the statement the call itself runs, with its own bindings.
  const capture = captureStatements(db);
  try {
    staleRows(db, [inA.id], a.id);
    const [call, ...rest] = capture.take().filter((statement) => /^\s*SELECT t\.id, t\.project_id/.test(statement.sql));
    expect(rest).toEqual([]);
    expect(capture.plan(call!)).toMatch(/SEARCH t USING .*\(id=\?\)/);
    expect(capture.plan(call!)).not.toMatch(/SCAN t\b/);
  } finally { capture.restore(); }
  await harness.dispose();
});

it("does not flag a card waiting on an open owner question as having no active thread", () => {
  const { bb } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Waiting", prefix: "WAI", color: "blue" });
  const card = store.tasks.createTask({ projectId: project.id, title: "waits", status: "in_progress" });
  const db = bb.storage.database();
  const setQuestion = (id: string, payload: Record<string, unknown>) =>
    db.prepare<[string, string, string]>("INSERT INTO task_questions (id, task_id, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload")
      .run(id, card.id, JSON.stringify({ selectedOptionIds: [], answerText: "", ...payload }));
  const observed = () => store.tasks.staleStatusObservations(project.id, [card.id])[0]!.signals.no_active_thread.present;
  expect(store.tasks.staleStatusFlags().get(card.id)).toEqual(["no_active_thread"]);
  expect(observed()).toBe(true);
  setQuestion("q1", {});
  expect(store.tasks.staleStatusFlags().has(card.id)).toBe(false);
  expect(observed()).toBe(false);
  setQuestion("q1", { answerText: "Confirmed" });
  expect(store.tasks.staleStatusFlags().get(card.id)).toEqual(["no_active_thread"]);
  expect(observed()).toBe(true);
  setQuestion("q2", { withdrawnAt: "2000-01-01T00:00:00.000Z" });
  setQuestion("q3", { supersededBy: "q4" });
  expect(store.tasks.staleStatusFlags().get(card.id)).toEqual(["no_active_thread"]);
  store.tasks.updateTask(card.id, { status: "todo" });
  setQuestion("q5", {});
  store.tasks.updateTask(card.id, { status: "in_progress" });
  expect(store.tasks.staleStatusFlags().has(card.id)).toBe(false);
});

it("retains PR history after unlinking the last PR and deleting its card", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const review = store.tasks.createTask({ projectId: project.id, title: "Review", status: "in_review" });
  const linked = store.tasks.createTask({ projectId: project.id, title: "Linked", status: "todo" });
  const db = bb.storage.database();
  expect(store.tasks.staleStatusFlags([review.id]).has(review.id)).toBe(false);
  db.prepare("INSERT INTO task_pr_links(task_id,identity,payload) VALUES (?, ?, ?)").run(linked.id, "example/one#1", JSON.stringify({ excluded: true }));
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toContain("no_open_pr");
  db.prepare("DELETE FROM task_pr_links WHERE task_id=?").run(linked.id);
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toContain("no_open_pr");
  db.prepare("INSERT INTO task_pr_links(task_id,identity,payload) VALUES (?, ?, ?)").run(linked.id, "example/one#1", JSON.stringify({ excluded: true }));
  store.tasks.deleteTask(linked.id);
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toContain("no_open_pr");
  await harness.dispose();
});

it("backfills project PR history when upgrading an existing database", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Linked", status: "todo" });
  const db = bb.storage.database();
  db.exec("DROP TRIGGER project_pr_history_insert; DROP TRIGGER project_pr_history_move; DROP TABLE project_pr_history");
  db.prepare("DELETE FROM schema_version WHERE version=?").run(MIGRATIONS.length - 2);
  db.prepare("INSERT INTO task_pr_links(task_id,identity,payload) VALUES (?, ?, ?)").run(task.id, "example/one#1", JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z" }));
  initializeTasksSchema(db);
  expect(db.prepare("SELECT first_linked_at FROM project_pr_history WHERE project_id=?").get(project.id)).toEqual({ first_linked_at: "2026-01-01T00:00:00.000Z" });
  await harness.dispose();
});

it("records PR history when the first linked card moves into another project", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const source = store.tasks.createProject({ name: "Source", prefix: "SRC", color: "blue" });
  const target = store.tasks.createProject({ name: "Target", prefix: "DST", color: "blue" });
  const linked = store.tasks.createTask({ projectId: source.id, title: "Linked", status: "todo" });
  const review = store.tasks.createTask({ projectId: target.id, title: "Review", status: "in_review" });
  const db = bb.storage.database();
  db.prepare("INSERT INTO task_pr_links(task_id,identity,payload) VALUES (?, ?, ?)").run(linked.id, "example/one#1", JSON.stringify({ excluded: true }));
  expect(store.tasks.staleStatusFlags([review.id]).has(review.id)).toBe(false);
  store.tasks.moveTaskToProject(linked.id, target.id);
  expect(store.tasks.staleStatusFlags([review.id]).get(review.id)).toContain("no_open_pr");
  expect(db.prepare("SELECT first_linked_at FROM project_pr_history WHERE project_id=?").get(target.id)).toEqual({ first_linked_at: expect.any(String) });
  await harness.dispose();
});
