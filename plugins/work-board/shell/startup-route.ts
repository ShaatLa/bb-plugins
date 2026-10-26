import type { ResolvedTasksRoute } from "./routes.js";

export function startupRoute(
  screen: unknown,
  projects: readonly { id: string }[],
  lastProjectId: string | null,
): ResolvedTasksRoute {
  if (screen === "all" || screen === "active") return { kind: screen };
  const project = projects.find(({ id }) => id === lastProjectId) ?? projects[0];
  if (!project) return { kind: "all" };
  return {
    kind: "project",
    projectId: project.id,
    view: screen === "last-project-list" ? "list" : "board",
  };
}
