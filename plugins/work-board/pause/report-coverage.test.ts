import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api";
import { pauseReport } from "./report";
import { sweepPauseSignals } from "./signals";
import { endPauses, pauseArm, startManualPause } from "./store";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const iso = (at: number) => new Date(at).toISOString();
const hosts: { harness: { dispose: () => unknown } }[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(hosts.splice(0).map((h) => h.harness.dispose())); });

/** One card per requested arm and a sample every ten minutes from `first` to now; the card works only at its first sample, so its idle time is an abandonment episode. */
function setup(arms: ("control" | "auto")[], span = 40 * HOUR) {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const db = host.bb.storage.database();
  const end = Date.now(), first = end - span;
  const tasks = arms.map((arm) => {
    let id = "";
    do id = store.tasks.createTask({ projectId: project.id, title: "Example", status: "in_progress" }).id; while (pauseArm(id) !== arm);
    return id;
  });
  db.prepare("INSERT INTO pause_log(project_id,at,event,detail) VALUES (?,?,'mode',?)").run(project.id, iso(first), JSON.stringify({ previous: "off", mode: "ab" }));
  for (let at = first; at < end; at += 10 * MIN) {
    db.prepare("INSERT INTO pause_sample_runs VALUES (?,?)").run(project.id, iso(at));
    for (const id of tasks) db.prepare("INSERT INTO pause_samples VALUES (?,?,?,?,?,?,?,?,?,?)").run(iso(at), project.id, id, pauseArm(id), "in_progress", 1, 0, 0, 0, at === first ? 1 : 0);
  }
  const report = (from = first) => pauseReport(db, project.id, iso(from), iso(end), end);
  const live = (taskId: string, started: number, coverage: number | null, until = end + DAY) =>
    db.prepare("INSERT INTO task_pauses(id,task_id,source,signal,thread_id,reason,started_at,until,applied,coverage_started_at) VALUES (?,?,'manual','manual','thr_setter','Waiting',?,?,1,?)").run(`p${Math.random()}`, taskId, iso(started), iso(until), coverage === null ? null : iso(coverage));
  const log = (taskId: string, at: number, event: "start" | "end", extra: Record<string, string | null> = {}) =>
    db.prepare("INSERT INTO pause_log(project_id,task_id,task_key,at,event,source,signal,thread_id,arm,applied,until,pause_started_at,coverage_started_at) VALUES (?,?,'EXA-1',?,?,'manual','manual','thr_setter',?,1,?,?,?)")
      .run(project.id, taskId, iso(at), event, pauseArm(taskId), extra.until ?? null, extra.pauseStarted ?? null, extra.coverage ?? null);
  return { ...host, store, project, db, tasks, first, end, report, live, log };
}
const beyond = (report: ReturnType<ReturnType<typeof setup>["report"]>, arm: "control" | "auto") => report.diagnostics[`manualBeyond8h:${arm}`]!;

it("excludes the time beyond eight hours of a chain of three extensions, and a new pause does not restart the clock", async () => {
  const f = setup(["control"]);
  const t0 = f.first + 2 * HOUR;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t0); startManualPause(f.db, f.tasks[0]!, "Waiting", 4 * HOUR, "thr_setter");
  vi.setSystemTime(t0 + 4 * HOUR - MIN); startManualPause(f.db, f.tasks[0]!, "Waiting", 4 * HOUR + MIN, "thr_setter");
  vi.setSystemTime(t0 + 8 * HOUR - MIN); startManualPause(f.db, f.tasks[0]!, "Waiting", 4 * HOUR + MIN, "thr_setter");
  expect(f.db.prepare<[], { coverage_started_at: string }>("SELECT coverage_started_at FROM task_pauses").get()!.coverage_started_at).toBe(iso(t0));
  vi.setSystemTime(t0 + 12 * HOUR + 30_000);
  const { bb } = f;
  await sweepPauseSignals(bb);
  vi.useRealTimers();
  const report = f.report();
  expect(beyond(report, "control")).toBe(4 * HOUR);
  // The end row of the last pause describes its whole pause and where the chain began.
  expect(f.db.prepare("SELECT pause_started_at,coverage_started_at FROM pause_log WHERE event='end' AND end_reason='expired'").get()).toEqual({ pause_started_at: iso(t0 + 8 * HOUR - MIN), coverage_started_at: iso(t0) });
});

it("merges a re-pause made within five minutes of an expiry and not one made ten minutes after", async () => {
  const f = setup(["control", "control"]);
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = f.first + 2 * HOUR;
  for (const [index, gap] of [2 * MIN, 10 * MIN].entries()) {
    const id = f.tasks[index]!;
    vi.setSystemTime(t0); startManualPause(f.db, id, "Waiting", HOUR, "thr_setter");
    vi.setSystemTime(t0 + HOUR + 10_000); await sweepPauseSignals(f.bb);
    vi.setSystemTime(t0 + HOUR + 10_000 + gap); startManualPause(f.db, id, "Again", HOUR, "thr_setter");
    expect(f.db.prepare<[string], { coverage_started_at: string }>("SELECT coverage_started_at FROM task_pauses WHERE task_id=?").get(id)!.coverage_started_at).toBe(iso(index === 0 ? t0 : t0 + HOUR + 10_000 + gap));
  }
});

it("counts only the part inside the window, with the clock running from the real start", () => {
  const f = setup(["auto"]);
  f.live(f.tasks[0]!, f.first, f.first);
  const from = f.first + 10 * HOUR;
  expect(beyond(f.report(from), "auto")).toBe(f.end - from);
  expect(beyond(f.report(), "auto")).toBe(f.end - (f.first + 8 * HOUR));
});

it("excludes nothing for a pause ended early", () => {
  const f = setup(["control"]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(f.first + 2 * HOUR); startManualPause(f.db, f.tasks[0]!, "Waiting", 20 * HOUR, "thr_setter");
  vi.setSystemTime(f.first + 7 * HOUR); f.db.transaction(() => endPauses(f.db, f.tasks[0]!, "resume", "thr_setter"))();
  vi.useRealTimers();
  expect(beyond(f.report(), "control")).toBe(0);
});

it("applies the same cut to card-days, episodes and the verdict inputs of both arms", () => {
  const f = setup(["control", "auto"]);
  const before = f.report();
  for (const arm of ["control", "auto"] as const) { expect(before.arms[arm].misses).toBe(1); expect(before.arms[arm].longestUnflaggedMs).toBeGreaterThan(30 * HOUR); }
  for (const id of f.tasks) f.live(id, f.first + HOUR, f.first + HOUR);
  const after = f.report();
  for (const arm of ["control", "auto"] as const) {
    expect(beyond(after, arm)).toBe(f.end - (f.first + 9 * HOUR));
    // Only the hour between the start of the abandonment and the start of the excluded time is left.
    expect(after.arms[arm].longestUnflaggedMs).toBeLessThanOrEqual(HOUR + 10 * MIN);
    expect(after.arms[arm].cardDays).toBeCloseTo((9 * HOUR) / DAY, 1);
  }
  expect(after.arms.control.cardDays).toBeCloseTo(after.arms.auto.cardDays, 6);
  expect(after.arms.control.misses).toBe(after.arms.auto.misses);
  expect(after.arms.control.totalUnflaggedMs).toBe(after.arms.auto.totalUnflaggedMs);
});

it("keeps the clock when the start rows are long pruned: a running pause, an extension chain, and an ended pause rebuilt from its end row", () => {
  const f = setup(["control", "auto", "control"]);
  // Running for 100 days, no log row at all.
  f.live(f.tasks[0]!, f.end - 100 * DAY, f.end - 100 * DAY);
  // An ended pause from a chain begun 60 days ago: its end row alone places it and its clock.
  f.log(f.tasks[1]!, f.first + DAY, "end", { until: iso(f.first + 2 * DAY), pauseStarted: iso(f.first - DAY), coverage: iso(f.end - 60 * DAY) });
  const report = f.report();
  expect(beyond(report, "control")).toBe(f.end - f.first);
  expect(beyond(report, "auto")).toBe(DAY);
  // Rows written before the new columns exist are paired and merged the v1 way.
  const g = setup(["control", "control"]);
  g.log(g.tasks[0]!, g.first, "start"); g.log(g.tasks[0]!, g.first + 5 * HOUR, "end", { until: iso(g.first + 5 * HOUR) });
  g.log(g.tasks[0]!, g.first + 5 * HOUR + 2 * MIN, "start"); g.log(g.tasks[0]!, g.first + 10 * HOUR, "end", { until: iso(g.first + 10 * HOUR) });
  g.log(g.tasks[1]!, g.first, "start"); g.log(g.tasks[1]!, g.first + 5 * HOUR, "end", { until: iso(g.first + 5 * HOUR) });
  g.log(g.tasks[1]!, g.first + 5 * HOUR + 10 * MIN, "start"); g.log(g.tasks[1]!, g.first + 10 * HOUR, "end", { until: iso(g.first + 10 * HOUR) });
  expect(beyond(g.report(), "control")).toBe(2 * HOUR);
});

it("leaves a report with pauses of eight hours or less unchanged", () => {
  const f = setup(["control", "auto"]);
  const before = f.report();
  for (const id of f.tasks) {
    f.log(id, f.first + HOUR, "start", { until: iso(f.first + 7 * HOUR), coverage: iso(f.first + HOUR) });
    f.log(id, f.first + 7 * HOUR, "end", { until: iso(f.first + 7 * HOUR), pauseStarted: iso(f.first + HOUR), coverage: iso(f.first + HOUR) });
    f.log(id, f.first + 9 * HOUR, "start", { until: iso(f.first + 15 * HOUR), coverage: iso(f.first + 9 * HOUR) });
    f.log(id, f.first + 15 * HOUR, "end", { until: iso(f.first + 15 * HOUR), pauseStarted: iso(f.first + 9 * HOUR), coverage: iso(f.first + 9 * HOUR) });
  }
  const after = f.report();
  expect(after.arms).toEqual(before.arms);
  expect(after.verdict).toBe(before.verdict);
  expect(after.diagnostics["manualBeyond8h:control"]).toBe(0);
  expect(after.diagnostics["manualBeyond8h:auto"]).toBe(0);
});

it("rebuilds the chain of a pause that was already running when the coverage column was added", async () => {
  const f = setup(["control", "control"]);
  const t0 = f.first + 2 * HOUR;
  // Rows as the older version left them: a 4 h pause extended at +3 h by 4 h more, still running, with no coverage stored anywhere.
  for (const id of f.tasks) {
    f.log(id, t0, "start", { until: iso(t0 + 4 * HOUR) });
    f.log(id, t0 + 3 * HOUR, "end", { until: iso(t0 + 4 * HOUR) });
    f.log(id, t0 + 3 * HOUR, "start", { until: iso(t0 + 8 * HOUR) });
    f.live(id, t0 + 3 * HOUR, null, t0 + 8 * HOUR);
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  // After the upgrade: extend the running pause by 4 h more (5 h from now, 1 h of the old one is left).
  vi.setSystemTime(t0 + 7 * HOUR);
  startManualPause(f.db, f.tasks[0]!, "Waiting", 5 * HOUR, "thr_setter");
  expect(f.db.prepare<[string], { coverage_started_at: string }>("SELECT coverage_started_at FROM task_pauses WHERE task_id=?").get(f.tasks[0]!)!.coverage_started_at).toBe(iso(t0));
  // The other chain ends by a normal expiry: its end row carries the same rebuilt start.
  vi.setSystemTime(t0 + 8 * HOUR + 30_000);
  await sweepPauseSignals(f.bb);
  expect(f.db.prepare("SELECT pause_started_at,coverage_started_at FROM pause_log WHERE task_id=? AND end_reason='expired'").get(f.tasks[1]!)).toEqual({ pause_started_at: iso(t0 + 3 * HOUR), coverage_started_at: iso(t0) });
  vi.setSystemTime(t0 + 12 * HOUR + 30_000);
  await sweepPauseSignals(f.bb);
  vi.useRealTimers();
  expect(f.db.prepare("SELECT count(*) AS n FROM task_pauses").get()).toEqual({ n: 0 });
  // 12 h of continuous coverage from t0: the report excludes the last 4 h (first card), and the second chain ended at 8 h excludes none.
  expect(beyond(f.report(), "control")).toBe(4 * HOUR);
});
