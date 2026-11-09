import { createContext, useContext, useMemo } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { storeLastProjectId } from "./view-preference.js";

export const PANEL_PATH = "work-board";

export type TaskViewMode = "list" | "board";

export const SCHEDULED_TABS = ["all", "attention", "results", "history"] as const;
export type ScheduledTab = (typeof SCHEDULED_TABS)[number];

export type TasksRoute =
  | { kind: "all" }
  | { kind: "active" }
  | { kind: "archive" }
  | { kind: "manage" }
  | { kind: "scheduled"; tab: ScheduledTab }
  | { kind: "project"; projectId: string; view: TaskViewMode | null }
  | { kind: "task"; taskKey: string };

export type ResolvedTasksRoute =
  | Exclude<TasksRoute, { kind: "project" }>
  | { kind: "project"; projectId: string; view: TaskViewMode };

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseTasksRoute(rawSubPath: string): TasksRoute {
  const subPath = rawSubPath.split("/").map(decodeSegment).join("/");
  const queryIndex = subPath.indexOf("?");
  const path = queryIndex === -1 ? subPath : subPath.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : subPath.slice(queryIndex + 1);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const head = segments[0];
  if (head === undefined || head === "all") return { kind: "all" };
  if (head === "archive") return { kind: "archive" };
  if (head === "active") return { kind: "active" };
  if (head === "manage") return { kind: "manage" };
  if (head === "scheduled") {
    const tab = new URLSearchParams(query).get("tab");
    return { kind: "scheduled", tab: SCHEDULED_TABS.find((candidate) => candidate === tab) ?? "all" };
  }
  if (head === "task") {
    const taskKey = segments[1];
    if (taskKey !== undefined) return { kind: "task", taskKey };
    return { kind: "all" };
  }
  const view = new URLSearchParams(query).get("view");
  return {
    kind: "project",
    projectId: head,
    view: view === "board" || view === "list" ? view : null,
  };
}

export function tasksRouteToSubPath(route: TasksRoute): string {
  switch (route.kind) {
    case "all":
      return "all";
    case "archive":
      return "archive";
    case "active":
      return "active";
    case "manage":
      return "manage";
    case "scheduled":
      return route.tab === "all" ? "scheduled" : `scheduled?tab=${route.tab}`;
    case "task":
      return `task/${route.taskKey}`;
    case "project":
      return route.view === null
        ? route.projectId
        : `${route.projectId}?view=${route.view}`;
  }
}

export interface TasksNavigation {
  go: (route: TasksRoute, options?: { replace?: boolean }) => void;
}

export const TasksNavigationContext = createContext<TasksNavigation | null>(null);

export function useTasksNavigation(): TasksNavigation {
  const navigate = useBbNavigate();
  const localNavigation = useContext(TasksNavigationContext);
  return useMemo(
    () => localNavigation ?? ({
      go: (route, options) => {
        if (route.kind === "project") storeLastProjectId(route.projectId);
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: tasksRouteToSubPath(route),
          ...(options?.replace ? { replace: true } : {}),
        });
      },
    }),
    [navigate, localNavigation],
  );
}
