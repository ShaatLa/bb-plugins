import type { Project } from "../shared/contract.js";
import type { TasksRoute } from "./routes.js";

export function projectForRoute(
  route: TasksRoute,
  projects: readonly Project[] | undefined,
): Project | null {
  if (route.kind === "project") return projects?.find((p) => p.id === route.projectId) ?? null;
  if (route.kind === "task" || route.kind === "plan") {
    const prefix = route.taskKey.split("-", 1)[0] ?? "";
    return projects?.find((p) => p.prefix === prefix) ?? null;
  }
  return null;
}
