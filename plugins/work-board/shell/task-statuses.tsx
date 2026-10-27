import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Project } from "../shared/contract.js";
import {
  DEFAULT_TASK_STATUSES,
  statusLabel,
  type TaskStatusDefinition,
} from "../shared/statuses.js";
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
      for (const project of projects)
        for (const status of project.statuses ?? []) {
          if (!statuses.some((entry) => entry.id === status.id))
            statuses.splice(
              Math.max(
                0,
                statuses.findIndex((entry) => entry.id === "done"),
              ),
              0,
              status,
            );
        }
    }
    return {
      prefix: projects.find((project) => project.id === projectId)?.prefix ?? null,
      statuses,
      ids: statuses.map((status) => status.id),
      label: (status: string, id = projectId) =>
        statusLabel(status, id ? projectStatuses(id) : statuses),
    };
  }, [projects, projectId]);
}
