import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receiptPolling } from "../steer";
import { BB_PROJECT, cleanTempDirs, setup, type Fixture } from "./fixtures";

const fixtures: Fixture[] = [];
const make = async () => { const f = await setup(); fixtures.push(f); f.standard(); return f; };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

const setKey = (f: Fixture, key: string, value: unknown, projectId = f.tracker.id) => f.harness.callRpc("config.set", { projectId, key: `checks.${key}`, value }) as Promise<{ value: unknown }>;
const getKey = async (f: Fixture, key: string) => ((await f.harness.callRpc("config.get", { projectId: f.tracker.id, key: `checks.${key}` })) as { values: Record<string, unknown> }).values[`checks.${key}`];

describe("settings", () => {
  it("is off by default, with documented defaults", async () => {
    const f = await make();
    const all = ((await f.harness.callRpc("config.get", { projectId: f.tracker.id })) as { values: Record<string, unknown> }).values;
    expect(all).toMatchObject({ "checks.enabled": false, "checks.branch": null, "checks.script": null, "checks.args": [], "checks.intervalMinutes": 10, "checks.timeoutSeconds": 300, "checks.snapshots": false });
    await f.tick();
    expect(f.runs()).toBe(0);
    expect(f.service.status(f.tracker.id)).toMatchObject({ nextRun: null, draining: false });
  });

  it("refuses `enabled` through config.set and the CLI, and records the UI's change with its time and previous value", async () => {
    const f = await make();
    f.configure();
    await expect(setKey(f, "enabled", true)).rejects.toThrow(/owner/);
    expect((await f.harness.runCli(["config", "set", "checks.enabled", "true", "--project", "CHK"])).exitCode).toBe(1);
    expect(await getKey(f, "enabled")).toBe(false);
    await f.harness.callRpc("updateChecksEnabled", { projectId: f.tracker.id, enabled: true });
    expect(f.service.status(f.tracker.id)).toMatchObject({ config: { enabled: true }, enabledPrevious: false, enabledChangedAt: expect.any(String) });
    await f.harness.callRpc("updateChecksEnabled", { projectId: f.tracker.id, enabled: false });
    expect(f.service.status(f.tracker.id)).toMatchObject({ config: { enabled: false }, enabledPrevious: true });
  });

  it("allows omitted fields while off, rejects a supplied invalid value at once, and refuses enabling an incomplete configuration", async () => {
    const f = await make();
    await setKey(f, "intervalMinutes", 15); // a draft without branch and script
    await expect(setKey(f, "branch", "bad branch")).rejects.toThrow(/Invalid value for checks.branch/);
    await expect(setKey(f, "script", "/abs/run.sh")).rejects.toThrow(/Invalid value/);
    expect(await getKey(f, "branch")).toBeNull();
    expect(() => f.service.setEnabled(f.tracker.id, true)).toThrow(/Set branch and script/);
    await setKey(f, "branch", "main");
    expect(() => f.service.setEnabled(f.tracker.id, true)).toThrow(/Set script/);
    await setKey(f, "script", "checks/run.sh");
    expect(f.service.setEnabled(f.tracker.id, true)).toEqual({ enabled: true });
  });

  it("validates fields as Sweep does: timeout 0, 1, 300 and 301, branch, script and argv limits", async () => {
    const f = await make();
    for (const bad of [0, 301, 1.5]) await expect(setKey(f, "timeoutSeconds", bad)).rejects.toThrow(/Invalid value/);
    for (const good of [1, 300]) expect((await setKey(f, "timeoutSeconds", good)).value).toBe(good);
    for (const bad of [0, 1441]) await expect(setKey(f, "intervalMinutes", bad)).rejects.toThrow(/Invalid value/);
    for (const bad of ["", "-x", "a b", "x".repeat(201), ".hidden"]) await expect(setKey(f, "branch", bad)).rejects.toThrow(/Invalid value/);
    expect((await setKey(f, "branch", "release/1.0_a-b")).value).toBe("release/1.0_a-b");
    for (const bad of ["", "/abs", "a/../b", "..", "x".repeat(1001)]) await expect(setKey(f, "script", bad)).rejects.toThrow(/Invalid value/);
    await expect(setKey(f, "args", Array(101).fill("a"))).rejects.toThrow(/Invalid value/);
    await expect(setKey(f, "args", ["x".repeat(10001)])).rejects.toThrow(/Invalid value/);
    await expect(setKey(f, "args", "--root")).rejects.toThrow(/Invalid value/);
    expect((await setKey(f, "args", ["--root", "{manager}"])).value).toEqual(["--root", "{manager}"]);
    expect((await setKey(f, "args", Array(100).fill("x".repeat(10000)))).value).toHaveLength(100);
    // From the shell: digits parse to a number, so a numeric branch name still works.
    expect((await f.harness.runCli(["config", "set", "checks.branch", "2024", "--project", "CHK", "--json"])).exitCode).toBe(0);
    expect(await getKey(f, "branch")).toBe("2024");
    // Branch and script keep their literal text: `1e3` is a legal branch name, not the number 1000.
    expect((await f.harness.runCli(["config", "set", "checks.branch", "1e3", "--project", "CHK"])).exitCode).toBe(0);
    expect(await getKey(f, "branch")).toBe("1e3");
    expect((await f.harness.runCli(["config", "set", "checks.script", "1e3", "--project", "CHK"])).exitCode).toBe(0);
    expect(await getKey(f, "script")).toBe("1e3");
    // A typed caller must send strings.
    await expect(setKey(f, "branch", 1000)).rejects.toThrow(/Invalid value/);
    await expect(setKey(f, "script", 5)).rejects.toThrow(/Invalid value/);
    await expect(f.harness.callRpc("updateChecksSetting", { projectId: f.tracker.id, key: "branch", value: 7 })).rejects.toThrow(/Invalid value/);
  });

  it("merges concurrent per-field edits, and a stale edit never restores `enabled`", async () => {
    const f = await make();
    f.enable();
    await Promise.all([setKey(f, "intervalMinutes", 20), setKey(f, "timeoutSeconds", 60), setKey(f, "snapshots", true), setKey(f, "args", ["a"])]);
    expect(f.service.status(f.tracker.id).config).toEqual({ enabled: true, branch: "main", script: "checks/run.sh", args: ["a"], intervalMinutes: 20, timeoutSeconds: 60, snapshots: true });
    // The owner turns it off; an edit that raced with it changes only its own field.
    await f.harness.callRpc("updateChecksEnabled", { projectId: f.tracker.id, enabled: false });
    await setKey(f, "branch", "dev");
    expect(f.service.status(f.tracker.id).config).toMatchObject({ enabled: false, branch: "dev", intervalMinutes: 20 });
  });

  it("re-checks `enabled` when a due callback resumes, so disabling while it waited prevents the run", async () => {
    const f = await make();
    f.output("ACTION idle EXA-1", 1);
    f.enable();
    f.threads.threads.set("thr_manager", { archived: true });
    await f.tick(); // runs, stages the report; delivery fails
    expect(f.runs()).toBe(1);
    f.threads.threads.set("thr_manager", {});
    let release!: () => void;
    f.threads.getGateOnce = new Promise((resolve) => { release = resolve; });
    const waiting = f.tick(); // delivers the pending report, held at the manager lookup
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.service.setEnabled(f.tracker.id, false);
    release();
    await waiting;
    expect(f.runs()).toBe(1);
    expect(f.delivery()?.report_id).toBeNull();
  });
});

describe("ownership", () => {
  it("lets one tracker own a bb project's runner: the second can neither enable nor run, dry-run included", async () => {
    const f = await make();
    f.output("ACTION idle EXA-1", 1);
    f.enable();
    const second = f.other();
    for (const [key, value] of Object.entries({ branch: "main", script: "checks/run.sh" })) f.service.setField(second.id, key as never, value);
    f.db.prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at) VALUES (?, 'thr_manager', ?)").run(second.id, new Date().toISOString());
    expect(() => f.service.setEnabled(second.id, true)).toThrow(/belong to tracker CHK/);
    await expect(f.service.manualRun(second.id)).rejects.toThrow(/belong to tracker CHK/);
    expect((await f.harness.runCli(["checks", "run", "--project", "OTH", "--dry-run"])).exitCode).toBe(1);
    expect(f.runs()).toBe(0);
    // Once the first is disabled and has nothing pending, the second may take over.
    f.service.setEnabled(f.tracker.id, false);
    expect(f.service.setEnabled(second.id, true)).toEqual({ enabled: true });
  });

  it("keeps a disabled tracker the owner while it has a pending report, and refuses relink and reset until it drains", async () => {
    const f = await make();
    f.output("ACTION idle EXA-1", 1);
    f.enable();
    f.threads.threads.set("thr_manager", { archived: true });
    await f.tick();
    expect(f.delivery()?.report_id).toBeTruthy();
    f.service.setEnabled(f.tracker.id, false);
    expect(f.service.status(f.tracker.id)).toMatchObject({ draining: true, nextRun: expect.any(Number) });
    const second = f.other();
    for (const [key, value] of Object.entries({ branch: "main", script: "checks/run.sh" })) f.service.setField(second.id, key as never, value);
    expect(() => f.service.setEnabled(second.id, true)).toThrow(/still delivering|belong to tracker CHK/);
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" })).toThrow(/still delivering/);
    expect(() => f.service.reset(f.tracker.id)).toThrow(/drain/);
    // The scheduler drains it in the background although it is disabled; no new run starts.
    f.threads.threads.set("thr_manager", {});
    await f.tick();
    expect(f.delivery()?.report_id).toBeNull();
    expect(f.runs()).toBe(1);
    expect(f.service.status(f.tracker.id)).toMatchObject({ draining: false, nextRun: null });
    expect(f.service.setEnabled(second.id, true)).toEqual({ enabled: true });
  });

  it("freezes the link while enabled, and never applies state recorded for another bb project after a relink", async () => {
    const f = await make();
    f.output("", 0, '{"seen":1}');
    f.enable({ snapshots: true });
    expect(() => f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" })).toThrow(/Repository checks/);
    await f.tick(); // the first candidate is a baseline: delivered and promoted
    expect(f.db.prepare("SELECT committed_project FROM checks_delivery").get()).toEqual({ committed_project: BB_PROJECT });
    f.service.setEnabled(f.tracker.id, false);
    f.store.tasks.updateProject(f.tracker.id, { linkedBbProjectId: "proj_other" });
    expect(f.service.status(f.tracker.id).stateMismatch).toBe(`State belongs to ${BB_PROJECT}; reset it`);
    // The script sees no committed file; enabling and scheduled ticks refuse until the owner resets.
    f.script(`if [ -e "$BB_SWEEP_COMMITTED_STATE" ]; then echo committed; else echo absent; fi`);
    expect((await f.service.manualRun(f.tracker.id)).output).toBe("absent\n");
    expect(() => f.service.setEnabled(f.tracker.id, true)).toThrow(/belongs? to proj_example|State belongs/);
    f.service.reset(f.tracker.id);
    expect(f.service.status(f.tracker.id).stateMismatch).toBeNull();
    expect(f.delivery()).toBeUndefined();
  });

  it("refuses to delete a tracker, force included, while checks are enabled or draining", async () => {
    const f = await make();
    f.output("ACTION idle EXA-1", 1);
    f.enable();
    await expect(f.harness.callRpc("deleteProject", { projectId: f.tracker.id, force: true })).rejects.toThrow(/before deleting/);
    f.threads.threads.set("thr_manager", { archived: true });
    await f.tick();
    f.service.setEnabled(f.tracker.id, false);
    await expect(f.harness.callRpc("deleteProject", { projectId: f.tracker.id, force: true })).rejects.toThrow(/before deleting/);
    expect(f.delivery()?.report_id).toBeTruthy();
    f.threads.threads.set("thr_manager", {});
    await f.tick();
    expect(await f.harness.callRpc("deleteProject", { projectId: f.tracker.id, force: true })).toMatchObject({ deleted: true });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM checks_delivery").get()).toEqual({ n: 0 });
  });

  it("never delivers a report staged for another bb project", async () => {
    const f = await make();
    f.output("ACTION idle EXA-1", 1);
    f.enable();
    f.threads.threads.set("thr_manager", { archived: true });
    await f.tick();
    f.service.setEnabled(f.tracker.id, false);
    f.threads.threads.set("thr_manager", {});
    f.db.prepare("UPDATE checks_delivery SET pending_project='proj_other'").run();
    await f.tick();
    expect(f.threads.sends).toBe(0);
    expect(f.service.status(f.tracker.id)).toMatchObject({ draining: false, stateMismatch: expect.stringContaining("proj_other") });
    expect(f.service.reset(f.tracker.id)).toEqual({ ok: true });
  });
});
