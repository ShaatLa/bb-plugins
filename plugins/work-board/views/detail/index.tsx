import { PullRequestsSection } from "../../components/pr-links";
import { ArchiveTaskControl } from "../../components/archive-task-control";
import { useTaskStatuses } from "../../shell/task-statuses.js";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import SmilePlusIcon from "@hugeicons/core-free-icons/SmilePlusIcon";
import type { Task, TaskThread } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import {
  experimental_copyToClipboard,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  listAllTasks,
  useMentionItems,
  useTasksQuery,
  useTasksRpc,
} from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { TaskActivity } from "../activity/task-activity.js";
import { QuestionsSection } from "./questions";
import { QuestionCount, useQuestionCounts } from "../../components/question-count";
import { AttachmentsGrid, uploadAttachment } from "./attachments.js";
import {
  createDescriptionSaver,
  type DescriptionSaver,
} from "./description-save.js";
import { StatusIcon } from "./meta.js";
import {
  InlineProperties,
  PropertiesRail,
  type TaskPropertyUpdate,
} from "./rail.js";
import { ThreadsSection } from "./threads.js";
import { DetailToasts, useDetailToasts } from "./toast.js";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface DetailViewProps {
  taskKey: string;
  onCanonicalKey?: (taskKey: string) => void;
  onBack: () => void;
  backLabel?: string;
  headerActions?: ReactNode;
}

const DESCRIPTION_SAVE_DELAY_MS = 800;
const ACTIVE_PULL_REQUEST_REFRESH_MS = 60_000;

function SubTaskDonut({
  subtasks,
  onClick,
  epic,
}: {
  epic: boolean;
  subtasks: Task[];
  onClick: () => void;
}) {
  if (subtasks.length === 0) return null;
  const done = subtasks.filter((subtask) => subtask.status === "done").length;
  const degrees = (done / subtasks.length) * 360;
  return (
    <button
      type="button"
      title={epic ? "Tasks completed" : "Sub-tasks completed"}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs hover:border-input hover:text-foreground"
    >
      <span
        aria-hidden
        className="inline-block size-3 rounded-full"
        style={{
          background: `conic-gradient(var(--primary) ${degrees}deg, var(--muted) 0)`,
        }}
      />
      {done}/{subtasks.length} {epic ? "tasks" : "sub-tasks"}
    </button>
  );
}

function CopyTaskKey({
  taskKey,
  onError,
}: {
  taskKey: string;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyKey = async () => {
    try {
      if (
        !(await experimental_copyToClipboard({
          text: taskKey,
        }))
      ) {
        throw new Error("Clipboard write failed");
      }
      setCopied(true);
    } catch {
      setCopied(false);
      onError("Could not copy task key. Please try again.");
    }
  };

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground max-md:pointer-coarse:size-9"
              aria-label="Copy task key"
              onClick={() => void copyKey()}
            >
              <Icon name={copied ? "Check" : "Copy"} className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {copied ? "Copied" : "Copy task key"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <span role="status" className="sr-only">
        {copied ? "Task key copied" : ""}
      </span>
    </>
  );
}

function EditableTitle({
  task,
  onSave,
}: {
  task: Task;
  onSave: (title: string) => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const element = titleRef.current;
    if (element && document.activeElement !== element) element.textContent = task.title;
  }, [task.id, task.title]);
  return (
    <div className="mb-2.5 mt-1">
      <h1
        key={task.id}
        ref={titleRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-label="Task title"
        className="min-w-0 flex-1 break-words text-2xl font-semibold leading-tight outline-none"
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          const next = event.currentTarget.textContent?.trim() ?? "";
          if (!next) {
            event.currentTarget.textContent = task.title;
            return;
          }
          if (next !== task.title) onSave(next);
        }}
      />
    </div>
  );
}

function SubTasksSection({
  ref,
  task,
  subtasks,
  onCreate,
}: {
  ref: React.Ref<HTMLElement>;
  task: Task;
  subtasks: Task[];
  onCreate: (title: string) => Promise<boolean>;
}) {
  const navigation = useTasksNavigation();
  const { label: statusLabel } = useTaskStatuses(task.projectId);
  const questionCounts = useQuestionCounts(subtasks);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const created = await onCreate(trimmed);
    setBusy(false);
    if (created) setTitle("");
  };

  return (
    <section ref={ref} className="mt-5">
      {task.type === "epic" ? (
        <h2 className="mb-2 text-sm font-semibold">Tasks in this epic</h2>
      ) : null}
      {subtasks.map((subtask) => (
        <button
          key={subtask.id}
          type="button"
          className="flex h-8 w-full items-center gap-2 border-b border-border-hairline px-0.5 text-left text-sm hover:bg-state-hover"
          title={statusLabel(subtask.status)}
          onClick={() => navigation.go({ kind: "task", taskKey: subtask.key })}
        >
          <StatusIcon status={subtask.status} />
          <span className="shrink-0 text-xs text-muted-foreground">
            {subtask.key}
          </span>
          <span className="min-w-0 flex-1 truncate">{subtask.title}</span>
          {subtask.archivedAt ? <span className="text-xs text-muted-foreground">Archived</span> : null}
          <QuestionCount count={questionCounts.data?.get(subtask.id)} />
        </button>
      ))}
      {adding ? (
        <div className="flex h-8 items-center gap-2 border-b border-border-hairline px-0.5">
          <StatusIcon status="todo" className="opacity-60" />
          <input
            autoFocus
            value={title}
            placeholder={`${task.type === "epic" ? "Task in" : "Sub-task of"} ${task.key}…`}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") {
                setAdding(false);
                setTitle("");
              }
            }}
            onBlur={() => {
              if (!title.trim()) setAdding(false);
            }}
          />
        </div>
      ) : null}
      <button
        type="button"
        className="flex items-center gap-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        hidden={Boolean(task.archivedAt)}
        onClick={() => setAdding(true)}
      >
        <Icon name="Plus" className="size-3" />
        {task.type === "epic" ? "Add task" : "Add sub-task"}
      </button>
    </section>
  );
}

function DetailSkeleton() {
  return (
    <DelayedLoading>
      <div className="mx-auto w-full max-w-3xl px-8 py-12">
        <Skeleton className="mb-4 h-7 w-2/3" />
        <Skeleton className="mb-2 h-4 w-full" />
        <Skeleton className="mb-2 h-4 w-5/6" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </DelayedLoading>
  );
}

function TaskDetail({
  task,
  header,
}: {
  task: Task;
  header: (copyAction?: ReactNode) => ReactNode;
}) {
  const rpc = useTasksRpc();
  const delegationRpc = useRpc<DelegationRpcContract>();
  const navigation = useTasksNavigation();
  const { toasts, push, dismiss } = useDetailToasts();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtasksRef = useRef<HTMLElement>(null);
  const [addingQuestion, setAddingQuestion] = useState<string | null>(null);

  const [draft, setDraft] = useState<{ taskId: string; markdown: string }>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const pushRef = useRef(push);
  pushRef.current = push;
  const saverRef = useRef<DescriptionSaver | null>(null);
  saverRef.current ??= createDescriptionSaver({
    save: async (taskId, markdown) => {
      const result = await rpcRef.current.call("updateTask", {
        taskId,
        description: markdown,
      });
      return result.ok
        ? { ok: true }
        : { ok: false, errorMessage: result.error.message };
    },
    onError: (message) => pushRef.current(message),
    delayMs: DESCRIPTION_SAVE_DELAY_MS,
  });

  const projects = useTasksQuery(
    async (query) => (await query.call("listProjects", {})).projects,
    ["projects:changed"],
  );
  const project = projects.data?.find((entry) => entry.id === task.projectId);

  const parent = useTasksQuery(
    async (query) =>
      task.parentTaskId
        ? (await query.call("getTask", { taskId: task.parentTaskId })).task
        : null,
    ["tasks:changed"],
    [task.parentTaskId],
    { relevantTaskIds: task.parentTaskId ? [task.parentTaskId] : [] },
  );
  const epicId = task.epicId ?? parent.data?.epicId ?? null;
  const epic = useTasksQuery(
    async (query) =>
      epicId ? (await query.call("getTask", { taskId: epicId })).task : null,
    ["tasks:changed"],
    [epicId],
  );
  const subtasks = useTasksQuery(
    async (query) =>
      listAllTasks(
        query,
        task.type === "epic" ? { epicId: task.id, archive: "all" } : { parentTaskId: task.id, archive: "all" },
      ),
    ["tasks:changed"],
    [task.id, task.type],
  );
  const labels = useTasksQuery(
    async (query) =>
      (await query.call("listLabels", { projectId: task.projectId })).labels,
    ["projects:changed"],
    [task.projectId],
  );
  const attachments = useTasksQuery(
    async (query) =>
      (await query.call("listAttachments", { taskId: task.id })).attachments,
    ["tasks:changed"],
    [task.id],
    { relevantTaskIds: [task.id] },
  );
  const threads = useTasksQuery<TaskThread[]>(
    async (query, publish) => {
      const cached = await query.call("listTaskThreads", { taskId: task.id, reconcile: false });
      publish(cached.taskThreads);
      return (await query.call("listTaskThreads", { taskId: task.id })).taskThreads;
    },
    ["threads:changed"],
    [task.id],
    { relevantTaskIds: [task.id] },
  );
  const presets = useTasksQuery(
    async (query) => (await query.call("listPresets")).presets,
    ["projects:changed"],
  );
  const pullRequests = useTasksQuery(
    async (query) => query.call("listTaskPullRequests", { taskId: task.id }),
    ["threads:changed"],
    [task.id],
    { relevantTaskIds: [task.id] },
  );
  const refreshPullRequests = pullRequests.refresh;
  const hasActivePullRequest = (pullRequests.data?.pullRequests ?? []).some(
    (pullRequest) =>
      pullRequest.state === "open" || pullRequest.state === "draft",
  );
  useEffect(() => {
    window.addEventListener("focus", refreshPullRequests);
    return () => window.removeEventListener("focus", refreshPullRequests);
  }, [refreshPullRequests]);
  useEffect(() => {
    if (!hasActivePullRequest) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refreshPullRequests();
    }, ACTIVE_PULL_REQUEST_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasActivePullRequest, refreshPullRequests]);

  const updateTask = async (
    input: TaskPropertyUpdate & { title?: string; description?: string },
  ) => {
    try {
      const result = await rpc.call("updateTask", {
        taskId: task.id,
        ...input,
      });
      if (!result.ok) push(result.error.message);
      else if (result.notification === "not_sent")
        push(
          "Saved as Done, but the requester thread could not be notified. Notify it manually.",
        );
    } catch (error) {
      push(errorMessage(error));
    }
  };

  const moveToProject = async (projectId: string) => {
    saverRef.current?.flush(task.id);
    try {
      const result = await rpc.call("moveTaskToProject", {
        taskId: task.id,
        projectId,
      });
      if (!result.ok) {
        push(result.error.message);
        return;
      }
      navigation.go(
        { kind: "task", taskKey: result.task.key },
        { replace: true },
      );
    } catch (error) {
      push(errorMessage(error));
    }
  };

  const onDescriptionChange = (markdown: string) => {
    setDraft({ taskId: task.id, markdown });
    saverRef.current?.onChange(task.id, markdown);
  };

  useEffect(() => {
    return () => saverRef.current?.flush(task.id);
  }, [task.id]);

  const uploadForTask = async (file: File) => {
    const result = await uploadAttachment(file, { taskId: task.id });
    attachments.refresh();
    return result;
  };

  const onPickFiles = async (files: FileList | null) => {
    for (const file of files ?? []) {
      try {
        await uploadAttachment(file, { taskId: task.id });
      } catch (error) {
        push(errorMessage(error));
      }
    }
    attachments.refresh();
  };

  const createSubtask = async (title: string): Promise<boolean> => {
    try {
      const result = await rpc.call("createTask", {
        projectId: task.projectId,
        title,
        ...(task.type === "epic"
          ? { epicId: task.id }
          : { parentTaskId: task.id }),
        status: "todo",
      });
      if (!result.ok) {
        push(result.error.message);
        return false;
      }
      subtasks.refresh();
      return true;
    } catch (error) {
      push(errorMessage(error));
      return false;
    }
  };

  const mentionItems = useMentionItems();
  const navigate = useBbNavigate();

  const descriptionValue =
    draft && draft.taskId === task.id ? draft.markdown : task.description;
  const parentTask = parent.data ?? null;

  return (
    <div className="@container flex min-h-full flex-col bg-surface-recessed-solid p-3">
      <div className="flex flex-1 flex-col items-stretch rounded-lg border border-border bg-card shadow-2xs @[45rem]:flex-row">
        <div className="mx-auto w-full min-w-0 max-w-[55rem] flex-1 px-7 pb-16 pt-8 @3xl:px-13 @3xl:pt-11">
          {header(
            <CopyTaskKey
              key={task.id}
              taskKey={task.key}
              onError={push}
            />,
          )}
          {task.type === "epic" ||
          epic.data ||
          parentTask ||
          subtasks.data?.length ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {task.type === "epic" ? (
                <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium">
                  Epic
                </span>
              ) : null}
              {epic.data ? (
                <button
                  type="button"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs hover:border-input"
                  onClick={() =>
                    navigation.go({ kind: "task", taskKey: epic.data!.key })
                  }
                >
                  <Icon name="Zap" className="size-3" />
                  <span className="truncate">
                    {epic.data.key} · {epic.data.title}
                  </span>
                </button>
              ) : null}
              {parentTask ? (
                <button
                  type="button"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs hover:border-input"
                  onClick={() =>
                    navigation.go({ kind: "task", taskKey: parentTask.key })
                  }
                >
                  Sub-task of
                  <StatusIcon status={parentTask.status} className="size-3" />
                  <span className="font-medium text-foreground">
                    {parentTask.key}
                  </span>
                  <span className="min-w-0 truncate">{parentTask.title}</span>
                </button>
              ) : null}
              <SubTaskDonut
                epic={task.type === "epic"}
                subtasks={subtasks.data ?? []}
                onClick={() =>
                  subtasksRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  })
                }
              />
            </div>
          ) : null}

          <ArchiveTaskControl task={task} onError={push} />
          <EditableTitle
            task={task}
            onSave={(title) => void updateTask({ title })}
          />

          <InlineProperties
            task={task}
            project={project}
            projects={projects.data}
            labels={labels.data}
            threads={threads.data ?? []}
            presets={presets.data}
            onUpdate={(update) => void updateTask(update)}
            onMoveToProject={(projectId) => void moveToProject(projectId)}
            onError={(message) => push(message)}
            onAddQuestion={() => setAddingQuestion(task.id)}
            className="mb-4 @[45rem]:hidden"
          />

          <TasksEditor
            value={descriptionValue}
            onChange={onDescriptionChange}
            variant="doc"
            className="min-h-24"
            placeholder={
              task.executionTarget === "owner"
                ? "Action to take, why the owner is needed, and how to verify completion…"
                : "Add a description… rich text: headings, lists, code, checkboxes, @mentions"
            }
            onUploadImage={uploadForTask}
            mentionItems={mentionItems}
            onOpenThread={(threadId) => navigate.toThread(threadId)}
          />

          <div className="mb-1 mt-3 flex items-center gap-1">
            <button
              type="button"
              title="Reactions coming soon"
              aria-label="Add reaction"
              disabled
              className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground opacity-50"
            >
              <HugeiconsIcon icon={SmilePlusIcon} className="size-4" />
            </button>
            <button
              type="button"
              title="Attach file"
              aria-label="Attach file"
              className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="Paperclip" className="size-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void onPickFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>

          <AttachmentsGrid
            attachments={attachments.data ?? []}
            onRemove={async (attachment) => {
              const result = await rpc.call("deleteAttachment", {
                attachmentId: attachment.id,
                removeDescriptionReferences: true,
              });
              if (!result.ok) throw new Error(result.error.message);
              attachments.refresh();
            }}
            onError={(message) => push(message)}
          />

          {task.parentTaskId === null ? (
            <SubTasksSection
              ref={subtasksRef}
              task={task}
              subtasks={subtasks.data ?? []}
              onCreate={createSubtask}
            />
          ) : null}

          {(threads.data ?? []).length > 0 ? (
            <div className="mt-6">
              <ThreadsSection
                threads={threads.data ?? []}
                pullRequests={pullRequests.data?.pullRequests}
                unavailableThreadIds={
                  pullRequests.data?.unavailableThreadIds ?? []
                }
                onDetach={async (thread) => {
                  await delegationRpc.call("taskThreadsDetach", {
                    taskId: task.id,
                    threadId: thread.threadId,
                  });
                  threads.refresh();
                  pullRequests.refresh();
                }}
                onError={(message) => push(message)}
              />
            </div>
          ) : null}

          <div className="mt-1">
            <QuestionsSection
              key={task.id}
              taskId={task.id}
              adding={addingQuestion === task.id}
              onAddingChange={(adding) =>
                setAddingQuestion(adding ? task.id : null)
              }
              onError={push}
            />
            <TaskActivity
              taskId={task.id}
              pullRequests={pullRequests.data?.pullRequests}
            />
          </div>
        </div>

        <PropertiesRail
          task={task}
          project={project}
          projects={projects.data}
          labels={labels.data}
          threads={threads.data ?? []}
          presets={presets.data}
          onUpdate={(update) => void updateTask(update)}
          onMoveToProject={(projectId) => void moveToProject(projectId)}
          onError={(message) => push(message)}
          onAddQuestion={() => setAddingQuestion(task.id)}
        >
          <PullRequestsSection key={task.id} taskId={task.id} projectId={task.projectId} loading={pullRequests.isFetching} />
        </PropertiesRail>
      </div>
      <DetailToasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

export function DetailView({
  taskKey,
  onCanonicalKey,
  onBack,
  backLabel = "Back (Esc)",
  headerActions,
}: DetailViewProps) {
  const query = useTasksQuery(
    async (rpc) => (await rpc.call("getTaskByKey", { taskKey })).task,
    ["tasks:changed"],
    [taskKey],
  );
  const canonicalKey = query.data?.key;
  useEffect(() => {
    if (canonicalKey) onCanonicalKey?.(canonicalKey);
  }, [canonicalKey, onCanonicalKey]);

  const header = (copyAction?: ReactNode) => (
    <header
      aria-label="Task heading"
      className="mb-4 flex min-w-0 items-center gap-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground max-md:pointer-coarse:size-9"
        aria-label={backLabel}
        onClick={onBack}
      >
        <Icon name="ArrowLeft" className="size-4" />
      </Button>
      <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
        {canonicalKey ?? taskKey}
      </span>
      {copyAction}
      {headerActions ? (
        <div className="ml-auto flex shrink-0">{headerActions}</div>
      ) : null}
    </header>
  );

  if (query.data == null) {
    return (
      <div className="flex min-h-full flex-col p-7">
        {header()}
        {query.data === undefined ? (
          query.error ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
              {query.error}
            </div>
          ) : (
            <DetailSkeleton />
          )
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Icon name="FileQuestion" className="size-5" />
            Task {taskKey} was not found.
          </div>
        )}
      </div>
    );
  }
  return <TaskDetail task={query.data} header={header} />;
}
