import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { Task } from "../shared/contract.js";
import { waitingOnOwner } from "../shared/waiting-on-owner.js";
import type { Project } from "../shared/contract.js";
import {
  DEFAULT_TASK_STATUSES,
  statusLabel,
  type TaskStatusDefinition,
} from "../shared/statuses.js";
import { resolveRoles } from "../shared/status-roles.js";
import { useProjects } from "./data.js";

const TaskStatusesContext = createContext<readonly Project[]>([]);

export function TaskStatusesProvider({ children }: { children: ReactNode }) {
  const projects = useProjects();
  return (
    <TaskStatusesContext.Provider value={projects.data ?? []}>
      {children}
    </TaskStatusesContext.Provider>
  );
}

/** `waitingOnOwner` for a card of any project: a card closed in its own project's workflow is not waited on. */
export function useWaitingOnOwner(): (task: Task, unanswered: number) => boolean {
  const projects = useContext(TaskStatusesContext);
  return useCallback(
    (task, unanswered) => waitingOnOwner(task, unanswered, resolveRoles(projects.find((project) => project.id === task.projectId) ?? {}).closed),
    [projects],
  );
}

/** The project list the shell already keeps current; closed dialogs read it instead of running their own query. */
export function useProjectList(): readonly Project[] {
  return useContext(TaskStatusesContext);
}

export function useTaskStatuses(projectId?: string | null) {
  const projects = useContext(TaskStatusesContext);
  return useMemo(() => {
    const projectStatuses = (id?: string | null) =>
      projects.find((project) => project.id === id)?.statuses ??
      DEFAULT_TASK_STATUSES;
    const statuses: TaskStatusDefinition[] = projectId
      ? projectStatuses(projectId)
      : [...DEFAULT_TASK_STATUSES];
    if (!projectId) {
      // A status only some project has goes before the first status any project closes in, else at the end.
      const closed = new Set(projects.flatMap((project) => resolveRoles(project).closed));
      for (const project of projects)
        for (const status of project.statuses ?? []) {
          if (!statuses.some((entry) => entry.id === status.id)) {
            const at = statuses.findIndex((entry) => closed.has(entry.id));
            statuses.splice(at < 0 ? statuses.length : at, 0, status);
          }
        }
    }
    return {
      color: (status: string) => statuses.find((entry) => entry.id === status)?.color,
      icon: (status: string) => statuses.find((entry) => entry.id === status)?.icon,
      prefix: projects.find((project) => project.id === projectId)?.prefix ?? null,
      /** The project's workflow roles (its done, new-card and ready statuses and so on); the standard ones for no project. */
      roles: resolveRoles(projects.find((project) => project.id === projectId) ?? {}),
      statuses,
      ids: statuses.map((status) => status.id),
      label: (status: string, id = projectId) =>
        statusLabel(status, id ? projectStatuses(id) : statuses),
    };
  }, [projects, projectId]);
}
