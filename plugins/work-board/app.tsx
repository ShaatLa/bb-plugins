import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TasksSettings } from "./views/settings.js";
import { TasksAppShell } from "./shell/app-shell.js";
import { useOpenTasksBadge } from "./shell/open-tasks-badge.js";
import { TasksNavigationPanel } from "./shell/navigation-panel.js";
import { KanbanPanel, KANBAN_TAB } from "./shell/kanban-panel.js";
import { TASK_TAB, TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";
import { useTaskLinkInterception } from "./components/task-link-interceptor.js";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "settings",
    title: "Work Board",
    description: "Projects, workflows and GitHub synchronization for work shared by people and AI agents.",
    component: TasksSettings,
  });
  app.slots.navPanel({
    id: "work-board",
    title: "Work Board",
    icon: "ListTodo",
    path: "work-board",
    component: TasksAppShell,
    experimental_useBadge: useOpenTasksBadge,
  });
  // Tab ids stay "navigation", "kanban" and "task" so saved panel layouts survive.
  app.slots.experimental_tab({
    context: { kind: "nav-panel", panelId: "work-board" },
    availability: "fixed",
    id: "navigation",
    title: "Navigation",
    icon: "ListTodo",
    component: TasksNavigationPanel,
    layout: "flush",
  });
  app.slots.experimental_tab({
    ...KANBAN_TAB,
    title: "Kanban",
    icon: "Columns2",
    component: KanbanPanel,
    layout: "flush",
  });
  app.slots.experimental_tab({
    ...TASK_TAB,
    title: "Work Board",
    icon: "ListTodo",
    component: TaskEmbedPanel,
    layout: "flush",
  });
  // Never shown: its useVisible hook hosts the chat task-link click handler inside each thread.
  app.slots.experimental_threadContextSegment({
    id: "task-links",
    title: "Work Board task links",
    group: "9_work-board",
    summary: () => null,
    useVisible: useTaskLinkInterception,
  });
  app.slots.messageDirective({ id: "task", component: TaskDirectiveCard });
});
