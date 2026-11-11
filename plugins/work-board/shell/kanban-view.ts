import { useCallback } from "react";
import {
  experimental_useAppPanel,
  experimental_usePanelTabs,
  experimental_usePluginId,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Project } from "../shared/contract.js";
import { KANBAN_TAB } from "./kanban-panel.js";
import type { TasksRoute } from "./routes.js";

export const PANEL_ID = KANBAN_TAB.context.panelId;
const NAVIGATION_TAB_ID = "navigation";

export function projectForRoute(
  route: TasksRoute,
  projects: readonly Project[] | undefined,
): Project | null {
  if (route.kind === "project") return projects?.find((p) => p.id === route.projectId) ?? null;
  if (route.kind === "task") {
    const prefix = route.taskKey.split("-", 1)[0] ?? "";
    return projects?.find((p) => p.prefix === prefix) ?? null;
  }
  return null;
}

/**
 * The native right panel is the only source of truth for "Board": it is active
 * exactly when the panel is showing and the Kanban tab is selected. Derived on
 * every render from the live tab list, never stored.
 */
export function useKanbanPanel() {
  const pluginId = experimental_usePluginId();
  const panel = experimental_useAppPanel();
  const { open, selectedKey, tabs } = experimental_usePanelTabs();
  const own = (id: string) =>
    tabs.find(
      ({ detail }) =>
        detail.kind === "plugin" &&
        detail.pluginId === pluginId &&
        detail.tab.id === id &&
        detail.tab.context.kind === "nav-panel" &&
        detail.tab.context.panelId === PANEL_ID,
    );
  const kanbanKey = own(KANBAN_TAB.id)?.key;
  const navigationKey = own(NAVIGATION_TAB_ID)?.key;
  const active = open && kanbanKey !== undefined && selectedKey === kanbanKey;

  const show = useCallback((): boolean => {
    if (panel.openTab({ tab: KANBAN_TAB })) return true;
    toast.error("Could not open the kanban panel");
    return false;
  }, [panel]);

  // Prefer the Navigation tab; hide the panel only when it is not available.
  const hide = useCallback((): boolean => {
    const left =
      navigationKey !== undefined ? panel.selectTab(navigationKey) : panel.close();
    if (!left) toast.error("Could not leave the kanban panel");
    return left;
  }, [panel, navigationKey]);

  return { active, show, hide };
}
