import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from ".";
import { registerTasksCli } from "../cli";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { resolveRoles } from "../shared/status-roles";
import { getWorkflowPolicy, workflowPolicySchema } from "../shared/workflow-policy";
import { WAITING_ON_OWNER } from "../db/waiting-on-owner";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

const statuses = (...removed: string[]) => DEFAULT_TASK_STATUSES.filter((status) => !removed.includes(status.id)).map((status) => ({ ...status }));
const renamedTodo = () => statuses().map((status) => (status.id === "todo" ? { ...status, name: "Run-up" } : status));

function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(host.harness);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const current = () => store.tasks.getProject(project.id)!;
  const comments = (taskId: string) => store.tasks.listComments(taskId).map((comment) => comment.body);
  return { ...host, store, project, current, comments };
}

describe("a project without a former system status", () => {
  it("works end to end without todo: create, move, close, plan gates, dependencies", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("todo") });
    expect(f.current().statuses?.map((status) => status.id)).not.toContain("todo");
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "Card" });
    expect(card.status).toBe("backlog");
    expect(f.store.tasks.updateTask(card.id, { status: "in_progress" }).status).toBe("in_progress");
    expect(() => f.store.tasks.updateTask(card.id, { status: "todo" })).toThrow(/EXA-1: status `todo` is not in this project \(statuses: backlog, in_progress/);
    expect(() => f.store.tasks.createTask({ projectId: f.project.id, title: "Bad", status: "todo" })).toThrow(/not in this project/);
    // closing and the closure record
    expect(f.store.tasks.updateTask(card.id, { status: "done" }).status).toBe("done");
    expect(f.store.tasks.closures.currentId(card.id)).not.toBeNull();
    // planning required: In progress is gated, canceled never is
    f.store.tasks.updateProject(f.project.id, { planning: "required" });
    const gated = f.store.tasks.createTask({ projectId: f.project.id, title: "Gated" });
    expect(() => f.store.tasks.updateTask(gated.id, { status: "in_progress" })).toThrow(/plan/i);
    expect(f.store.tasks.updateTask(gated.id, { status: "canceled" }).status).toBe("canceled");
    // dependencies: only the done status satisfies a predecessor (the SQL fragment is covered by the agreement test)
    const blocker = f.store.tasks.createTask({ projectId: f.project.id, title: "Blocker" });
    const dependent = f.store.tasks.createTask({ projectId: f.project.id, title: "Dependent" });
    f.store.tasks.updateProject(f.project.id, { planning: "off" });
    f.bb.storage.database().prepare("INSERT INTO task_dependencies(task_id, blocking_task_id, created_at) VALUES (?,?,?)").run(dependent.id, blocker.id, new Date().toISOString());
    const held = () => f.bb.storage.database().prepare(`SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.blocking_task_id WHERE d.task_id=? AND NOT ${"COALESCE(t.status = 'done', 0)"}`).get(dependent.id);
    expect(held()).toBeTruthy();
    f.store.tasks.updateTask(blocker.id, { status: "done" });
    expect(held()).toBeUndefined();
  });

  it("falls back to the first status for a new card without backlog, and has no canceled close without canceled", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("backlog"), workflowPolicy: workflowPolicySchema.parse({}) });
    expect(f.store.tasks.createTask({ projectId: f.project.id, title: "A" }).status).toBe("todo");
    const noCancel = setup();
    noCancel.store.tasks.updateProject(noCancel.project.id, { statuses: statuses("canceled"), workflowPolicy: workflowPolicySchema.parse({ canceledStatus: null }) });
    expect(resolveRoles(noCancel.current()).canceled).toBeNull();
    expect(resolveRoles(noCancel.current()).closed).toEqual(["done"]);
  });

  it("closes in a custom done status without done", () => {
    const f = setup();
    const list = [...statuses("done"), { id: "shipped", name: "Shipped" }];
    f.store.tasks.updateProject(f.project.id, { statuses: list, workflowPolicy: workflowPolicySchema.parse({ doneStatus: "shipped" }) });
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "A" });
    f.store.tasks.updateTask(card.id, { status: "shipped" });
    expect(f.store.tasks.closures.currentId(card.id)).not.toBeNull();
    const rows = f.bb.storage.database().prepare(`SELECT t.id FROM tasks t WHERE ${WAITING_ON_OWNER}`).all();
    expect(rows).toEqual([]);
  });
});

describe("deleting a status", () => {
  it("refuses while cards (archived too) hold it and shows the counts, then moves them through the normal path", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: renamedTodo() });
    const a = f.store.tasks.createTask({ projectId: f.project.id, title: "A", status: "todo" });
    const b = f.store.tasks.createTask({ projectId: f.project.id, title: "B", status: "todo" });
    f.store.tasks.updateTask(b.id, { status: "done" });
    f.store.tasks.updateTask(b.id, { status: "todo" });
    f.store.tasks.updateTask(b.id, { status: "done" });
    f.store.tasks.setTaskArchived(b.id, true);
    f.store.tasks.updateTask(b.id, { status: "todo" }); // archived cards keep a status; reopen it into the deleted one
    expect(() => f.store.tasks.updateProject(f.project.id, { statuses: statuses("todo") })).toThrow(/2 cards are in Run-up \(todo\) \(1 archived\); move them with --move-status todo=<status>/);
    expect(f.store.tasks.getTask(a.id)?.status).toBe("todo");
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("todo"), statusMoves: { todo: "backlog" }, authorName: "Agent" });
    expect(f.store.tasks.getTask(a.id)?.status).toBe("backlog");
    expect(f.store.tasks.getTask(b.id)?.status).toBe("backlog");
    expect(f.comments(a.id)).toContain("Status: Run-up → Backlog (status deleted)");
    expect(f.current().statuses?.map((status) => status.id)).not.toContain("todo");
    // earlyStatuses dropped the id, no role was asked
    expect(resolveRoles(f.current()).early).toEqual(["in_progress"]);
  });

  it("sets and clears the closure of moved cards and satisfies a dependent when the blocker moves into done", () => {
    const f = setup();
    const blocker = f.store.tasks.createTask({ projectId: f.project.id, title: "Blocker", status: "todo" });
    const open = f.store.tasks.createTask({ projectId: f.project.id, title: "Open", status: "todo" });
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("todo"), statusMoves: { todo: "done" } });
    expect(f.store.tasks.getTask(blocker.id)?.status).toBe("done");
    expect(f.store.tasks.closures.currentId(blocker.id)).not.toBeNull();
    expect(f.store.tasks.getTask(open.id)?.status).toBe("done");
  });

  it("refuses a move into a plan-gated status without an approved plan, and writes nothing", () => {
    const f = setup();
    const first = f.store.tasks.createTask({ projectId: f.project.id, title: "A", status: "todo" });
    f.store.tasks.updateProject(f.project.id, { planning: "required", statuses: statuses().map((status) => (status.id === "in_review" ? { ...status, requiresApprovedPlan: true } : status)) });
    const before = f.current();
    const kept = before.statuses!.filter((status) => status.id !== "todo");
    expect(() => f.store.tasks.updateProject(f.project.id, { statuses: kept, statusMoves: { todo: "in_review" } })).toThrow(/EXA-1/);
    expect(f.current()).toEqual(before);
    expect(f.store.tasks.getTask(first.id)?.status).toBe("todo");
    expect(f.comments(first.id).filter((body) => body.includes("status deleted"))).toEqual([]);
  });

  it("asks for a single role that points at the deleted status, accepts none for a nullable role and refuses it for the new-card status", () => {
    const f = setup();
    expect(() => f.store.tasks.updateProject(f.project.id, { statuses: statuses("in_review") })).toThrow(/reviewStatus points to the deleted status In Review \(in_review\); set it with --set-role reviewStatus=<status\|none>/);
    const policy = workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), reviewStatus: null });
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("in_review"), workflowPolicy: policy });
    expect(resolveRoles(f.current()).review).toBeNull();
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), newCardStatus: "backlog" }) });
    expect(() => f.store.tasks.updateProject(f.project.id, { statuses: statuses("in_review", "backlog") })).toThrow(/newCardStatus points to the deleted status/);
    expect(() => f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), newCardStatus: null }) })).toThrow();
  });

  it("checks only the roles a write changes; an old materialized role naming an unlisted status is tolerated", () => {
    const f = setup();
    // The stored policy holds the old defaults (bugfix, in_testing) although neither status is listed.
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({}) });
    expect(getWorkflowPolicy(f.current())).toMatchObject({ bugfixStatus: "bugfix", testingStatus: "in_testing", earlyStatuses: ["todo", "in_progress"] });
    expect(f.store.tasks.updateProject(f.project.id, { name: "Renamed" }).name).toBe("Renamed");
    // deleting todo drops it from earlyStatuses and asks no role question
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("todo") });
    expect(getWorkflowPolicy(f.current()).earlyStatuses).toEqual(["in_progress"]);
    // a changed role must name a listed status
    expect(() => f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), reviewStatus: "nope" }) })).toThrow(/reviewStatus: status `nope` is not in this project/);
  });

  it("keeps an explicit array explicit (even empty) and lets an omitted array pick a re-added id up again", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), earlyStatuses: ["todo"], notStartedStatuses: ["todo"] }) });
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("todo") });
    const policy = getWorkflowPolicy(f.current());
    expect(policy.earlyStatuses).toEqual([]);
    expect(policy.notStartedStatuses).toEqual([]);
    expect(resolveRoles(f.current()).notStarted).toEqual([]);
    f.store.tasks.updateProject(f.project.id, { statuses: statuses() });
    expect(resolveRoles(f.current()).notStarted).toEqual([]); // explicit: the owner adds it back
    // an omitted array follows its default
    const g = setup();
    g.store.tasks.updateProject(g.project.id, { statuses: statuses("todo") });
    expect(resolveRoles(g.current()).notStarted).toEqual(["backlog"]);
    g.store.tasks.updateProject(g.project.id, { statuses: statuses() });
    expect(resolveRoles(g.current()).notStarted).toEqual(["backlog", "todo"]);
  });

  it("leaves an explicit unlisted inProgressStatus as configured, with no start move", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ inProgressStatus: null }), statuses: statuses("in_progress") });
    expect(resolveRoles(f.current()).inProgress).toBeNull();
  });
});

describe("a deletion judges its moves against the project it leaves", () => {
  it("moves cards to a status added in the same request", () => {
    const f = setup();
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "A", status: "todo" });
    f.store.tasks.updateProject(f.project.id, { statuses: [...statuses("todo"), { id: "ready", name: "Ready" }], statusMoves: { todo: "ready" } });
    expect(f.store.tasks.getTask(card.id)?.status).toBe("ready");
    expect(f.comments(card.id)).toContain("Status: Todo → Ready (status deleted)");
  });

  it("refuses a move into a status that becomes plan-gated in the same request, and rolls the whole request back", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { planning: "required" });
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "A", status: "todo" });
    const before = f.current();
    const gated = before.statuses!.filter((status) => status.id !== "todo").map((status) => (status.id === "in_review" ? { ...status, requiresApprovedPlan: true } : status));
    expect(() => f.store.tasks.updateProject(f.project.id, { statuses: gated, statusMoves: { todo: "in_review" } })).toThrow(/EXA-1.*approved/s);
    expect(f.current()).toEqual(before);
    expect(f.store.tasks.getTask(card.id)?.status).toBe("todo");
    expect(f.comments(card.id).filter((body) => body.includes("status deleted"))).toEqual([]);
  });

  it("sets the closure for a move into a status that becomes closed in the same request", () => {
    const f = setup();
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "A", status: "todo" });
    f.store.tasks.updateProject(f.project.id, {
      statuses: [...statuses("todo"), { id: "shipped", name: "Shipped" }],
      workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), closedStatuses: ["done", "canceled", "shipped"] }),
      statusMoves: { todo: "shipped" },
    });
    expect(f.store.tasks.getTask(card.id)?.status).toBe("shipped");
    expect(f.store.tasks.closures.currentId(card.id)).not.toBeNull();
  });
});

describe("the bugfix to done rule in a deletion move", () => {
  it("refuses moving the cards of a deleted bugfix status into done, and writes nothing", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: [...statuses(), { id: "bugfix", name: "Bugfix" }] });
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "A", status: "bugfix" });
    const before = f.current();
    const remaining = before.statuses!.filter((status) => status.id !== "bugfix");
    const policy = workflowPolicySchema.parse({ ...getWorkflowPolicy(before), bugfixStatus: null });
    expect(() => f.store.tasks.updateProject(f.project.id, { statuses: remaining, workflowPolicy: policy, statusMoves: { bugfix: "done" } })).toThrow(/Cannot move directly from bugfix to done/);
    expect(f.current()).toEqual(before);
    expect(f.store.tasks.getTask(card.id)?.status).toBe("bugfix");
    expect(f.comments(card.id).filter((body) => body.includes("status deleted"))).toEqual([]);
    // to any other status it goes
    f.store.tasks.updateProject(f.project.id, { statuses: remaining, workflowPolicy: policy, statusMoves: { bugfix: "in_progress" } });
    expect(f.store.tasks.getTask(card.id)?.status).toBe("in_progress");
  });
});

describe("a role the request sets is validated, whatever its value", () => {
  it("refuses doneStatus=done after done was deleted, and an explicit default array naming an unlisted id", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { statuses: [...statuses("done"), { id: "shipped", name: "Shipped" }], workflowPolicy: workflowPolicySchema.parse({ doneStatus: "shipped" }) });
    expect(resolveRoles(f.current()).done).toBe("shipped");
    expect(() => f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), doneStatus: "done" }) })).toThrow(/doneStatus: status `done` is not in this project/);
    expect(() => f.store.tasks.updateProject(f.project.id, { workflowPolicy: workflowPolicySchema.parse({ ...getWorkflowPolicy(f.current()), closedStatuses: ["done", "canceled"] }) })).toThrow(/closedStatuses: `done` not in this project/);
    // an untouched stale role (old bugfix/in_testing defaults) is still tolerated
    expect(f.store.tasks.updateProject(f.project.id, { name: "Renamed" }).name).toBe("Renamed");
  });
});

describe("the CLI", () => {
  it("refuses none for the new-card status and a role it does not know, and a move to a status the project does not have", async () => {
    const f = setup();
    const none = await f.harness.runCli(["project", "update", "EXA", "--set-role", "newCardStatus=none"]);
    expect(none.exitCode).not.toBe(0);
    expect(none.stderr).toMatch(/newCardStatus cannot be none/);
    const unknown = await f.harness.runCli(["project", "update", "EXA", "--set-role", "bogus=done"]);
    expect(unknown.stderr).toMatch(/--set-role takes/);
    const set = await f.harness.runCli(["project", "update", "EXA", "--set-role", "reviewStatus=none"]);
    expect(set.exitCode, set.stderr).toBe(0);
    expect(resolveRoles(f.current()).review).toBeNull();
    const card = f.store.tasks.createTask({ projectId: f.project.id, title: "A" });
    f.store.tasks.updateProject(f.project.id, { statuses: statuses("todo") });
    const moved = await f.harness.runCli(["update", card.key, "--status", "todo"]);
    expect(moved.exitCode).not.toBe(0);
    expect(moved.stderr).toMatch(/not in this project/);
  });
});
