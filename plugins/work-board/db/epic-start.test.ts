import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerDelegation } from "../delegate";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { workflowPolicySchema } from "../shared/workflow-policy";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(planning: "off" | "required" = "off") {
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }), send: async () => ({}), spawn: async () => ({ id: "thr_spawned" }) } },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerDelegation(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue", linkedBbProjectId: "proj_example" });
  if (planning !== "off") store.tasks.updateProject(project.id, { planning });
  const task = (title: string, input: Record<string, unknown> = {}) => store.tasks.createTask({ projectId: project.id, title, ...input });
  const epic = (status = "backlog") => task("Epic", { type: "epic", status });
  const call = (method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, input as never) as Promise<any>;
  const status = (id: string) => store.tasks.getTask(id)!.status;
  const history = (id: string) => store.tasks.listComments(id).filter((comment) => comment.authorName === "Work Board" && comment.body.endsWith(" started)"));
  const signals = (channel: string, id: string) => host.harness.realtimeSignals.filter((signal) => signal.channel === channel && (signal.payload as { taskId: string }).taskId === id);
  const statuses = (policy: Record<string, unknown>, list: Array<{ id: string; name: string }> = DEFAULT_TASK_STATUSES) =>
    {
      store.tasks.updateProject(project.id, { statuses: list as never });
      // Written raw: these cases map a role to a status the project does not list, which the settings write refuses.
      host.bb.storage.database().prepare("UPDATE projects SET workflow_policy = ? WHERE id = ?").run(JSON.stringify(workflowPolicySchema.parse({ ...store.tasks.getProject(project.id)!.workflowPolicy, ...policy })), project.id);
    };
  return { ...host, host, store, project, task, epic, call, status, history, signals, statuses };
}

describe("an epic follows its first started task", () => {
  it.each([
    ["updateTask", (f: ReturnType<typeof setup>, id: string) => f.call("updateTask", { taskId: id, status: "in_progress", authorName: "You" })],
    ["boardMove", (f: ReturnType<typeof setup>, id: string) => f.call("boardMove", { taskId: id, status: "in_progress", authorName: "You" })],
  ])("moves a Backlog epic to In progress when a child moves there through %s, with one system comment", async (_name, move) => {
    const f = setup();
    const epic = f.epic();
    const child = f.task("Work", { epicId: epic.id });
    await move(f, child.id);
    await flush();
    expect(f.status(epic.id)).toBe("in_progress");
    expect(f.history(epic.id).map((comment) => ({ kind: comment.kind, body: comment.body }))).toEqual([
      { kind: "system", body: `Status changed to In Progress by Work Board (${child.key} started)` },
    ]);
    // A second child finds the epic moved: no second entry.
    const other = f.task("More", { epicId: epic.id });
    f.store.tasks.updateTask(other.id, { status: "in_progress" });
    expect(f.history(epic.id)).toHaveLength(1);
  });

  it("counts Planning as started and moves an epic from Todo", async () => {
    const f = setup();
    f.statuses({ planningStatus: "planning" }, [...DEFAULT_TASK_STATUSES.slice(0, 2), { id: "planning", name: "Planning" }, ...DEFAULT_TASK_STATUSES.slice(2)]);
    const epic = f.epic("todo");
    const child = f.task("Work", { epicId: epic.id });
    f.store.tasks.updateTask(child.id, { status: "planning" });
    expect(f.status(epic.id)).toBe("in_progress");
    expect(f.history(epic.id)[0]!.body).toBe(`Status changed to In Progress by Work Board (${child.key} started)`);
  });

  it("follows a sub-task to its parent's epic, a reparented started sub-task, a task joining with started sub-tasks, and a started creation", () => {
    const f = setup();
    const epic = f.epic();
    const parent = f.task("Parent", { epicId: epic.id });
    const sub = f.task("Sub", { parentTaskId: parent.id });
    f.store.tasks.updateTask(sub.id, { status: "in_progress" });
    expect(f.status(epic.id)).toBe("in_progress");

    const second = f.epic();
    const loose = f.task("Loose");
    const started = f.task("Started sub", { parentTaskId: loose.id, status: "in_progress" });
    expect(f.status(second.id)).toBe("backlog");
    f.store.tasks.updateTask(loose.id, { epicId: second.id });
    expect(f.status(second.id)).toBe("in_progress");

    const third = f.epic("todo");
    const other = f.task("Other");
    const sub2 = f.task("Sub2", { parentTaskId: other.id, status: "in_progress" });
    const thirdParent = f.task("Third parent", { epicId: third.id });
    f.store.tasks.updateTask(sub2.id, { parentTaskId: thirdParent.id });
    expect(f.status(third.id)).toBe("in_progress");
    expect(f.history(third.id).map((comment) => comment.body)).toEqual([`Status changed to In Progress by Work Board (${sub2.key} started)`]);
    const fourth = f.epic();
    f.task("Born started", { epicId: fourth.id, status: "in_progress" });
    expect(f.status(fourth.id)).toBe("in_progress");
    expect(started.status).toBe("in_progress");
  });

  it("does not re-advance an epic the owner moved back when a started sub-task moves between two tasks of that epic", () => {
    const f = setup();
    const epic = f.epic();
    const first = f.task("First", { epicId: epic.id });
    const second = f.task("Second", { epicId: epic.id });
    const sub = f.task("Sub", { parentTaskId: first.id });
    f.store.tasks.updateTask(sub.id, { status: "in_progress" });
    f.store.tasks.updateTask(epic.id, { status: "todo" });
    f.store.tasks.updateTask(sub.id, { parentTaskId: second.id });
    expect(f.status(epic.id)).toBe("todo");
    expect(f.history(epic.id)).toHaveLength(1);
  });

  it("leaves an epic that is in progress, in review, done, canceled or archived", () => {
    const f = setup();
    for (const state of ["in_progress", "in_review", "done", "canceled"]) {
      const epic = f.epic(state);
      f.store.tasks.updateTask(f.task("Work", { epicId: epic.id }).id, { status: "in_progress" });
      expect(f.status(epic.id)).toBe(state);
      expect(f.history(epic.id)).toEqual([]);
    }
    const epic = f.epic();
    const child = f.task("Work", { epicId: epic.id });
    f.host.bb.storage.database().prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), epic.id);
    f.store.tasks.updatePosition(child.id, { status: "in_progress" });
    expect(f.status(epic.id)).toBe("backlog");
  });

  it("skips an unusable target without failing the child write", () => {
    const f = setup();
    const missing = f.epic();
    const a = f.task("A", { epicId: missing.id });
    f.statuses({ inProgressStatus: "busy" });
    expect(f.store.tasks.updateTask(a.id, { status: "in_progress" }).status).toBe("in_progress");
    expect(f.status(missing.id)).toBe("backlog");
    // An In progress role that overlaps the done role.
    f.statuses({ inProgressStatus: "done" });
    const overlap = f.epic();
    expect(f.store.tasks.updateTask(f.task("B", { epicId: overlap.id }).id, { status: "in_review" }).status).toBe("in_review");
    expect(f.status(overlap.id)).toBe("backlog");
    // In progress listed before the epic's own status.
    f.statuses({ inProgressStatus: "in_progress" }, [DEFAULT_TASK_STATUSES[2]!, DEFAULT_TASK_STATUSES[0]!, DEFAULT_TASK_STATUSES[1]!, ...DEFAULT_TASK_STATUSES.slice(3)]);
    const backward = f.epic();
    f.store.tasks.updateTask(f.task("C", { epicId: backward.id }).id, { status: "in_progress" });
    expect(f.status(backward.id)).toBe("backlog");
  });

  it("uses custom role ids", () => {
    const f = setup();
    f.statuses({ inProgressStatus: "busy" }, [...DEFAULT_TASK_STATUSES.slice(0, 2), { id: "busy", name: "Busy" }, ...DEFAULT_TASK_STATUSES.slice(2)]);
    const epic = f.epic();
    f.store.tasks.updateTask(f.task("Work", { epicId: epic.id }).id, { status: "busy" });
    expect(f.status(epic.id)).toBe("busy");
  });

  it("does not move back with the child, and a same-column drag leaves an epic the owner moved back", async () => {
    const f = setup();
    const epic = f.epic();
    const child = f.task("Work", { epicId: epic.id });
    f.store.tasks.updateTask(child.id, { status: "in_progress" });
    f.store.tasks.updateTask(child.id, { status: "backlog" });
    expect(f.status(epic.id)).toBe("in_progress");
    f.store.tasks.updateTask(child.id, { status: "in_progress" });
    f.store.tasks.updateTask(epic.id, { status: "todo" });
    f.store.tasks.updatePosition(child.id, { status: "in_progress" });
    f.store.tasks.updateTask(child.id, { title: "Renamed" });
    expect(f.status(epic.id)).toBe("todo");
    expect(f.history(epic.id)).toHaveLength(1);
  });

  it("leaves the epic, its history and its signals alone when the child's plan gate refuses the write", async () => {
    const f = setup("required");
    const epic = f.epic();
    const child = f.task("Work", { epicId: epic.id, status: "todo" });
    await expect(f.call("updateTask", { taskId: child.id, status: "in_progress", authorName: "You" })).rejects.toThrow(/no plan/);
    await flush();
    expect(f.status(epic.id)).toBe("backlog");
    expect(f.history(epic.id)).toEqual([]);
    expect(f.signals("tasks:changed", epic.id)).toEqual([]);
    expect(f.signals("comments:changed", epic.id)).toEqual([]);
  });
});

describe("the epic move is published after the commit", () => {
  it("publishes tasks:changed and comments:changed for the epic after an RPC write", async () => {
    const f = setup();
    const epic = f.epic();
    const child = f.task("Work", { epicId: epic.id });
    await f.call("updateTask", { taskId: child.id, status: "in_progress", authorName: "You" });
    await flush();
    expect(f.signals("tasks:changed", epic.id).length).toBeGreaterThan(0);
    expect(f.signals("comments:changed", epic.id)).toHaveLength(1);
  });

  it("publishes the epic's own events when an inherited sub-task starts (the child's publication does not reach the epic)", async () => {
    const f = setup();
    const epic = f.epic();
    const parent = f.task("Parent", { epicId: epic.id });
    const sub = f.task("Sub", { parentTaskId: parent.id });
    await f.call("updateTask", { taskId: sub.id, status: "in_progress", authorName: "You" });
    await flush();
    expect(f.status(epic.id)).toBe("in_progress");
    expect(f.signals("tasks:changed", epic.id).length).toBeGreaterThan(0);
    expect(f.signals("comments:changed", epic.id)).toHaveLength(1);
  });

  it("publishes for a write that did not go through the API (the delegate's move to In progress)", async () => {
    const f = setup();
    const epic = f.epic();
    const child = f.task("Work", { epicId: epic.id, status: "todo" });
    await f.call("delegateToThread", { taskId: child.id, threadId: "thr_example" });
    await flush();
    expect(f.status(child.id)).toBe("in_progress");
    expect(f.status(epic.id)).toBe("in_progress");
    expect(f.signals("tasks:changed", epic.id).length).toBeGreaterThan(0);
    expect(f.signals("comments:changed", epic.id)).toHaveLength(1);
  });

  it("publishes nothing when an enclosing transaction rolls back", async () => {
    const f = setup();
    const epic = f.epic();
    const child = f.task("Work", { epicId: epic.id });
    expect(() => f.store.transaction(() => {
      f.store.tasks.updateTask(child.id, { status: "in_progress" });
      throw new Error("rolled back");
    })).toThrow("rolled back");
    await flush();
    expect(f.status(epic.id)).toBe("backlog");
    expect(f.history(epic.id)).toEqual([]);
    expect(f.signals("tasks:changed", epic.id)).toEqual([]);
    expect(f.signals("comments:changed", epic.id)).toEqual([]);
  });
});
