import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { drainQueueNotices, recoverQueueNotices } from "./notices";
import { dropThreadQueues, queueAdd, queueArm, queueMove, queueRemove, setQueueMode } from "./store";
import { queueReport, sampleQueueTrial } from "./trial";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const EXEC = "thr_exec", OTHER = "thr_other", MANAGER = "thr_manager";

function setup(options: { sendFails?: () => boolean; archived?: string[] } = {}) {
  const sent: { threadId: string; text: string }[] = [];
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", ...(options.archived?.includes(threadId) ? { archivedAt: 1_767_225_600_000 } : {}) }),
        send: async ({ threadId, input }: { threadId: string; input: readonly { type: string; text?: string }[] }) => {
          if (options.sendFails?.()) throw new Error("transport down");
          sent.push({ threadId, text: input[0]!.text ?? "" });
        },
        queuedMessages: { list: async () => [] },
      },
    },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const db = host.bb.storage.database();
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  setQueueMode(db, project.id, "on");
  const card = (status = "todo", projectId = project.id) => store.tasks.createTask({ projectId, title: `Card ${Math.random().toString(36).slice(2, 6)}`, status });
  const positions = (threadId = EXEC, projectId = project.id) => db.prepare<[string, string], { key: string; position: number }>("SELECT p.prefix || '-' || t.number AS key, q.position FROM task_queue q JOIN tasks t ON t.id=q.task_id JOIN projects p ON p.id=t.project_id WHERE q.project_id=? AND q.thread_id=? ORDER BY q.position").all(projectId, threadId);
  const manager = (id: string | null, projectId = project.id) => db.prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?,?,?,NULL) ON CONFLICT(tracker_id) DO UPDATE SET manager=excluded.manager").run(projectId, id, new Date().toISOString());
  const call = (method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, input as never) as Promise<any>;
  return { host, store, db, project, card, positions, manager, call, sent };
}
const add = (f: ReturnType<typeof setup>, task: { id: string }, extra: { position?: number; actor?: string; threadId?: string } = {}) =>
  queueAdd(f.db, { taskId: task.id, threadId: extra.threadId ?? EXEC, actor: extra.actor ?? EXEC, ...(extra.position ? { position: extra.position } : {}) });

describe("queue store", () => {
  it("adds, moves and removes with dense positions and one log row per affected card", () => {
    const f = setup();
    const [a, b, c] = [f.card(), f.card(), f.card()];
    add(f, a); add(f, b); add(f, c);
    expect(f.positions()).toEqual([{ key: "EXA-1", position: 1 }, { key: "EXA-2", position: 2 }, { key: "EXA-3", position: 3 }]);
    const before = f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM task_queue_log").get()!.n;
    queueMove(f.db, { taskId: c.id, position: 1, actor: EXEC });
    expect(f.positions().map((row) => row.key)).toEqual(["EXA-3", "EXA-1", "EXA-2"]);
    const rows = f.db.prepare<[number], { task_id: string; action: string; actor: string; old_position: number; new_position: number; change_id: string }>("SELECT * FROM task_queue_log WHERE id>? ORDER BY id").all(before);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.change_id)).size).toBe(1);
    expect(rows[0]).toMatchObject({ task_id: c.id, action: "move", actor: EXEC, old_position: 3, new_position: 1 });
    queueRemove(f.db, { taskId: c.id, actor: EXEC });
    expect(f.positions().map((row) => row.position)).toEqual([1, 2]);
    // A stale position is clamped; the log shows the result.
    queueMove(f.db, { taskId: a.id, position: 99, actor: EXEC });
    expect(f.positions().map((row) => row.key)).toEqual(["EXA-2", "EXA-1"]);
    expect(() => add(f, a)).toThrow(/already queued/);
  });

  it("keeps a thread's queues in two projects independent and bounds the manager to its own project", () => {
    const f = setup();
    const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
    setQueueMode(f.db, other.id, "on");
    const a = f.card(), b = f.card("todo", other.id), a2 = f.card();
    add(f, a); add(f, a2); add(f, b);
    expect(f.positions().map((row) => row.key)).toEqual(["EXA-1", "EXA-2"]);
    expect(f.positions(EXEC, other.id)).toEqual([{ key: "OTH-1", position: 1 }]);
    f.manager(MANAGER, f.project.id);
    expect(() => queueMove(f.db, { taskId: a2.id, position: 1, actor: MANAGER })).not.toThrow();
    expect(() => queueMove(f.db, { taskId: b.id, position: 1, actor: MANAGER })).toThrow(/Only the executor/);
    expect(() => queueMove(f.db, { taskId: a.id, position: 1, actor: OTHER })).toThrow(/Only the executor/);
    expect(() => queueMove(f.db, { taskId: a.id, position: 1, actor: "owner" })).not.toThrow();
  });

  it("refuses closed, archived and work-status cards where the invariants forbid them", () => {
    const f = setup();
    const done = f.card("done"), working = f.card("in_progress"), todo = f.card(), todo2 = f.card();
    expect(() => add(f, done)).toThrow(/closed/);
    add(f, working);
    expect(() => add(f, todo, { position: 1 })).toThrow(/behind another card|in_progress/);
    add(f, todo);
    expect(() => queueMove(f.db, { taskId: todo.id, position: 1, actor: EXEC })).toThrow(/behind another card/);
    const second = f.card("in_progress");
    expect(() => add(f, second)).toThrow(/only the first card/);
    // A pre-work card may go first when the current card is also pre-work.
    f.store.tasks.updateTask(working.id, { status: "todo" });
    expect(() => add(f, todo2, { position: 1 })).not.toThrow();
    f.store.tasks.updateTask(done.id, { status: "done" });
    f.store.tasks.setTaskArchived(done.id, true);
    expect(() => add(f, done)).toThrow(/archived/);
  });

  it("handles status changes: a user path into work is refused, an automatic one removes the card with its cause", () => {
    const f = setup();
    const a = f.card(), b = f.card(), c = f.card();
    add(f, a); add(f, b); add(f, c);
    expect(() => f.store.tasks.updateTask(b.id, { status: "in_progress", statusLog: { by: "Owner" } })).toThrow(/queued #2/);
    f.store.tasks.updateTask(b.id, { status: "in_progress", statusLog: { by: "Work Board", cause: "PR opened" } });
    expect(f.positions().map((row) => row.key)).toEqual(["EXA-1", "EXA-3"]);
    expect(f.db.prepare("SELECT action, cause, actor FROM task_queue_log WHERE task_id=? ORDER BY id DESC LIMIT 1").get(b.id)).toEqual({ action: "remove", cause: "PR opened", actor: "Work Board" });
    // The current card may start.
    f.store.tasks.updateTask(a.id, { status: "in_progress", statusLog: { by: "Owner" } });
    expect(f.positions()[0]).toEqual({ key: "EXA-1", position: 1 });
  });

  it("removes cards on archive, delete, project move and executor thread removal", () => {
    const f = setup();
    const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
    const a = f.card(), b = f.card(), c = f.card(), d = f.card();
    add(f, a); add(f, b); add(f, c); add(f, d);
    f.store.tasks.deleteTask(b.id);
    expect(f.positions().map((row) => row.key)).toEqual(["EXA-1", "EXA-3", "EXA-4"]);
    f.store.tasks.moveTaskToProject(c.id, other.id);
    expect(f.positions().map((row) => row.key)).toEqual(["EXA-1", "EXA-4"]);
    expect(dropThreadQueues(f.db, EXEC, "thread archived")).toBe(2);
    expect(f.positions()).toEqual([]);
    expect(f.db.prepare<[], { cause: string }>("SELECT cause FROM task_queue_log WHERE action='remove' ORDER BY id").all().map((row) => row.cause)).toEqual(["deleted", "moved", "thread archived", "thread archived"]);
  });

  it("keeps waiting cards out of the stale flags and still flags a waiting card that is in work", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { planning: "optional" });
    const a = f.card("in_progress"), b = f.card();
    add(f, a); add(f, b);
    const flags = () => f.store.tasks.staleStatusFlags([a.id, b.id]);
    expect(flags().get(b.id)).toBeUndefined();
    expect(flags().get(a.id)).toContain("no_active_thread");
    // Legacy data that breaks the invariant is flagged as usual.
    f.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(b.id);
    expect(flags().get(b.id)).toContain("no_active_thread");
  });

  it("applies the trial arms and the owner modes", () => {
    const f = setup();
    const [auto, control] = Array.from({ length: 40 }, (_, i) => `thr_t${i}`).reduce<[string[], string[]]>((acc, id) => { acc[queueArm(f.project.id, id) === "auto" ? 0 : 1].push(id); return acc; }, [[], []]);
    setQueueMode(f.db, f.project.id, "trial");
    expect(() => add(f, f.card(), { threadId: control![0]!, actor: "owner" })).toThrow(/control arm of the queue trial/);
    expect(() => add(f, f.card(), { threadId: auto![0]!, actor: "owner" })).not.toThrow();
    setQueueMode(f.db, f.project.id, "on");
    expect(() => add(f, f.card(), { threadId: control![0]!, actor: "owner" })).not.toThrow();
    setQueueMode(f.db, f.project.id, "off");
    expect(() => add(f, f.card(), { actor: "owner" })).toThrow(/queue is off in this project/);
    expect(f.db.prepare<[], { cause: string }>("SELECT cause FROM task_queue_log WHERE action='mode' ORDER BY id").all().map((row) => row.cause)).toEqual(["trial->on", "on->trial", "trial->on", "on->off"]);
  });
});

describe("next-card notice", () => {
  it("promotes in the closing transaction and delivers one message that starts nothing", async () => {
    const f = setup();
    const [a, b, c] = [f.card(), f.card(), f.card()];
    add(f, a); add(f, b); add(f, c);
    f.store.tasks.updateTask(a.id, { status: "done", statusLog: { by: "Owner" } });
    expect(f.positions().map((row) => [row.key, row.position])).toEqual([["EXA-2", 1], ["EXA-3", 2]]);
    const pending = f.db.prepare<[], { state: string; from_task: string; to_task: string }>("SELECT state, from_task, to_task FROM task_queue_notices").all();
    expect(pending).toEqual([{ state: "pending", from_task: a.id, to_task: b.id }]);
    await drainQueueNotices(f.host.bb);
    await drainQueueNotices(f.host.bb);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.threadId).toBe(EXEC);
    expect(f.sent[0]!.text).toContain("EXA-1 left work (Done). Next in your queue: EXA-2 ·");
    expect(f.sent[0]!.text).toContain("(/plugins/work-board/work-board/task/EXA-2)");
    expect(f.sent[0]!.text).toContain("Nothing was started or moved.");
    expect(f.store.tasks.getTask(b.id)!.status).toBe("todo");
    // A duplicate status event finds the card gone from the queue and writes no second row.
    f.store.tasks.updateTask(a.id, { status: "canceled", statusLog: { by: "Owner" } });
    expect(f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM task_queue_notices").get()!.n).toBe(1);
  });

  it("promotes on the review status, on every path, and sends nothing for an empty queue", async () => {
    const f = setup();
    const [a, b] = [f.card("in_progress"), f.card()];
    add(f, a); add(f, b);
    f.store.tasks.updateTask(a.id, { status: "in_review", statusLog: { by: "Work Board", cause: "PR ready" } });
    expect(f.positions()).toEqual([{ key: "EXA-2", position: 1 }]);
    expect(f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM task_queue_notices").get()!.n).toBe(1);
    f.store.tasks.updatePosition(b.id, { status: "done", statusLog: { by: "Owner" } });
    expect(f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM task_queue_notices").get()!.n).toBe(1);
    await drainQueueNotices(f.host.bb);
    expect(f.sent).toHaveLength(1);
  });

  it("still delivers after a drain that found nothing", async () => {
    const f = setup();
    const [a, b] = [f.card(), f.card()];
    await drainQueueNotices(f.host.bb);
    add(f, a); add(f, b);
    f.store.tasks.updateTask(a.id, { status: "done", statusLog: { by: "Owner" } });
    await drainQueueNotices(f.host.bb);
    expect(f.sent).toHaveLength(1);
  });

  it("retries a definite failure up to the cap, and never resends an interrupted one", async () => {
    let failing = true;
    const f = setup({ sendFails: () => failing });
    const [a, b] = [f.card(), f.card()];
    add(f, a); add(f, b);
    f.store.tasks.updateTask(a.id, { status: "done", statusLog: { by: "Owner" } });
    await drainQueueNotices(f.host.bb);
    expect(f.db.prepare("SELECT state, attempts FROM task_queue_notices").get()).toEqual({ state: "failed", attempts: 1 });
    failing = false;
    await drainQueueNotices(f.host.bb);
    expect(f.sent).toHaveLength(1);
    expect(f.db.prepare("SELECT state, attempts FROM task_queue_notices").get()).toEqual({ state: "sent", attempts: 2 });
    // A row left `sending` by a crash becomes unknown and is not sent again.
    f.db.prepare("UPDATE task_queue_notices SET state='sending'").run();
    expect(recoverQueueNotices(f.db)).toBe(1);
    await drainQueueNotices(f.host.bb);
    expect(f.sent).toHaveLength(1);
    expect(f.db.prepare("SELECT state FROM task_queue_notices").get()).toEqual({ state: "unknown" });
  });

  it("two transitions on one queue give two promotions in order", () => {
    const f = setup();
    const [a, b, c] = [f.card(), f.card(), f.card()];
    add(f, a); add(f, b); add(f, c);
    f.store.tasks.updateTask(a.id, { status: "done", statusLog: { by: "Owner" } });
    f.store.tasks.updateTask(b.id, { status: "done", statusLog: { by: "Owner" } });
    expect(f.db.prepare<[], { from_task: string; to_task: string }>("SELECT from_task, to_task FROM task_queue_notices ORDER BY created_at, rowid").all()).toEqual([{ from_task: a.id, to_task: b.id }, { from_task: b.id, to_task: c.id }]);
  });
});

describe("queue calls and CLI", () => {
  it("refuses an archived or unknown executor thread and publishes through the RPC", async () => {
    const f = setup({ archived: ["thr_gone"] });
    const task = f.card();
    await expect(f.call("queueAdd", { taskId: task.id, threadId: "thr_gone", actor: "owner" })).rejects.toThrow(/archived or deleted/);
    const added = await f.call("queueAdd", { taskId: task.id, threadId: EXEC, actor: EXEC });
    expect(added.position).toBe(1);
    const meta = await f.call("listTaskCardMeta", { taskIds: [task.id] });
    expect(meta.metadata[0].queue).toEqual({ threadId: EXEC, position: 1 });
  });

  it("lists, adds, moves and removes through the CLI and shows the queue in show --json", async () => {
    const f = setup();
    const [a, b] = [f.card(), f.card()];
    const run = (args: string[], env: Record<string, string> = {}) => { Object.assign(process.env, { BB_THREAD_ID: EXEC, ...env }); return f.host.harness.runCli(args); };
    expect((await run(["queue", "add", a.key, "--thread", EXEC])).exitCode).toBe(0);
    expect((await run(["queue", "add", b.key, "--thread", EXEC])).exitCode).toBe(0);
    expect((await run(["queue", "add", b.key, "--thread", EXEC, "--project", "OTH"])).exitCode).not.toBe(0);
    const listed = JSON.parse((await run(["queue", "list", "--json"])).stdout);
    expect(listed.queues[0].entries.map((entry: { key: string; position: number }) => [entry.key, entry.position])).toEqual([["EXA-1", 1], ["EXA-2", 2]]);
    expect((await run(["queue", "list"])).stdout).toContain("Current  EXA-1");
    expect((await run(["queue", "move", b.key, "--position", "1"])).exitCode).toBe(0);
    expect(JSON.parse((await run(["show", a.key, "--json"])).stdout).queue).toEqual({ threadId: EXEC, position: 2 });
    const refused = await run(["queue", "move", a.key, "--position", "1"], { BB_THREAD_ID: OTHER });
    expect(refused.exitCode).not.toBe(0);
    expect((await run(["queue", "remove", a.key])).stdout).toContain("left the queue");
    expect(JSON.parse((await run(["show", a.key, "--json"])).stdout).queue).toBeUndefined();
    delete process.env.BB_THREAD_ID;
  });

  it("never lets an agent change the owner-only queueMode setting", async () => {
    const f = setup();
    expect((await f.call("config.get", { projectId: f.project.id, key: "queueMode" })).values.queueMode).toBe("on");
    await expect(f.call("config.set", { projectId: f.project.id, key: "queueMode", value: "off" })).rejects.toThrow(/owner/);
  });
});

describe("queue trial", () => {
  const T0 = Date.parse("2026-03-10T10:00:00.000Z");
  function trial() {
    const f = setup();
    setQueueMode(f.db, f.project.id, "trial");
    // The test clock is fixed in the past: the rollout and the project start a day before it.
    f.db.prepare("UPDATE queue_rollout SET at=?").run(new Date(T0 - 86_400_000).toISOString());
    f.db.prepare("UPDATE projects SET created_at=? WHERE id=?").run(new Date(T0 - 86_400_000).toISOString(), f.project.id);
    const [auto] = Array.from({ length: 40 }, (_, i) => `thr_t${i}`).filter((id) => queueArm(f.project.id, id) === "auto");
    const [control] = Array.from({ length: 40 }, (_, i) => `thr_t${i}`).filter((id) => queueArm(f.project.id, id) === "control");
    const link = (taskId: string, threadId: string) => f.db.prepare("INSERT INTO task_threads(id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(`link_${taskId}_${threadId}`, taskId, threadId, "preset", "t", "idle", new Date(T0 - 86_400_000).toISOString(), new Date(T0).toISOString());
    const cards = (threadId: string) => { const list = [f.card("in_progress"), f.card("todo")]; list.forEach((task) => link(task.id, threadId)); return list; };
    return { f, auto: auto!, control: control!, link, cards };
  }
  const occurrence = (f: ReturnType<typeof setup>, taskId: string, key: string, at: number) => f.db.prepare("INSERT INTO manager_attention(id, tracker_id, task_id, task_key, kind, signal, first_seen_at, eligible_at, created_rev, rev) VALUES (?,?,?,?,?,?,?,?,1,1)").run(`occ_${taskId}_${at}`, f.project.id, taskId, key, "stale-status", "no_active_thread", new Date(at).toISOString(), new Date(at).toISOString());

  it("writes coverage once per eligible unit, split at midnight, and samples each card", () => {
    const { f, auto, cards } = trial();
    cards(auto);
    const lonely = f.card(); f.db.prepare("INSERT INTO task_threads(id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at) VALUES ('l1',?,?,'p','t','idle','2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z')").run(lonely.id, "thr_lonely");
    const night = Date.parse("2026-03-10T23:50:00.000Z");
    sampleQueueTrial(f.db, night);
    sampleQueueTrial(f.db, night + 20 * 60_000);
    const rows = f.db.prepare<[], { at: string; interval_ms: number; arm: string; mode: string }>("SELECT at, interval_ms, arm, mode FROM queue_trial_coverage ORDER BY at").all();
    expect(rows.map((row) => [row.at, row.interval_ms])).toEqual([["2026-03-10T23:50:00.000Z", 0], ["2026-03-11T00:00:00.000Z", 600_000], ["2026-03-11T00:10:00.000Z", 600_000]]);
    expect(rows[0]).toMatchObject({ arm: "auto", mode: "trial" });
    expect(f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM queue_trial_samples").get()!.n).toBe(4);
    expect(f.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM queue_trial_coverage WHERE thread_id='thr_lonely'").get()!.n).toBe(0);
  });

  it("credits no coverage for the time a unit was not eligible", () => {
    const { f, auto, cards } = trial();
    const [, second] = cards(auto);
    sampleQueueTrial(f.db, T0);
    f.db.prepare("DELETE FROM task_threads WHERE task_id=?").run(second!.id);
    sampleQueueTrial(f.db, T0 + 10 * 60_000);
    f.db.prepare("INSERT INTO task_threads(id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("relink", second!.id, auto, "preset", "t", "idle", new Date(T0).toISOString(), new Date(T0).toISOString());
    sampleQueueTrial(f.db, T0 + 20 * 60_000);
    sampleQueueTrial(f.db, T0 + 30 * 60_000);
    const rows = f.db.prepare<[], { at: string; interval_ms: number }>("SELECT at, interval_ms FROM queue_trial_coverage ORDER BY at").all();
    expect(rows.map((row) => [Date.parse(row.at) - T0, row.interval_ms])).toEqual([[0, 0], [20 * 60_000, 0], [30 * 60_000, 600_000]]);
  });

  it("counts only the part of a coverage interval inside the report window", () => {
    const { f, auto, cards } = trial();
    cards(auto);
    sampleQueueTrial(f.db, T0);
    sampleQueueTrial(f.db, T0 + 20 * 60_000);
    const report = queueReport(f.db, f.project.id, { since: new Date(T0 + 10 * 60_000).toISOString(), nowMs: T0 + 60 * 60_000 }) as any;
    expect(report.arms.auto.coveredMs).toBe(10 * 60_000);
    // The end clips too: a window ending between two scans keeps the part before its end.
    const ending = queueReport(f.db, f.project.id, { since: new Date(T0 - 7 * 86_400_000 + 15 * 60_000).toISOString(), nowMs: T0 + 60 * 60_000 }) as any;
    expect(ending.arms.auto.coveredMs).toBe(15 * 60_000);
  });

  it("attributes occurrences to units deterministically, lists shared cards and unmatched ones, and reports per arm", () => {
    const { f, auto, control, link, cards } = trial();
    const [a1, a2] = cards(auto), [c1] = cards(control);
    link(a1!.id, control);
    for (let i = 0; i <= 6; i++) sampleQueueTrial(f.db, T0 + i * 10 * 60_000);
    occurrence(f, a2!.id, a2!.key, T0 + 35 * 60_000);
    occurrence(f, a1!.id, a1!.key, T0 + 35 * 60_000);
    occurrence(f, c1!.id, c1!.key, T0 + 35 * 60_000 + 3 * 3_600_000);
    // A sample taken while the card sat in another project never attributes its occurrence here.
    f.db.prepare("INSERT INTO queue_trial_samples(at, project_id, thread_id, task_id, status, linked, queue_position) VALUES (?,?,?,?,?,?,?)")
      .run(new Date(T0 + 3 * 3_600_000 + 30 * 60_000).toISOString(), "proj_other", auto, c1!.id, "todo", 1, null);
    const report = queueReport(f.db, f.project.id, { nowMs: T0 + 4 * 3_600_000 }) as any;
    expect(report.arms.auto.units).toBe(1);
    expect(report.arms.control.units).toBe(1);
    expect(report.primary.auto.occurrences).toBeCloseTo(1.5);
    expect(report.primary.control.occurrences).toBeCloseTo(0.5);
    expect(report.primary.multipleLinked.map((row: { key: string }) => row.key)).toEqual([a1!.key]);
    expect(report.primary.withoutMultipleLinked.auto.occurrences).toBe(1);
    expect(report.primary.unmatched.map((row: { key: string; reason: string }) => [row.key, row.reason])).toEqual([[c1!.key, "no sample within 30 minutes"]]);
    expect(report.primary.unmatchedByArm.control).toBe(1);
    expect(report.sensitivityQueueInclusive.auto.occurrences).toBeCloseTo(1.5);
    expect(report.baseline.approximate).toBe(true);
    expect(report.limitations.length).toBeGreaterThan(3);
    expect(report.primary.auto.perUnitDay).toBeCloseTo(report.primary.auto.occurrences / report.arms.auto.unitDays);
  });

  it("counts a queued, unlinked card only in the sensitivity analysis and excludes mode-change days", () => {
    const { f, auto, cards } = trial();
    cards(auto);
    const queuedOnly = f.card("todo");
    queueAdd(f.db, { taskId: queuedOnly.id, threadId: auto, actor: "owner" });
    sampleQueueTrial(f.db, T0);
    sampleQueueTrial(f.db, T0 + 600_000);
    occurrence(f, queuedOnly.id, queuedOnly.key, T0 + 700_000);
    let report = queueReport(f.db, f.project.id, { nowMs: T0 + 3_600_000 }) as any;
    expect(report.primary.auto.occurrences).toBe(0);
    expect(report.primary.unmatched).toHaveLength(1);
    expect(report.sensitivityQueueInclusive.auto.occurrences).toBe(1);
    setQueueMode(f.db, f.project.id, "on");
    f.db.prepare("UPDATE task_queue_log SET at=? WHERE action='mode' AND cause LIKE '%->on'").run(new Date(T0 + 1_200_000).toISOString());
    report = queueReport(f.db, f.project.id, { nowMs: T0 + 3_600_000 }) as any;
    expect(report.excludedDays).toEqual(["2026-03-10"]);
    expect(report.arms.auto.unitDays).toBe(0);
  });

  it("anchors the window and the baseline to the rollout, not to the first coverage", () => {
    const { f, auto, cards } = trial();
    const [a] = cards(auto);
    const rollout = T0 - 3 * 86_400_000;
    f.db.prepare("UPDATE queue_rollout SET at=?").run(new Date(rollout).toISOString());
    f.db.prepare("UPDATE projects SET created_at=? WHERE id=?").run(new Date(rollout - 86_400_000).toISOString(), f.project.id);
    // Eligible units appear only three days after release; a stale occurrence in between belongs to the window.
    occurrence(f, a!.id, a!.key, T0 - 2 * 86_400_000);
    sampleQueueTrial(f.db, T0);
    sampleQueueTrial(f.db, T0 + 600_000);
    const report = queueReport(f.db, f.project.id, { nowMs: T0 + 5 * 86_400_000 }) as any;
    expect(report.since).toBe(new Date(rollout).toISOString());
    expect(report.until).toBe(new Date(rollout + 7 * 86_400_000).toISOString());
    expect(report.baseline.until).toBe(report.since);
    expect(report.baseline.from).toBe(new Date(rollout - 7 * 86_400_000).toISOString());
    // The post-release occurrence stays out of the pre-release baseline.
    expect(report.baseline.occurrences).toEqual({ auto: 0, control: 0 });
    expect(report.primary.unmatched.map((row: { key: string }) => row.key)).toEqual([a!.key]);
    // A project created after the rollout starts at its creation; --since still overrides.
    f.db.prepare("UPDATE projects SET created_at=? WHERE id=?").run(new Date(T0 - 86_400_000).toISOString(), f.project.id);
    expect((queueReport(f.db, f.project.id, { nowMs: T0 + 5 * 86_400_000 }) as any).since).toBe(new Date(T0 - 86_400_000).toISOString());
    expect((queueReport(f.db, f.project.id, { since: new Date(T0).toISOString(), nowMs: T0 + 5 * 86_400_000 }) as any).since).toBe(new Date(T0).toISOString());
  });

  it("lists ordering workarounds with their rows", () => {
    const { f, auto, cards } = trial();
    const [a, b] = cards(auto);
    sampleQueueTrial(f.db, T0);
    sampleQueueTrial(f.db, T0 + 600_000);
    f.db.prepare("INSERT INTO task_dependencies(task_id, blocking_task_id, created_at) VALUES (?,?,?)").run(b!.id, a!.id, new Date(T0 + 300_000).toISOString());
    f.db.prepare("INSERT INTO pause_log(project_id, task_id, task_key, at, event, source, signal, detail) VALUES (?,?,?,?,'start','manual','manual','queued behind EXA-1')").run(f.project.id, b!.id, b!.key, new Date(T0 + 400_000).toISOString());
    f.db.prepare("INSERT INTO pause_log(project_id, task_id, task_key, at, event, source, signal, detail) VALUES (?,?,?,?,'start','manual','manual','waiting for review')").run(f.project.id, b!.id, b!.key, new Date(T0 + 500_000).toISOString());
    const report = queueReport(f.db, f.project.id, { nowMs: T0 + 3_600_000 }) as any;
    expect(report.workarounds.map((row: { kind: string }) => row.kind).sort()).toEqual(["blocked-by", "pause"]);
    expect(report.secondary.auto.count).toBe(2);
  });
});
