import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { samplePauses } from "../pause/sample";
import { setPauseMode } from "../pause/store";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { resolveRoles } from "../shared/status-roles";
import { evaluateThreadHealth } from "../shared/thread-health";
import { getWorkflowPolicy, workflowPolicySchema } from "../shared/workflow-policy";
import { isDoneIn } from "../db/status-sql";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.harness.dispose(); });
const listed = (...removed: string[]) => DEFAULT_TASK_STATUSES.filter((status) => !removed.includes(status.id)).map((status) => ({ ...status }));

function setup() {
  const send = vi.fn(async (_input: unknown) => ({ ok: true, channels: ["desktop"] }));
  const host = createFakePluginHost({ pluginId: "work-board", sdk: { plugins: { callRpc: send } } });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const db = host.bb.storage.database();
  return { ...host, store, project, db, send, current: () => store.tasks.getProject(project.id)! };
}

describe("effects of a status deletion", () => {
  it("sets and clears the closure by the target, satisfies a dependent, and sends no push notification", async () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statusNotifications: "all", statuses: [...listed(), { id: "shipped", name: "Shipped" }], workflowPolicy: workflowPolicySchema.parse({ closedStatuses: ["done", "canceled", "shipped"] }) });
    const blocker = f.store.tasks.createTask({ projectId: f.project.id, title: "Blocker", status: "todo" });
    const dependent = f.store.tasks.createTask({ projectId: f.project.id, title: "Dependent" });
    const closedCard = f.store.tasks.createTask({ projectId: f.project.id, title: "Shipped" });
    f.store.tasks.updateTask(closedCard.id, { status: "shipped" });
    f.db.prepare("INSERT INTO task_dependencies(task_id, blocking_task_id, created_at) VALUES (?,?,?)").run(dependent.id, blocker.id, new Date().toISOString());
    const held = () => f.db.prepare(`SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id=d.blocking_task_id WHERE d.task_id=? AND NOT ${isDoneIn("b")}`).get(dependent.id);
    expect(held()).toBeTruthy();
    expect(f.store.tasks.closures.currentId(closedCard.id)).not.toBeNull();
    f.store.tasks.updateProject(f.project.id, { statuses: listed("todo"), statusMoves: { todo: "done", shipped: "backlog" } });
    expect(getWorkflowPolicy(f.current()).closedStatuses).toEqual(["done", "canceled"]);
    expect(f.store.tasks.getTask(blocker.id)?.status).toBe("done");
    expect(held()).toBeUndefined();
    // moved from a closed status to an open one: the closure is cleared
    expect(f.store.tasks.getTask(closedCard.id)?.status).toBe("backlog");
    expect(f.store.tasks.closures.currentId(closedCard.id)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.send).not.toHaveBeenCalled();
    // a normal move still notifies
    f.store.tasks.updateTask(dependent.id, { status: "in_progress" });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
  });

  it("refuses a move to an unknown status through the RPC too", async () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: listed("todo") });
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "A" });
    await expect(f.harness.callRpc("updateTask", { taskId: card.id, status: "todo", authorName: "You" })).rejects.toThrow(/EXA-1: status `todo` is not in this project/);
    await expect(f.harness.callRpc("createTask", { projectId: f.project.id, title: "B", status: "todo" })).rejects.toThrow(/not in this project/);
  });
});

describe("pilot scope and stale-status scope", () => {
  const pilot = ["in_progress", "in_review", "in_testing", "bugfix"];
  const all = ["backlog", "todo", "in_progress", "in_review", "in_testing", "bugfix", "done", "canceled"];

  it("keeps the pilot default at exactly four ids, even with a custom inProgressStatus or a null reviewStatus", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: [...listed(), { id: "in_testing", name: "In testing" }, { id: "bugfix", name: "Bugfix" }] });
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), inProgressStatus: "todo", reviewStatus: null }) });
    const cards = new Map(all.map((status) => [status, f.store.tasks.createTask({ projectId: f.project.id, title: status, status })]));
    const inScope = (taskId: string) => f.store.tasks.staleStatusObservations(f.project.id, [taskId])[0]!.inScope;
    for (const [status, card] of cards) expect({ status, scope: inScope(card.id) }).toEqual({ status, scope: pilot.includes(status) });
    setPauseMode(f.db, f.project.id, "ab");
    samplePauses(f.bb, Date.now());
    const sampled = f.db.prepare<[], { status: string; in_scope: number }>("SELECT status, in_scope FROM pause_samples").all();
    // pause samples cover pilot statuses and the planning status only; each sampled pilot card is in scope
    expect(sampled.map((row) => row.status).sort()).toEqual([...pilot].sort());
    expect(sampled.every((row) => row.in_scope === 1)).toBe(true);
    expect(resolveRoles(f.current()).pilot).toEqual(pilot);
  });

  it("flags a card without a thread in a project without todo, and leaves a not-started one alone", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: listed("todo") });
    const working = f.store.tasks.createTask({ projectId: f.project.id, title: "Working", status: "in_progress" });
    const waiting = f.store.tasks.createTask({ projectId: f.project.id, title: "Waiting", status: "backlog" });
    const flags = f.store.tasks.staleStatusFlags([working.id, waiting.id]);
    expect(flags.get(working.id)).toEqual(["no_active_thread"]);
    expect(flags.has(waiting.id)).toBe(false);
  });

  it("has no waiting-for-review status without in_review, and an explicit empty earlyStatuses stays empty", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: listed("in_review"), workflowPolicy: workflowPolicySchema.parse({ reviewStatus: null, earlyStatuses: [] }) });
    const roles = resolveRoles(f.current());
    expect(roles.review).toBeNull();
    const link = { threadId: "thr_example", liveStatus: "idle", updatedAt: "2026-10-28T08:00:00.000Z", title: "t" } as never;
    expect(evaluateThreadHealth("in_progress", [link], "2026-10-28T08:00:00.000Z", 45, [roles.review], false, roles.closed).idle).not.toBeNull();
    f.store.tasks.updateProject(f.project.id, { name: "Renamed" });
    f.store.tasks.updateProject(f.project.id, { statuses: listed("in_review", "todo") });
    expect(roles.early).toEqual([]);
    expect(getWorkflowPolicy(f.current()).earlyStatuses).toEqual([]);
  });

  it("treats doneStatus null as satisfying no dependency", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ doneStatus: null }) });
    const blocker = f.store.tasks.createTask({ projectId: f.project.id, title: "B", status: "done" });
    expect(f.db.prepare(`SELECT 1 FROM tasks b WHERE b.id=? AND NOT ${isDoneIn("b")}`).get(blocker.id)).toBeTruthy();
  });
});
