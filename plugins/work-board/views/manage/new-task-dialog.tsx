import { useTaskStatuses } from "../../shell/task-statuses.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  TASK_PRIORITIES,
  type TaskType,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";
import { EpicPicker } from "../../components/epic-picker.js";
import { errorMessage } from "../../shared/errors.js";
import {
  AttachmentChip,
  settleStagedUploads,
  stageFiles,
  uploadStagedAttachments,
  useStagedAttachmentRetry,
  type StagedAttachment,
} from "../../components/staged-attachments.js";
import { useProjects, useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { CheckboxField, DEFAULT_COLOR } from "./shared.js";
import {
  clearNewTaskDraft,
  hasDraftContent,
  type NewTaskDraft,
} from "./new-task-draft.js";
import { PRIORITY_LABELS } from "../list/lib.js";
import { ScheduleDialog, type Draft as ScheduleDraft } from "../scheduled/schedule-dialog.js";

const CHIP_TRIGGER =
  "h-7 w-auto gap-1.5 rounded-md px-2 text-xs text-muted-foreground";

function TaskFieldPicker<Value extends string>({
  dialogOpen,
  label,
  value,
  options,
  onValueChange,
}: {
  dialogOpen: boolean;
  label: string;
  value: Value | null;
  options: ReadonlyArray<{
    value: Value;
    label: string;
    color?: string;
    keywords?: string[];
  }>;
  onValueChange: (value: Value) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    if (!dialogOpen) setPickerOpen(false);
  }, [dialogOpen]);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={label}
          variant="outline"
          size="sm"
          className={cn(CHIP_TRIGGER, "max-w-44 border-input font-normal")}
        >
          <span className="truncate">{selected?.label ?? label}</span>
          <Icon name="ChevronDown" className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Choose ${label.toLowerCase()}…`} />
          <CommandList>
            <CommandEmpty>No matching options.</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, ...(option.keywords ?? [])]}
                  onSelect={() => {
                    if (option.value !== value) onValueChange(option.value);
                    setPickerOpen(false);
                  }}
                >
                  {option.color ? (
                    <span
                      aria-hidden
                      className="size-2.5 rounded-sm"
                      style={{ backgroundColor: option.color }}
                    />
                  ) : null}
                  <span className="flex-1 truncate">{option.label}</span>
                  {option.value === value ? (
                    <Icon name="Check" className="size-3.5" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type Step = "choose" | "form" | "schedule";

const KIND_CHOICES: ReadonlyArray<{
  kind: TaskType | "scheduled";
  label: string;
  icon: string;
  description: string;
}> = [
  {
    kind: "task",
    label: "Task",
    icon: "ListTodo",
    description: "A single piece of work, done once.",
  },
  {
    kind: "epic",
    label: "Epic",
    icon: "Zap",
    description: "A larger initiative that groups tasks.",
  },
  {
    kind: "scheduled",
    label: "Scheduled task",
    icon: "Clock",
    description: "Runs automatically, once or on a repeating schedule.",
  },
];

function blankDraft(
  projectId: string | null,
  defaultStatus: TaskStatus | undefined,
): NewTaskDraft {
  return {
    projectId,
    title: "",
    description: "",
    status: defaultStatus ?? "todo",
    priority: "none",
    labelIds: [],
    dueDate: "",
    type: "task",
    epicId: null,
  };
}

interface NewTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  defaultStatus?: TaskStatus;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  projectId,
  defaultStatus,
}: NewTaskDialogProps) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const projects = useProjects();

  const [draft, setDraft] = useState(() =>
    blankDraft(projectId, defaultStatus),
  );
  const [createMore, setCreateMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labelQuery, setLabelQuery] = useState("");
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<StagedAttachment[]>([]);
  const [createdTask, setCreatedTask] = useState<Task | null>(null);
  // The kind is chosen before editing; Back returns here without touching draft or files.
  const [step, setStep] = useState<Step>("choose");
  // In-memory only: the whole draft (task form, files, schedule form) lives and dies with one open dialog.
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateDraft = (
    change: (current: NewTaskDraft) => Partial<NewTaskDraft>,
  ) =>
    setDraft((current) => {
      const resolved = {
        ...current,
        epicId:
          current.projectId === effectiveProjectId ? current.epicId : null,
        projectId: effectiveProjectId,
        labelIds: labels.data
          ? current.labelIds.filter((id) =>
              labels.data?.some((label) => label.id === id),
            )
          : current.labelIds,
      };
      return { ...resolved, ...change(resolved) };
    });

  useEffect(() => {
    // Purges any draft an older version left in localStorage, on open and on close.
    clearNewTaskDraft();
    setScheduleDraft(null);
    if (!open) {
      // Release the draft and staged files on close; uploaded attachments are untouched.
      setDraft(blankDraft(projectId, defaultStatus));
      setPendingFiles([]);
      setCreatedTask(null);
      return;
    }
    setDraft(blankDraft(projectId, defaultStatus));
    setLabelQuery("");
    setPendingFiles([]);
    setCreatedTask(null);
    setError(null);
    setStep("choose");
    // oxlint-disable-next-line react/exhaustive-deps
  }, [open]);

  const { title, description, status, priority, dueDate, type, epicId } = draft;
  const projectList = projects.data ?? [];
  const project =
    projectList.find((entry) => entry.id === draft.projectId) ??
    projectList.find((entry) => entry.id === projectId) ??
    projectList[0] ??
    null;
  const effectiveProjectId = project?.id ?? null;
  const { ids: statusIds, label: statusLabel } = useTaskStatuses(effectiveProjectId);

  useEffect(() => {
    if (!open || draft.projectId !== null || effectiveProjectId === null)
      return;
    setDraft((current) =>
      current.projectId !== null
        ? current
        : { ...current, projectId: effectiveProjectId },
    );
  }, [open, draft.projectId, effectiveProjectId]);

  const labelsQuery = useTasksQuery(
    async (rpc) => ({
      projectId: effectiveProjectId,
      labels: effectiveProjectId
        ? (await rpc.call("listLabels", { projectId: effectiveProjectId }))
            .labels
        : [],
    }),
    ["projects:changed"],
    [effectiveProjectId],
  );
  const labels = {
    ...labelsQuery,
    data:
      labelsQuery.data?.projectId === effectiveProjectId
        ? labelsQuery.data.labels
        : undefined,
  };
  const labelIds = draft.labelIds.filter((id) =>
    labels.data?.some((label) => label.id === id),
  );

  const changeProject = (id: string) =>
    updateDraft((current) => ({ projectId: id, labelIds: [], epicId: null, status: (projectList.find((project) => project.id === id)?.statuses ?? []).some((status) => status.id === current.status) || ["backlog", "todo", "in_progress", "in_review", "done", "canceled"].includes(current.status) ? current.status : "backlog" }));

  const toggleLabel = (labelId: string) =>
    updateDraft((current) => ({
      labelIds: current.labelIds.includes(labelId)
        ? current.labelIds.filter((id) => id !== labelId)
        : [...current.labelIds, labelId],
    }));

  const discardDraft = () => {
    setDraft(blankDraft(projectId, defaultStatus));
    setPendingFiles([]);
    setError(null);
    titleRef.current?.focus();
  };

  const createLabelFromQuery = async () => {
    const name = labelQuery.trim();
    if (!name || effectiveProjectId === null || creatingLabel) return;
    setCreatingLabel(true);
    try {
      const { label } = await rpc.call("createLabel", {
        projectId: effectiveProjectId,
        name,
        color: DEFAULT_COLOR,
      });
      labels.refresh();
      updateDraft((current) => ({
        labelIds: [...current.labelIds, label.id],
      }));
      setLabelQuery("");
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setCreatingLabel(false);
    }
  };

  const chooseKind = (kind: TaskType | "scheduled") => {
    if (kind === "scheduled") {
      setStep("schedule");
      return;
    }
    // epicId stays in the draft so Task -> Epic -> Task does not lose the parent; submit ignores it for epics.
    if (kind !== draft.type) updateDraft(() => ({ type: kind }));
    setStep("form");
  };

  const stageMore = (files: File[]) => {
    if (
      files.length === 0 ||
      submitting ||
      createdTask !== null ||
      step !== "form"
    )
      return;
    setPendingFiles((current) => [...current, ...stageFiles(files)]);
  };

  const removeFile = (id: number) => {
    if (submitting) return;
    setPendingFiles((files) => files.filter((entry) => entry.id !== id));
  };

  const retryUpload = useStagedAttachmentRetry(setPendingFiles);

  const finish = (task: Task) => {
    onOpenChange(false);
    navigation.go({ kind: "task", taskKey: task.key });
  };

  useEffect(() => {
    if (step === "form") titleRef.current?.focus();
  }, [step]);

  const requestClose = (next: boolean) => {
    if (!next && createdTask !== null && pendingFiles.length > 0) return;
    onOpenChange(next);
  };

  useEffect(() => {
    if (createdTask && pendingFiles.length === 0) finish(createdTask);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [createdTask, pendingFiles.length]);

  const hasOversized = pendingFiles.some(
    (entry) => entry.status === "oversized",
  );
  const canSubmit =
    step === "form" &&
    effectiveProjectId !== null &&
    title.trim().length > 0 &&
    !submitting &&
    statusIds.includes(status) &&
    !labels.isLoading &&
    labels.data !== undefined &&
    labels.error === null &&
    !hasOversized &&
    createdTask === null;

  const submit = async () => {
    if (!canSubmit || effectiveProjectId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await rpc.call("createTask", {
        projectId: effectiveProjectId,
        title: title.trim(),
        description,
        status,
        priority,
        dueDate: dueDate === "" ? null : dueDate,
        parentTaskId: null,
        type,
        epicId:
          type === "epic" || draft.projectId !== effectiveProjectId
            ? null
            : epicId,
        labelIds,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const staged = pendingFiles.filter((entry) => entry.status === "staged");
      const failed = await uploadStagedAttachments(staged, {
        taskId: result.task.id,
      });
      if (failed.length > 0) {
        setPendingFiles((files) => settleStagedUploads(files, staged, failed));
        setCreatedTask(result.task);
        return;
      }
      if (createMore) {
        setDraft((current) => ({
          ...current,
          title: "",
          description: "",
          labelIds: [],
          dueDate: "",
        }));
        setPendingFiles([]);
        titleRef.current?.focus();
      } else {
        finish(result.task);
      }
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const selectedLabels = useMemo(
    () => (labels.data ?? []).filter((label) => labelIds.includes(label.id)),
    [labels.data, labelIds],
  );
  const failedCount = pendingFiles.filter(
    (entry) => entry.status === "failed",
  ).length;

  const choosing = step === "choose";

  return (
    <>
    <Dialog open={open && step !== "schedule"} onOpenChange={requestClose}>
      <DialogContent
        className="flex max-h-[85dvh] min-h-0 max-w-xl flex-col gap-0 p-0"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        onPaste={(event) => {
          if (
            event.defaultPrevented ||
            submitting ||
            createdTask !== null ||
            step !== "form"
          )
            return;
          const files = [...(event.clipboardData?.files ?? [])];
          if (files.length === 0) return;
          event.preventDefault();
          stageMore(files);
        }}
      >
        <DialogTitle className="flex shrink-0 items-center gap-2 px-4 pt-4 text-xs font-normal text-muted-foreground">
          {project ? (
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-sm"
              style={{ backgroundColor: project.color }}
            />
          ) : null}
          {choosing ? "Create new" : type === "epic" ? "New epic" : "New task"}
          {project ? ` · ${project.name}` : ""}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {choosing
            ? "Choose whether to create a task, an epic, or a scheduled task."
            : "Create a task with a title, description, attributes, and attachments."}
        </DialogDescription>
        {choosing ? (
          <div
            role="group"
            aria-label="What to create"
            className="flex flex-col gap-2 px-4 pb-1 pt-3"
          >
            {KIND_CHOICES.map((choice) => (
              <button
                key={choice.kind}
                type="button"
                aria-label={choice.label}
                aria-describedby={`new-task-kind-${choice.kind}`}
                onClick={() => chooseKind(choice.kind)}
                className="flex items-start gap-3 rounded-md border border-input p-3 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Icon
                  name={choice.icon}
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{choice.label}</span>
                  <span
                    id={`new-task-kind-${choice.kind}`}
                    className="text-xs text-muted-foreground"
                  >
                    {choice.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {createdTask ? (
          <div className="min-h-0 flex-auto overflow-y-auto px-4 pt-2">
            <p role="alert" className="text-sm">
              Task <span className="font-medium">{createdTask.key}</span> was
              created, but {failedCount} attachment
              {failedCount === 1 ? "" : "s"} failed to upload.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Retry the uploads below, remove a file to skip it, or skip them
              all and open the task.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {pendingFiles.map((entry) => (
                <AttachmentChip
                  key={entry.id}
                  entry={entry}
                  onRemove={() => removeFile(entry.id)}
                  onRetry={
                    entry.status === "failed"
                      ? () => void retryUpload(entry)
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
        {!choosing ? (
        <>
        <div
          className={cn(
            "flex min-h-0 flex-auto flex-col px-4 pt-2",
            createdTask && "hidden",
          )}
        >
          <input
            ref={titleRef}
            autoFocus
            value={title}
            onChange={(event) => {
              const next = event.target.value;
              updateDraft(() => ({ title: next }));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                void submit();
              }
            }}
            placeholder="Task title"
            aria-label="Task title"
            className="w-full shrink-0 bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-muted-foreground"
          />
          <TasksEditor
            variant="comment"
            value={description}
            onChange={(markdown) =>
              updateDraft(() => ({ description: markdown }))
            }
            placeholder="Description — rich text, round-trips as markdown for agents"
            className="mt-2 min-h-16 flex-auto overflow-y-auto"
            onAttachFiles={stageMore}
          />
          {pendingFiles.length > 0 ? (
            <div className="mt-2 flex max-h-24 shrink-0 flex-wrap gap-1.5 overflow-y-auto">
              {pendingFiles.map((entry) => (
                <AttachmentChip
                  key={entry.id}
                  entry={entry}
                  disabled={submitting}
                  onRemove={() => removeFile(entry.id)}
                />
              ))}
            </div>
          ) : null}
          {hasOversized ? (
            <p className="mt-2 shrink-0 text-xs text-destructive">
              Remove attachments over the 25 MB limit before creating the task.
            </p>
          ) : null}
        </div>
        <div className={cn("shrink-0 px-4 pt-3", createdTask && "hidden")}>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border-hairline pb-2">
            <TaskFieldPicker
              dialogOpen={open}
              label="Project"
              value={effectiveProjectId}
              options={projectList.map((entry) => ({
                value: entry.id,
                label: entry.name,
                color: entry.color,
                keywords: [entry.prefix],
              }))}
              onValueChange={changeProject}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-2">
            {type === "task" ? (
              <EpicPicker
                projectId={effectiveProjectId}
                value={epicId}
                onChange={(epicId) => updateDraft(() => ({ epicId }))}
                className={cn(CHIP_TRIGGER, "max-w-64 border border-input")}
              />
            ) : null}
            <TaskFieldPicker<TaskStatus>
              dialogOpen={open}
              label="Status"
              value={status}
              options={statusIds.map((value) => ({
                value,
                label: statusLabel(value),
              }))}
              onValueChange={(status) => updateDraft(() => ({ status }))}
            />
            <TaskFieldPicker<TaskPriority>
              dialogOpen={open}
              label="Priority"
              value={priority}
              options={TASK_PRIORITIES.map((value) => ({
                value,
                label: PRIORITY_LABELS[value],
              }))}
              onValueChange={(priority) => updateDraft(() => ({ priority }))}
            />
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(CHIP_TRIGGER, "border-input font-normal")}
                >
                  {selectedLabels.length === 0 ? (
                    <>
                      <Icon name="Plus" className="size-3" />
                      Labels
                    </>
                  ) : (
                    <>
                      <span className="flex items-center gap-0.5">
                        {selectedLabels.slice(0, 3).map((label) => (
                          <span
                            key={label.id}
                            aria-hidden
                            className="size-2 rounded-full"
                            style={{ backgroundColor: label.color }}
                          />
                        ))}
                      </span>
                      {selectedLabels.length === 1
                        ? selectedLabels[0]!.name
                        : `${selectedLabels.length} labels`}
                    </>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-0" align="start">
                <Command>
                  <CommandInput
                    placeholder="Add labels…"
                    value={labelQuery}
                    onValueChange={setLabelQuery}
                  />
                  <CommandList>
                    <CommandEmpty
                      className={
                        labelQuery.trim() !== "" ? "p-1 text-left" : undefined
                      }
                    >
                      {labelQuery.trim() !== "" ? (
                        <button
                          type="button"
                          disabled={creatingLabel}
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                          onClick={() => void createLabelFromQuery()}
                        >
                          <Icon name="Plus" className="size-3.5" />
                          Create “{labelQuery.trim()}”
                        </button>
                      ) : (
                        "No labels in this project."
                      )}
                    </CommandEmpty>
                    <CommandGroup>
                      {(labels.data ?? []).map((label) => (
                        <CommandItem
                          key={label.id}
                          value={label.name}
                          onSelect={() => toggleLabel(label.id)}
                        >
                          <span
                            aria-hidden
                            className="size-2.5 rounded-full"
                            style={{ backgroundColor: label.color }}
                          />
                          <span className="flex-1">{label.name}</span>
                          {labelIds.includes(label.id) ? (
                            <Icon name="Check" className="size-3.5" />
                          ) : null}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <input
              type="date"
              value={dueDate}
              onChange={(event) => {
                const next = event.target.value;
                updateDraft(() => ({ dueDate: next }));
              }}
              aria-label="Due date"
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
        </>
        ) : null}
        {error || labels.error ? (
          <p
            role="alert"
            className="shrink-0 px-4 pt-2 text-xs text-destructive"
          >
            {error ?? labels.error}
          </p>
        ) : null}
        <DialogFooter className="mt-4 shrink-0 flex-row items-center border-t border-border-hairline px-4 py-3 sm:justify-between">
          {choosing ? (
            <>
              <span />
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
            </>
          ) : createdTask ? (
            <>
              <span />
              <Button size="sm" onClick={() => finish(createdTask)}>
                Skip attachments and open task
              </Button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={submitting}
                  className="text-muted-foreground"
                  onClick={() => setStep("choose")}
                >
                  <Icon name="ArrowLeft" className="size-3.5" />
                  Back
                </Button>
                <CheckboxField
                  checked={createMore}
                  onCheckedChange={setCreateMore}
                  label="Create more"
                />
              </div>
              <div className="flex items-center gap-1.5">
                {hasDraftContent(draft) ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={submitting}
                    className="text-muted-foreground"
                    onClick={discardDraft}
                  >
                    Discard draft
                  </Button>
                ) : null}
                <button
                  type="button"
                  title="Attach files"
                  aria-label="Attach files"
                  disabled={submitting}
                  className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:opacity-50"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="Paperclip" className="size-4" />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  aria-hidden
                  tabIndex={-1}
                  className="hidden"
                  onChange={(event) => {
                    stageMore([...(event.target.files ?? [])]);
                    event.target.value = "";
                  }}
                />
                <Button
                  size="sm"
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  {type === "epic" ? "Create epic" : "Create task"}
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {open && step === "schedule" ? (
      <ScheduleDialog
        scheduleId={null}
        defaultProjectId={effectiveProjectId}
        initialDraft={scheduleDraft}
        onDraftChange={setScheduleDraft}
        onBack={() => setStep("choose")}
        onClose={() => onOpenChange(false)}
        onSaved={() => {
          onOpenChange(false);
          navigation.go({ kind: "scheduled", tab: "all" });
        }}
      />
    ) : null}
    </>
  );
}
