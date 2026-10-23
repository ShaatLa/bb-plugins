import { describe, expect, it } from "vitest";
import { startupRoute } from "./startup-route";

const projects = [{ id: "first" }, { id: "last" }];

describe("default task screen", () => {
  it("defaults to the last project's kanban and falls back to an existing project", () => {
    expect(startupRoute(undefined, projects, "last")).toEqual({ kind: "project", projectId: "last", view: "board" });
    expect(startupRoute("last-project-board", projects, "deleted")).toEqual({ kind: "project", projectId: "first", view: "board" });
    expect(startupRoute("unknown", projects, null)).toEqual({ kind: "project", projectId: "first", view: "board" });
    expect(startupRoute(undefined, [], "deleted")).toEqual({ kind: "all" });
  });

  it("respects each alternate start screen", () => {
    expect(startupRoute("last-project-list", projects, "last")).toEqual({ kind: "project", projectId: "last", view: "list" });
    expect(startupRoute("all", projects, "last")).toEqual({ kind: "all" });
    expect(startupRoute("active", projects, "last")).toEqual({ kind: "active" });
  });
});
