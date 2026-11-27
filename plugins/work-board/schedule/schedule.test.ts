import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGER } from "../attention/fixtures";
import { historyLimits, receiptPolling } from "../steer";
import { fixture, fixtures, rpcError } from "./fixture";
import { POLICY_GIVE_UP_MS, recoverScheduledStarts } from "./service";
import { claimDue, markerOf, recordOutcome } from "./store";
import { joinArgs, parseStartTime, splitArgs } from "./when";

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const limits = { ...historyLimits };
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { Object.assign(historyLimits, limits); vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

describe("setting a start", () => {
  it("dry-runs the builder with the stored args and the setter as parent, and stores the start with a log row and a comment", async () => {
    const f = fixture();
    const { scheduledStart } = await f.schedule("+10m");
    expect(f.world.starts).toEqual([{ projectId: "proj_example", parentThreadId: "thr_setter", args: ["--card", f.task.key, "--role", "impl"], dryRun: true }]);
    expect(scheduledStart).toMatchObject({ state: "scheduled", mode: "spawn_gate", setter: "thr_setter", builderArgs: ["--card", f.task.key, "--role", "impl"] });
    expect(f.events()).toEqual(["scheduled"]);
    expect(f.comments()[0]).toContain(`Start scheduled for`);
    expect(f.comments()[0]).toContain("by thr_setter: Spawn Gate `--card");
  });

  it("returns a builder refusal with its reason code and stores nothing", async () => {
    const f = fixture();
    f.world.start = async () => { throw rpcError("handler_error", 'builder.py exited 1: {"reasonCode":"missing_required_sections"}\nno scope'); };
    await expect(f.schedule()).rejects.toThrow(/refuses these arguments \(missing_required_sections\)/);
    expect(f.rows()).toHaveLength(0);
    expect(f.events()).toEqual([]);
  });

  it("refuses a preset in a Script-mode project and the gate launch in a project without it", async () => {
    const f = fixture();
    await expect(f.schedule("+10m", f.viaPreset)).rejects.toThrow(/Spawn Gate launches this project's sessions/);
    f.world.installed = false;
    await expect(f.schedule("+10m", f.gate)).rejects.toThrow(/does not launch through Spawn Gate's Script mode/);
    f.world.installed = true; f.world.method = "instruction";
    await expect(f.schedule("+10m", f.gate)).rejects.toThrow(/does not launch through Spawn Gate/);
    expect((await f.schedule("+10m", f.viaPreset)).scheduledStart.mode).toBe("preset");
  });

  it("refuses times in the past, under two minutes ahead, and without an offset", async () => {
    const f = fixture();
    await expect(f.schedule("2000-01-01T00:00:00Z")).rejects.toThrow(/at least 2 minutes ahead/);
    await expect(f.schedule("+1m")).rejects.toThrow(/at least 2 minutes ahead/);
    await expect(f.schedule("2099-01-01T02:00:00")).rejects.toThrow(/Cannot read the start time/);
    expect(parseStartTime("2099-01-01T02:00:00+03:00")).toBe("2098-12-31T23:00:00.000Z");
    expect(f.rows()).toHaveLength(0);
  });

  it("fails closed when the policy cannot be read: no schedule, no preset fallback", async () => {
    const f = fixture();
    f.world.configFail = true;
    await expect(f.schedule("+10m", f.viaPreset)).rejects.toThrow(/could not read the Spawn Gate launch policy/);
    await expect(f.schedule("+10m", f.gate)).rejects.toThrow(/could not read the Spawn Gate launch policy/);
    f.world.configFail = false; f.world.listFail = true;
    await expect(f.schedule("+10m", f.viaPreset)).rejects.toThrow(/could not read the Spawn Gate launch policy/);
    expect(f.rows()).toHaveLength(0);
  });

  it("allows one active start per card and points to change", async () => {
    const f = fixture();
    await f.schedule();
    await expect(f.schedule()).rejects.toThrow(/schedule change or schedule cancel/);
    expect(f.rows()).toHaveLength(1);
  });

  it("refuses a closed card and a project without a manager for the owner", async () => {
    const f = fixture();
    const done = f.card("Done card", "done");
    await expect(f.schedule("+10m", f.gate, "thr_setter", done.id)).rejects.toThrow(/closed or archived/);
    f.db.prepare("DELETE FROM attention_manager").run();
    await expect(f.schedule("+10m", f.gate, "owner")).rejects.toThrow(/no manager thread to own a scheduled start/);
  });

  it("fills the project's scheduledStartArgs setting, and the card key", async () => {
    const f = fixture();
    await f.call("config.set", { projectId: f.tracker.id, key: "scheduledStartArgs", value: "--card {key} --role check --reason 'night run'" });
    expect((await f.call("config.get", { projectId: f.tracker.id, key: "scheduledStartArgs" })).values.scheduledStartArgs).toContain("--role check");
    await f.schedule("+10m", { kind: "gate" });
    expect(f.world.starts.at(-1)!.args).toEqual(["--card", f.task.key, "--role", "check", "--reason", "night run"]);
    expect(splitArgs(`a "b c" d\\ e 'f g'`)).toEqual(["a", "b c", "d e", "f g"]);
  });

  it("joins arguments so that splitting gives the same array back", () => {
    for (const args of [["--reason", "night run"], [""], ['a"b'], ["c\\d"], ["it's"], ["--card", "{key}", "--role", "impl"], ["a  b", "", "'", "\\", "x\ty", "$HOME", "é ü"], []]) expect(splitArgs(joinArgs(args))).toEqual(args);
    expect(joinArgs(["--reason", "night run"])).toBe("--reason 'night run'");
  });
});

describe("launching", () => {
  it("launches through Spawn Gate at its time only: nothing before, one start call after with the stored args and the resolved parent", async () => {
    const f = fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now();
    await f.schedule("+10m");
    vi.setSystemTime(base + 9 * MINUTE);
    await f.sweep();
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(0);
    expect(f.row().state).toBe("scheduled");
    vi.setSystemTime(base + 10 * MINUTE + 1000);
    await f.sweep();
    const real = f.world.starts.filter((call) => !call.dryRun);
    expect(real).toEqual([{ projectId: "proj_example", parentThreadId: "thr_setter", args: ["--card", f.task.key, "--role", "impl"], dryRun: false }]);
    expect(f.row()).toMatchObject({ state: "launched", thread_id: "thr_launched", attached: 1 });
    expect(f.events()).toEqual(["scheduled", "launching", "launched"]);
    expect(f.comments().some((text) => text.includes("Scheduled start launched thr_launched"))).toBe(true);
    expect(f.db.prepare("SELECT 1 FROM task_threads WHERE task_id=? AND thread_id='thr_launched'").get(f.task.id)).toBeTruthy();
    await f.sweep(); await f.sweep();
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(1);
  });

  it("launches a preset start through delegate, with the marker in the seed prompt and the setter as parent", async () => {
    const f = fixture();
    f.world.installed = false;
    await f.schedule("+10m", { ...f.viaPreset, brief: "Run the focused tests." });
    f.due();
    await f.sweep();
    expect(f.world.spawned).toHaveLength(1);
    expect(f.world.spawned[0]!.parentThreadId).toBe("thr_setter");
    expect(f.world.spawned[0]!.prompt).toContain("Run the focused tests.");
    expect(f.world.spawned[0]!.prompt).toContain(markerOf(f.row().launch_id));
    expect(f.row()).toMatchObject({ state: "launched", thread_id: "thr_spawned_1", attached: 1 });
    expect(f.events()).toEqual(["scheduled", "launching", "launched"]);
  });

  it("a canceled start never launches, and a change moves the time", async () => {
    const f = fixture();
    await f.schedule("+10m");
    await f.call("changeScheduledStart", { taskId: f.task.id, at: "+3h", actor: "thr_setter" });
    expect(new Date(f.row().start_at).getTime()).toBeGreaterThan(Date.now() + 2 * HOUR);
    f.due();
    await f.call("cancelScheduledStart", { taskId: f.task.id, reason: "not tonight", actor: "thr_setter" });
    await f.sweep();
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(0);
    expect(f.row().state).toBe("canceled");
    expect(f.events()).toEqual(["scheduled", "changed", "canceled"]);
    expect(f.comments().at(-1)).toContain("canceled by thr_setter: not tonight");
  });

  it("cancels at the sweep a start whose card was closed meanwhile", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.store.tasks.updateTask(f.task.id, { status: "done" });
    f.due();
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "canceled", error: expect.stringContaining("closed") });
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(0);
  });

  it("records a refusal with its reason code, writes one comment, and sends one notice to the setter", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.world.start = async (input) => { if (input.dryRun) return { dryRun: true }; throw rpcError("handler_error", 'Provider pace meets or exceeds 1.25 for claude-code. {"reasonCode":"over_pace"}'); };
    f.due();
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "refused", reason_code: "over_pace" });
    expect(f.comments().filter((text) => text.includes("refused"))).toHaveLength(1);
    expect(f.notices()).toEqual([{ state: "sent", recipient: "thr_setter", kind: "refused" }]);
    expect(f.to("thr_setter")).toHaveLength(1);
    expect(f.to("thr_setter")[0]).toContain("was refused and nothing was started");
    await f.sweep(); await f.sweep();
    expect(f.to("thr_setter")).toHaveLength(1);
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(1);
  });

  it("tells the parent of an archived setter, and the manager for the owner", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.threads.threads.set("thr_setter", { archived: true, parent: "thr_parent" });
    f.world.start = async () => { throw rpcError("invalid_input", "bad args"); };
    f.due();
    await f.sweep();
    // The archived setter's own parent takes the launch (and is saved as its parent) and the notice alike.
    expect(f.row().parent_thread_id).toBe("thr_parent");
    expect(f.to("thr_parent")).toHaveLength(1);
    expect(f.to("thr_parent")[0]).toContain("You get this because thr_setter is archived or gone.");
    const g = fixture();
    await g.schedule("+10m", g.gate, "owner");
    g.world.start = async () => { throw rpcError("invalid_input", "bad args"); };
    g.due();
    await g.sweep();
    expect(g.to(MANAGER)).toHaveLength(1);
    expect(g.to(MANAGER)[0]).toContain("scheduled by the owner");
  });

  it("stores a lost response as unknown, never failed, with a notice and a comment, and never relaunches", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.world.start = async (input) => { if (input.dryRun) return { dryRun: true }; throw rpcError("transport_error", "request timed out"); };
    f.due();
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "unknown", error: expect.stringContaining("timed out") });
    expect(f.notices()).toMatchObject([{ kind: "unknown", state: "sent" }]);
    expect(f.comments().some((text) => text.includes("outcome unknown"))).toBe(true);
    await f.sweep(); await f.sweep();
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(1);
    // An unknown handler error (for example a failed spawn call) is unknown too.
    const g = fixture();
    await g.schedule("+10m");
    g.world.start = async (input) => { if (input.dryRun) return { dryRun: true }; throw rpcError("handler_error", "HTTP 502: bad gateway"); };
    g.due(); await g.sweep();
    expect(g.row().state).toBe("unknown");
  });

  it("attaches a launched Spawn Gate session on a later sweep when the first attach failed", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due();
    const real = f.threads.sdk.threads.get;
    let fail = true;
    f.harness.sdk.stub("threads.get", async (args: { threadId: string }) => { if (fail && args.threadId === "thr_launched") throw new Error("not ready"); return real(args); });
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "launched", attached: 0 });
    fail = false;
    await f.sweep();
    expect(f.row().attached).toBe(1);
    expect(f.db.prepare("SELECT 1 FROM task_threads WHERE task_id=? AND thread_id='thr_launched'").get(f.task.id)).toBeTruthy();
  });
});

describe("the launch policy at launch time", () => {
  it("waits out a read error and launches on a later sweep", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due(new Date(Date.now() - MINUTE).toISOString());
    f.world.configFail = true;
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "scheduled", policy_error: expect.stringContaining("could not read") });
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(0);
    f.world.configFail = false;
    await f.sweep();
    expect(f.row().state).toBe("launched");
  });

  it("gives up with a refusal when the policy is still unreadable 30 minutes after the start time", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due(new Date(Date.now() - POLICY_GIVE_UP_MS - MINUTE).toISOString());
    f.world.configFail = true;
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "refused", error: expect.stringContaining("unreadable") });
    expect(f.notices()).toHaveLength(1);
  });

  it("refuses, spawning nothing, when the project turned Spawn Gate on after a preset schedule, or off after a gate schedule", async () => {
    const f = fixture();
    f.world.installed = false;
    await f.schedule("+10m", f.viaPreset);
    f.world.installed = true;
    f.due(); await f.sweep();
    expect(f.row()).toMatchObject({ state: "refused", error: expect.stringContaining("launch policy changed") });
    expect(f.world.spawned).toHaveLength(0);
    const g = fixture();
    await g.schedule("+10m", g.gate);
    g.world.method = "instruction";
    g.due(); await g.sweep();
    expect(g.row().state).toBe("refused");
    expect(g.world.starts.filter((call) => !call.dryRun)).toHaveLength(0);
  });
});

describe("restart and crash safety", () => {
  it("keeps a schedule across a restart and launches it on time", async () => {
    const f = fixture();
    await f.schedule("+10m");
    expect(recoverScheduledStarts(f.db)).toBe(0);
    f.due();
    await f.sweep();
    expect(f.row().state).toBe("launched");
  });

  it("turns a launching row into unknown at startup and never relaunches it", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due();
    claimDue(f.db, new Date().toISOString());
    expect(f.row().state).toBe("launching");
    expect(recoverScheduledStarts(f.db)).toBe(1);
    expect(f.row().state).toBe("unknown");
    await f.sweep();
    expect(f.world.starts.filter((call) => !call.dryRun)).toHaveLength(0);
    expect(f.row().state).toBe("unknown");
    expect(f.notices()).toMatchObject([{ kind: "unknown" }]);
  });

  it("reconciles a preset start by its marker: exactly one child, and two concurrent starts each find only their own", async () => {
    const f = fixture();
    f.world.installed = false;
    const other = f.card("Other card", "todo");
    await f.schedule("+10m", f.viaPreset);
    await f.schedule("+10m", f.viaPreset, "thr_setter", other.id);
    f.due(undefined, f.task.id); f.due(undefined, other.id);
    claimDue(f.db, new Date().toISOString()); claimDue(f.db, new Date().toISOString());
    recoverScheduledStarts(f.db);
    const mine = f.row(f.task.id), theirs = f.row(other.id);
    expect([mine.state, theirs.state]).toEqual(["unknown", "unknown"]);
    const created = Date.now();
    f.world.children.push({ id: "thr_mine", parentThreadId: "thr_setter", createdAt: created }, { id: "thr_theirs", parentThreadId: "thr_setter", createdAt: created }, { id: "thr_unrelated", parentThreadId: "thr_setter", createdAt: created });
    f.threads.dispatch(`Seed ${markerOf(mine.launch_id)}`, "thr_mine");
    f.threads.dispatch(`Seed ${markerOf(theirs.launch_id)}`, "thr_theirs");
    f.threads.dispatch("An unrelated first prompt", "thr_unrelated");
    await f.sweep();
    expect(f.row(f.task.id)).toMatchObject({ state: "launched", thread_id: "thr_mine" });
    expect(f.row(other.id)).toMatchObject({ state: "launched", thread_id: "thr_theirs" });
    expect(f.events(f.task.id)).toContain("reconciled");
    expect(f.db.prepare("SELECT 1 FROM task_threads WHERE task_id=? AND thread_id='thr_mine'").get(f.task.id)).toBeTruthy();
  });

  it("saves the parent a launch uses, so a lost response after a spawn under a new parent reconciles to that session", async () => {
    const f = fixture();
    f.world.installed = false;
    await f.schedule("+10m", f.viaPreset);
    expect(f.row().parent_thread_id).toBe("thr_setter");
    // The setter is archived before the launch: the session goes under its live parent.
    f.threads.threads.set("thr_setter", { archived: true, parent: "thr_parent" });
    f.world.spawnLoseResponse = true;
    f.due();
    await f.sweep();
    expect(f.world.spawned).toHaveLength(1);
    expect(f.world.spawned[0]!.parentThreadId).toBe("thr_parent");
    expect(f.row()).toMatchObject({ state: "unknown", parent_thread_id: "thr_parent" });
    // The spawned session exists under that parent, carrying the marker in its first prompt.
    f.world.children.push({ id: "thr_spawned_1", parentThreadId: "thr_parent", createdAt: Date.now() });
    f.threads.dispatch(f.world.spawned[0]!.prompt, "thr_spawned_1");
    expect(recoverScheduledStarts(f.db)).toBe(0);
    await f.sweep();
    expect(f.row()).toMatchObject({ state: "launched", thread_id: "thr_spawned_1", attached: 1 });
    expect(f.events()).toContain("reconciled");
  });

  it("passes the stored launch parent to Spawn Gate's start", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.threads.threads.set("thr_setter", { archived: true, parent: "thr_parent" });
    f.due();
    await f.sweep();
    expect(f.world.starts.filter((call) => !call.dryRun).map((call) => call.parentThreadId)).toEqual(["thr_parent"]);
    expect(f.row()).toMatchObject({ state: "launched", parent_thread_id: "thr_parent" });
  });

  it("leaves a Spawn Gate start unknown: no marker, nothing is guessed from threads", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due();
    claimDue(f.db, new Date().toISOString());
    recoverScheduledStarts(f.db);
    f.world.children.push({ id: "thr_maybe", parentThreadId: "thr_setter", createdAt: Date.now() });
    await f.sweep();
    expect(f.row().state).toBe("unknown");
  });

  it("resolves an unknown start by hand and blocks a new schedule until then", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due();
    claimDue(f.db, new Date().toISOString());
    recoverScheduledStarts(f.db);
    await expect(f.schedule()).rejects.toThrow(/resolve the previous start first/);
    await expect(f.call("resolveScheduledStart", { taskId: f.task.id, notLaunched: true, actor: "thr_stranger" })).rejects.toThrow(/Only the setter/);
    await f.call("resolveScheduledStart", { taskId: f.task.id, launchedThreadId: "thr_found", actor: "thr_setter" });
    expect(f.row()).toMatchObject({ state: "launched", thread_id: "thr_found", attached: 1 });
    expect(f.events()).toContain("resolved");
    // Not-launched frees the card for a new schedule.
    const g = fixture();
    await g.schedule("+10m"); g.due(); claimDue(g.db, new Date().toISOString()); recoverScheduledStarts(g.db);
    await g.call("resolveScheduledStart", { taskId: g.task.id, notLaunched: true, actor: "owner" });
    expect((await g.schedule()).scheduledStart.state).toBe("scheduled");
  });
});

describe("cancel and change against the claim", () => {
  it("refuses cancel and change once the claim committed, and the launch goes ahead", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due();
    const claimed = claimDue(f.db, new Date().toISOString());
    expect(claimed?.state).toBe("launching");
    await expect(f.call("cancelScheduledStart", { taskId: f.task.id, actor: "thr_setter" })).rejects.toThrow(/already in progress; cancel is no longer possible/);
    await expect(f.call("changeScheduledStart", { taskId: f.task.id, at: "+1h", actor: "thr_setter" })).rejects.toThrow(/already in progress; change is no longer possible/);
    expect(f.row().state).toBe("launching");
  });

  it("finds nothing to claim when the cancel or the change committed first, and calls no RPC", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due();
    await f.call("cancelScheduledStart", { taskId: f.task.id, actor: "thr_setter" });
    expect(claimDue(f.db, new Date().toISOString())).toBeUndefined();
    const g = fixture();
    await g.schedule("+10m");
    g.due();
    await g.call("changeScheduledStart", { taskId: g.task.id, at: "+5h", actor: "thr_setter" });
    expect(claimDue(g.db, new Date().toISOString())).toBeUndefined();
    await g.sweep();
    expect(g.world.starts.filter((call) => !call.dryRun)).toHaveLength(0);
  });
});

describe("recording and permissions", () => {
  it("rolls back the state, the log row, the comment and the notice together", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.due();
    const claimed = claimDue(f.db, new Date().toISOString())!;
    const logs = () => f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM scheduled_start_log").get()!.n;
    const before = { logs: logs(), comments: f.comments("%").length };
    f.db.exec("CREATE TRIGGER boom BEFORE INSERT ON scheduled_start_notices BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => recordOutcome(f.db, claimed.id, "launching", { state: "refused", error: "nope" })).toThrow(/injected/);
    expect(f.row().state).toBe("launching");
    expect({ logs: logs(), comments: f.comments("%").length }).toEqual(before);
    expect(f.notices()).toHaveLength(0);
  });

  it("lets the setter, the manager and the owner change and cancel, and refuses a stranger", async () => {
    const f = fixture();
    await f.schedule("+10m");
    await expect(f.call("changeScheduledStart", { taskId: f.task.id, at: "+1h", actor: "thr_stranger" })).rejects.toThrow(/Only the setter/);
    await expect(f.call("cancelScheduledStart", { taskId: f.task.id, actor: "thr_stranger" })).rejects.toThrow(/Only the setter/);
    await f.call("changeScheduledStart", { taskId: f.task.id, at: "+1h", actor: MANAGER });
    await f.call("changeScheduledStart", { taskId: f.task.id, at: "+2h", actor: "owner" });
    await f.call("cancelScheduledStart", { taskId: f.task.id, actor: "thr_setter" });
    expect(f.row().state).toBe("canceled");
  });

  it("exposes the start in the card meta and the log RPC", async () => {
    const f = fixture();
    await f.schedule("+10m");
    const meta = (await f.call("listTaskCardMeta", { taskIds: [f.task.id] })).metadata[0];
    expect(meta.scheduledStart).toMatchObject({ mode: "spawn_gate", state: "scheduled", setter: "thr_setter" });
    const { events } = await f.call("listScheduledStartLog", { taskId: f.task.id });
    expect(events.map((event: { event: string }) => event.event)).toEqual(["scheduled"]);
    const { scheduledStart } = await f.call("getScheduledStart", { taskId: f.task.id });
    expect(scheduledStart).toMatchObject({ state: "scheduled" });
  });

  it("answers a check with the builder's refusal inline, and reports the policy-read error in the options", async () => {
    const f = fixture();
    f.world.start = async () => { throw rpcError("handler_error", 'builder.py exited 1: {"reasonCode":"no_scope"}'); };
    expect(await f.call("checkScheduledStart", { taskId: f.task.id, launch: f.gate, actor: "owner" })).toMatchObject({ ok: false, reasonCode: "no_scope" });
    f.world.start = undefined;
    expect(await f.call("checkScheduledStart", { taskId: f.task.id, launch: f.gate, actor: "owner" })).toMatchObject({ ok: true, mode: "spawn_gate" });
    expect(await f.call("scheduleOptions", { projectId: f.tracker.id })).toMatchObject({ mode: "spawn_gate", defaultArgs: "--card {key} --role impl" });
    f.world.configFail = true;
    expect(await f.call("scheduleOptions", { projectId: f.tracker.id })).toMatchObject({ mode: null, error: expect.stringContaining("could not read") });
  });
});
