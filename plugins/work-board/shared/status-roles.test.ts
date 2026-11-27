import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_STATUSES } from "./statuses";
import { isClosed, isClosedAsDone, isDoneStatus, isNotStarted, resolveRoles } from "./status-roles";
import { arrayRolesHolding, deletionPlan, rolesPointingTo } from "./status-delete";
import { effectiveInProgressStatus, usableStartTarget } from "./workflow-policy";

const ids = (...list: string[]) => list.map((id) => ({ id, name: id }));
const without = (...removed: string[]) => DEFAULT_TASK_STATUSES.filter((status) => !removed.includes(status.id));

describe("resolveRoles", () => {
  it("gives a default project exactly today's sets", () => {
    const roles = resolveRoles({ statuses: DEFAULT_TASK_STATUSES });
    expect(roles).toMatchObject({
      done: "done", canceled: "canceled", closed: ["done", "canceled"], notStarted: ["backlog", "todo"],
      newCard: "backlog", ready: "todo", inProgress: "in_progress", review: "in_review", early: ["todo", "in_progress"],
      pilot: ["in_progress", "in_review", "in_testing", "bugfix"],
    });
  });

  it("keeps done closed for a project with a custom done status that still lists done", () => {
    const project = { statuses: ids("backlog", "shipped", "done", "canceled"), workflowPolicy: { doneStatus: "shipped" } };
    expect(resolveRoles(project).closed.sort()).toEqual(["canceled", "done", "shipped"]);
    expect(isDoneStatus(project, "done")).toBe(false);
    expect(isClosedAsDone(project, "shipped")).toBe(true);
    expect(isClosedAsDone(project, "canceled")).toBe(false);
  });

  it("filters the defaults by the listed statuses and falls back for the new card", () => {
    const noTodo = resolveRoles({ statuses: without("todo") });
    expect(noTodo.notStarted).toEqual(["backlog"]);
    expect(noTodo.ready).toBe("backlog");
    expect(noTodo.early).toEqual(["in_progress"]);
    const noBacklog = resolveRoles({ statuses: without("backlog") });
    expect(noBacklog.newCard).toBe("todo");
    const first = resolveRoles({ statuses: ids("a", "b") });
    expect(first).toMatchObject({ newCard: "a", ready: "a", done: null, canceled: null, closed: [], review: null, inProgress: "in_progress" });
  });

  it("treats omitted, explicit null and explicit empty differently", () => {
    const statuses = DEFAULT_TASK_STATUSES;
    expect(resolveRoles({ statuses, workflowPolicy: { doneStatus: null } }).done).toBeNull();
    // explicit null done: the default closed pair is still closed
    expect(resolveRoles({ statuses, workflowPolicy: { doneStatus: null } }).closed).toEqual(["done", "canceled"]);
    expect(resolveRoles({ statuses, workflowPolicy: { earlyStatuses: [] } }).early).toEqual([]);
    expect(resolveRoles({ statuses, workflowPolicy: { reviewStatus: "gone" } }).review).toBeNull();
    // an explicit closed array without done still closes the done role
    const project = { statuses, workflowPolicy: { closedStatuses: ["canceled"] } };
    expect(resolveRoles(project).closed.sort()).toEqual(["canceled", "done"]);
    expect(resolveRoles({ statuses, workflowPolicy: { closedStatuses: ["canceled"], doneStatus: null } }).closed).toEqual(["canceled"]);
  });

  it("keeps the pilot default exactly four ids, whatever the other roles say", () => {
    const project = { statuses: ids("a", "b"), workflowPolicy: { inProgressStatus: "a", reviewStatus: null } };
    expect(resolveRoles(project).pilot).toEqual(["in_progress", "in_review", "in_testing", "bugfix"]);
    expect(resolveRoles({ statuses: ids("a", "b"), workflowPolicy: { pilotStatuses: ["a", "gone"] } }).pilot).toEqual(["a"]);
  });

  it("resolves inProgress in three cases", () => {
    expect(effectiveInProgressStatus({ statuses: DEFAULT_TASK_STATUSES, workflowPolicy: { inProgressStatus: null } })).toBe("in_progress");
    expect(effectiveInProgressStatus({ statuses: without("in_progress"), workflowPolicy: { inProgressStatus: null } })).toBeNull();
    const custom = { statuses: DEFAULT_TASK_STATUSES, workflowPolicy: { inProgressStatus: "unlisted" } };
    expect(effectiveInProgressStatus(custom)).toBe("unlisted");
    expect(usableStartTarget(custom, "backlog")).toBeNull();
  });

  it("does not filter a project that carries no status list", () => {
    const project = { workflowPolicy: { doneStatus: "shipped" } };
    expect(isClosed(project, "shipped")).toBe(true);
    expect(isNotStarted({}, "todo")).toBe(true);
  });
});

describe("status deletion helpers", () => {
  it("finds the single roles pointing at a status, explicitly or by default", () => {
    expect(rolesPointingTo({}, "done")).toEqual(["doneStatus"]);
    expect(rolesPointingTo({}, "canceled")).toEqual(["canceledStatus"]);
    expect(rolesPointingTo({}, "todo")).toEqual([]);
    expect(rolesPointingTo({ workflowPolicy: { readyStatus: "todo", newCardStatus: "backlog" } }, "todo")).toEqual(["readyStatus"]);
    expect(rolesPointingTo({ workflowPolicy: { inProgressStatus: null } }, "in_progress")).toEqual([]);
  });

  it("names the array roles that drop a status and counts cards", () => {
    expect(arrayRolesHolding({}, "todo")).toEqual(["earlyStatuses"]);
    expect(arrayRolesHolding({ workflowPolicy: { notStartedStatuses: ["todo"] } }, "todo").sort()).toEqual(["earlyStatuses", "notStartedStatuses"]);
    expect(deletionPlan({}, "todo", { cards: 3, archived: 1 })).toMatchObject({ cards: 3, archived: 1, roles: [], arrays: ["earlyStatuses"] });
  });
});
