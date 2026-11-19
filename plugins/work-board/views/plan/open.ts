import { useCallback } from "react";
import { experimental_useAppPanel, type ExperimentalPanelController } from "@get-bb/plugin-sdk/app";
import { useTasksNavigation } from "../../shell/routes.js";

/** The Plan tab is one action tab registered in two contexts; one instance is opened per task. */
export const PLAN_TAB_ID = "plan";
export const PLAN_THREAD_TAB = { id: PLAN_TAB_ID, context: { kind: "thread" }, availability: "action" } as const;
export const PLAN_NAV_TAB = { id: PLAN_TAB_ID, context: { kind: "nav-panel", panelId: "work-board" }, availability: "action" } as const;

export const planTabTitle = (taskKey: string) => `Plan · ${taskKey}`;

/** Opens the task's plan in whichever of the two Plan tabs the current surface offers; false when it has no side panel. */
export function openPlanTab(panel: Pick<ExperimentalPanelController, "openTab">, taskKey: string): boolean {
  const options = { params: { taskKey }, title: planTabTitle(taskKey) };
  return panel.openTab({ tab: PLAN_THREAD_TAB, ...options }) || panel.openTab({ tab: PLAN_NAV_TAB, ...options });
}

// "Write plan" opens the plan view and asks it to start editing. The view may not exist yet, so the request waits here.
const editRequests = new Set<string>();
const editListeners = new Set<() => void>();

export function requestPlanEdit(taskKey: string) {
  editRequests.add(taskKey);
  for (const listener of [...editListeners]) listener();
}
export function takePlanEditRequest(taskKey: string): boolean {
  return editRequests.delete(taskKey);
}
export function subscribePlanEditRequests(listener: () => void): () => void {
  editListeners.add(listener);
  return () => void editListeners.delete(listener);
}

/** Opens a task's plan in the side panel, or in the main area when there is no side panel. */
export function useOpenPlan(): (taskKey: string, options?: { edit?: boolean }) => void {
  const panel = experimental_useAppPanel();
  const navigation = useTasksNavigation();
  return useCallback((taskKey, options) => {
    if (options?.edit) requestPlanEdit(taskKey);
    if (!openPlanTab(panel, taskKey)) navigation.go({ kind: "plan", taskKey });
  }, [panel, navigation]);
}
