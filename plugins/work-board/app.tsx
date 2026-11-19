import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TasksSettings } from "./views/settings.js";
import { TasksAppShell } from "./shell/app-shell.js";
import { useOpenTasksBadge } from "./shell/open-tasks-badge.js";
import { TasksNavigationPanel } from "./shell/navigation-panel.js";
import { KanbanGlyph, KanbanPanel, KANBAN_ICON, KANBAN_TAB } from "./shell/kanban-panel.js";
import { TASK_TAB, TaskDirectiveCard, TaskEmbedPanel } from "./views/embed/index.js";
import { WorkBoardHosts } from "./views/embed/hosts.js";
import { useTaskLinkInterception } from "./components/task-link-interceptor.js";
import { StatusGlyph } from "./components/status-icon.js";
import { STATUS_ICONS, STATUS_ICON_NAME_PREFIX } from "./shared/statuses.js";

export default definePluginApp((app) => {
  // Other plugins draw status glyphs by name; threadTasks returns the name and color.
  for (const { id } of STATUS_ICONS)
    app.experimental_icons.register({ name: STATUS_ICON_NAME_PREFIX + id, component: ({ className }) => <StatusGlyph glyph={id} className={className} /> });
  app.experimental_icons.register({ name: KANBAN_ICON, component: KanbanGlyph });
  app.slots.settingsSection({
    id: "settings",
    title: "Work Board",
    description: "Projects, workflows and GitHub synchronization for work shared by people and AI agents.",
    component: TasksSettings,
  });
  app.slots.navPanel({
    id: "work-board",
    title: "Work Board",
    icon: KANBAN_ICON,
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
    icon: KANBAN_ICON,
    component: KanbanPanel,
    layout: "flush",
  });
  app.slots.experimental_tab({
    ...TASK_TAB,
    title: "Work Board",
    icon: KANBAN_ICON,
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
  app.slots.experimental_appOverlay({ id: "board-hosts", component: WorkBoardHosts });
});
