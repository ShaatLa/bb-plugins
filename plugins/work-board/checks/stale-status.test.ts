import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModeRow, requestMode, selfAckTransition } from "../attention/modes";
import { initializeTasksSchema } from "../db/schema";
import { receiptPolling } from "../steer";
import { reportContents } from "./reports";
import { checksTuning } from "./service";
import { cleanTempDirs, MANAGER, setup, type Fixture } from "./fixtures";

const fixtures: Fixture[] = [];
const make = async () => { const f = await setup(); fixtures.push(f); f.standard(); await f.enable(); return f; };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; checksTuning.lateSearchMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

const STALE = "ACTION stale-status EXA-1: in progress with no active thread";
/** The rendered stale-status items in everything the manager received. */
const staleSent = (f: Fixture) => f.sent().split("`stale status`").length - 1;
const shadow = (f: Fixture) => requestMode(f.db, { trackerId: f.tracker.id, mode: "shadow" });
/** Shadow past its gate, a live request, and Work Board's own acknowledgement (it owns the runner). */
const live = (f: Fixture) => {
  f.db.prepare("UPDATE attention_modes SET shadow_started_at=? WHERE tracker_id=?").run(new Date(Date.now() - 49 * 3_600_000).toISOString(), f.tracker.id);
  requestMode(f.db, { trackerId: f.tracker.id, mode: "live", parityReviewed: true });
  expect(selfAckTransition(f.db, f.tracker.id)).toMatchObject({ ok: true, mode: "live" });
};
const back = (f: Fixture) => {
  requestMode(f.db, { trackerId: f.tracker.id, mode: "shadow" });
  const ack = selfAckTransition(f.db, f.tracker.id);
  expect(ack).toMatchObject({ ok: true, mode: "shadow" });
  return (ack as { generation: number }).generation;
};
const consumed = (f: Fixture) => (f.db.prepare<[string], { consumed_generation: number }>("SELECT consumed_generation FROM checks_stale_rollback WHERE tracker_id=?").get(f.tracker.id))?.consumed_generation ?? null;
const unusableManager = (f: Fixture, archived: boolean) => f.threads.threads.set(MANAGER, { archived });

describe("the report parser's drop option", () => {
  it("drops both forms of a stale-status line from items and body, lowers the summary count and keeps other lines", () => {
    const output = `${STALE}\nACTION stale-status: EXA-2 in review with no open PR\nACTION idle EXA-3\nsweep: 1 threads, 3 cards checked, 3 actions\n`;
    const report = reportContents(1, output, { drop: "ACTION stale-status" });
    expect(report.dropped).toBe(2);
    expect([...report.items.values()]).toEqual(["ACTION idle"]);
    expect(report.body).toBe("ACTION idle EXA-3\nsweep: 1 threads, 3 cards checked, 1 actions\n");
    expect(report.fingerprint).toBe(reportContents(1, "ACTION idle EXA-3\n").fingerprint);
    expect(reportContents(1, output).body).toBe(output);
  });
});

describe("the runner while attention is live", () => {
  it("sends nothing when the only findings are stale-status lines, and the exit counts as quiet", async () => {
    const f = await make();
    shadow(f); live(f);
    f.output(`${STALE}\nsweep: 1 threads, 1 cards checked, 1 actions`, 1);
    await f.tick();
    expect(f.threads.sends).toBe(0);
    expect(f.delivery()?.report_id ?? null).toBeNull();
    expect(f.state().exitCode).toBe(0);
  });

  it("removes stale-status lines from a mixed report and lowers its count, and still sends a genuine exit-1 diagnostic", async () => {
    const f = await make();
    shadow(f); live(f);
    f.output(`${STALE}\nACTION idle EXA-2\nsweep: 1 threads, 2 cards checked, 2 actions`, 1);
    await f.tick();
    expect(staleSent(f)).toBe(0);
    expect(f.sent()).toContain("EXA-2");
    expect(f.sent()).toContain("1 to review");
    f.output(`${STALE}\nsomething broke`, 1);
    await f.tick();
    expect(f.sent()).toContain("something broke");
    expect(staleSent(f)).toBe(0);
    expect(f.state().exitCode).toBe(1);
  });

  it("delivers a mixed report staged in shadow unchanged, once, after the switch", async () => {
    const f = await make();
    shadow(f);
    f.output(`${STALE}\nACTION idle EXA-2`, 1);
    unusableManager(f, true);
    await f.tick(); // staged, not delivered
    expect(f.delivery()?.report_id).toBeTruthy();
    live(f);
    unusableManager(f, false);
    await f.tick(); // the staged bytes go out; the new run's filtered output is no news
    await f.tick();
    expect(staleSent(f)).toBe(1);
    expect(f.threads.sends).toBe(1);
  });

  it("filters the output of a script that was already running at the switch by the mode in force when it is judged", async () => {
    const f = await setup(); fixtures.push(f);
    // The script signals that it started, then waits for the switch before it prints.
    f.script(`touch "${f.io}/started"\nwhile [ ! -f "${f.io}/go" ]; do sleep 0.05; done\ncat "${f.io}/out.txt"\nexit $(cat "${f.io}/code.txt")`);
    await f.enable();
    shadow(f);
    f.output(`${STALE}\nACTION idle EXA-2`, 1);
    const running = f.tick();
    await vi.waitFor(() => expect(existsSync(join(f.io, "started"))).toBe(true), { timeout: 10_000 });
    live(f);
    writeFileSync(join(f.io, "go"), "");
    await running;
    expect(getModeRow(f.db, f.tracker.id).effective_mode).toBe("live");
    expect(f.sent()).toContain("EXA-2");
    expect(staleSent(f)).toBe(0);
  });

  it("keeps a manual run's output raw", async () => {
    const f = await make();
    shadow(f); live(f);
    f.output(STALE, 1);
    await expect(f.service.manualRun(f.tracker.id)).resolves.toMatchObject({ exitCode: 1, output: expect.stringContaining("ACTION stale-status") });
  });
});

describe("the runner after a return to shadow", () => {
  it("resends an identical stale-status line on the first shadow judgement after zero judgements in live, and only once", async () => {
    const f = await make();
    shadow(f);
    f.output(STALE, 1);
    unusableManager(f, true);
    await f.tick(); // a shadow report is staged
    live(f);
    await f.tick(); // live: only the delivery is retried
    const generation = back(f);
    unusableManager(f, false);
    await f.tick(); // the shadow report is accepted, then the same line is judged and resent
    expect(staleSent(f)).toBe(2);
    expect(consumed(f)).toBe(generation);
    await f.tick();
    expect(staleSent(f)).toBe(2);
  });

  it("resends it over an identical fingerprint-only baseline", async () => {
    const f = await make();
    shadow(f);
    f.output(STALE, 1);
    await f.tick();
    expect(staleSent(f)).toBe(1);
    const state = f.state(); delete state.lastReport.changes;
    f.db.prepare("UPDATE checks_state SET value=? WHERE tracker_id=?").run(JSON.stringify(state), f.tracker.id);
    live(f); back(f);
    await f.tick();
    expect(staleSent(f)).toBe(2);
  });

  it("neither resends nor consumes while the scan fails or is incomplete, and sends the unchanged line exactly once on recovery", async () => {
    const f = await make();
    const source = f.worktrees.enable();
    shadow(f);
    f.output(STALE, 1);
    await f.tick();
    expect(staleSent(f)).toBe(1);
    live(f); const generation = back(f);
    const sources = f.worktrees.scan.sources;
    // First the scan throws while it reads the project's sources, then the configured source is missing (an incomplete scan).
    f.worktrees.scan.sources = { filter: () => { throw new Error("sources unavailable"); } } as never;
    await f.tick();
    f.worktrees.scan.sources = sources;
    rmSync(source, { recursive: true, force: true });
    await f.tick();
    expect(f.attempts()).toHaveLength(1);
    expect(consumed(f)).not.toBe(generation);
    f.worktrees.makeRepo(source);
    await f.tick();
    await f.tick();
    expect(f.attempts().map((attempt) => attempt.outcome)).toEqual(["queued", "appended"]);
    expect(staleSent(f)).toBe(2);
    expect(consumed(f)).toBe(generation);
  });

  it("keeps the return unconsumed while a configured source is missing, and sends the line once the source is back", async () => {
    const f = await make();
    const source = f.worktrees.enable();
    shadow(f);
    f.output(STALE, 1);
    await f.tick();
    expect(staleSent(f)).toBe(1);
    live(f); const generation = back(f);
    rmSync(source, { recursive: true, force: true });
    f.output("", 0); // nothing stale now: a complete judgement would consume the return
    await f.tick();
    expect(consumed(f)).not.toBe(generation);
    f.worktrees.makeRepo(source);
    f.output(STALE, 1); // the same line as the last delivered report
    await f.tick();
    expect(staleSent(f)).toBe(2);
    expect(consumed(f)).toBe(generation);
  });

  it("forgets a deleted tracker's returns, so a restore of the same id resends on its first return to shadow", async () => {
    const f = await make();
    const cycle = async () => {
      shadow(f);
      f.output(STALE, 1);
      await f.tick();
      live(f);
      return back(f);
    };
    const first = await cycle();
    await f.tick();
    expect(consumed(f)).toBe(first);
    requestMode(f.db, { trackerId: f.tracker.id, mode: "off" });
    await f.service.setEnabled(f.tracker.id, false);
    const project = f.db.prepare<[string], Record<string, unknown>>("SELECT * FROM projects WHERE id=?").get(f.tracker.id)!;
    expect(f.store.tasks.deleteProject(f.tracker.id)).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM attention_acks WHERE tracker_id=?").get(f.tracker.id)).toEqual({ n: 0 });
    expect(consumed(f)).toBeNull();
    // A restore brings the same id back with its generations starting over.
    const columns = Object.keys(project);
    f.db.prepare(`INSERT INTO projects (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => project[column]));
    f.setManager(MANAGER);
    await f.enable();
    const sent = staleSent(f);
    expect(await cycle()).toBe(first);
    expect(staleSent(f)).toBe(sent + 1); // the restored tracker's first shadow report
    await f.tick();
    expect(staleSent(f)).toBe(sent + 2);
    expect(consumed(f)).toBe(first);
  });

  it.each([["after", false], ["before", true]])("drops the returns of a tracker deleted before the upgrade, so a restore of the same id %s the upgrade resends on its first return to shadow", async (_when, restoreFirst) => {
    const f = await make();
    const cycle = async () => {
      shadow(f);
      f.output(STALE, 1);
      await f.tick();
      live(f);
      return back(f);
    };
    const first = await cycle();
    await f.tick();
    requestMode(f.db, { trackerId: f.tracker.id, mode: "off" });
    await f.service.setEnabled(f.tracker.id, false);
    // The schema before the upgrade, and its deletion, which kept the tracker's acknowledgements.
    f.db.exec("DROP TABLE checks_stale_rollback");
    // Version 47 is the migration that creates checks_stale_rollback; later migrations stay applied.
    f.db.prepare("DELETE FROM schema_version WHERE version=47").run();
    const project = f.db.prepare<[string], Record<string, unknown>>("SELECT * FROM projects WHERE id=?").get(f.tracker.id)!;
    f.db.prepare("DELETE FROM checks_runner_owner WHERE tracker_id=?").run(f.tracker.id);
    f.db.prepare("DELETE FROM projects WHERE id=?").run(f.tracker.id);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM attention_acks WHERE tracker_id=?").get(f.tracker.id)).toEqual({ n: 2 });
    const columns = Object.keys(project);
    const restore = () => f.db.prepare(`INSERT INTO projects (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => project[column]));
    if (restoreFirst) restore();
    initializeTasksSchema(f.db);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM attention_acks WHERE tracker_id=?").get(f.tracker.id)).toEqual({ n: 0 });
    expect(consumed(f)).toBeNull();
    if (!restoreFirst) restore();
    f.setManager(MANAGER);
    await f.enable();
    const sent = staleSent(f);
    expect(await cycle()).toBe(first);
    await f.tick();
    expect(staleSent(f)).toBe(sent + 2);
    expect(consumed(f)).toBe(first);
  });

  it("does not resend unrelated actions or Waiting from the old baseline", async () => {
    const f = await make();
    shadow(f);
    f.output("ACTION idle EXA-2\nWAIT EXA-3: blocker EXA-4", 1);
    await f.tick();
    live(f);
    await f.tick();
    const generation = back(f);
    await f.tick();
    expect(f.threads.sends).toBe(1);
    expect(consumed(f)).toBe(generation);
  });

  it("sends nothing new for a tracker that never went live, or one whose return is older than the upgrade", async () => {
    const f = await make();
    f.output(STALE, 1);
    await f.tick();
    await f.tick();
    expect(staleSent(f)).toBe(1);
    // A return acknowledged before the upgrade: the migration seeds it as consumed.
    f.db.prepare("INSERT INTO attention_acks (tracker_id, kind, token, generation, direction, fence_id, ids_hash, result_json) VALUES (?, 'stale-status', 'tok_example', 3, 'to_shadow', 'fence', 'h', '{}')").run(f.tracker.id);
    // The tracker went off -> shadow -> live -> shadow -> off before the upgrade, so its mode row has reached that return.
    f.db.prepare("INSERT INTO attention_modes (tracker_id, kind, effective_mode, effective_generation) VALUES (?, 'stale-status', 'off', 4)").run(f.tracker.id);
    f.db.exec("DROP TABLE checks_stale_rollback");
    // Version 47 is the migration that creates checks_stale_rollback; later migrations stay applied.
    f.db.prepare("DELETE FROM schema_version WHERE version=47").run();
    initializeTasksSchema(f.db);
    expect(consumed(f)).toBe(3);
    await f.tick();
    expect(staleSent(f)).toBe(1);
  });
});
