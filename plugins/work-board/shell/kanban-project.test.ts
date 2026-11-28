import { describe, expect, it } from "vitest";
import { mergeKanbanChoice, resolveKanbanProject, type KanbanChoice } from "./kanban-project.js";
import type { TasksRoute } from "./routes.js";

const projects = [{ id: "pa", prefix: "AAA" }, { id: "pb", prefix: "BBB" }, { id: "pc", prefix: "CCC" }];
const all: TasksRoute = { kind: "all" };
const project = (projectId: string): TasksRoute => ({ kind: "project", projectId, view: null });
const task = (taskKey: string): TasksRoute => ({ kind: "task", taskKey } as TasksRoute);
const run = (route: TasksRoute, stored: KanbanChoice | null, last: string | null = null, list: typeof projects | undefined = projects) => resolveKanbanProject({ route, stored, last, projects: list });
// Applies the write the way the panel does, so a sequence of routes reads as the panel's life.
const step = (state: KanbanChoice | null, route: TasksRoute, last: string | null = null) => {
  const result = run(route, state, last);
  return { state: result.next ?? state, shown: result.shown?.id };
};

describe("kanban panel project", () => {
  it("follows the main area when its project changes", () => {
    expect(run(project("pb"), { projectId: "pa", followed: "pa" })).toMatchObject({ shown: { id: "pb" }, next: { projectId: "pb", followed: "pb" } });
  });
  it("keeps a pick while the main area's project stays the same", () => {
    expect(run(project("pa"), { projectId: "pb", followed: "pa" })).toMatchObject({ shown: { id: "pb" }, next: null });
  });
  it("A, pick B, All, A restores A", () => {
    let s = step(null, project("pa"));
    expect(s.shown).toBe("pa");
    s = { state: { projectId: "pb", followed: "pa" }, shown: "pb" };
    s = step(s.state, all);
    expect(s).toEqual({ state: { projectId: "pb", followed: null }, shown: "pb" });
    s = step(s.state, project("pa"));
    expect(s).toEqual({ state: { projectId: "pa", followed: "pa" }, shown: "pa" });
  });
  it("A, All unmounted, B shows B on mount", () => {
    expect(step({ projectId: "pa", followed: "pa" }, project("pb")).shown).toBe("pb");
  });
  it("documents the limit: an unseen A, All, A round trip keeps the pick", () => {
    expect(run(project("pa"), { projectId: "pb", followed: "pa" })).toMatchObject({ shown: { id: "pb" }, next: null });
  });
  it("skips a stored project that no longer exists", () => {
    expect(run(all, { projectId: "gone", followed: null }, "pc").shown?.id).toBe("pc");
    expect(run(project("pa"), { projectId: "gone", followed: "pa" }).shown?.id).toBe("pa");
  });
  it("stores the shown fallback, not a deleted id, when the main area leaves for a cross-project view", () => {
    expect(run(all, { projectId: "gone", followed: "pa" }, "pc")).toMatchObject({ shown: { id: "pc" }, next: { projectId: "pc", followed: null } });
    expect(run(all, { projectId: "gone", followed: "pa" }, null)).toMatchObject({ shown: { id: "pa" }, next: { projectId: "pa", followed: null } });
    expect(run(all, { projectId: "pb", followed: "pa" }, "pc")).toMatchObject({ shown: { id: "pb" }, next: { projectId: "pb", followed: null } });
  });
  it("treats a deleted followed project as a plain mismatch", () => {
    expect(run(project("pa"), { projectId: "pb", followed: "gone" })).toMatchObject({ shown: { id: "pa" }, next: { projectId: "pa", followed: "pa" } });
  });
  it("counts an unknown project route or task prefix as a cross-project view", () => {
    expect(run(project("gone"), null, "pc").shown?.id).toBe("pc");
    expect(run(task("ZZZ-1"), null, "pc").shown?.id).toBe("pc");
    expect(run(task("ZZZ-1"), null, null).shown?.id).toBe("pa");
    expect(run(task("ccc-4"), null, "pa").shown?.id).toBe("pc");
  });
  it("starts from the last project on a cross-project view without writing", () => {
    expect(run(all, null, "pb")).toMatchObject({ shown: { id: "pb" }, next: null });
  });
  it("neither resolves nor writes while projects load or when there are none", () => {
    expect(resolveKanbanProject({ route: project("pa"), stored: { projectId: "pb", followed: "pb" }, last: null, projects: undefined })).toEqual({ shown: null, next: null, main: null });
    expect(run(project("pa"), null, null, [])).toEqual({ shown: null, next: null, main: null });
  });
});

describe("kanban panel stored value merge", () => {
  const open = { kind: "task" as const, taskKey: "AAA-1" };
  it("keeps open on a follow or pick write", () => {
    expect(mergeKanbanChoice({ projectId: "pa", followed: "pa", open }, { projectId: "pb", followed: "pb" })).toEqual({ projectId: "pb", followed: "pb", open });
    expect(mergeKanbanChoice({ projectId: "pa", followed: "pa", open }, { projectId: "pb", followed: null })).toEqual({ projectId: "pb", followed: null, open });
  });
  it("keeps projectId and followed on an open or back write", () => {
    expect(mergeKanbanChoice({ projectId: "pb", followed: "pa" }, { open })).toEqual({ projectId: "pb", followed: "pa", open });
    expect(mergeKanbanChoice({ projectId: "pb", followed: "pa", open }, { open: null })).toEqual({ projectId: "pb", followed: "pa" });
    expect(mergeKanbanChoice({ projectId: "pb", followed: "pa", open }, { open: { kind: "plan", taskKey: "AAA-1" } })).toEqual({ projectId: "pb", followed: "pa", open: { kind: "plan", taskKey: "AAA-1" } });
  });
  it("starts from nothing stored, and a project write can close the open task", () => {
    expect(mergeKanbanChoice(null, { open })).toEqual({ projectId: null, followed: null, open });
    expect(mergeKanbanChoice({ projectId: "pa", followed: "pa", open }, { projectId: "pb", followed: "pa", open: null })).toEqual({ projectId: "pb", followed: "pa" });
  });
  it("is unaffected by an open task in what the panel resolves", () => {
    const stored = { projectId: "pb", followed: "pa", open } as KanbanChoice;
    expect(run(project("pa"), stored)).toMatchObject({ shown: { id: "pb" }, next: null });
    expect(run(project("pc"), stored)).toMatchObject({ shown: { id: "pc" }, next: { projectId: "pc", followed: "pc" } });
  });
});
