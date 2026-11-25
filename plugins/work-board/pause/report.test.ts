import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api";
import { pauseReport } from "./report";
import { pauseArm, setPauseMode } from "./store";

it("clips sample intervals, reports gaps, and refuses windows beyond retention", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  setPauseMode(db, project.id, "ab");
  const end = Date.now();
  const start = end - 8 * 86400_000;
  db.prepare("UPDATE pause_log SET at=? WHERE project_id=? AND event='mode'").run(new Date(start).toISOString(), project.id);
  for (let at = start + 300_000; at < end - 300_000; at += 600_000) {
    const stamp = new Date(at).toISOString();
    db.prepare("INSERT INTO pause_sample_runs(project_id,at) VALUES (?,?)").run(project.id, stamp);
    db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(stamp, project.id, task.id, pauseArm(task.id), "in_progress", 1, 0, 0, 0, 1);
  }
  const report = pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end);
  expect(report.window.unsampledMs).toBe(600_000);
  expect(report.arms[pauseArm(task.id)].cardDays).toBeCloseTo((8 * 86400_000 - 600_000) / 86400_000, 5);
  expect(report.verdict).toBe("extend: not enough data");
  db.prepare("DELETE FROM pause_samples WHERE at>? AND at<?").run(new Date(start + 86400_000).toISOString(), new Date(start + 3 * 86400_000).toISOString());
  db.prepare("DELETE FROM pause_sample_runs WHERE at>? AND at<?").run(new Date(start + 86400_000).toISOString(), new Date(start + 3 * 86400_000).toISOString());
  expect(pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end).verdict).toBe("extend: incomplete sampling");
  expect(() => pauseReport(db, project.id, new Date(end - 31 * 86400_000).toISOString(), undefined, end)).toThrow(/30-day/);
  await harness.dispose();
});

it("counts an idle episode as a miss even if the only comments are pause bookkeeping", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  setPauseMode(db, project.id, "ab");
  const end = Date.now(), start = end - 2 * 3600_000, lookback = start - 8 * 3600_000;
  db.prepare("UPDATE pause_log SET at=? WHERE project_id=? AND event='mode'").run(new Date(lookback).toISOString(), project.id);
  for (let at = lookback; at < end; at += 600_000) {
    const stamp = new Date(at).toISOString();
    db.prepare("INSERT INTO pause_sample_runs VALUES (?,?)").run(project.id, stamp);
    db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(stamp, project.id, task.id, pauseArm(task.id), "in_progress", 1, 0, 0, 1, 0);
  }
  const report = pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end);
  const arm = report.arms[pauseArm(task.id)];
  expect(arm.misses).toBe(1);
  expect(arm.totalUnflaggedMs).toBe(2 * 3600_000);
  expect(report.verdict).toBe("extend: under 7 days");
  const before = new Date(start - 3600_000).toISOString();
  db.prepare("INSERT INTO manager_attention(id,tracker_id,task_id,task_key,kind,signal,first_seen_at,eligible_at,cleared_at,created_rev,rev) VALUES ('old',?,?,'EXA-1','stale-status','no_active_thread',?,?,?,1,1)").run(project.id, task.id, before, before, before);
  db.prepare("INSERT INTO attention_attempts(attempt_id,tracker_id,kind,generation,batch_id,recipient_thread_id,recipient_source,started_at,outcome,accepted_at,rev) VALUES ('a',?,'stale-status',1,'b','thr_example','manager',?,'queued',?,1)").run(project.id, before, before);
  db.prepare("INSERT INTO attention_attempt_items VALUES ('a','old')").run();
  expect(pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end).arms[pauseArm(task.id)].misses).toBe(1);
  db.prepare("UPDATE manager_attention SET cleared_at=NULL WHERE id='old'").run();
  expect(pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end).arms[pauseArm(task.id)].misses).toBe(0);
  const withinHour = new Date(start + 30 * 60_000).toISOString();
  db.prepare("UPDATE attention_attempts SET accepted_at=? WHERE attempt_id='a'").run(withinHour);
  expect(pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end).arms[pauseArm(task.id)].misses).toBe(0);
  await harness.dispose();
});

it("uses the predefined thresholds for keep and switch off", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const cards = new Map<string, string>();
  while (cards.size < 2) {
    const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
    cards.set(pauseArm(task.id), task.id);
  }
  const db = bb.storage.database();
  setPauseMode(db, project.id, "ab");
  const end = Date.now(), start = end - 8 * 86400_000;
  db.prepare("UPDATE pause_log SET at=? WHERE project_id=? AND event='mode'").run(new Date(start).toISOString(), project.id);
  for (let at = start; at < end; at += 600_000) {
    const stamp = new Date(at).toISOString();
    db.prepare("INSERT INTO pause_sample_runs VALUES (?,?)").run(project.id, stamp);
    for (const [arm, id] of cards) db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(stamp, project.id, id, arm, "in_progress", 1, 0, 0, 0, 1);
  }
  function notice(arm: string, i: number) {
    const id = `${arm}-${i}`, taskId = cards.get(arm)!;
    const at = new Date(start + (i + 1) * 3600_000).toISOString();
    db.prepare("INSERT INTO manager_attention(id,tracker_id,task_id,task_key,kind,signal,first_seen_at,eligible_at,created_rev,rev) VALUES (?,?,?,'EXA-1','stale-status','no_active_thread',?,?,?,?)").run(id, project.id, taskId, at, at, i, i);
    db.prepare("INSERT INTO attention_attempts(attempt_id,tracker_id,kind,generation,batch_id,recipient_thread_id,recipient_source,started_at,outcome,accepted_at,rev) VALUES (?,?,'stale-status',1,?,'thr_example','manager',?,'queued',?,?)").run(id, project.id, id, at, at, i);
    db.prepare("INSERT INTO attention_attempt_items VALUES (?,?)").run(id, id);
  }
  for (let i = 0; i < 20; i++) notice("control", i);
  for (let i = 0; i < 10; i++) notice("auto", i);
  expect(pauseReport(db, project.id, undefined, undefined, end).verdict).toBe("keep");
  for (let i = 10; i < 15; i++) notice("auto", i);
  expect(pauseReport(db, project.id, undefined, undefined, end).verdict).toBe("switch off");
  await harness.dispose();
});

it("clips A/B time and censors a late notice and a late episode", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  setPauseMode(db, project.id, "ab");
  const end = Date.now(), abStart = end - 10 * 3600_000, requestedStart = abStart - 3600_000;
  db.prepare("UPDATE pause_log SET at=? WHERE project_id=? AND event='mode'").run(new Date(abStart).toISOString(), project.id);
  for (let at = abStart; at < end; at += 600_000) {
    const stamp = new Date(at).toISOString();
    db.prepare("INSERT INTO pause_sample_runs VALUES (?,?)").run(project.id, stamp);
    db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(stamp, project.id, task.id, pauseArm(task.id), "in_progress", 1, 0, 0, 0, at === end - 8.5 * 3600_000 ? 1 : 0);
  }
  const noticeAt = new Date(end - 15 * 60_000).toISOString();
  db.prepare("INSERT INTO manager_attention(id,tracker_id,task_id,task_key,kind,signal,first_seen_at,eligible_at,created_rev,rev) VALUES ('late',?,?,'EXA-1','stale-status','no_active_thread',?,?,1,1)").run(project.id, task.id, noticeAt, noticeAt);
  db.prepare("INSERT INTO attention_attempts(attempt_id,tracker_id,kind,generation,batch_id,recipient_thread_id,recipient_source,started_at,outcome,accepted_at,rev) VALUES ('late',?,'stale-status',1,'late','thr_example','manager',?,'queued',?,1)").run(project.id, noticeAt, noticeAt);
  db.prepare("INSERT INTO attention_attempt_items VALUES ('late','late')").run();
  const report = pauseReport(db, project.id, new Date(requestedStart).toISOString(), new Date(end).toISOString(), end);
  expect(report.window.outsideAbMs).toBe(3600_000);
  expect(report.window.abMs).toBe(10 * 3600_000);
  expect(report.arms[pauseArm(task.id)]).toMatchObject({ notices: 1, censoredNotices: 1, censoredEpisodes: 1, misses: 0 });
  await harness.dispose();
});

it("marks an episode unknown when its eight-hour lookback crosses an outage", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  setPauseMode(db, project.id, "ab");
  const end = Date.now(), start = end - 2 * 3600_000, work = start - 8 * 3600_000;
  db.prepare("UPDATE pause_log SET at=? WHERE project_id=? AND event='mode'").run(new Date(work).toISOString(), project.id);
  for (let at = work; at < end; at += 600_000) {
    if (at >= work + 3600_000 && at < work + 2 * 3600_000) continue;
    const stamp = new Date(at).toISOString();
    db.prepare("INSERT INTO pause_sample_runs VALUES (?,?)").run(project.id, stamp);
    db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(stamp, project.id, task.id, pauseArm(task.id), "in_progress", 1, 0, 0, 0, at === work ? 1 : 0);
  }
  const arm = pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end).arms[pauseArm(task.id)];
  expect(arm.unknownEpisodes).toBe(1);
  expect(arm.misses).toBe(0);
  await harness.dispose();
});

it("judges a notice against the real episode start before the window", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" });
  const db = bb.storage.database();
  setPauseMode(db, project.id, "ab");
  const end = Date.now(), start = end - 2 * 3600_000, work = start - 9 * 3600_000;
  db.prepare("UPDATE pause_log SET at=? WHERE project_id=? AND event='mode'").run(new Date(work).toISOString(), project.id);
  for (let at = work; at < end; at += 600_000) {
    const stamp = new Date(at).toISOString();
    db.prepare("INSERT INTO pause_sample_runs VALUES (?,?)").run(project.id, stamp);
    db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(stamp, project.id, task.id, pauseArm(task.id), "in_progress", 1, 0, 0, 0, at === work ? 1 : 0);
  }
  const notice = new Date(start + 30 * 60_000).toISOString();
  db.prepare("INSERT INTO manager_attention(id,tracker_id,task_id,task_key,kind,signal,first_seen_at,eligible_at,created_rev,rev) VALUES ('late',?,?,'EXA-1','stale-status','no_active_thread',?,?,1,1)").run(project.id, task.id, notice, notice);
  db.prepare("INSERT INTO attention_attempts(attempt_id,tracker_id,kind,generation,batch_id,recipient_thread_id,recipient_source,started_at,outcome,accepted_at,rev) VALUES ('late',?,'stale-status',1,'late','thr_example','manager',?,'queued',?,1)").run(project.id, notice, notice);
  db.prepare("INSERT INTO attention_attempt_items VALUES ('late','late')").run();
  const arm = pauseReport(db, project.id, new Date(start).toISOString(), new Date(end).toISOString(), end).arms[pauseArm(task.id)];
  expect(arm.misses).toBe(1);
  expect(arm.totalUnflaggedMs).toBe(30 * 60_000);
  await harness.dispose();
});
