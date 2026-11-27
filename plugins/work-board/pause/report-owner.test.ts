import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api";
import { pauseReport } from "./report";
import { pauseArm } from "./store";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (at: number) => new Date(at).toISOString();

/** A project with A/B intervals, cards in the given arms, and a sample every ten minutes over the whole span. */
async function setup(options: { arms: ("control" | "auto")[]; span: number; ab?: [number, number][]; worked?: boolean }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const db = bb.storage.database();
  const end = Date.now(), first = end - options.span;
  const tasks: string[] = [];
  for (const arm of options.arms) {
    let id = "";
    do id = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" }).id; while (pauseArm(id) !== arm);
    tasks.push(id);
  }
  for (const [from, to] of options.ab ?? [[first, end]]) {
    db.prepare("INSERT INTO pause_log(project_id,at,event,detail) VALUES (?,?,'mode',?)").run(project.id, iso(from), JSON.stringify({ previous: "off", mode: "ab" }));
    if (to < end) db.prepare("INSERT INTO pause_log(project_id,at,event,detail) VALUES (?,?,'mode',?)").run(project.id, iso(to), JSON.stringify({ previous: "ab", mode: "off" }));
  }
  for (let at = first; at < end; at += 10 * MIN) {
    db.prepare("INSERT INTO pause_sample_runs VALUES (?,?)").run(project.id, iso(at));
    for (const id of tasks) db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(iso(at), project.id, id, pauseArm(id), "in_progress", 1, 0, 0, 0, options.worked === false ? 0 : 1);
  }
  let n = 0;
  const owner = (taskId: string, at: number, event: "start" | "end", extra: { source?: string; signal?: string; endReason?: string } = {}) =>
    db.prepare("INSERT INTO pause_log(project_id,task_id,task_key,at,event,source,signal,end_reason,thread_id,arm,applied) VALUES (?,?,?,?,?,?,?,?,'owner',?,1)")
      .run(project.id, taskId, "EXA-1", iso(at), event, extra.source ?? "manual", extra.signal ?? "manual", extra.endReason ?? null, pauseArm(taskId));
  const notice = (taskId: string, at: number) => {
    n++;
    db.prepare("INSERT INTO manager_attention(id,tracker_id,task_id,task_key,kind,signal,first_seen_at,eligible_at,created_rev,rev) VALUES (?,?,?,'EXA-1','stale-status','no_active_thread',?,?,1,1)").run(`o${n}`, project.id, taskId, iso(at), iso(at));
    db.prepare("INSERT INTO attention_attempts(attempt_id,tracker_id,kind,generation,batch_id,recipient_thread_id,recipient_source,started_at,outcome,accepted_at,rev) VALUES (?,?,'stale-status',1,?,'thr_example','manager',?,'queued',?,1)").run(`a${n}`, project.id, `b${n}`, iso(at), iso(at));
    db.prepare("INSERT INTO attention_attempt_items VALUES (?,?)").run(`a${n}`, `o${n}`);
  };
  const report = (from = first, to = end) => pauseReport(db, project.id, iso(from), iso(to), end);
  return { harness, tasks, first, end, owner, notice, report };
}

it("counts the owner overruling an automatic pause in the treatment arm and prefixes owner diagnostics", async () => {
  const f = await setup({ arms: ["auto", "control"], span: DAY });
  f.owner(f.tasks[0]!, f.end - HOUR, "end", { source: "auto", signal: "background", endReason: "resume" });
  f.owner(f.tasks[1]!, f.end - HOUR, "end", { source: "auto", signal: "background", endReason: "resume" });
  const report = f.report();
  expect(report.ownerOverruledAuto).toBe(1);
  expect(report.diagnostics["owner:end:background:resume"]).toBe(2);
  await f.harness.dispose();
});

it("takes a card out of both arms' keep metrics from its first owner action, and leaves other cards as before", async () => {
  const f = await setup({ arms: ["control", "control"], span: 8 * DAY });
  const before = f.report().arms.control.cardDays;
  // Off the ten-minute sampling grid, so one sample interval crosses T and is clipped there.
  const t = f.first + 4 * DAY + 5 * MIN;
  f.owner(f.tasks[0]!, t, "start");
  f.notice(f.tasks[0]!, t + HOUR);
  f.notice(f.tasks[1]!, t + HOUR);
  const arm = f.report().arms.control;
  expect(arm.owner).toMatchObject({ cards: 1, actions: 1, notices: 1 });
  expect(arm.owner.cardDays).toBeCloseTo(4 - 5 * MIN / DAY, 6);
  expect(arm.cardDays + arm.owner.cardDays).toBeCloseTo(before, 6);
  expect(arm.notices).toBe(1);
  await f.harness.dispose();
});

it("censors a notice whose look-ahead crosses the owner action", async () => {
  const f = await setup({ arms: ["control"], span: DAY });
  const t = f.end - 6 * HOUR;
  f.notice(f.tasks[0]!, t - 10 * MIN);
  f.owner(f.tasks[0]!, t, "start");
  const arm = f.report().arms.control;
  expect(arm.notices).toBe(1);
  expect(arm.censoredNotices).toBe(1);
  expect(arm.matureNotices).toBe(0);
  await f.harness.dispose();
});

it("censors an unflagged episode still open at the owner action instead of counting a miss", async () => {
  const f = await setup({ arms: ["control"], span: 12 * HOUR, worked: false });
  const window = f.end - 2 * HOUR;
  expect(f.report(window).arms.control.misses).toBe(1);
  f.owner(f.tasks[0]!, f.end - 30 * MIN, "start");
  const arm = f.report(window).arms.control;
  expect(arm.misses).toBe(0);
  expect(arm.censoredEpisodes).toBe(1);
  // The unflagged time before the action still counts: from the window start to the action.
  expect(arm.totalUnflaggedMs).toBe(90 * MIN);
  expect(arm.longestUnflaggedMs).toBe(90 * MIN);
  f.notice(f.tasks[0]!, f.end - 60 * MIN);
  expect(f.report(window).arms.control.totalUnflaggedMs).toBe(60 * MIN);
  await f.harness.dispose();
});

it("excludes from the window start for an owner action earlier in the same A/B interval, not before that interval", async () => {
  const f = await setup({ arms: ["control"], span: 2 * DAY });
  const window = f.first + DAY;
  f.owner(f.tasks[0]!, f.first + 2 * HOUR, "start");
  f.owner(f.tasks[0]!, f.first + 3 * HOUR, "end", { endReason: "resume" });
  const arm = f.report(window).arms.control;
  expect(arm.cardDays).toBe(0);
  expect(arm.owner.cardDays).toBeCloseTo(1, 2);
  expect(arm.owner.actions).toBe(0);
  const g = await setup({ arms: ["control"], span: 2 * DAY, ab: [[Date.now() - DAY - HOUR, Date.now()]] });
  g.owner(g.tasks[0]!, g.first + 2 * HOUR, "start");
  expect(g.report(g.end - DAY).arms.control.owner.cards).toBe(0);
  await f.harness.dispose();
  await g.harness.dispose();
});

it("applies an owner action between two A/B periods to the later period", async () => {
  const span = 4 * DAY, end = Date.now(), first = end - span;
  const f = await setup({ arms: ["control"], span, ab: [[first, first + DAY], [first + 2 * DAY, end]] });
  f.owner(f.tasks[0]!, first + 1.5 * DAY, "start");
  const arm = f.report().arms.control;
  expect(arm.cardDays).toBeCloseTo(1, 1);
  expect(arm.owner.cardDays).toBeCloseTo(2, 1);
  await f.harness.dispose();
});

it("changes the verdict once owner-touched time is excluded, and guards a large owner share", async () => {
  const f = await setup({ arms: ["control", "auto", "auto"], span: 8 * DAY });
  const [control, auto, touched] = f.tasks as [string, string, string];
  for (let i = 0; i < 30; i++) f.notice(control, f.first + DAY + i * 3 * HOUR);
  for (let i = 0; i < 5; i++) f.notice(auto, f.first + DAY + i * 3 * HOUR);
  for (let i = 0; i < 40; i++) f.notice(touched, f.end - 10 * HOUR + i * 10 * MIN);
  expect(f.report().verdict).toBe("switch off");
  f.owner(touched, f.end - 12 * HOUR, "start");
  expect(f.report().verdict).toBe("keep");
  f.owner(touched, f.first + DAY, "end", { endReason: "resume" });
  expect(f.report().verdict).toBe("extend: owner actions cover too much card time");
  await f.harness.dispose();
});

it("counts no episode when the owner acted before the window and the open episode has nothing inside it", async () => {
  const f = await setup({ arms: ["control"], span: 12 * HOUR, worked: false });
  const window = f.end - 2 * HOUR;
  f.owner(f.tasks[0]!, f.first + 9 * HOUR, "start");
  const arm = f.report(window).arms.control;
  expect(arm.episodes).toBe(0);
  expect(arm.censoredEpisodes).toBe(0);
  expect(arm.totalUnflaggedMs).toBe(0);
  expect(arm.owner.cardDays).toBeCloseTo(2 / 24, 6);
  await f.harness.dispose();
});
