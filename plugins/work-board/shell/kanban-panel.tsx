import { TaskStatusesProvider } from "./task-statuses.js";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { BoardView } from "../views/board/index.js";
import { useProjects } from "./data.js";
import { TasksRefreshProvider } from "./refresh.js";
import { parseTasksRoute } from "./routes.js";
import { loadLastProjectId } from "./view-preference.js";
import { DialogScope } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LockChips } from "../components/lock-chips.js";
import { ManagerQuickSet } from "../components/manager-quick-set.js";
import { cn } from "@/lib/utils";

/** Shared app icon of a kanban board: three column headers with cards stacked under them. */
export const KANBAN_ICON = "work-board/kanban";
export function KanbanGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn("size-4 shrink-0", className)}>
      <path d="M3 3.75H7.5M9.75 3.75H14.25M16.5 3.75H21" />
      <rect x="3" y="7" width="4.5" height="5" rx="1.25" />
      <rect x="3" y="14.5" width="4.5" height="5" rx="1.25" />
      <rect x="9.75" y="7" width="4.5" height="5" rx="1.25" />
      <rect x="16.5" y="7" width="4.5" height="5" rx="1.25" />
      <rect x="16.5" y="14.5" width="4.5" height="5" rx="1.25" />
    </svg>
  );
}

export const KANBAN_TAB = {
  id: "kanban",
  context: { kind: "nav-panel", panelId: "work-board" },
  availability: "fixed",
} as const;

function KanbanPanelContent({ subPath }: PluginNavPanelProps) {
  const projects = useProjects();
  const route = parseTasksRoute(subPath);
  const project = projects.data?.find((project) =>
    route.kind === "project" ? project.id === route.projectId :
    route.kind === "task" || route.kind === "plan" ? project.prefix === route.taskKey.split("-", 1)[0]?.toUpperCase() :
    project.id === loadLastProjectId(),
  ) ?? projects.data?.[0];

  if (projects.error) {
    return <div className="space-y-3 p-4 text-sm"><p role="alert">{projects.error}</p><Button variant="outline" onClick={projects.refresh}>Retry</Button></div>;
  }
  if (!project) {
    return <p role="status" className="p-4 text-sm text-muted-foreground">{projects.data === undefined ? "Loading projects…" : "Create a project to open its kanban board."}</p>;
  }
  return (
    <section aria-label="Project kanban" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-4 py-2 text-sm font-medium"><span className="min-w-0 truncate">{project.name}</span><ManagerQuickSet projectId={project.id} className="ml-6" /><span aria-hidden className="ml-auto" /><LockChips projectId={project.id} /></header>
      <div className="min-h-0 flex-1"><BoardView key={project.id} projectId={project.id} /></div>
    </section>
  );
}

export function KanbanPanel(props: PluginNavPanelProps) {
  return <DialogScope className="relative h-full min-h-0"><TasksRefreshProvider><TaskStatusesProvider><KanbanPanelContent {...props} /></TaskStatusesProvider></TasksRefreshProvider></DialogScope>;
}
