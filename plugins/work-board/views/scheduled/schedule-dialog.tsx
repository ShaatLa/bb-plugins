import { useEffect, useMemo, useState } from "react";
import type { z } from "zod";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { TASK_PRIORITIES, type Task, type TaskPriority } from "../../shared/contract.js";
import {
  createScheduleInputSchema,
  recurrenceSchema,
  scheduledRpcContract,
  type Recurrence,
} from "../../shared/scheduled.js";
import { errorMessage } from "../../shared/errors.js";
import { useMentionItems, usePresets, useProjects, useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { ShareTaskButton } from "../../components/share-task-button";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { StatusIcon } from "../../components/status-icon.js";
import { PRIORITY_LABELS } from "../list/lib.js";
import { CheckboxField, Field } from "../manage/shared.js";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useScheduledQuery, useScheduledRpc, useTasksById, useThreadNames } from "./data.js";
import {
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  browserTimeZone,
  formatInZone,
  isoToZonedLocal,
  supportedTimeZones,
  zonedLocalToIso,
} from "./lib.js";
import { OptionPicker } from "./option-picker.js";

type Kind = Recurrence["kind"];

export interface Draft {
  projectId: string | null;
  title: string;
  description: string;
  priority: TaskPriority;
  dependencyIds: string[];
  kind: Kind;
  time: string;
  weekdays: number[];
  onceLocal: string;
  timezone: string;
  // "unassigned" (imported schedules) is never a valid saved choice; the owner must pick one.
  targetKind: "thread" | "preset" | "unassigned";
  threadId: string;
  presetId: string | null;
  enabled: boolean;
}

function blankDraft(projectId: string | null): Draft {
  return {
    projectId,
    title: "",
    description: "",
    priority: "none",
    dependencyIds: [],
    kind: "daily",
    time: "09:00",
    weekdays: [1, 2, 3, 4, 5],
    onceLocal: "",
    timezone: browserTimeZone(),
    targetKind: "preset",
    threadId: "",
    presetId: null,
    enabled: true,
  };
}

type Detail = z.infer<(typeof scheduledRpcContract)["getSchedule"]["output"]>;

function draftFromDetail(detail: Detail): Draft {
  const { schedule, task } = detail;
  const rule = schedule.rule;
  return {
    ...blankDraft(schedule.projectId),
    title: task.title,
    description: task.description,
    priority: task.priority,
    dependencyIds: detail.dependencyIds,
    kind: rule.kind,
    time: rule.kind === "once" ? "09:00" : rule.time,
    weekdays: rule.kind === "weekly" ? [...rule.weekdays] : [1, 2, 3, 4, 5],
    onceLocal: rule.kind === "once" ? isoToZonedLocal(rule.at, rule.timezone) : "",
    timezone: rule.timezone,
    targetKind: schedule.target.kind,
    threadId: schedule.target.kind === "thread" ? schedule.target.threadId : "",
    presetId: schedule.target.kind === "preset" ? schedule.target.presetId : null,
    enabled: schedule.enabled,
  };
}

export function buildRule(draft: Draft): Recurrence | null {
  let candidate: unknown;
  if (draft.kind === "once") {
    const at = zonedLocalToIso(draft.onceLocal, draft.timezone);
    candidate = at === null ? null : { kind: "once", at, timezone: draft.timezone };
  } else if (draft.kind === "weekly") {
    candidate = { kind: "weekly", time: draft.time, timezone: draft.timezone, weekdays: [...draft.weekdays].sort((a, b) => a - b) };
  } else {
    candidate = { kind: "daily", time: draft.time, timezone: draft.timezone };
  }
  const parsed = recurrenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function buildTarget(draft: Draft) {
  if (draft.targetKind === "unassigned") return null;
  return draft.targetKind === "thread"
    ? { kind: "thread" as const, threadId: draft.threadId.trim() }
    : { kind: "preset" as const, presetId: draft.presetId ?? "" };
}

function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex w-fit items-center rounded-md bg-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded-sm px-2.5 py-0.5 text-xs max-md:pointer-coarse:py-1.5",
            value === option.value ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function DependencyPicker({
  projectId,
  taskIds,
  onChange,
}: {
  projectId: string;
  taskIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<ReadonlyMap<string, Task>>(new Map());
  const fetched = useTasksById(taskIds);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setSearch(input.trim()), 200);
    return () => clearTimeout(timer);
  }, [input, open]);
  const results = useTasksQuery(
    async (rpc) => (await rpc.call("listTasks", { projectId, archive: "all", search, limit: 20 })).tasks,
    [],
    [projectId, search],
    { enabled: open },
  );
  const lookup = (id: string) => picked.get(id) ?? fetched.get(id);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {taskIds.map((id) => {
          const task = lookup(id);
          return (
            <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs">
              <span className="truncate">{task ? `${task.key} · ${task.title}` : id}</span>
              <button
                type="button"
                aria-label={`Remove dependency ${task?.key ?? id}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onChange(taskIds.filter((entry) => entry !== id))}
              >
                <Icon name="X" className="size-3" />
              </button>
            </span>
          );
        })}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-2xs" aria-label="Add predecessor">
              <Icon name="Plus" className="size-3" />
              Add
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-0">
            <Command shouldFilter={false}>
              <CommandInput placeholder="Search task key or title…" value={input} onValueChange={setInput} />
              <CommandList>
                <CommandEmpty>{results.error ?? (results.isFetching ? "Searching…" : "No matching tasks.")}</CommandEmpty>
                <CommandGroup>
                  {(results.data ?? []).filter((row) => !taskIds.includes(row.id)).map((row) => (
                    <CommandItem
                      key={row.id}
                      value={row.id}
                      onSelect={() => {
                        setPicked((current) => new Map(current).set(row.id, row));
                        onChange([...taskIds, row.id]);
                        setOpen(false);
                      }}
                    >
                      <StatusIcon projectId={row.projectId} status={row.status} />
                      <span className="truncate">{row.key} · {row.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      <p className="text-xs text-muted-foreground">Predecessors only warn; they never block a scheduled run.</p>
    </div>
  );
}

function ThreadPicker({ value, onChange }: { value: string; onChange: (threadId: string) => void }) {
  const sdk = useSdk();
  type Threads = Awaited<ReturnType<typeof sdk.threads.list>>;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<Threads>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    sdk.threads.list({ archived: false, limit: 50, offset: 0 }).then(
      (page) => { if (!cancelled) setThreads(page); },
      (cause: unknown) => { if (!cancelled) setError(errorMessage(cause)); },
    );
    return () => { cancelled = true; };
  }, [open, sdk]);
  const titleOf = (thread: Threads[number]) => thread.title ?? thread.titleFallback ?? "Untitled thread";
  const selected = threads.find((thread) => thread.id === value);
  const names = useThreadNames(value ? [value] : []);
  const typedId = /^thr_[A-Za-z0-9_-]+$/.test(query.trim()) ? query.trim() : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label="Target thread" className="h-8 w-full justify-between gap-1.5 border-input px-2 text-xs font-normal">
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value ? (selected ? titleOf(selected) : names.get(value) ?? "Thread unavailable") : "Choose a thread"}</span>
          <Icon name="ChevronDown" className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0">
        <Command>
          <CommandInput placeholder="Filter threads or paste thr_…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{error ?? "No matching threads."}</CommandEmpty>
            <CommandGroup>
              {typedId ? (
                <CommandItem value={typedId} onSelect={() => { onChange(typedId); setOpen(false); }}>
                  Use thread {typedId}
                </CommandItem>
              ) : null}
              {threads.filter((thread) => thread.deletedAt == null && thread.archivedAt == null && thread.visibility !== "hidden").map((thread) => (
                <CommandItem
                  key={thread.id}
                  value={thread.id}
                  keywords={[titleOf(thread)]}
                  onSelect={() => { onChange(thread.id); setOpen(false); }}
                >
                  <span className="min-w-0 flex-1 truncate">{titleOf(thread)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{thread.status}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ScheduleForm({
  initial,
  scheduleId,
  showProjectPicker,
  onClose,
  onSaved,
  onBack,
  onDraftChange,
}: {
  initial: Draft;
  scheduleId: string | null;
  showProjectPicker: boolean;
  onClose: () => void;
  onSaved: () => void;
  onBack?: () => void;
  onDraftChange?: (draft: Draft) => void;
}) {
  const rpc = useScheduledRpc();
  const navigation = useTasksNavigation();
  const mentionItems = useMentionItems();
  const projects = useProjects();
  const presets = usePresets();
  const [draft, setDraft] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ dates: string[]; error: string | null } | null>(null);
  const zones = useMemo(() => supportedTimeZones().map((zone) => ({ value: zone, label: zone })), []);
  const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));
  // Lets an embedding dialog keep the form in memory while it is unmounted (Back).
  useEffect(() => {
    onDraftChange?.(draft);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [draft]);

  const projectId = draft.projectId ?? projects.data?.[0]?.id ?? null;
  const rule = buildRule(draft);
  const ruleKey = JSON.stringify(rule);
  useEffect(() => {
    if (rule === null) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      rpc.call("previewSchedule", { rule, count: 3 }).then(
        ({ dates }) => { if (!cancelled) setPreview({ dates, error: null }); },
        (cause: unknown) => { if (!cancelled) setPreview({ dates: [], error: errorMessage(cause) }); },
      );
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
    // oxlint-disable-next-line react/exhaustive-deps
  }, [ruleKey, rpc]);

  const target = buildTarget(draft);
  const input = {
    title: draft.title.trim(),
    description: draft.description,
    priority: draft.priority,
    dependencyIds: draft.dependencyIds,
    rule,
    target,
    enabled: draft.enabled,
  };
  const valid =
    projectId !== null &&
    target !== null &&
    createScheduleInputSchema.safeParse({ ...input, projectId }).success;

  const submit = async () => {
    if (!valid || rule === null || target === null || projectId === null || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = { ...input, rule, target };
      if (scheduleId === null) await rpc.call("createSchedule", { ...body, projectId });
      else await rpc.call("updateSchedule", { ...body, scheduleId });
      onSaved();
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const project = projects.data?.find((entry) => entry.id === projectId);
  const timeInputClass = "h-8 rounded-md border border-input bg-transparent px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring";
  return (
    <>
      <DialogTitle className="flex shrink-0 items-center gap-2 px-4 pt-4 text-xs font-normal text-muted-foreground">
        {project ? <span aria-hidden className="size-3 shrink-0 rounded-sm" style={{ backgroundColor: project.color }} /> : null}
        {scheduleId === null ? "New schedule" : "Edit schedule"}
        {project ? ` · ${project.name}` : ""}
      </DialogTitle>
      <DialogDescription className="sr-only">
        Create or edit a scheduled task: what to run, when, and which thread or preset receives it.
      </DialogDescription>
      <div className="min-h-0 flex-auto space-y-4 overflow-y-auto px-4 pb-2 pt-2">
        <div className="flex min-h-0 flex-col">
          <input
            autoFocus
            value={draft.title}
            onChange={(event) => set({ title: event.target.value })}
            placeholder="Schedule title"
            aria-label="Schedule title"
            className="w-full bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-muted-foreground"
          />
          <TasksEditor
            variant="comment"
            value={draft.description}
            onChange={(markdown) => set({ description: markdown })}
            mentionItems={mentionItems}
            placeholder="What should the agent do each time? Rich text, round-trips as markdown."
            className="mt-2 min-h-24 overflow-y-auto"
          />
        </div>
        <div className={cn("grid gap-3", showProjectPicker && "@sm:grid-cols-2")}>
          {showProjectPicker ? (
            <Field label="Project">
              <OptionPicker
                label="Project"
                value={projectId}
                options={(projects.data ?? []).map((entry) => ({ value: entry.id, label: entry.name, hint: entry.prefix }))}
                onChange={(id) => set({ projectId: id, dependencyIds: [] })}
              />
            </Field>
          ) : null}
          <Field label="Priority">
            <OptionPicker<TaskPriority>
              label="Priority"
              value={draft.priority}
              options={TASK_PRIORITIES.map((value) => ({ value, label: PRIORITY_LABELS[value] }))}
              onChange={(priority) => set({ priority })}
            />
          </Field>
        </div>
        {projectId !== null ? (
          <Field label="Predecessors">
            <DependencyPicker projectId={projectId} taskIds={draft.dependencyIds} onChange={(dependencyIds) => set({ dependencyIds })} />
          </Field>
        ) : null}

        <Field label="Repeat">
          <div className="space-y-2">
            <Segmented<Kind>
              label="Repeat"
              value={draft.kind}
              options={[
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
                { value: "once", label: "Once" },
              ]}
              onChange={(kind) => set({ kind })}
            />
            {draft.kind === "weekly" ? (
              <div role="group" aria-label="Weekdays" className="flex flex-wrap gap-1">
                {WEEKDAY_ORDER.map((day) => {
                  const on = draft.weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ weekdays: on ? draft.weekdays.filter((entry) => entry !== day) : [...draft.weekdays, day] })}
                      className={cn(
                        "h-7 min-w-10 rounded-md border px-2 text-xs",
                        on ? "border-primary bg-primary/10 text-foreground" : "border-input text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {WEEKDAY_LABELS[day]}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="grid items-center gap-2 @sm:grid-cols-2">
              {draft.kind === "once" ? (
                <input
                  type="datetime-local"
                  aria-label="Run at"
                  value={draft.onceLocal}
                  onChange={(event) => set({ onceLocal: event.target.value })}
                  className={timeInputClass}
                />
              ) : (
                <input
                  type="time"
                  aria-label="Time of day"
                  value={draft.time}
                  onChange={(event) => set({ time: event.target.value })}
                  className={timeInputClass}
                />
              )}
              <OptionPicker label="Time zone" value={draft.timezone} options={zones} onChange={(timezone) => set({ timezone })} />
            </div>
            <div aria-live="polite" className="min-h-[3.75rem] text-xs text-muted-foreground">
              {rule === null ? (
                <p>{draft.kind === "once" ? "Pick a date and time." : draft.kind === "weekly" && draft.weekdays.length === 0 ? "Pick at least one weekday." : "Enter a valid time."}</p>
              ) : preview?.error ? (
                <p role="alert" className="text-destructive">{preview.error}</p>
              ) : preview ? (
                preview.dates.length === 0 ? <p>No upcoming run.</p> : (
                  <>
                    <p className="font-medium text-foreground">Next runs</p>
                    <ul>{preview.dates.map((date) => <li key={date}>{formatInZone(date, draft.timezone)}</li>)}</ul>
                  </>
                )
              ) : <p>Calculating next runs…</p>}
            </div>
          </div>
        </Field>

        <Field label="Run in" hint={draft.targetKind === "unassigned" ? "Choose where this schedule runs before it can be saved or enabled." : draft.targetKind === "thread" ? "Waits in the thread's queue when it is busy. Never replaced silently if the thread is gone." : "Starts a new session with the preset's current settings at every run."}>
          <div className="space-y-2">
            <Segmented<"thread" | "preset" | "unassigned">
              label="Run in"
              value={draft.targetKind}
              options={[
                { value: "preset", label: "New session" },
                { value: "thread", label: "Existing thread" },
              ]}
              onChange={(targetKind) => set({ targetKind })}
            />
            {draft.targetKind === "thread" ? (
              <ThreadPicker value={draft.threadId} onChange={(threadId) => set({ threadId })} />
            ) : draft.targetKind === "unassigned" ? null : (
              <OptionPicker
                label="Preset"
                placeholder="Choose a preset"
                value={draft.presetId}
                options={(presets.data ?? []).map((preset) => ({ value: preset.id, label: preset.name, hint: preset.modelId }))}
                onChange={(presetId) => set({ presetId })}
              />
            )}
          </div>
        </Field>
        {scheduleId !== null ? (
          <p className="text-xs text-muted-foreground">
            Attachments, questions and comments live on the template task.{" "}
            <TemplateLink scheduleId={scheduleId} onOpen={(key) => { onClose(); navigation.go({ kind: "task", taskKey: key }); }} />
          </p>
        ) : null}
      </div>
      {error ? <p role="alert" className="shrink-0 px-4 pt-2 text-xs text-destructive">{error}</p> : null}
      <DialogFooter className="mt-2 shrink-0 flex-row items-center border-t border-border-hairline px-4 py-3 sm:justify-between">
        <CheckboxField checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} label="Enabled" />
        <div className="flex items-center gap-1.5">
          {onBack ? <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={onBack}>Back</Button> : null}
          <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" disabled={!valid || submitting} onClick={() => void submit()}>
            {scheduleId === null ? "Create schedule" : "Save changes"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function TemplateLink({ scheduleId, onOpen }: { scheduleId: string; onOpen: (taskKey: string) => void }) {
  const detail = useScheduledQuery((rpc) => rpc.call("getSchedule", { scheduleId }), [scheduleId]);
  const key = detail.data?.task.key;
  return key ? (
    <><button type="button" className="underline hover:text-foreground" onClick={() => onOpen(key)}>Open template task {key}</button> <ShareTaskButton taskKey={key} /></>
  ) : null;
}

export function ScheduleDialog({
  scheduleId,
  defaultProjectId,
  onClose,
  onSaved,
  initialDraft,
  onBack,
  onDraftChange,
}: {
  scheduleId: string | null;
  defaultProjectId: string | null;
  onClose: () => void;
  onSaved: () => void;
  /** Embedding hooks (New task dialog): restore an in-memory draft, go back, and report edits. */
  initialDraft?: Draft | null;
  onBack?: () => void;
  onDraftChange?: (draft: Draft) => void;
}) {
  const detail = useScheduledQuery(
    async (rpc) => (scheduleId === null ? null : await rpc.call("getSchedule", { scheduleId })),
    [scheduleId],
    { enabled: scheduleId !== null },
  );
  const ready = scheduleId === null || detail.data != null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="@container flex max-h-[88dvh] min-h-0 max-w-2xl flex-col gap-0 p-0">
        {ready ? (
          <ScheduleForm
            initial={detail.data ? draftFromDetail(detail.data) : (initialDraft ?? blankDraft(defaultProjectId))}
            scheduleId={scheduleId}
            showProjectPicker={scheduleId === null && defaultProjectId === null}
            onClose={onClose}
            onSaved={onSaved}
            onBack={onBack}
            onDraftChange={onDraftChange}
          />
        ) : (
          <div className="p-6">
            <DialogTitle className="sr-only">Edit schedule</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              {detail.error ? <span role="alert" className="text-destructive">{detail.error}</span> : "Loading schedule…"}
            </DialogDescription>
            {detail.error ? <Button className="mt-3" size="sm" variant="outline" onClick={onClose}>Close</Button> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
