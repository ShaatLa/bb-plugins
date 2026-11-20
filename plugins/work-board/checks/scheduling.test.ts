import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiptPolling } from "../steer";
import { checksTuning } from "./service";
import { cleanTempDirs, MANAGER, setup, type Fixture } from "./fixtures";

const fixtures: Fixture[] = [];
const make = async (fields: Record<string, unknown> = {}) => {
  const f = await setup(); fixtures.push(f); f.standard(); f.enable(fields); return f;
};
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; checksTuning.lateSearchMs = 0; checksTuning.killGraceMs = 200; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });
const ticks = (f: Fixture) => f.db.prepare<[string], { tick: string; executed: number; delivered: number; suppressed: number; refresh_failed: number; script_failed: number; delivery_failed: number }>("SELECT * FROM checks_ticks WHERE tracker_id=? ORDER BY at").all(f.tracker.id);
const idle = (key: string) => `ACTION no-active-thread ${key}: no active session for 5 min`;

describe("scheduling", () => {
  it("runs once per interval and coalesces missed intervals into one tick", async () => {
    const f = await make({ intervalMinutes: 5 });
    await f.service.runDue();
    await f.service.runDue();
    expect(f.runs()).toBe(1);
    expect(f.state().nextRun).toBeGreaterThan(Date.now() + 4 * 60_000);
    f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.nextRun', ?)").run(Date.now() - 6 * 5 * 60_000);
    await f.service.runDue();
    await f.service.runDue();
    expect(f.runs()).toBe(2);
    expect(ticks(f)).toHaveLength(2);
  });

  it("recovers due ticks through the watchdog service when the cron dispatcher stalls", async () => {
    const f = await make();
    const { controller, done } = (f.harness as unknown as { runService(name: string): { controller: AbortController; done: Promise<void> } }).runService("checks-due");
    await new Promise<void>((resolve, reject) => { const stop = Date.now() + 8000; const poll = () => (f.runs() >= 1 ? resolve() : Date.now() > stop ? reject(new Error("service never ran")) : setTimeout(poll, 50)); poll(); });
    controller.abort();
    await done;
    expect(f.runs()).toBe(1);
  });

  it("serializes ticks and manual runs per project", async () => {
    const f = await make();
    const go = `${f.io}/go`;
    f.script(`echo run >> "${f.io}/runs.log"; while [ ! -e "${go}" ]; do sleep 0.1; done`);
    const first = f.tick();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await f.tick(); // coalesced into the active run
    await expect(f.service.manualRun(f.tracker.id)).rejects.toThrow(/already running/);
    expect(f.runs()).toBe(1);
    writeFileSync(go, "");
    await first;
    expect(ticks(f)).toHaveLength(1);
  });

  it("doubles the refresh backoff up to an hour and resets it after a successful refresh", async () => {
    const f = await make({ intervalMinutes: 10 });
    f.control.remote = "file:///nonexistent/example";
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await f.tick();
      delays.push(Math.round((f.state().refreshRetryAt - Date.now()) / 60_000));
      f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.refreshRetryAt', ?)").run(Date.now() - 1);
    }
    expect(delays).toEqual([10, 20, 40, 60, 60, 60]);
    // A backoff in force delays the next run, not the tick.
    await f.tick();
    f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.refreshRetryAt', ?)").run(Date.now() + 3_600_000);
    const before = ticks(f).length;
    await f.tick();
    expect(ticks(f)).toHaveLength(before + 1);
    expect(ticks(f).at(-1)!.executed).toBe(0);
    f.control.remote = f.repo.url;
    f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.refreshRetryAt', ?)").run(Date.now() - 1);
    await f.tick();
    expect(f.runs()).toBe(1);
    expect(f.state()).toMatchObject({ refreshFailures: 0 });
    expect(f.state().refreshRetryAt).toBeUndefined();
  });

  it("records a timeout and an output over 1 MB as exit-2 script failures", async () => {
    const f = await make({ timeoutSeconds: 1 });
    f.script("sleep 30");
    await f.tick();
    expect(f.state()).toMatchObject({ exitCode: 2, failureStage: "script", error: expect.stringContaining("timed out") });
    f.db.prepare("UPDATE checks_state SET value = json_set(value, '$.lastFailure', json('null'))").run();
    f.script("head -c 1500000 /dev/zero | tr '\\0' a");
    await f.tick(); // the first failure is delivered; a different failure notifies again
    expect(f.state()).toMatchObject({ exitCode: 2, failureStage: "script", error: expect.stringContaining("exceeds 1 MB") });
    expect(ticks(f).map((t) => t.script_failed)).toEqual([1, 1]);
  });

  it("cancels the running script on shutdown", async () => {
    const f = await make();
    f.script(`echo $$ > "${f.io}/pid"; sleep 30`);
    const running = f.tick().catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await f.dispose();
    expect(String(await running)).toMatch(/abort|shutdown|Error/i);
    const pid = Number(await import("node:fs").then(({ readFileSync }) => readFileSync(`${f.io}/pid`, "utf8")));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("stats and status", () => {
  it("counts a failed refresh as a check with a result, and a backing-off tick as scheduled but not executed", async () => {
    const f = await make();
    f.control.remote = "file:///nonexistent/example";
    await f.tick();
    await f.tick(); // under backoff
    expect(ticks(f).map((t) => [t.executed, t.refresh_failed])).toEqual([[1, 1], [0, 0]]);
    expect(f.service.stats(f.tracker.id, 1)).toMatchObject({ ticks: 2, executed: 1, refreshFailures: 1, scriptFailures: 0 });
  });

  it("keeps the staged tick apart from the retry tick, and a tick that only fails to deliver is not executed", async () => {
    const f = await make();
    f.output(idle("EXA-1"), 1);
    f.threads.threads.set(MANAGER, { archived: true });
    await f.tick(); // t1: runs, stages, delivery fails
    await f.tick(); // t2: only retries the pending report, which fails again
    f.threads.threads.set(MANAGER, {});
    await f.tick(); // t3: the retry is accepted, then the script runs again
    const rows = ticks(f);
    expect(rows.map((t) => [t.executed, t.delivered, t.delivery_failed])).toEqual([[1, 0, 1], [0, 0, 0], [1, 1, 0]]);
    const status = f.service.status(f.tracker.id);
    expect(status.lastDelivery).toMatchObject({ tickId: rows[0]!.tick, to: MANAGER, receipt: { mode: "queued" } });
    expect(status.stats).toMatchObject({ ticks: 3, executed: 2, deliveries: 1, deliveryFailures: 1, suppressedReports: 1 });
    expect(status).toMatchObject({ exitCode: 1, failureStage: null, pending: null, awaitingRetry: false, error: null, lastRun: expect.any(Number), nextRun: expect.any(Number) });
  });

  it("counts an item once per fingerprint per tick, and new items only when first seen in the window", async () => {
    const f = await make();
    f.output(`${idle("EXA-1")}\n${idle("EXA-1")}\nANSWER EXA-1 owner: yes`, 1);
    await f.tick();
    expect(f.service.stats(f.tracker.id, 1)).toMatchObject({ repeats: 0, newItems: { "ACTION no-active-thread": 1, ANSWER: 1 } });
    f.output(`${idle("EXA-1")}\nANSWER EXA-1 owner: yes`, 1);
    await f.tick();
    expect(f.service.stats(f.tracker.id, 1)).toMatchObject({ repeats: 2, newItems: { "ACTION no-active-thread": 1, ANSWER: 1 } });
    f.db.prepare("UPDATE checks_items SET first_at = ?").run(Date.now() - 5 * 86_400_000);
    expect(f.service.stats(f.tracker.id, 1).newItems).toEqual({});
    expect(f.service.stats(f.tracker.id, 7).newItems).toEqual({ "ACTION no-active-thread": 1, ANSWER: 1 });
  });

  it("does not count a fully quiet no-op as a suppressed report", async () => {
    const f = await make();
    f.output("", 0);
    await f.tick();
    expect(f.service.stats(f.tracker.id, 1)).toMatchObject({ executed: 1, suppressedReports: 0 });
    f.output("WAIT EXA-1: blocker EXA-2", 0);
    await f.tick();
    await f.tick();
    expect(f.service.stats(f.tracker.id, 1)).toMatchObject({ suppressedReports: 1 });
  });

  it("serves status and stats through the CLI", async () => {
    const f = await make();
    f.output(idle("EXA-1"), 1);
    await f.tick();
    const status = JSON.parse((await f.harness.runCli(["checks", "status", "--project", "CHK", "--json"])).stdout!);
    expect(status).toMatchObject({ prefix: "CHK", bbProjectId: "proj_example", manager: MANAGER, exitCode: 1, lastDelivery: { to: MANAGER } });
    expect((await f.harness.runCli(["checks", "status", "--project", "CHK"])).stdout).toMatch(/Last delivery\s+\S+ to thr_manager \(queued\)/);
    expect(JSON.parse((await f.harness.runCli(["checks", "stats", "--project", "CHK", "--days", "7", "--json"])).stdout!)).toMatchObject({ days: 7, ticks: 1, deliveries: 1 });
    expect((await f.harness.runCli(["checks", "stats", "--project", "CHK", "--days", "31"])).exitCode).toBe(1);
  });
});
