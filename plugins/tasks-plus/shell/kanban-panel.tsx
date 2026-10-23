import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { BoardView } from "../views/board/index.js";
import { useProjects } from "./data.js";
import { TasksRefreshProvider } from "./refresh.js";
import { parseTasksRoute } from "./routes.js";
import { loadLastProjectId } from "./view-preference.js";
import { Button } from "@/components/ui/button";

export const KANBAN_TAB = { panelId: "tasks", id: "kanban" } as const;

function KanbanPanelContent({ subPath }: PluginNavPanelProps) {
  const projects = useProjects();
  const route = parseTasksRoute(subPath);
  const project = projects.data?.find((project) =>
    route.kind === "project" ? project.id === route.projectId :
    route.kind === "task" ? project.prefix === route.taskKey.split("-", 1)[0]?.toUpperCase() :
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
      <header className="shrink-0 truncate border-b border-border-hairline px-4 py-2 text-sm font-medium">{project.name}</header>
      <div className="min-h-0 flex-1"><BoardView key={project.id} projectId={project.id} /></div>
    </section>
  );
}

export function KanbanPanel(props: PluginNavPanelProps) {
  return <TasksRefreshProvider><KanbanPanelContent {...props} /></TasksRefreshProvider>;
}
