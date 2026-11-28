import type { TasksRoute } from "./routes.js";

/** What the right Kanban panel remembers: the project it shows and the main area's project as it last saw it. */
export interface KanbanChoice {
  projectId: string | null;
  followed: string | null;
}

interface Input<P extends { id: string; prefix: string }> {
  route: TasksRoute;
  stored: KanbanChoice | null;
  last: string | null;
  projects: readonly P[] | undefined;
}

/** The project the main area shows: a project route, or the project of a task or plan key. Null on cross-project views and unknown projects. */
export function mainAreaProject<P extends { id: string; prefix: string }>(route: TasksRoute, projects: readonly P[]): P | null {
  if (route.kind === "project") return projects.find((project) => project.id === route.projectId) ?? null;
  if (route.kind === "task" || route.kind === "plan") {
    const prefix = route.taskKey.split("-", 1)[0]?.toUpperCase();
    return projects.find((project) => project.prefix === prefix) ?? null;
  }
  return null;
}

/**
 * The panel follows the main area when its project changes and keeps its own pick otherwise.
 * `next` is the value to store (null when nothing changes); nothing is resolved while projects load.
 */
export function resolveKanbanProject<P extends { id: string; prefix: string }>({ route, stored, last, projects }: Input<P>): { shown: P | null; next: KanbanChoice | null; main: P | null } {
  if (!projects?.length) return { shown: null, next: null, main: null };
  const main = mainAreaProject(route, projects);
  const mainId = main?.id ?? null;
  const byId = (id: string | null | undefined) => (id ? projects.find((project) => project.id === id) ?? null : null);
  const changed = (stored?.followed ?? null) !== mainId;
  // A changed main project wins; otherwise the stored pick, then the fallbacks. A write stores what is shown, never a deleted id.
  const shown = (changed ? main : null) ?? byId(stored?.projectId) ?? main ?? byId(last) ?? projects[0] ?? null;
  const next: KanbanChoice | null = changed && shown ? { projectId: shown.id, followed: mainId } : null;
  return { shown, next, main };
}
