import { definePluginApp, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { TasksAppShell } from "./shell/app-shell.js";
import { TasksSidebarAccessory } from "./shell/sidebar-accessory.js";
import { TasksNavigationPanel } from "./shell/navigation-panel.js";
import { KanbanPanel, KANBAN_TAB } from "./shell/kanban-panel.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";

function TasksSettings() {
  const navigate = useBbNavigate();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Send tasks to existing threads from the task card. Busy threads receive the task in their queue using their current settings.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => navigate.toPluginPanel("tasks")}>Open Tasks</Button>
        <Button variant="outline" onClick={() => navigate.toPluginPanel("tasks", { subPath: "manage" })}>Manage projects and presets</Button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "Tasks Plus",
    description: "Task tracking and delegation to existing threads.",
    component: TasksSettings,
  });
  app.slots.navPanel({
    id: "tasks",
    title: "Tasks Plus",
    icon: "ListTodo",
    path: "tasks",
    component: TasksAppShell,
    experimental_sidebarAccessory: TasksSidebarAccessory,
    fixedTabs: [
      {
        panelId: "tasks",
        id: "navigation",
        title: "Navigation",
        icon: "ListTodo",
        component: TasksNavigationPanel,
        layout: "flush",
      },
      {
        ...KANBAN_TAB,
        title: "Kanban",
        icon: "Columns2",
        component: KanbanPanel,
        layout: "flush",
      },
    ],
  });
  app.slots.threadPanelAction({
    id: "task",
    title: "Task",
    icon: "ListTodo",
    component: TaskEmbedPanel,
    layout: "flush",
  });
  app.slots.messageDirective({ id: "task", component: TaskDirectiveCard });
});
