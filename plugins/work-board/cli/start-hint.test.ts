import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { createScheduledStore } from "../scheduled/store";
import { createPlanStore } from "../plans/store";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { TASK_LINK_INSTRUCTIONS } from "../shared/task-link";
import { usableStartTarget, workflowPolicySchema } from "../shared/workflow-policy";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const owner = { kind: "person" as const, threadId: null, name: "Owner" };
const author = { kind: "agent" as const, threadId: "thr_example", name: "agent (thr_example)" };
const list = (...ids: string[]) => ids.map((id) => DEFAULT_TASK_STATUSES.find((status) => status.id === id) ?? { id, name: id });
const project = (policy: Record<string, unknown> = {}, statuses = DEFAULT_TASK_STATUSES) => ({ statuses, workflowPolicy: workflowPolicySchema.parse(policy) });

describe("usableStartTarget", () => {
  it("returns In progress for an open source before it, on the default statuses", () => {
    expect(usableStartTarget(project(), "backlog")).toBe("in_progress");
    expect(usableStartTarget(project(), "todo")).toBe("in_progress");
  });
  it("is null when the target is not listed, overlaps the done role, or is not after the source", () => {
    expect(usableStartTarget(project({ inProgressStatus: "busy" }), "todo")).toBeNull();
    expect(usableStartTarget(project({ inProgressStatus: "done" }), "todo")).toBeNull();
    expect(usableStartTarget(project({}, list("in_progress", "backlog", "todo", "in_review", "done", "canceled")), "todo")).toBeNull();
    expect(usableStartTarget(project({}), "in_progress")).toBeNull();
  });
  it("is null for a closed or unlisted source and for a target of backlog or todo", () => {
    expect(usableStartTarget(project(), "done")).toBeNull();
    expect(usableStartTarget(project(), "canceled")).toBeNull();
    expect(usableStartTarget(project(), "elsewhere")).toBeNull();
    expect(usableStartTarget(project({ inProgressStatus: "todo" }), "backlog")).toBeNull();
  });
  it("follows custom role ids", () => {
    const custom = project({ inProgressStatus: "busy" }, list("backlog", "todo", "busy", "in_review", "done", "canceled") as never);
    expect(usableStartTarget(custom, "todo")).toBe("busy");
  });
});

function setup(planning: "off" | "optional" | "required" = "off") {
  const host = createFakePluginHost({ pluginId: "work-board", sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }) } } });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const created = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  if (planning !== "off") store.tasks.updateProject(created.id, { planning });
  const card = (title: string, input: Record<string, unknown> = {}) => store.tasks.createTask({ projectId: created.id, title, status: "backlog", ...input });
  const configure = (policy: Record<string, unknown>, statuses?: Array<{ id: string; name: string }>) =>
    store.tasks.updateProject(created.id, { ...(statuses ? { statuses: statuses as never } : {}), workflowPolicy: workflowPolicySchema.parse({ ...store.tasks.getProject(created.id)!.workflowPolicy, ...policy }) });
  const withPlan = (taskId: string, state: "draft" | "approved") => {
    const before = store.tasks.getTask(taskId)!.status;
    const plans = createPlanStore(host.bb.storage.database(), store.tasks);
    plans.save({ taskId, op: "replace", baseVersion: 0, body: "# Plan\n\n## Steps\nDo it.\n", summary: "Plan", author });
    store.tasks.updateTask(taskId, { status: before });
    if (state === "approved") plans.setState(taskId, "approved", owner);
  };
  /** The hint, after checking that the plain output and the JSON carry the same text. */
  const hint = async (key: string): Promise<string | null> => {
    const json = await host.harness.runCli(["show", key, "--json"]);
    const text = await host.harness.runCli(["show", key]);
    expect(json.exitCode, json.stderr).toBe(0);
    expect(text.exitCode, text.stderr).toBe(0);
    const startHint = JSON.parse(json.stdout).startHint as string | null;
    if (startHint === null) expect(text.stdout).not.toContain("Next step");
    else expect(text.stdout).toContain(`Next step\n${startHint}`);
    return startHint;
  };
  return { ...host, host, store, project: created, card, configure, withPlan, hint };
}

const PLANNING = [...DEFAULT_TASK_STATUSES.slice(0, 2), { id: "planning", name: "Planning" }, ...DEFAULT_TASK_STATUSES.slice(2)];

describe("show: Next step", () => {
  it("suggests In progress for a Backlog or Todo task when planning is off", async () => {
    const f = setup();
    const backlog = f.card("Work");
    const todo = f.card("Later", { status: "todo" });
    expect(await f.hint(backlog.key)).toBe(`Taking this task? Move it first: bb work-board update ${backlog.key} --status in_progress`);
    expect(await f.hint(todo.key)).toContain(`update ${todo.key} --status in_progress`);
  });

  it("suggests nothing for a started task, an epic, or a project without a usable In progress", async () => {
    const f = setup();
    expect(await f.hint(f.card("Busy", { status: "in_progress" }).key)).toBeNull();
    expect(await f.hint(f.card("Epic", { type: "epic" }).key)).toBeNull();
    const plain = f.card("Plain");
    f.configure({ inProgressStatus: "busy" });
    expect(await f.hint(plain.key)).toBeNull();
  });

  it("suggests nothing for a scheduled template", async () => {
    const f = setup();
    const schedule = createScheduledStore(f.host.bb, f.store).create({ projectId: f.project.id, title: "Rule", rule: { kind: "daily", time: "09:00", timezone: "UTC" }, target: { kind: "thread", threadId: "thr_example" } });
    const template = f.store.tasks.getTask(schedule.templateTaskId)!;
    expect(template).toMatchObject({ scheduledRole: "template" });
    expect(["backlog", "todo"]).toContain(template.status);
    expect(await f.hint(template.key)).toBeNull();
  });

  it("uses the planning status while planning is required and the plan is not approved", async () => {
    const f = setup("required");
    f.configure({ planningStatus: "planning" }, PLANNING);
    const task = f.card("Work");
    expect(await f.hint(task.key)).toContain(`update ${task.key} --status planning`);
    f.withPlan(task.id, "draft");
    expect(await f.hint(task.key)).toContain("--status planning");
    f.withPlan(f.card("Approved").id, "approved");
    const approved = f.store.tasks.listTasks({ projectId: f.project.id }).find((entry) => entry.title === "Approved")!;
    expect(await f.hint(approved.key)).toContain(`--status in_progress`);
  });

  it("has no move line when the planning status is the task's own column, is missing, or is not ahead of it", async () => {
    const f = setup("required");
    const task = f.card("Work", { status: "todo" });
    expect(await f.hint(task.key)).toContain("--status planning");
    f.configure({ planningStatus: "todo" });
    expect(await f.hint(task.key)).toBeNull();
    f.configure({ planningStatus: "backlog" });
    expect(await f.hint(task.key)).toBeNull();
    f.configure({ planningStatus: null });
    expect(f.store.tasks.getProject(f.project.id)?.workflowPolicy?.planningStatus ?? null).toBeNull();
    expect(await f.hint(task.key)).toBeNull();
  });

  it("names the epic that follows, for a direct epic and an inherited one, but not one already moving", async () => {
    const f = setup();
    const epic = f.card("Epic", { type: "epic" });
    const direct = f.card("Direct", { epicId: epic.id });
    const parent = f.card("Parent", { epicId: epic.id });
    const sub = f.card("Sub", { parentTaskId: parent.id });
    const line = `Its epic ${epic.key} moves to In Progress automatically when this task starts.`;
    expect(await f.hint(direct.key)).toContain(line);
    expect(await f.hint(sub.key)).toContain(line);
    f.store.tasks.updateTask(epic.id, { status: "in_progress" });
    expect(await f.hint(direct.key)).not.toContain("Its epic");
    expect(await f.hint(direct.key)).toContain("Taking this task?");
  });

  it("uses custom role ids", async () => {
    const f = setup();
    f.configure({ inProgressStatus: "busy" }, [...DEFAULT_TASK_STATUSES.slice(0, 2), { id: "busy", name: "Busy" }, ...DEFAULT_TASK_STATUSES.slice(2)]);
    const epic = f.card("Epic", { type: "epic" });
    const task = f.card("Work", { epicId: epic.id });
    expect(await f.hint(task.key)).toBe(`Taking this task? Move it first: bb work-board update ${task.key} --status busy\nIts epic ${epic.key} moves to Busy automatically when this task starts.`);
  });
});

it("tells agents in the standing instructions to move a task they take", () => {
  expect(TASK_LINK_INSTRUCTIONS).toContain("When you take a task from Backlog or Todo, move it as `bb work-board show` suggests");
});
