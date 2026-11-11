import { ScheduledView } from "../views/scheduled/index.js";
import { ArchiveView } from "../views/archive/index";
import { TaskStatusesProvider } from "./task-statuses.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useKanbanPanel, projectForRoute } from "./kanban-view.js";
import type { TaskViewMode } from "./routes.js";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useProjects, useTasksQuery } from "./data.js";
import { DEFAULT_BOARD_PREFERENCES } from "../shared/project-settings";
import {
  parseTasksRoute,
  tasksRouteToSubPath,
  useTasksNavigation,
  type ResolvedTasksRoute,
  type TasksNavigation,
  type TasksRoute,
} from "./routes.js";
import { loadLastProjectId, loadLastRoute, storeLastProjectId, storeLastRoute, loadViewMode, storeViewMode } from "./view-preference.js";
import { startupRoute } from "./startup-route.js";
import { TasksTopbar } from "./topbar.js";
import { ListView } from "../views/list/index.js";
import { DetailView } from "../views/detail/index.js";
import { useTaskScrollResume } from "../views/detail/scroll-resume.js";
import { NewTaskDialog } from "../views/manage/new-task-dialog.js";
import { NewProjectDialog } from "../views/manage/new-project-dialog.js";
import { ManagePanel } from "../views/manage/manage-panel.js";
import { EmptyState } from "../components/empty-state.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { DialogScope } from "@/components/ui/dialog";
import { TasksRefreshProvider } from "./refresh.js";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function hasOpenOverlay(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="menu"], [role="listbox"]',
    ) !== null
  );
}

function RouteOutlet({
  route,
  onBack,
}: {
  route: ResolvedTasksRoute;
  onBack: () => void;
}) {
  switch (route.kind) {
    case "all":
      return <ListView projectId={null} />;
    case "active":
      return <ListView projectId={null} activeOnly />;
    case "manage":
      return <ManagePanel />;
    case "archive":
      return <ArchiveView />;
    case "scheduled":
      return <ScheduledView tab={route.tab} />;
    case "task":
      return <TaskRouteView taskKey={route.taskKey} onBack={onBack} />;
    case "project":
      // The board lives only in the native right panel (one BoardView).
      return <ListView projectId={route.projectId} />;
  }
}

function TaskRouteView({
  taskKey,
  onBack,
}: {
  taskKey: string;
  onBack: () => void;
}) {
  const navigation = useTasksNavigation();
  const onCanonicalKey = useCallback(
    (canonicalKey: string) => {
      if (canonicalKey.toUpperCase() !== taskKey.toUpperCase()) {
        navigation.go(
          { kind: "task", taskKey: canonicalKey },
          { replace: true },
        );
      }
    },
    [navigation, taskKey],
  );
  return (
    <DetailView
      key={taskKey}
      taskKey={taskKey}
      onCanonicalKey={onCanonicalKey}
      onBack={onBack}
    />
  );
}

function resolveRoute(route: TasksRoute): ResolvedTasksRoute {
  if (route.kind !== "project") return route;
  return { ...route, view: route.view ?? loadViewMode(route.projectId) };
}

function TasksAppShellContent({ subPath }: PluginNavPanelProps) {
  const projects = useProjects();
  const isRoot = subPath === "" || subPath === "/";
  const settings = useTasksQuery((rpc) => isRoot ? rpc.call("getBoardPreferences", null) : Promise.resolve(DEFAULT_BOARD_PREFERENCES), ["projects:changed"], [isRoot]);
  const remembered = isRoot ? loadLastRoute() : null;
  const rememberedRoute = remembered ? parseTasksRoute(remembered) : null;
  // A remembered project that was deleted meanwhile falls back to the default screen.
  const resumable = rememberedRoute !== null && (rememberedRoute.kind !== "project" || projects.data?.some(({ id }) => id === rememberedRoute.projectId) === true);
  const opening = isRoot && (projects.data === undefined || (!resumable && projects.data.length > 0 && settings.data === undefined && settings.error === null));
  const route = !isRoot
    ? resolveRoute(parseTasksRoute(subPath))
    : resumable
      ? resolveRoute(rememberedRoute)
      : startupRoute(settings.data?.defaultScreen, projects.data ?? [], loadLastProjectId());
  useEffect(() => {
    if (!isRoot) storeLastRoute(subPath);
  }, [isRoot, subPath]);
  const contentRef = useRef<HTMLDivElement>(null);
  useTaskScrollResume(contentRef, route.kind === "task" && !opening ? route.taskKey : null);
  const tasksNavigation = useTasksNavigation();
  const resolvedSubPath = tasksRouteToSubPath(route);
  useEffect(() => {
    if (isRoot && !opening) {
      tasksNavigation.go(parseTasksRoute(resolvedSubPath), { replace: true });
    }
  }, [isRoot, opening, resolvedSubPath, tasksNavigation]);
  const currentProjectId = route.kind === "project" ? route.projectId : null;
  useEffect(() => {
    if (currentProjectId && projects.data?.some(({ id }) => id === currentProjectId)) {
      storeLastProjectId(currentProjectId);
    }
  }, [currentProjectId, projects.data]);
  const navigation = useMemo<TasksNavigation>(
    () => ({
      go: (target, options) => {
        if (target.kind === "project" && target.view !== null) {
          storeViewMode(target.projectId, target.view);
        }
        tasksNavigation.go(target, options);
      },
    }),
    [tasksNavigation],
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  // Native selectedKey+open decide "Board"; route/local preference is only intent.
  const kanban = useKanbanPanel();
  const viewProject = projectForRoute(route, projects.data);
  const viewProjectId = viewProject?.id ?? null;
  const appliedBoardIntent = useRef<string | null>(null);
  const rememberView = (view: TaskViewMode) => {
    if (viewProjectId === null) return;
    storeViewMode(viewProjectId, view);
    const explicit = parseTasksRoute(subPath);
    if (explicit.kind === "project" && explicit.view !== null && explicit.view !== view) {
      const next: TasksRoute = { kind: "project", projectId: explicit.projectId, view };
      if (view === "board") appliedBoardIntent.current = tasksRouteToSubPath(next);
      tasksNavigation.go(next, { replace: true });
    }
  };
  const changeView = (view: TaskViewMode) => {
    if (view === "board" ? !kanban.active && !kanban.show() : kanban.active && !kanban.hide()) return;
    rememberView(view);
  };
  // A board intent opens the native tab once per navigation; a later external
  // close is never undone by the same (stale) route.
  const boardIntent =
    !isRoot && !opening && route.kind === "project" && route.view === "board" ? resolvedSubPath : null;
  useEffect(() => {
    if (boardIntent === null) {
      appliedBoardIntent.current = null;
      return;
    }
    if (appliedBoardIntent.current === boardIntent) return;
    appliedBoardIntent.current = boardIntent;
    if (!kanban.active) kanban.show();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [boardIntent]);
  // Closing/switching the native tab elsewhere demotes the remembered view.
  const wasBoardActive = useRef(kanban.active);
  useEffect(() => {
    const was = wasBoardActive.current;
    wasBoardActive.current = kanban.active;
    if (was && !kanban.active) rememberView("list");
    // oxlint-disable-next-line react/exhaustive-deps
  }, [kanban.active]);

  const lastBrowseRouteRef = useRef<TasksRoute | null>(null);
  useEffect(() => {
    if (!opening && route.kind !== "task") lastBrowseRouteRef.current = route;
    // oxlint-disable-next-line react/exhaustive-deps
  }, [resolvedSubPath, opening]);
  const backFromTask = () =>
    navigation.go(lastBrowseRouteRef.current ?? { kind: "all" });
  const onTaskRoute = route.kind === "task";
  const backRef = useRef(backFromTask);
  backRef.current = backFromTask;
  useEffect(() => {
    if (!onTaskRoute) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      if (hasOpenOverlay()) return;
      backRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onTaskRoute]);

  const noProjects = projects.data !== undefined && projects.data.length === 0;
  const newTaskProjectId = route.kind === "project" ? route.projectId : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (event.defaultPrevented || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (hasOpenOverlay()) return;
      event.preventDefault();
      setNewTaskOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <DialogScope className="relative flex h-full min-h-0 bg-background text-foreground">
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TasksTopbar
          route={route}
          projects={projects.data}
          pagerScope={
            lastBrowseRouteRef.current === null
              ? null
              : {
                  projectId:
                    lastBrowseRouteRef.current.kind === "project"
                      ? lastBrowseRouteRef.current.projectId
                      : null,
                }
          }
          view={kanban.active ? "board" : "list"}
          onViewChange={changeView}
          onNavigate={navigation.go}
          onNewTask={() => setNewTaskOpen(true)}
        />
        <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
          {opening ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading tasks…</p> : noProjects && route.kind !== "task" && route.kind !== "manage" ? (
            <EmptyState
              icon="ListTodo"
              title="No projects yet"
              description="Create a project to start tracking tasks and dispatching work to agents."
              action={
                <Button size="sm" onClick={() => setNewProjectOpen(true)}>
                  <Icon name="Plus" className="size-3.5" />
                  New project
                </Button>
              }
            />
          ) : (
            <RouteOutlet route={route} onBack={backFromTask} />
          )}
        </div>
      </main>
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        projectId={newTaskProjectId}
      />
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
      />
    </DialogScope>
  );
}

export function TasksAppShell(props: PluginNavPanelProps) {
  return (
    <TasksRefreshProvider>
      <TaskStatusesProvider><TasksAppShellContent {...props} /></TaskStatusesProvider>
    </TasksRefreshProvider>
  );
}
