import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import plugin from "../server";
import { initializeTasksSchema } from "../db/schema";
import { evaluateThreadHealth } from "../shared/thread-health";
import type { TaskThread } from "../shared/contract";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { ensurePlanningStatus, planningStatusOf, startsFromStatus, workflowPolicySchema } from "../shared/workflow-policy";
import { createStructuredStore } from "../structured/store";
import { createPlanStore } from "./store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const author = { kind: "agent" as const, threadId: "thr_example", name: "agent (thr_example)" };
const owner = { kind: "person" as const, threadId: null, name: "Owner" };
const BODY = "# Plan\n\n## Steps\n- one\n";
const ids = (statuses: ReadonlyArray<{ id: string }> | undefined | null) => (statuses ?? []).map((status) => status.id);
const defaults = () => DEFAULT_TASK_STATUSES.map((status) => ({ ...status })) as Array<{ id: string; name: string; requiresApprovedPlan?: boolean }>;

function setup(planning: "off" | "optional" | "required" = "optional") {
  const host = createFakePluginHost({ pluginId: "work-board", sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }), send: async () => undefined } } });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  if (planning !== "off") store.tasks.updateProject(project.id, { planning });
  const db = host.bb.storage.database();
  const plans = createPlanStore(db, store.tasks);
  const card = (status = "backlog", title = "Planned work") => store.tasks.createTask({ projectId: project.id, title, status });
  const save = (taskId: string, baseVersion = 0, body = BODY) => plans.save({ taskId, op: "replace", baseVersion, body, summary: "Plan", author });
  const status = (taskId: string) => store.tasks.getTask(taskId)!.status;
  const current = () => store.tasks.getProject(project.id)!;
  const edit = (change: (statuses: Array<{ id: string; name: string; requiresApprovedPlan?: boolean }>) => unknown, policy?: Record<string, unknown>) =>
    store.tasks.updateProject(project.id, { statuses: change(current().statuses! as never) as never ?? (current().statuses as never), ...(policy ? { workflowPolicy: workflowPolicySchema.parse({ ...current().workflowPolicy, ...policy }) } : {}) });
  return { ...host, store, project, db, plans, card, save, status, current, edit };
}

describe("ensurePlanningStatus", () => {
  it("inserts an unmarked Planning status right before In progress when both the id and the name are free", () => {
    const result = ensurePlanningStatus({ statuses: defaults() });
    expect(ids(result.statuses)).toEqual(["backlog", "todo", "planning", "in_progress", "in_review", "done", "canceled"]);
    expect(result.statuses[2]).toEqual({ id: "planning", name: "Planning" });
    expect(result).toMatchObject({ planningStatus: "planning", reason: null });
  });

  it("uses an existing planning id as is and never touches its owner flags; a marked one is no target", () => {
    const plain = defaults();
    plain.splice(2, 0, { id: "planning", name: "Thinking" });
    expect(ensurePlanningStatus({ statuses: plain })).toMatchObject({ planningStatus: "planning", statuses: plain });
    const marked = defaults();
    marked.splice(2, 0, { id: "planning", name: "Thinking", requiresApprovedPlan: true });
    const result = ensurePlanningStatus({ statuses: marked });
    expect(result.planningStatus).toBeNull();
    expect(result.statuses).toEqual(marked);
    expect(result.statuses[2]).toHaveProperty("requiresApprovedPlan", true);
  });

  it("uses a status named Planning (any case) with another id, and keeps a valid configured one", () => {
    const named = defaults();
    named.splice(2, 0, { id: "design", name: "PLANNING" });
    expect(ensurePlanningStatus({ statuses: named })).toMatchObject({ planningStatus: "design", statuses: named });
    const custom = defaults();
    custom.splice(1, 0, { id: "triage", name: "Triage" });
    expect(ensurePlanningStatus({ statuses: custom, workflowPolicy: workflowPolicySchema.parse({ planningStatus: "triage" }) })).toMatchObject({ planningStatus: "triage" });
  });

  it("inserts nothing when the id or the name is taken by a status that cannot be a target", () => {
    const doneNamed = defaults().map((status) => (status.id === "done" ? { ...status, name: "Planning" } : status));
    expect(ensurePlanningStatus({ statuses: doneNamed })).toMatchObject({ planningStatus: null, statuses: doneNamed });
    const idTaken = defaults();
    idTaken.splice(2, 0, { id: "planning", name: "Review lane" });
    const policy = workflowPolicySchema.parse({ reviewStatus: "planning" });
    const result = ensurePlanningStatus({ statuses: idTaken, workflowPolicy: policy });
    expect(result.planningStatus).toBeNull();
    expect(result.statuses).toEqual(idTaken);
    expect(result.reason).toContain("planning");
  });

  it("judges both candidates: an unusable planning id does not mask a usable status named Planning", () => {
    const statuses = defaults();
    statuses.splice(2, 0, { id: "planning", name: "Research", requiresApprovedPlan: true }, { id: "design", name: "Planning" });
    const result = ensurePlanningStatus({ statuses });
    expect(result).toMatchObject({ planningStatus: "design", statuses });
  });

  it("does not insert a Planning column that a workflow role already claims through the absent id", () => {
    const result = ensurePlanningStatus({ statuses: defaults(), workflowPolicy: workflowPolicySchema.parse({ doneStatus: "planning" }) });
    expect(result.planningStatus).toBeNull();
    expect(result.statuses).toEqual(defaults());
    expect(result.reason).toContain("workflow role");
  });

  it("inserts nothing into a full list or a list without In progress, and says why", () => {
    const full = [...defaults(), ...Array.from({ length: 26 }, (_, index) => ({ id: `extra_${index}`, name: `Extra ${index}` }))];
    expect(full).toHaveLength(32);
    expect(ensurePlanningStatus({ statuses: full })).toMatchObject({ planningStatus: null, reason: expect.stringContaining("32") });
    expect(ensurePlanningStatus({ statuses: full }).statuses).toHaveLength(32);
    const noStart = defaults().filter((status) => status.id !== "in_progress");
    expect(ensurePlanningStatus({ statuses: noStart, workflowPolicy: workflowPolicySchema.parse({ inProgressStatus: null }) })).toMatchObject({ planningStatus: null, reason: expect.stringContaining("In progress") });
  });
});

describe("planning status in the project settings", () => {
  it("is settled when the owner turns planning on, and left in place when it is turned off", () => {
    const f = setup("off");
    expect(ids(f.current().statuses ?? DEFAULT_TASK_STATUSES)).not.toContain("planning");
    f.store.tasks.updateProject(f.project.id, { planning: "required" });
    expect(ids(f.current().statuses)).toEqual(["backlog", "todo", "planning", "in_progress", "in_review", "done", "canceled"]);
    expect(f.current().workflowPolicy?.planningStatus).toBe("planning");
    expect(f.current().statuses!.find((status) => status.id === "planning")).not.toHaveProperty("requiresApprovedPlan");
    f.store.tasks.updateProject(f.project.id, { planning: "off" });
    expect(ids(f.current().statuses)).toContain("planning");
    expect(f.current().workflowPolicy?.planningStatus).toBe("planning");
  });

  it("is checked against the project at every use, so a later settings edit takes effect", () => {
    const f = setup();
    expect(planningStatusOf(f.current())).toBe("planning");
    f.edit((statuses) => statuses.map((status) => (status.id === "planning" ? { ...status, requiresApprovedPlan: true } : status)));
    expect(planningStatusOf(f.current())).toBeNull();
    expect(startsFromStatus(f.current(), "planning")).toBe(false);
    expect(startsFromStatus(f.current(), "todo")).toBe(true);
  });
});

describe("planning status and workflow roles when planning is turned on", () => {
  it("adds no column that would close cards when the policy maps the absent id planning to Done", () => {
    const f = setup("off");
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ doneStatus: "planning" }) });
    f.store.tasks.updateProject(f.project.id, { planning: "optional" });
    expect(ids(f.current().statuses ?? DEFAULT_TASK_STATUSES)).not.toContain("planning");
    expect(planningStatusOf(f.current())).toBeNull();
  });

  it("selects a usable Planning-named column when the planning id is unusable", () => {
    const f = setup("off");
    f.store.tasks.updateProject(f.project.id, {
      statuses: [...DEFAULT_TASK_STATUSES.slice(0, 2), { id: "planning", name: "Research", requiresApprovedPlan: true }, { id: "design", name: "Planning" }, ...DEFAULT_TASK_STATUSES.slice(2)] as never,
    });
    f.store.tasks.updateProject(f.project.id, { planning: "optional" });
    expect(f.current().workflowPolicy?.planningStatus).toBe("design");
    expect(ids(f.current().statuses)).toHaveLength(8);
  });
});

describe("planning status migration", () => {
  it("settles every planning project and isolates a board that cannot be read", () => {
    const f = setup("off");
    const messages: string[] = [];
    const good = f.store.tasks.createProject({ name: "Good", prefix: "GOOD", color: "blue" });
    const bad = f.store.tasks.createProject({ name: "Bad", prefix: "BAD", color: "blue" });
    const off = f.store.tasks.createProject({ name: "Off", prefix: "OFF", color: "blue" });
    f.db.prepare("UPDATE projects SET planning = 'optional' WHERE id IN (?, ?)").run(good.id, bad.id);
    f.db.prepare("UPDATE projects SET statuses = 'not json' WHERE id = ?").run(bad.id);
    // Run the last migration again, as an upgrade from the previous version would.
    const last = f.db.prepare<[], { version: number }>("SELECT MAX(version) AS version FROM schema_version").get()!.version;
    f.db.prepare("DELETE FROM schema_version WHERE version = ?").run(last);
    initializeTasksSchema(f.db, (message) => messages.push(message));
    const read = (id: string) => f.db.prepare<[string], { statuses: string | null; workflow_policy: string | null }>("SELECT statuses, workflow_policy FROM projects WHERE id = ?").get(id)!;
    expect(ids(JSON.parse(read(good.id).statuses!))).toEqual(["backlog", "todo", "planning", "in_progress", "in_review", "done", "canceled"]);
    expect(JSON.parse(read(good.id).workflow_policy!).planningStatus).toBe("planning");
    expect(read(bad.id).statuses).toBe("not json");
    expect(messages).toEqual([expect.stringContaining("BAD")]);
    expect(read(off.id)).toEqual({ statuses: null, workflow_policy: null });
  });
});

describe("entering Planning with the first plan version", () => {
  it.each(["backlog", "todo"])("moves a %s card in the same write and reports the move once", async (from) => {
    const f = setup();
    const task = f.card(from);
    const saved = f.save(task.id);
    expect(saved.movedTo).toEqual({ status: "planning", label: "Planning" });
    expect(f.status(task.id)).toBe("planning");
    // A later version does not move anything.
    f.store.tasks.updateTask(task.id, { status: "todo" });
    expect(f.save(task.id, 1, `${BODY}More.\n`).movedTo).toBeNull();
    expect(f.status(task.id)).toBe("todo");
  });

  it("moves nothing when the save fails, or for a card in progress, closed, archived or a template", () => {
    const f = setup();
    const failing = f.card("backlog", "Failing");
    expect(() => f.save(failing.id, 3)).toThrow(/must be 0/);
    expect(f.status(failing.id)).toBe("backlog");
    for (const state of ["in_progress", "done", "canceled"]) {
      const task = f.card(state, `Card ${state}`);
      expect(f.save(task.id).movedTo).toBeNull();
      expect(f.status(task.id)).toBe(state);
    }
    const archived = f.card("backlog", "Archived");
    f.db.prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), archived.id);
    expect(() => f.save(archived.id)).toThrow(/archived/);
    expect(f.status(archived.id)).toBe("backlog");
    const template = f.card("backlog", "Template");
    f.db.prepare("INSERT INTO task_scheduled_sources(task_id, schedule_id, schedule_title, role) VALUES (?, '00000000-0000-0000-0000-000000000000', 'Hidden', 'template')").run(template.id);
    expect(f.save(template.id).movedTo).toBeNull();
    expect(f.status(template.id)).toBe("backlog");
  });

  it("never reopens a closed card whose Done is mapped to Todo or Backlog, through the saveTaskPlan RPC", async () => {
    for (const closed of ["todo", "backlog"]) {
      const f = setup();
      f.edit((statuses) => statuses, { doneStatus: closed });
      const task = f.card(closed, `Closed in ${closed}`);
      const saved = (await f.harness.callRpc("saveTaskPlan" as never, { taskId: task.id, summary: "Plan", author, op: "replace", baseVersion: 0, body: BODY } as never)) as { ok: boolean; movedTo: unknown };
      expect(saved).toMatchObject({ ok: true, movedTo: null });
      expect(f.status(task.id)).toBe(closed);
    }
  });

  it("reports no move for a card that is already in the planning column, such as a Todo column named Planning", async () => {
    const f = setup();
    f.edit((statuses) => statuses.filter((status) => status.id !== "planning").map((status) => (status.id === "todo" ? { ...status, name: "Planning" } : status)), { planningStatus: "todo" });
    expect(planningStatusOf(f.current())).toBe("todo");
    const task = f.card("todo");
    const saved = (await f.harness.callRpc("saveTaskPlan" as never, { taskId: task.id, summary: "Plan", author, op: "replace", baseVersion: 0, body: BODY } as never)) as { ok: boolean; movedTo: unknown };
    expect(saved).toMatchObject({ ok: true, movedTo: null });
    expect(f.status(task.id)).toBe("todo");
  });

  it("does not move a card when planning is off", async () => {
    const f = setup();
    const task = f.card();
    f.store.tasks.updateProject(f.project.id, { planning: "off" });
    expect(() => f.save(task.id)).toThrow(/planning is off/);
    expect(f.status(task.id)).toBe("backlog");
  });

  it("prints the move line only for a committed move, through the plan set command", async () => {
    const host = createFakePluginHost({ pluginId: "work-board" });
    hosts.push(host);
    await plugin(host.bb);
    const cli = (...args: string[]) => host.harness.runCli(args);
    await cli("project", "create", "--name", "Example", "--prefix", "EXA");
    const projectId = (host.bb.storage.database().prepare("SELECT id FROM projects").get() as { id: string }).id;
    await host.harness.callRpc("updateProject" as never, { projectId, planning: "optional" } as never);
    await cli("create", "--project", "EXA", "--title", "One");
    await cli("create", "--project", "EXA", "--title", "Two", "--status", "in_progress");
    const first = await cli("plan", "set", "EXA-1", "--base-version", "0", "--summary", "Plan", "--body", BODY);
    expect(first.stdout).toMatch(/EXA-1 plan saved as v1[^\n]*\nEXA-1 moved to Planning$/);
    const second = await cli("plan", "set", "EXA-2", "--base-version", "0", "--summary", "Plan", "--body", BODY);
    expect(second.stdout).not.toContain("moved to");
    const failed = await cli("plan", "set", "EXA-1", "--base-version", "0", "--summary", "Plan", "--body", BODY);
    expect(failed.stdout + failed.stderr).not.toContain("moved to");
  });
});

describe("planning status that is not a valid target", () => {
  const invalid: Array<[string, (f: ReturnType<typeof setup>) => void]> = [
    ["a Done renamed to Planning", (f) => f.edit((statuses) => statuses.filter((status) => status.id !== "planning").map((status) => (status.id === "done" ? { ...status, name: "Planning" } : status)), { planningStatus: "done" })],
    ["a column mapped to doneStatus", (f) => f.edit((statuses) => [...statuses, { id: "shipped", name: "Shipped" }], { doneStatus: "shipped", planningStatus: "shipped" })],
    ["a canceled column named Planning", (f) => f.edit((statuses) => statuses.filter((status) => status.id !== "planning").map((status) => (status.id === "canceled" ? { ...status, name: "Planning" } : status)), { planningStatus: "canceled" })],
    ["a marked planning column", (f) => f.edit((statuses) => statuses.map((status) => (status.id === "planning" ? { ...status, requiresApprovedPlan: true } : status)))],
  ];
  it.each(invalid)("keeps the card in place and saves the plan with no move for %s", (_label, change) => {
    const f = setup();
    change(f);
    expect(planningStatusOf(f.current())).toBeNull();
    const task = f.card("todo");
    const saved = f.save(task.id);
    expect(saved).toMatchObject({ version: { version: 1 }, movedTo: null });
    expect(f.status(task.id)).toBe("todo");
  });
});

describe("leaving Planning", () => {
  it("is an ordinary move: free when In progress is unmarked, gated when it is marked in a required project", () => {
    const f = setup("required");
    const task = f.card("backlog");
    f.save(task.id);
    expect(f.status(task.id)).toBe("planning");
    expect(() => f.store.tasks.updateTask(task.id, { status: "in_progress" })).toThrow(/plan v1 is draft/);
    f.plans.setState(task.id, "approved", owner);
    expect(f.store.tasks.updateTask(task.id, { status: "in_progress" }).status).toBe("in_progress");
    // With In progress unmarked, a card without an approved plan moves freely.
    const free = f.card("planning", "Free");
    f.edit((statuses) => statuses.map((status) => (status.id === "in_progress" ? { ...status, requiresApprovedPlan: false } : status)));
    expect(f.store.tasks.updateTask(free.id, { status: "in_progress" }).status).toBe("in_progress");
  });
});

describe("signals", () => {
  const flags = (f: ReturnType<typeof setup>, taskId: string) => f.store.tasks.staleStatusFlags([taskId]).get(taskId) ?? [];

  it("raises no_active_thread for the planning status like In progress, with predecessor suppression and the working check", async () => {
    const f = setup();
    const task = f.card("planning");
    expect(flags(f, task.id)).toEqual(["no_active_thread"]);
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_example", presetName: "Default", title: "Planner", liveStatus: "working" });
    expect(flags(f, task.id)).toEqual([]);
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_example", presetName: "Default", title: "Planner", liveStatus: "idle" });
    expect(flags(f, task.id)).toEqual(["no_active_thread"]);
    const predecessor = f.card("todo", "Predecessor");
    await f.harness.callRpc("addTaskDependency" as never, { taskId: task.id, blockingTaskId: predecessor.id, authorName: "Owner" } as never);
    expect(flags(f, task.id)).toEqual([]);
    // A Planning status that is no longer a valid target raises nothing.
    await f.harness.callRpc("removeTaskDependency" as never, { taskId: task.id, blockingTaskId: predecessor.id, authorName: "Owner" } as never);
    f.edit((statuses) => statuses.map((status) => (status.id === "planning" ? { ...status, requiresApprovedPlan: true } : status)));
    expect(flags(f, task.id)).toEqual([]);
  });

  it("counts a card in Planning as waiting on the owner and as active in thread health, as any open status does", async () => {
    const f = setup();
    const task = f.card("planning");
    await createStructuredStore(f.bb, f.store).handlers.createQuestion({ taskId: task.id, kind: "decision", askedByThread: null, prompt: "Which one?", steps: [], options: ["A", "B"], mode: "single" });
    const waiting = f.store.tasks.listTasksPage({ projectId: f.project.id, waitingOnOwner: true });
    expect(waiting.tasks.map((entry) => entry.id)).toEqual([task.id]);
    const link = { id: "id_a", taskId: task.id, threadId: "thr_a", presetName: "p", title: "t", liveStatus: "idle", attachedAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T08:00:00.000Z" } as TaskThread;
    // Not a review or closed status, so an idle planner past the threshold is stale; an unanswered question excuses it.
    expect(evaluateThreadHealth("planning", [link], "2026-10-28T08:00:00.000Z", 45).idle).not.toBeNull();
    expect(evaluateThreadHealth("planning", [link], "2026-10-28T08:00:00.000Z", 45, ["in_review"], true).idle).toBeNull();
  });

  it("never lets a card in Planning alone into the pilot set of manager attention", () => {
    const f = setup();
    const task = f.card("planning");
    const [observation] = f.store.tasks.staleStatusObservations(f.project.id, [task.id]);
    expect(observation).toMatchObject({ taskId: task.id, inScope: false });
  });
});
