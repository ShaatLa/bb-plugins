import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TasksSettings } from "./views/settings.js";
import { TasksAppShell } from "./shell/app-shell.js";
import { TasksSidebarAccessory } from "./shell/sidebar-accessory.js";
import { TasksNavigationPanel } from "./shell/navigation-panel.js";
import { KanbanPanel, KANBAN_TAB } from "./shell/kanban-panel.js";
import { TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "Agent Board",
    description: "Projects, workflows and GitHub synchronization for work shared by people and AI agents.",
    component: TasksSettings,
  });
  app.slots.navPanel({
    id: "agent-board",
    title: "Agent Board",
    icon: "ListTodo",
    path: "agent-board",
    component: TasksAppShell,
    experimental_sidebarAccessory: TasksSidebarAccessory,
    fixedTabs: [
      {
        panelId: "agent-board",
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
