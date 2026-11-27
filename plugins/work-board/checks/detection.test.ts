import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptPolling } from "../steer";
import { checksTuning } from "./service";
import { reportContents } from "./reports";
import { formatNotification } from "./notification";
import { cleanTempDirs, MANAGER, setup, type Fixture } from "./fixtures";

const fixtures: Fixture[] = [];
const make = async (fields: Record<string, unknown> = {}) => {
  const f = await setup(); fixtures.push(f); f.standard(); await f.enable(fields); return f;
};
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; checksTuning.lateSearchMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

const delivered = (f: Fixture) => f.attempts().filter((a) => ["queued", "appended", "inline"].includes(a.outcome as string)).length;
/** Runs one tick with this script output and reports how many deliveries it added. */
const step = async (f: Fixture, text: string, code = 0, candidate: string | null = null) => {
  f.output(text, code, candidate);
  const before = delivered(f);
  await f.tick();
  return delivered(f) - before;
};
const summary = (threads: number, cards: number, actions: number) => `checks: ${threads} threads, ${cards} cards checked, ${actions} actions`;
const idle = (key: string, minutes: number) => `ACTION no-active-thread ${key}: no active session for ${minutes} min`;

describe("change detection", () => {
  it("ignores changed counts, order and volatile counters, and sends a new action or answer", async () => {
    const f = await make();
    expect(await step(f, [summary(5, 10, 2), idle("EXA-1", 45), idle("EXA-2", 10)].join("\n"), 1)).toBe(1);
    expect(await step(f, [idle("EXA-2", 70), idle("EXA-1", 90), summary(6, 12, 2)].join("\n"), 1)).toBe(0);
    expect(await step(f, [idle("EXA-1", 90), idle("EXA-2", 70), idle("EXA-3", 5)].join("\n"), 1)).toBe(1);
    expect(await step(f, [idle("EXA-1", 90), idle("EXA-2", 70), idle("EXA-3", 5), "ANSWER EXA-1 plan: approved"].join("\n"), 1)).toBe(1);
  });

  it("delivers removals and reminders, and records skipped runs", async () => {
    const f = await make({ reminderHours: 2 });
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    expect(await step(f, idle("EXA-1", 10), 1)).toBe(0);
    expect(f.state().lastDecision.decision).toBe("skip-unchanged");
    const state = f.state(); state.lastReport.at -= 2 * 3600_000;
    f.db.prepare("UPDATE checks_state SET value = ? WHERE tracker_id = ?").run(JSON.stringify(state), f.tracker.id);
    expect(await step(f, idle("EXA-1", 11), 1)).toBe(1);
    expect(f.sent()).toContain("reminder every 2 h");
    expect(await step(f, "", 0)).toBe(1);
    expect(f.sent()).toContain("Actions list is clear");
    expect(await step(f, "", 0)).toBe(0);
  });


  it("delivers a partial action removal with its reason and no clear line", async () => {
    const f = await make();
    expect(await step(f, `${idle("EXA-1", 5)}\n${idle("EXA-2", 5)}`, 1)).toBe(1);
    expect(f.state().lastDecision.reasons).toContain("actions-added");
    expect(await step(f, idle("EXA-1", 6), 1)).toBe(1);
    expect(f.state().lastDecision.reasons).toContain("actions-removed");
    expect(f.sent()).not.toContain("Actions list is clear");
  });

  it("reminds at the configured boundary but not just before it", async () => {
    const f = await make({ reminderHours: 2 });
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    const at = f.state().lastReport.at;
    const clock = vi.spyOn(Date, "now").mockReturnValue(at + 2 * 3600_000 - 1);
    try {
      expect(await step(f, idle("EXA-1", 6), 1)).toBe(0);
      clock.mockReturnValue(at + 2 * 3600_000);
      expect(await step(f, idle("EXA-1", 7), 1)).toBe(1);
      expect(f.state().lastDecision.decision).toBe("remind");
    } finally { clock.mockRestore(); }
  });

  it("does not remind an empty report after the interval", async () => {
    const f = await make({ reminderHours: 2 });
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    expect(await step(f, "", 0)).toBe(1);
    const state = f.state(); state.lastReport.at -= 3 * 3600_000;
    f.db.prepare("UPDATE checks_state SET value = ? WHERE tracker_id = ?").run(JSON.stringify(state), f.tracker.id);
    expect(await step(f, "", 0)).toBe(0);
    expect(f.state().lastDecision.decision).toBe("quiet");
  });

  it("reminds an answer without a snapshot candidate after delivering it once", async () => {
    const f = await make({ snapshots: true, reminderHours: 2 });
    const answer = "ANSWER EXA-1 owner: yes";
    expect(await step(f, answer, 1)).toBe(1);
    expect(await step(f, answer, 1)).toBe(0);
    const state = f.state(); state.lastReport.at -= 2 * 3600_000;
    f.db.prepare("UPDATE checks_state SET value = ? WHERE tracker_id = ?").run(JSON.stringify(state), f.tracker.id);
    expect(await step(f, answer, 1)).toBe(1);
    expect(f.state().lastDecision.decision).toBe("remind");
    expect(f.sent()).toContain("reminder every 2 h");
  });

  it("skips an empty report against an empty pre-upgrade baseline", async () => {
    const f = await make();
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    expect(await step(f, "", 0)).toBe(1);
    const state = f.state(); delete state.lastReport.changes.actions;
    f.db.prepare("UPDATE checks_state SET value = ? WHERE tracker_id = ?").run(JSON.stringify(state), f.tracker.id);
    expect(await step(f, "", 0)).toBe(0);
    expect(f.state().lastReport.changes.actions).toBeUndefined();
  });

  it("keeps upgrade reconciliation pending until delivery is accepted", async () => {
    const f = await make();
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    const state = f.state(); delete state.lastReport.changes.actions;
    f.db.prepare("UPDATE checks_state SET value = ? WHERE tracker_id = ?").run(JSON.stringify(state), f.tracker.id);
    f.threads.updateRejection = Object.assign(new Error("forbidden"), { status: 403 });
    expect(await step(f, "", 0)).toBe(0);
    expect(f.state().lastDecision.reasons).toContain("upgrade-baseline");
    expect(f.state().lastReport.changes.actions).toBeUndefined();
    const pending = f.delivery()!.report_id;
    await f.tick();
    expect(f.delivery()!.report_id).toBe(pending);
    expect(f.state().lastReport.changes.actions).toBeUndefined();
    f.threads.updateRejection = undefined;
    await f.tick();
    expect(f.delivery()!.report_id).toBeNull();
    expect(f.state().lastReport.changes.actions).toEqual([]);
    expect(await step(f, "", 0)).toBe(0);
  });

  it("skips changed candidates for unchanged items and promotes one with a new answer", async () => {
    const f = await make({ snapshots: true });
    const action = idle("EXA-1", 5);
    expect(await step(f, action, 1, '{"v":1}')).toBe(1);
    expect(await step(f, action, 1, '{"v":2}')).toBe(0);
    expect(f.delivery()).toMatchObject({ committed: Buffer.from('{"v":1}'), pending_snapshot: null, report_id: null });
    expect(await step(f, `${action}\nANSWER EXA-1 owner: yes`, 1, '{"v":3}')).toBe(1);
    expect(f.state().lastDecision.reasons).toContain("answer");
    expect(f.delivery()).toMatchObject({ committed: Buffer.from('{"v":3}'), pending_snapshot: null, report_id: null });
  });

  it("never says the Actions list is clear in a failure report", async () => {
    const f = await make();
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    expect(await step(f, "ERROR example failure", 2)).toBe(1);
    expect(f.sent()).not.toContain("Actions list is clear");
  });

  it("does not remind when reminders are disabled", async () => {
    const f = await make({ reminderHours: 0 });
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    const state = f.state(); state.lastReport.at -= 3 * 3600_000;
    f.db.prepare("UPDATE checks_state SET value = ? WHERE tracker_id = ?").run(JSON.stringify(state), f.tracker.id);
    expect(await step(f, idle("EXA-1", 6), 1)).toBe(0);
    expect((await f.harness.runCli(["checks", "status", "--project", "CHK"])).stdout).toMatch(/Last decision\s+skipped \(unchanged\)/);
    const status = JSON.parse((await f.harness.runCli(["checks", "status", "--project", "CHK", "--json"])).stdout!);
    expect(status).toMatchObject({ lastRun: expect.any(Number), lastDecision: { decision: "skip-unchanged" } });
  });

  it("reconciles an old baseline after its last action disappears", async () => {
    const f = await make();
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    const state = f.state(); delete state.lastReport.changes.actions;
    f.db.prepare("UPDATE checks_state SET value = ? WHERE tracker_id = ?").run(JSON.stringify(state), f.tracker.id);
    expect(await step(f, "", 0)).toBe(1);
    expect(f.state().lastDecision.reasons).toContain("upgrade-baseline");
    expect(f.sent()).toContain("Actions list is clear");
    expect(await step(f, "", 0)).toBe(0);
  });

  it("sends a Waiting addition and its explicit clear, even on exit 0", async () => {
    const f = await make();
    expect(await step(f, "WAIT EXA-3: blocker EXA-4", 0)).toBe(1);
    expect(await step(f, "WAIT EXA-3: blocker EXA-4", 0)).toBe(0);
    expect(await step(f, "WAIT EXA-3: blocker EXA-4\nWAIT EXA-5: blocker EXA-6", 0)).toBe(1);
    expect(await step(f, "", 0)).toBe(1);
    expect(f.threads.text(f.threads.rows[0]!)).toContain("- Waiting list is clear.");
    expect(await step(f, "", 0)).toBe(0);
  });

  it("sends a changed exit-1 diagnostic only when it has no parsed rows", async () => {
    const f = await make();
    expect(await step(f, "something odd happened", 1)).toBe(1);
    expect(await step(f, "something odd happened", 1)).toBe(0);
    expect(await step(f, "something else happened", 1)).toBe(1);
    expect(await step(f, `${idle("EXA-1", 5)}\nnoise one`, 1)).toBe(1);
    expect(await step(f, `${idle("EXA-1", 5)}\nnoise two`, 1)).toBe(0);
  });

  it("lets STATE travel with a report but never cause one", async () => {
    const f = await make();
    expect(await step(f, "STATE paused until Monday", 0)).toBe(0);
    expect(await step(f, `${idle("EXA-1", 5)}\nSTATE paused until Monday`, 1)).toBe(1);
    expect(f.sent()).toContain("**State changes**");
  });

  it("de-duplicates failures separately: a quiet success in between makes the same failure notify again", async () => {
    const f = await make();
    expect(await step(f, "boom", 2)).toBe(1);
    expect(await step(f, "boom", 2)).toBe(0);
    expect(await step(f, "", 0)).toBe(0); // quiet success, nothing sent, but it ends the failure streak
    expect(await step(f, "boom", 2)).toBe(1);
    expect(await step(f, "different boom", 2)).toBe(1);
  });

  it("resets the baseline when the recipient changes", async () => {
    const f = await make();
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(0);
    f.setManager("thr_second");
    expect(await step(f, idle("EXA-1", 5), 1)).toBe(1);
    expect(f.attempts().at(-1)).toMatchObject({ manager_thread_id: "thr_second" });
  });

  it("sends an answer from a snapshot-enabled script without a candidate only once", async () => {
    const f = await make({ snapshots: true });
    expect(await step(f, "ANSWER EXA-1 owner: yes", 1)).toBe(1);
    expect(await step(f, "ANSWER EXA-1 owner: yes", 1)).toBe(0);
    const plain = await make();
    expect(await step(plain, "ANSWER EXA-1 owner: yes", 1)).toBe(1);
    expect(await step(plain, "ANSWER EXA-1 owner: yes", 1)).toBe(0);
  });

  it("treats a first exit-0 candidate as a baseline and a byte-changed one as unchanged, promoting only on delivery", async () => {
    const f = await make({ snapshots: true });
    f.threads.threads.set(MANAGER, { archived: true });
    expect(await step(f, "", 0, '{"v":1}')).toBe(0);
    // Staged atomically with its tick and report; not yet promoted.
    expect(f.delivery()).toMatchObject({ committed: null, pending_snapshot: Buffer.from('{"v":1}'), pending_tick: f.state().tickId, report_id: expect.any(String), pending_exit: 0 });
    f.threads.threads.set(MANAGER, {});
    expect(await step(f, "", 0, '{"v":1}')).toBe(1);
    expect(f.delivery()).toMatchObject({ committed: Buffer.from('{"v":1}'), committed_project: "proj_example", report_id: null, pending_snapshot: null });
    expect(await step(f, "", 0, '{"v":1}')).toBe(0);
    expect(await step(f, "", 0, '{"v": 1}')).toBe(0);
    expect(f.delivery()).toMatchObject({ committed: Buffer.from('{"v":1}'), report_id: null });
    expect(await step(f, idle("EXA-1", 5), 1, '{"v": 1}')).toBe(1);
    expect(f.delivery()).toMatchObject({ committed: Buffer.from('{"v": 1}') });
    expect(await step(f, idle("EXA-1", 5), 1, null)).toBe(0);
  });

  it("turns an invalid candidate into an exit-2 failure that keeps the old committed bytes and never carries the invalid ones", async () => {
    const f = await make({ snapshots: true });
    expect(await step(f, "", 0, '{"v":1}')).toBe(1);
    expect(await step(f, idle("EXA-1", 5), 1, '{"v":')).toBe(1);
    const message = f.threads.text(f.threads.rows[0]!);
    expect(message).toContain("Check failed");
    expect(message).toContain("complete JSON");
    expect(message).not.toContain('{"v":\n');
    expect(f.delivery()).toMatchObject({ committed: Buffer.from('{"v":1}'), pending_snapshot: null, report_id: null });
    expect(f.state()).toMatchObject({ exitCode: 2, failureStage: "script" });
  });

  it("ignores the candidate on a failure", async () => {
    const f = await make({ snapshots: true });
    expect(await step(f, "boom", 2, '{"v":1}')).toBe(1);
    expect(f.delivery()).toMatchObject({ committed: null, pending_snapshot: null });
  });

  it("records a failed refresh as a refresh failure and a script failure as its own stage, without running the script", async () => {
    const f = await make();
    f.control.remote = "file:///nonexistent/example";
    await f.tick();
    expect(f.runs()).toBe(0);
    expect(f.state()).toMatchObject({ exitCode: 2, failureStage: "refresh", refreshFailures: 1 });
    expect(f.threads.text(f.threads.rows[0]!)).toContain("Checkout refresh failed");
    f.control.remote = f.repo.url;
    f.control.projectFail = true;
    f.db.prepare("UPDATE checks_state SET value = json_remove(value, '$.refreshRetryAt')").run();
    await f.tick();
    expect(f.state()).toMatchObject({ failureStage: "refresh", refreshFailures: 2 });
  });
});

describe("report text", () => {
  it("groups items with task and thread links and keeps the raw text", async () => {
    const f = await make();
    f.threads.threads.set(MANAGER, { archived: true });
    const raw = [summary(3, 9, 3), "ANSWER EXA-12 plan: Approved with notes", "ACTION stale-status EXA-3", "ACTION idle-thread thr_example: idle for 5 min", "WAIT EXA-5: blocker EXA-6", "STATE cursor moved", "free text line"].join("\n");
    await step(f, raw, 1);
    expect(f.delivery()).toMatchObject({ pending_body: `${raw}\n` });
    expect(f.service.status(f.tracker.id).pending?.raw).toBe(`${raw}\n`);
    const text = formatNotification(1, `${raw}\n`);
    expect(text).toContain("`Needs attention` · 3 to review · 3 threads · 9 cards checked");
    expect(text).toContain("**Owner answers**\n\n- [EXA-12](/plugins/work-board/work-board/task/EXA-12) — Approved with notes · `plan`");
    expect(text).toContain("`stale status` · [EXA-3](/plugins/work-board/work-board/task/EXA-3)");
    expect(text).toContain("@thread:thr_example");
    expect(text).toContain("[EXA-5](/plugins/work-board/work-board/task/EXA-5) — blocked by [EXA-6](/plugins/work-board/work-board/task/EXA-6)");
    expect(text).toContain("```text\nfree text line\n```");
    expect(formatNotification(2, "boom")).toBe("`Check failed` (exit 2)\n\n```text\nboom\n```");
  });

  it("normalizes volatile counters in the item fingerprint", () => {
    const a = reportContents(1, `${idle("EXA-1", 5)}\nACTION provider-idle x: 40% used, idle 3 h`);
    const b = reportContents(1, `ACTION provider-idle x: 90% used, idle 9 h\n${idle("EXA-1", 500)}`);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(new Set(a.changes.noteworthy)).toEqual(new Set(b.changes.noteworthy));
  });
});
