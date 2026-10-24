import { TaskStatusesProvider, useTaskStatuses } from "../../shell/task-statuses.js";
import { statusLabel } from "../../shared/statuses.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PluginMessageDirectiveProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk";
import { useBbNavigate, useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import type { Task } from "../../shared/contract.js";
import { useProjects, useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import {
  PANEL_PATH,
  TasksNavigationContext,
  tasksRouteToSubPath,
  type TasksNavigation,
  type TasksRoute,
} from "../../shell/routes.js";
import { BoardView } from "../board/index.js";
import { DetailView } from "../detail/index.js";
import { PRIORITY_LABELS } from "../list/lib.js";
import { StatusIcon } from "../list/icons.js";

const TASK_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

type TaskEmbedState =
  | { kind: "loading" }
  | { kind: "found"; task: Task }
  | { kind: "not_found" }
  | { kind: "error" };

function useTaskEmbed(taskKey: string): {
  state: TaskEmbedState;
  retry: () => void;
} {
  const rpc = useTasksRpc();
  const [state, setState] = useState<TaskEmbedState>({ kind: "loading" });
  const seqRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(() => {
    if (taskKey === "") return;
    const seq = ++seqRef.current;
    rpc.call("getTaskByKey", { taskKey }).then(
      ({ task }) => {
        if (seq !== seqRef.current) return;
        setState(task ? { kind: "found", task } : { kind: "not_found" });
      },
      () => {
        if (seq !== seqRef.current) return;
        setState({ kind: "error" });
      },
    );
  }, [rpc, taskKey]);

  useEffect(() => {
    setState({ kind: "loading" });
    refresh();
  }, [refresh]);

  const onEvent = useCallback(
    (matches: (task: Task) => boolean) => {
      const current = stateRef.current;
      if (current.kind !== "found" || matches(current.task)) refresh();
    },
    [refresh],
  );
  useRealtime("tasks:changed", (payload) => {
    const taskId = isRecord(payload) ? payload.taskId : undefined;
    onEvent((task) => typeof taskId !== "string" || taskId === task.id);
  });
  useRealtime("projects:changed", (payload) => {
    const projectId = isRecord(payload) ? payload.projectId : undefined;
    onEvent(
      (task) => typeof projectId !== "string" || projectId === task.projectId,
    );
  });

  return { state, retry: refresh };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function taskDetailSubPath(taskKey: string): string {
  return tasksRouteToSubPath({ kind: "task", taskKey });
}

function OpenInTasksButton({
  label,
  subPath,
}: {
  label: string;
  subPath?: string;
}) {
  const navigate = useBbNavigate();
  return (
    <Button
      className="size-6 shrink-0"
      size="icon"
      variant="ghost"
      aria-label={label}
      onClick={() =>
        navigate.toPluginPanel(
          PANEL_PATH,
          subPath === undefined ? {} : { subPath },
        )
      }
    >
      <Icon name="ArrowUpRight" className="size-4" />
    </Button>
  );
}

function CardShell({
  dashed = false,
  children,
}: {
  dashed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        dashed
          ? "my-1 inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-dashed border-border bg-surface-recessed-solid px-1 align-middle"
          : "my-1 inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-border bg-card px-1 align-middle transition-colors hover:bg-state-hover"
      }
    >
      {children}
    </div>
  );
}

function embedAriaLabel(task: Task, label = statusLabel(task.status)): string {
  const parts = [
    `${task.key} — ${task.title}`,
    label.toLowerCase(),
  ];
  if (task.priority !== "none") {
    parts.push(`${PRIORITY_LABELS[task.priority].toLowerCase()} priority`);
  }
  return `${parts.join(", ")} — open in side panel`;
}

function TaskDirectiveCardContent({ attributes }: PluginMessageDirectiveProps) {
  const { label: taskStatusLabel } = useTaskStatuses();
  const navigate = useBbNavigate();
  const taskKey = attributes.key?.trim() ?? "";
  const fallbackTitle = attributes.title?.trim() || null;
  const validKey = TASK_KEY_PATTERN.test(taskKey);
  const { state, retry } = useTaskEmbed(validKey ? taskKey : "");

  if (!validKey) {
    return (
      <div className="my-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        Invalid task link. Expected a task key like TSK-4.
      </div>
    );
  }

  if (state.kind === "loading") {
    return (
      <CardShell>
        <div
          role="status"
          aria-label={`Loading task ${taskKey}`}
          className="flex min-w-0 flex-1 items-center gap-2 px-1"
        >
          <Skeleton className="size-3.5 shrink-0 rounded-full" />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {taskKey}
          </span>
          {fallbackTitle ? (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">
              {fallbackTitle}
            </span>
          ) : (
            <Skeleton className="h-3.5 w-1/2" />
          )}
        </div>
      </CardShell>
    );
  }

  if (state.kind === "not_found") {
    return (
      <CardShell dashed>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <StatusIcon status="backlog" />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {taskKey}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            {fallbackTitle
              ? `${fallbackTitle} · not found`
              : "Task not found — deleted, or its key changed"}
          </span>
        </div>
        <OpenInTasksButton label="Open Tasks" />
      </CardShell>
    );
  }

  if (state.kind === "error") {
    return (
      <CardShell dashed>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <Icon
            name="AlertCircle"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {taskKey}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
            Couldn't load this task
          </span>
        </div>
        <Button variant="ghost" size="sm" className="shrink-0" onClick={retry}>
          Retry
        </Button>
      </CardShell>
    );
  }

  const { task } = state;
  const openInSidePanel = () => {
    const opened = navigate.openThreadPanel({
      actionId: "task",
      title: task.key,
      params: { taskKey: task.key },
    });
    if (!opened) {
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: taskDetailSubPath(task.key),
      });
    }
  };

  return (
    <CardShell>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={`${task.key} · ${task.title}`}
        aria-label={embedAriaLabel(task, taskStatusLabel(task.status, task.projectId))}
        onClick={openInSidePanel}
      >
        <span aria-hidden>
          <StatusIcon status={task.status} />
        </span>
        <span
          aria-hidden
          className="shrink-0 font-mono text-xs text-muted-foreground"
        >
          {task.key}
        </span>
        <span
          aria-hidden
          className="min-w-0 max-w-64 flex-1 truncate text-xs font-medium"
        >
          {task.title}
        </span>
      </button>
      <OpenInTasksButton
        label={`Open ${task.key} in Tasks`}
        subPath={taskDetailSubPath(task.key)}
      />
    </CardShell>
  );
}

function TaskEmbedPanelContent({ threadId, params }: PluginThreadPanelProps) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const initialKey = isRecord(params) && typeof params.taskKey === "string"
    ? params.taskKey.trim()
    : "";
  const [route, setRoute] = useState<TasksRoute>(() =>
    TASK_KEY_PATTERN.test(initialKey) ? { kind: "task", taskKey: initialKey } : { kind: "all" },
  );
  const projects = useProjects();
  const threadProject = useTasksQuery(
    async () => (await sdk.threads.get({ threadId })).projectId,
    [],
    [threadId],
  );
  const project = projects.data?.find((candidate) =>
    route.kind === "project"
      ? candidate.id === route.projectId
      : threadProject.data != null && candidate.linkedBbProjectId === threadProject.data,
  );
  const navigation = useMemo<TasksNavigation>(() => ({
    go: (next, options) => {
      if (next.kind === "task" || next.kind === "project") setRoute(next);
      else navigate.toPluginPanel(PANEL_PATH, {
        subPath: tasksRouteToSubPath(next),
        ...(options?.replace ? { replace: true } : {}),
      });
    },
  }), [navigate]);
  const taskKey = route.kind === "task" ? route.taskKey : null;
  const boardRoute: TasksRoute | null = project
    ? { kind: "project", projectId: project.id, view: "board" }
    : null;

  let content;
  if (taskKey !== null) {
    content = (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DetailView
          taskKey={taskKey}
          onBack={() => setRoute({ kind: "all" })}
          backLabel="Back to project board"
          headerActions={
            <OpenInTasksButton
              label={`Open ${taskKey} in Tasks`}
              subPath={taskDetailSubPath(taskKey)}
            />
          }
        />
      </div>
    );
  } else if (projects.error || threadProject.error) {
    content = (
      <div className="space-y-3 p-4 text-sm">
        <p role="alert">{projects.error ?? threadProject.error}</p>
        <Button variant="outline" onClick={() => { projects.refresh(); threadProject.refresh(); }}>Retry</Button>
      </div>
    );
  } else if (projects.data === undefined || threadProject.data === undefined) {
    content = <p role="status" className="p-4 text-sm text-muted-foreground">Loading project board…</p>;
  } else if (project) {
    content = <div className="min-h-0 flex-1"><BoardView key={project.id} projectId={project.id} /></div>;
  } else {
    content = (
      <div className="space-y-3 p-4 text-sm text-muted-foreground">
        <p>No Tasks project is linked to this thread's bb project.</p>
        <Button variant="outline" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "manage" })}>Manage projects</Button>
      </div>
    );
  }

  return (
    <TasksNavigationContext.Provider value={navigation}>
      <section
        aria-label="Thread tasks"
        className="flex h-full min-h-0 flex-col"
      >
        {taskKey === null ? (
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <div className="min-w-0 flex-1 truncate text-sm font-medium">
              {project?.name ?? "Project board"}
            </div>
            <OpenInTasksButton
              label="Open board in Tasks"
              subPath={boardRoute ? tasksRouteToSubPath(boardRoute) : undefined}
            />
          </header>
        ) : null}
        {content}
      </section>
    </TasksNavigationContext.Provider>
  );
}

export function TaskEmbedPanel(props: PluginThreadPanelProps) {
  return (
    <TasksRefreshProvider>
      <TaskStatusesProvider><TaskEmbedPanelContent key={`${props.threadId}:${JSON.stringify(props.params)}`} {...props} /></TaskStatusesProvider>
    </TasksRefreshProvider>
  );
}

export function TaskDirectiveCard(props: PluginMessageDirectiveProps) {
  const content = <TaskDirectiveCardContent {...props} />;
  return <TasksRefreshProvider>{TASK_KEY_PATTERN.test(props.attributes.key?.trim() ?? "") ? <TaskStatusesProvider>{content}</TaskStatusesProvider> : content}</TasksRefreshProvider>;
}
