import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api";
import { endPauses, startManualPause } from "./store";

it("logs a manual pause and ends it atomically on a status change", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  startManualPause(db, task.id, "Waiting", 60_000, "thr_example");
  expect(store.tasks.staleStatusFlags([task.id]).has(task.id)).toBe(false);
  expect(() => db.prepare("UPDATE tasks SET status='todo' WHERE id=?").run(task.id)).toThrow();
  store.tasks.updateTask(task.id, { status: "todo" });
  expect(db.prepare("SELECT event, end_reason FROM pause_log ORDER BY id").all()).toEqual([
    { event: "start", end_reason: null }, { event: "end", end_reason: "status_change" },
  ]);
  expect(db.prepare("SELECT count(*) AS n FROM task_pauses WHERE task_id=?").get(task.id)).toEqual({ n: 0 });
  expect(db.transaction(() => endPauses(db, task.id, "resume", "owner"))()).toBe(0);
  await harness.dispose();
});

it("exposes pause, show, history and resume through the CLI", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const { registerTasksApi } = await import("../api");
  const { registerTasksCli } = await import("../cli");
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const paused = await harness.runCli(["pause", task.key, "--reason", "Waiting", "--for", "1h"]);
  expect(paused.exitCode, paused.stderr).toBe(0);
  const show = await harness.runCli(["show", task.key, "--json"]);
  expect(show.exitCode, show.stderr).toBe(0);
  expect(JSON.parse(show.stdout).pauses).toHaveLength(1);
  const log = await harness.runCli(["pause", "log", task.key, "--json"]);
  expect(log.exitCode, log.stderr).toBe(0);
  expect(JSON.parse(log.stdout).entries).toHaveLength(1);
  const resume = await harness.runCli(["resume", task.key]);
  expect(resume.exitCode, resume.stderr).toBe(0);
  expect((await harness.runCli(["resume", task.key])).stdout).toContain("not paused");
  await harness.dispose();
});

it("ends a pause on a new linked executor or an agent takeover, but not on an owner comment", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  startManualPause(db, task.id, "Waiting", 60_000, "thr_example");
  store.tasks.createComment({ taskId: task.id, kind: "user", authorName: "Owner", body: "Note" });
  expect(db.prepare("SELECT count(*) AS n FROM task_pauses").get()).toEqual({ n: 1 });
  store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_other", title: "Worker", presetName: "Agent", liveStatus: "idle" });
  expect(db.prepare("SELECT end_reason FROM pause_log WHERE event='end'").get()).toEqual({ end_reason: "takeover" });
  startManualPause(db, task.id, "Waiting", 60_000, "thr_example");
  // A turn start alone ends nothing: only real input admitted by the dispatch gate does.
  store.tasks.updateTaskThreadStatus(store.tasks.listTaskThreads(task.id)[0]!.id, "working");
  expect(db.prepare("SELECT count(*) AS n FROM task_pauses").get()).toEqual({ n: 1 });
  store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Agent", threadId: "thr_new", body: "Taking over" });
  expect(db.prepare("SELECT end_reason FROM pause_log WHERE event='end' ORDER BY id DESC").get()).toEqual({ end_reason: "takeover" });
  startManualPause(db, task.id, "Waiting", 60_000, "thr_example");
  store.tasks.updateTask(task.id, { title: "Taken over", closerThreadId: "thr_new" });
  expect(db.prepare("SELECT end_reason FROM pause_log WHERE event='end' ORDER BY id DESC").get()).toEqual({ end_reason: "takeover" });
  await harness.dispose();
});

it("ends a pause when the board moves a task", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  startManualPause(db, task.id, "Waiting", 60_000, "thr_example");
  store.tasks.updatePosition(task.id, { status: "todo" });
  expect(db.prepare("SELECT end_reason,thread_id FROM pause_log WHERE event='end'").get()).toEqual({ end_reason: "status_change", thread_id: "owner" });
  await harness.dispose();
});

it("validates, replaces and expires manual pauses", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const closed = store.tasks.createTask({ projectId: project.id, title: "Closed", status: "done" });
  const db = bb.storage.database();
  expect(() => startManualPause(db, task.id, "Waiting", 9 * 3600_000, "owner")).toThrow(/8 hours/);
  expect(() => startManualPause(db, closed.id, "Waiting", 60_000, "owner")).toThrow(/closed/);
  startManualPause(db, task.id, "First", 60_000, "owner");
  startManualPause(db, task.id, "Second", 60_000, "owner");
  expect(db.prepare("SELECT end_reason FROM pause_log WHERE event='end'").get()).toEqual({ end_reason: "replaced" });
  db.prepare("UPDATE task_pauses SET until='2000-01-01T00:00:00.000Z'").run();
  const { sweepPauseSignals } = await import("./signals");
  await sweepPauseSignals(bb);
  expect(db.prepare("SELECT end_reason FROM pause_log WHERE event='end' ORDER BY id DESC").get()).toEqual({ end_reason: "expired" });
  expect(store.tasks.staleStatusFlags([task.id]).get(task.id)).toContain("no_active_thread");
  await harness.dispose();
});
