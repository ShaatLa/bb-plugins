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
  for (const bad of ["0m", "59s", "1w", "-1h"]) expect((await harness.runCli(["pause", task.key, "--reason", "Waiting", "--for", bad])).exitCode, bad).not.toBe(0);
  const long = await harness.runCli(["pause", task.key, "--reason", "Waiting", "--for", "3d", "--json"]);
  expect(long.exitCode, long.stderr).toBe(0);
  expect(Date.parse(JSON.parse(long.stdout).until) - Date.now()).toBeGreaterThan(2.99 * 86_400_000);
  const rpc = await harness.callRpc("pauseTask", { taskId: task.id, reason: "Waiting", durationMs: 3 * 86_400_000, actor: "owner" }) as { until: string };
  expect(Date.parse(rpc.until) - Date.now()).toBeGreaterThan(2.99 * 86_400_000);
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
  expect(() => startManualPause(db, task.id, "Waiting", 59_000, "owner")).toThrow(/at least 1 minute/);
  expect(() => startManualPause(db, task.id, "Waiting", 1e18, "owner")).toThrow(/before the year 10000/);
  expect(startManualPause(db, task.id, "Long", 3 * 86400_000, "owner").until).toBeTruthy();
  expect(Date.parse(db.prepare<[], { until: string }>("SELECT until FROM task_pauses").get()!.until) - Date.now()).toBeGreaterThan(2.9 * 86400_000);
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

it("replacing manual and background pauses leaves held pauses, and resume leaves them too", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  const { startSignalPause } = await import("./store");
  startManualPause(db, task.id, "Waiting", 3600000, "owner");
  startSignalPause(db, task.id, "background", "thr_example", "Running", true);
  startSignalPause(db, task.id, "held", "system", "Waiting", true);
  startManualPause(db, task.id, "Waiting", 7200000, "owner");
  expect(db.prepare("SELECT signal,end_reason FROM pause_log WHERE event='end' ORDER BY signal").all()).toEqual([{ signal: "background", end_reason: "replaced" }, { signal: "manual", end_reason: "replaced" }]);
  expect(db.prepare("SELECT signal FROM task_pauses ORDER BY signal").all()).toEqual([{ signal: "held" }, { signal: "manual" }]);
  db.transaction(() => endPauses(db, task.id, "resume", "owner"))();
  expect(db.prepare("SELECT signal FROM task_pauses").all()).toEqual([{ signal: "held" }]);
  await harness.dispose();
});

it("expires a pause past its deadline before setting a new one, and counts the gap from the deadline", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const db = bb.storage.database();
  const coverage = (id: string) => db.prepare<[string], { coverage_started_at: string; started_at: string }>("SELECT coverage_started_at,started_at FROM task_pauses WHERE task_id=?").get(id)!;
  for (const [gap, inherits] of [[10 * 60_000, false], [3 * 60_000, true]] as const) {
    const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
    const old = startManualPause(db, task.id, "Waiting", 60_000, "thr_example");
    const deadline = new Date(Date.now() - gap).toISOString(), began = new Date(Date.now() - gap - 60_000).toISOString();
    // Past its deadline, and the sweep has not ended it yet.
    db.prepare("UPDATE task_pauses SET started_at=?, coverage_started_at=?, until=? WHERE id=?").run(began, began, deadline, old.id);
    const fresh = startManualPause(db, task.id, "Again", 3600_000, "thr_example");
    expect(db.prepare("SELECT end_reason,until FROM pause_log WHERE task_id=? AND event='end'").all(task.id)).toEqual([{ end_reason: "expired", until: deadline }]);
    expect(db.prepare("SELECT pause_id,state,setter,reason FROM pause_expiry_notices WHERE task_id=?").all(task.id)).toEqual([{ pause_id: old.id, state: "pending", setter: "thr_example", reason: "Waiting" }]);
    expect(coverage(task.id).coverage_started_at).toBe(inherits ? began : fresh.started_at);
  }
  // Extending a running pause is still a replacement, with no notice.
  const running = store.tasks.createTask({ projectId: project.id, title: "Running", status: "in_progress" });
  startManualPause(db, running.id, "Waiting", 3600_000, "thr_example");
  startManualPause(db, running.id, "Longer", 7200_000, "thr_example");
  expect(db.prepare("SELECT count(*) AS n FROM pause_expiry_notices WHERE task_id=?").get(running.id)).toEqual({ n: 0 });
  await harness.dispose();
});

it("rejects an end in the year 10000 and keeps one in 9999 from expiring at once", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  expect(() => startManualPause(db, task.id, "Waiting", Date.UTC(10000, 0, 1) - Date.now() + 1000, "thr_example")).toThrow(/before the year 10000/);
  expect(db.prepare("SELECT count(*) AS n FROM task_pauses").get()).toEqual({ n: 0 });
  const row = startManualPause(db, task.id, "Waiting", Date.UTC(9999, 11, 31) - Date.now(), "thr_example");
  expect(row.until).toMatch(/^9999-12-31T/);
  const { sweepPauseSignals } = await import("./signals");
  await sweepPauseSignals(bb);
  expect(db.prepare("SELECT count(*) AS n FROM task_pauses").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT count(*) AS n FROM pause_expiry_notices").get()).toEqual({ n: 0 });
  await harness.dispose();
});
