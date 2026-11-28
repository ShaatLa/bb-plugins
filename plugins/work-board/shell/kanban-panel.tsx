import { useEffect, useState } from "react";
import { TaskStatusesProvider } from "./task-statuses.js";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { BoardView } from "../views/board/index.js";
import { useProjects } from "./data.js";
import { TasksRefreshProvider } from "./refresh.js";
import { parseTasksRoute } from "./routes.js";
import { loadKanbanChoice, loadLastProjectId, storeKanbanChoice } from "./view-preference.js";
import { resolveKanbanProject, type KanbanChoice } from "./kanban-project.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { DialogScope } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { LockChips } from "../components/lock-chips.js";
import { QueueMenu } from "../components/queue-menu.js";
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
  const [choice, setChoice] = useState<KanbanChoice | null>(loadKanbanChoice);
  const { shown: project, next, main } = resolveKanbanProject({ route: parseTasksRoute(subPath), stored: choice, last: projects.data ? loadLastProjectId() : null, projects: projects.data });
  // The panel follows the main area when its project changes; the write waits for the effect, the render already shows it.
  useEffect(() => {
    if (!next) return;
    setChoice(next);
    storeKanbanChoice(next);
  }, [next?.projectId, next?.followed]);
  const pick = (projectId: string) => {
    const picked = { projectId, followed: main?.id ?? null };
    setChoice(picked);
    storeKanbanChoice(picked);
  };

  if (projects.error) {
    return <div className="space-y-3 p-4 text-sm"><p role="alert">{projects.error}</p><Button variant="outline" onClick={projects.refresh}>Retry</Button></div>;
  }
  if (!project) {
    return <p role="status" className="p-4 text-sm text-muted-foreground">{projects.data === undefined ? "Loading projects…" : "Create a project to open its kanban board."}</p>;
  }
  return (
    <section aria-label="Project kanban" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-hairline px-4 py-2 text-sm font-medium"><DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Board project" className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 font-medium hover:bg-state-hover">
            <span aria-hidden className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: project.color }} />
            <span className="truncate">{project.name}</span>
            <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          {projects.data?.map((item) => (
            <DropdownMenuItem key={item.id} disabled={item.id === project.id} onSelect={() => pick(item.id)}>
              <span aria-hidden className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
              <span className="truncate">{item.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu><ManagerQuickSet projectId={project.id} className="ml-6" /><QueueMenu projectId={project.id} /><span aria-hidden className="ml-auto" /><LockChips projectId={project.id} /></header>
      <div className="min-h-0 flex-1"><BoardView key={project.id} projectId={project.id} /></div>
    </section>
  );
}

export function KanbanPanel(props: PluginNavPanelProps) {
  return <DialogScope className="relative h-full min-h-0"><TasksRefreshProvider><TaskStatusesProvider><KanbanPanelContent {...props} /></TaskStatusesProvider></TasksRefreshProvider></DialogScope>;
}
