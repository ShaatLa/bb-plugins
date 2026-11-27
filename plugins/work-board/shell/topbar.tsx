import { useTaskStatuses } from "./task-statuses.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Project, Task } from "../shared/contract.js";
import { groupTasksByStatus } from "../views/list/lib.js";
import { patchTasks, useTasksQuery } from "./data.js";
import { loadTaskDataset, taskDatasetSnapshot } from "./task-dataset";
import { signalTaskIds } from "./signal-scheduler.js";
import type { ResolvedTasksRoute, TaskViewMode, TasksRoute } from "./routes.js";
import { projectForRoute } from "./kanban-view.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTasksRefresh } from "./refresh.js";
import { LockChips } from "../components/lock-chips.js";
import { QueueMenu } from "../components/queue-menu.js";
import { ManagerQuickSet } from "../components/manager-quick-set.js";

const REFRESH_TASKS_LABEL = "Refresh tasks";

interface PagerPosition {
  index: number;
  total: number;
  prevKey: string | null;
  nextKey: string | null;
}

export function pagerPosition(
  tasks: readonly Task[],
  taskKey: string,
  statuses?: readonly string[],
): PagerPosition | null {
  const ordered = groupTasksByStatus(tasks, statuses).flatMap((group) => group.tasks);
  const wanted = taskKey.toUpperCase();
  const index = ordered.findIndex((task) => task.key.toUpperCase() === wanted);
  if (index === -1) return null;
  return {
    index: index + 1,
    total: ordered.length,
    prevKey: ordered[index - 1]?.key ?? null,
    nextKey: ordered[index + 1]?.key ?? null,
  };
}

function TaskPager({
  taskKey,
  projectId,
  onNavigate,
}: {
  taskKey: string;
  projectId: string | null;
  onNavigate: (route: TasksRoute) => void;
}) {
  const { ids: statusIds } = useTaskStatuses(projectId);
  // Shares the warm list/board dataset instead of re-listing the project on every event.
  const dataset = useTasksQuery<Task[]>(
    (rpc, publish) => loadTaskDataset(rpc, projectId, publish),
    ["tasks:changed", "projects:changed"],
    [projectId],
    {
      snapshot: taskDatasetSnapshot(projectId),
      applySignals: (rpc, current, signals) => signals.some((signal) => signal.channel === "projects:changed")
        ? Promise.resolve(null)
        : patchTasks(rpc, current, signalTaskIds(signals, "tasks:changed"), (task) => !task.archivedAt && (projectId === null || task.projectId === projectId)),
    },
  );
  const position = useMemo(
    () => (dataset.data ? pagerPosition(dataset.data.filter((task) => task.parentTaskId === null), taskKey, statusIds) : null),
    [dataset.data, taskKey, statusIds],
  );
  if (!position) return null;
  const step = (key: string | null) => {
    if (key !== null) onNavigate({ kind: "task", taskKey: key });
  };
  return (
    <div className="hidden shrink-0 items-center gap-0.5 text-xs tabular-nums text-muted-foreground @sm:flex">
      <span className="hidden px-1 @md:inline">
        {position.index} / {position.total}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 max-md:pointer-coarse:size-9"
        aria-label="Previous task"
        disabled={position.prevKey === null}
        onClick={() => step(position.prevKey)}
      >
        <Icon name="ChevronUp" className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 max-md:pointer-coarse:size-9"
        aria-label="Next task"
        disabled={position.nextKey === null}
        onClick={() => step(position.nextKey)}
      >
        <Icon name="ChevronDown" className="size-3.5" />
      </Button>
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: TaskViewMode;
  onChange: (view: TaskViewMode) => void;
}) {
  const segment = (mode: TaskViewMode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(mode)}
      aria-pressed={view === mode}
      className={cn(
        "rounded-sm px-2.5 py-0.5 text-xs max-md:pointer-coarse:py-1.5",
        view === mode
          ? "bg-background text-foreground shadow-2xs"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center rounded-md bg-muted p-0.5">
      {segment("board", "Board")}
      {segment("list", "List")}
    </div>
  );
}

function RefreshTasksButton() {
  const { refresh, isRefreshing } = useTasksRefresh();

  const handleRefresh = useCallback(() => {
    if (isRefreshing) return;
    refresh();
  }, [isRefreshing, refresh]);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground active:bg-state-active active:text-foreground max-md:pointer-coarse:size-9"
            aria-label={REFRESH_TASKS_LABEL}
            aria-busy={isRefreshing}
            disabled={isRefreshing}
            onClick={handleRefresh}
          >
            <Icon
              name="RotateCcw"
              className={cn("size-3.5", isRefreshing && "animate-spin")}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{REFRESH_TASKS_LABEL}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface TasksTopbarProps {
  route: ResolvedTasksRoute;
  projects: Project[] | undefined;
  pagerScope: { projectId: string | null } | null;
  /** "board" exactly while the native right panel shows the Kanban tab. */
  view: TaskViewMode;
  onViewChange: (view: TaskViewMode) => void;
  onNavigate: (route: TasksRoute) => void;
  onNewTask: () => void;
}

export function TasksTopbar({
  route,
  projects,
  pagerScope,
  view,
  onViewChange,
  onNavigate,
  onNewTask,
}: TasksTopbarProps) {
  const project = useMemo(() => projectForRoute(route, projects), [route, projects]);
  // Manage has no sidebar entry, so its header carries the way back.
  const beforeManage = useRef<TasksRoute>({ kind: "all" });
  useEffect(() => {
    if (route.kind !== "manage") beforeManage.current = route;
  }, [route]);

  const breadcrumb = (() => {
    switch (route.kind) {
      case "active":
        return (
          <span className="flex items-center gap-2">
            <span className="whitespace-nowrap font-semibold">Active</span>
            <span className="hidden text-xs font-normal text-muted-foreground @md:inline">
              agents working now
            </span>
          </span>
        );
      case "archive":
        return <span className="font-semibold">Archive</span>;
      case "manage":
        return (
          <span className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Back"
              className="-ml-1.5 size-7 shrink-0 text-muted-foreground hover:text-foreground max-md:pointer-coarse:size-9"
              onClick={() => onNavigate(beforeManage.current)}
            >
              <Icon name="ArrowLeft" className="size-4" />
            </Button>
            <span className="whitespace-nowrap font-semibold">Manage</span>
            <span className="hidden text-xs font-normal text-muted-foreground @md:inline">
              projects, labels, presets, folders
            </span>
          </span>
        );
      case "all":
      case "project":
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Switch project"
                className="flex min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-state-hover"
              >
                {project ? (
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: project.color }}
                  />
                ) : null}
                <span className="truncate font-semibold">
                  {route.kind === "all" ? "All tasks" : (project?.name ?? "Project")}
                </span>
                <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
              <DropdownMenuItem
                disabled={route.kind === "all"}
                onSelect={() => onNavigate({ kind: "all" })}
              >
                <Icon name="ListView" className="size-3.5 shrink-0 text-muted-foreground" />
                All tasks
              </DropdownMenuItem>
              {(projects ?? []).length > 0 ? <DropdownMenuSeparator /> : null}
              {(projects ?? []).map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  disabled={route.kind === "project" && item.id === project?.id}
                  onSelect={() =>
                    onNavigate({ kind: "project", projectId: item.id, view: null })
                  }
                >
                  <span
                    aria-hidden
                    className="size-3 shrink-0 rounded-sm"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate">{item.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      case "task":
      case "plan":
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            {project ? (
              <button
                type="button"
                className="hidden min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground @md:flex"
                onClick={() =>
                  onNavigate({
                    kind: "project",
                    projectId: project.id,
                    view: null,
                  })
                }
              >
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: project.color }}
                />
                <span className="truncate font-medium">{project.name}</span>
              </button>
            ) : null}
          </span>
        );
    }
  })();

  return (
    <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border-hairline bg-background px-3.5 text-sm max-md:pointer-coarse:h-12 max-md:pl-12 max-md:pointer-coarse:pl-14">
      {/* Room on the left so hover backgrounds pulled out with negative margins are not clipped. */}
      <div className="-ml-2 flex min-w-0 flex-1 items-center overflow-hidden pl-2">
        {breadcrumb}
        {route.kind === "project" && project ? <><ManagerQuickSet projectId={project.id} className="ml-10" /><QueueMenu key={project.id} projectId={project.id} /></> : null}
      </div>
      {route.kind === "project" && project ? <LockChips projectId={project.id} /> : null}
      {route.kind === "task" &&
      (pagerScope !== null || projects !== undefined) ? (
        <TaskPager
          taskKey={route.taskKey}
          projectId={
            pagerScope !== null ? pagerScope.projectId : (project?.id ?? null)
          }
          onNavigate={onNavigate}
        />
      ) : null}
      {project ? <ViewToggle view={view} onChange={onViewChange} /> : null}
      <RefreshTasksButton />
      <DropdownMenu>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Work Board settings"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-foreground max-md:pointer-coarse:size-9"
                >
                  <Icon name="Settings" className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Work Board settings</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onNavigate({ kind: "manage" })}>
            Manage labels and presets
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="/settings/plugins/work-board">Plugin settings</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {route.kind !== "task" && route.kind !== "manage" && route.kind !== "archive" ? (
        <Button
          size="sm"
          className="h-7 gap-1.5 max-md:pointer-coarse:h-9"
          aria-label="New task"
          onClick={onNewTask}
        >
          <Icon name="Plus" className="size-3.5" />
          <span className="hidden @lg:inline">New task</span>
        </Button>
      ) : null}
    </header>
  );
}
