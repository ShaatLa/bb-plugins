import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Project, Task } from "../../shared/contract.js";
import type { Schedule, ScheduleRun } from "../../shared/scheduled.js";
import { errorMessage } from "../../shared/errors.js";
import { usePresets, useProjects } from "../../shell/data.js";
import { SCHEDULED_TABS, useTasksNavigation, type ScheduledTab } from "../../shell/routes.js";
import { EmptyState } from "../../components/empty-state.js";
import { StatusIcon } from "../../components/status-icon.js";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog, ConfirmDeleteDialogContent } from "@/components/ui/confirm-delete-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useScheduledQuery, useScheduledRpc, useTasksById } from "./data.js";
import {
  RUN_STATE_LABELS,
  describePush,
  describeRule,
  describeTarget,
  executionSummary,
  formatInZone,
  newIdempotencyKey,
  runActions,
  scheduleStatus,
  browserTimeZone,
} from "./lib.js";
import { OptionPicker } from "./option-picker.js";
import { ScheduleDialog } from "./schedule-dialog.js";

const PAGE_SIZE = 25;
const TAB_LABELS: Record<ScheduledTab, string> = {
  all: "All",
  attention: "Needs attention",
  results: "Results",
  history: "History",
};
const ALL_PROJECTS = "__all__";

// ---- actions ------------------------------------------------------------------------------

/** Runs one management call at a time and keeps failures visible instead of swallowing them. */
function useActions(refresh: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const perform = async (id: string, action: () => Promise<unknown>) => {
    if (busy !== null) return;
    setBusy(id);
    setError(null);
    try {
      await action();
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, perform, dismissError: () => setError(null) };
}
type Actions = ReturnType<typeof useActions>;

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button type="button" aria-label="Dismiss error" className="shrink-0 hover:opacity-70" onClick={onDismiss}>
        <Icon name="X" className="size-3.5" />
      </button>
    </div>
  );
}

// ---- small shared pieces ------------------------------------------------------------------

function Badge({ tone = "muted", children }: { tone?: "muted" | "warning" | "danger" | "success"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-2xs font-medium",
        tone === "muted" && "border-border text-muted-foreground",
        tone === "warning" && "border-warning/40 text-warning",
        tone === "danger" && "border-destructive/40 text-destructive",
        tone === "success" && "border-success/40 text-success",
      )}
    >
      {children}
    </span>
  );
}

function runTone(state: ScheduleRun["state"]): "muted" | "warning" | "danger" | "success" {
  if (state === "failed") return "danger";
  if (state === "skipped" || state === "delivery_unknown" || state === "cancel_pending") return "warning";
  if (state === "completed" || state === "running") return "success";
  return "muted";
}

function LinkButton({ children, onClick, label }: { children: ReactNode; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="max-w-full truncate text-left text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function ListSkeleton() {
  return (
    <DelayedLoading>
      <div className="space-y-px">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-[4.5rem] space-y-2 border-b border-border-hairline px-4 py-3">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

/** Previous/next over offset cursors; the page stack resets when the owning list is remounted. */
function usePager() {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  return {
    cursor: cursors[cursors.length - 1],
    page: cursors.length,
    next: (cursor: string) => setCursors((current) => [...current, cursor]),
    previous: () => setCursors((current) => (current.length > 1 ? current.slice(0, -1) : current)),
  };
}

function Pager({ pager, nextCursor }: { pager: ReturnType<typeof usePager>; nextCursor: string | null | undefined }) {
  if (pager.page === 1 && !nextCursor) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-4 py-3 text-xs text-muted-foreground">
      <span className="tabular-nums">Page {pager.page}</span>
      <Button type="button" variant="outline" size="sm" className="h-7" disabled={pager.page === 1} onClick={pager.previous}>
        Previous
      </Button>
      <Button type="button" variant="outline" size="sm" className="h-7" disabled={!nextCursor} onClick={() => nextCursor && pager.next(nextCursor)}>
        Next
      </Button>
    </div>
  );
}

interface ListProps {
  projectId: string | null;
  search: string;
  projects: ReadonlyMap<string, Project>;
  onEdit: (scheduleId: string) => void;
  // The visible list publishes its refresh so a saved dialog can update it in place.
  refreshRef: MutableRefObject<(() => void) | null>;
}

function ListState({ error, loading, empty, emptyText, children }: { error: string | null; loading: boolean; empty: boolean; emptyText: string; children: ReactNode }) {
  if (loading) return <ListSkeleton />;
  if (error) return <p role="alert" className="p-4 text-sm text-destructive">{error}</p>;
  if (empty) return <div className="grid flex-1 place-items-center"><EmptyState icon="Clock" title={emptyText} /></div>;
  return <>{children}</>;
}

function ProjectChip({ project }: { project: Project | undefined }) {
  if (!project) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: project.color }} />
      <span className="truncate">{project.name}</span>
    </span>
  );
}

// ---- schedules ----------------------------------------------------------------------------

function SchedulesList({ projectId, search, projects, onEdit, refreshRef }: ListProps) {
  const pager = usePager();
  const navigation = useTasksNavigation();
  const rpc = useScheduledRpc();
  const presets = usePresets();
  const query = useScheduledQuery(
    (client) => client.call("listSchedules", { limit: PAGE_SIZE, ...(projectId ? { projectId } : {}), ...(search ? { search } : {}), ...(pager.cursor ? { cursor: pager.cursor } : {}) }),
    [projectId, search, pager.cursor],
  );
  refreshRef.current = query.refresh;
  const actions = useActions(query.refresh);
  const templates = useTasksById((query.data?.schedules ?? []).map((schedule) => schedule.templateTaskId));
  const presetName = (id: string) => presets.data?.find((preset) => preset.id === id)?.name;
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const schedules = query.data?.schedules ?? [];
  return (
    <>
      {actions.error ? <ErrorBanner message={actions.error} onDismiss={actions.dismissError} /> : null}
      <ListState
        error={query.error && query.data === undefined ? query.error : null}
        loading={query.data === undefined && query.error === null}
        empty={schedules.length === 0}
        emptyText={search || projectId ? "No schedules match these filters." : "No schedules yet"}
      >
        <ul>
          {schedules.map((schedule) => {
            const status = scheduleStatus(schedule);
            const template: Task | undefined = templates.get(schedule.templateTaskId);
            return (
              <li key={schedule.id} className="space-y-1.5 border-b border-border-hairline px-4 py-3" data-schedule-id={schedule.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{schedule.title}</span>
                  <Badge tone={status === "active" ? "success" : "muted"}>{status === "active" ? "Enabled" : status === "paused" ? "Paused" : "No future runs"}</Badge>
                  {schedule.target.kind === "unassigned" ? <Badge tone="warning">Choose target</Badge> : null}
                  {schedule.overlapRunIds.length > 0 ? <Badge tone="warning">Overlaps {schedule.overlapRunIds.length} unfinished</Badge> : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <ProjectChip project={projects.get(schedule.projectId)} />
                  <span>{describeRule(schedule.rule)}</span>
                  <span>{describeTarget(schedule, presetName)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">
                    {schedule.nextDueAt ? `Next: ${formatInZone(schedule.nextDueAt, schedule.rule.timezone)}` : status === "paused" ? "Paused — no future runs" : "No upcoming run"}
                  </span>
                  {template ? <LinkButton onClick={() => navigation.go({ kind: "task", taskKey: template.key })}>Template {template.key}</LinkButton> : null}
                </div>
                {schedule.overlapRunIds.length > 0 ? <OverlapLinks scheduleId={schedule.id} runIds={schedule.overlapRunIds} /> : null}
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <Button type="button" size="sm" variant="outline" className="h-7" disabled={actions.busy !== null || schedule.target.kind === "unassigned"} onClick={() => void actions.perform(`run:${schedule.id}`, () => rpc.call("runSchedule", { scheduleId: schedule.id, idempotencyKey: newIdempotencyKey() }))}>
                    <Icon name="Play" className="size-3.5" />
                    Run now
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="h-7" disabled={actions.busy !== null || (!schedule.enabled && schedule.target.kind === "unassigned")} onClick={() => void actions.perform(`toggle:${schedule.id}`, () => rpc.call("setScheduleEnabled", { scheduleId: schedule.id, enabled: !schedule.enabled }))}>
                    <Icon name={schedule.enabled ? "Pause" : "Play"} className="size-3.5" />
                    {schedule.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => onEdit(schedule.id)}>
                    <Icon name="Edit" className="size-3.5" />
                    Edit
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`More actions for ${schedule.title}`}>
                        <Icon name="MoreHorizontal" className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={!template} onSelect={() => template && navigation.go({ kind: "task", taskKey: template.key })}>
                        Open template task
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleting(schedule)}>
                        Delete schedule…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      </ListState>
      <Pager pager={pager} nextCursor={query.data?.nextCursor} />
      <ConfirmDeleteDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        {deleting ? (
          <ConfirmDeleteDialogContent
            title={`Delete “${deleting.title}”?`}
            description="Queued runs are canceled first and the schedule is only removed once that succeeds. Running agents keep going; past results stay available."
            confirmLabel="Delete schedule"
            pending={actions.busy !== null}
            onCancel={() => setDeleting(null)}
            onConfirm={() => {
              const target = deleting;
              setDeleting(null);
              void actions.perform(`delete:${target.id}`, async () => {
                const { deleted } = await rpc.call("deleteSchedule", { scheduleId: target.id });
                if (!deleted) throw new Error(`“${target.title}” was not deleted. Check its queued runs under Needs attention.`);
              });
            }}
          />
        ) : null}
      </ConfirmDeleteDialog>
    </>
  );
}

/** Advisory only: lists earlier unfinished results so the owner can judge the overlap. */
function OverlapLinks({ scheduleId, runIds }: { scheduleId: string; runIds: readonly string[] }) {
  const navigation = useTasksNavigation();
  const runs = useScheduledQuery((rpc) => rpc.call("listScheduleRuns", { scheduleId, limit: 100 }), [scheduleId]);
  const overlapping = (runs.data?.runs ?? []).filter((run) => runIds.includes(run.id));
  const tasks = useTasksById(overlapping.flatMap((run) => (run.taskId ? [run.taskId] : [])));
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-xs text-warning">
      <span>Earlier runs are unfinished (advisory, the run is not blocked):</span>
      {overlapping.map((run) => {
        const task = run.taskId ? tasks.get(run.taskId) : undefined;
        return task ? (
          <LinkButton key={run.id} onClick={() => navigation.go({ kind: "task", taskKey: task.key })}>{task.key}</LinkButton>
        ) : (
          <span key={run.id}>{RUN_STATE_LABELS[run.state]} run</span>
        );
      })}
    </p>
  );
}

// ---- runs (needs attention + history) -----------------------------------------------------

function DismissDialog({ run, onClose, onSubmit }: { run: ScheduleRun; onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("Dismissed from Scheduled.");
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Dismiss {RUN_STATE_LABELS[run.state].toLowerCase()} run</DialogTitle>
          <DialogDescription>
            {run.state === "delivery_unknown" || run.state === "cancel_pending"
              ? "The outcome is unknown. Dismissing only records your note; it does not prove the work did not run."
              : "Records your note and removes the run from Needs attention."}
          </DialogDescription>
        </DialogHeader>
        <Textarea aria-label="Resolution note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" disabled={note.trim() === ""} onClick={() => onSubmit(note.trim())}>Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunsList({ attention, projectId, search, projects, onEdit, refreshRef }: ListProps & { attention: boolean }) {
  const pager = usePager();
  const navigation = useTasksNavigation();
  const navigate = useBbNavigate();
  const rpc = useScheduledRpc();
  const query = useScheduledQuery(
    (client) => client.call("listScheduleRuns", { limit: PAGE_SIZE, ...(attention ? { needsAttention: true } : {}), ...(projectId ? { projectId } : {}), ...(search ? { search } : {}), ...(pager.cursor ? { cursor: pager.cursor } : {}) }),
    [attention, projectId, search, pager.cursor],
  );
  refreshRef.current = query.refresh;
  const actions = useActions(query.refresh);
  const runs = query.data?.runs ?? [];
  const tasks = useTasksById(runs.flatMap((run) => (run.taskId ? [run.taskId] : [])));
  const [dismissing, setDismissing] = useState<ScheduleRun | null>(null);
  return (
    <>
      {actions.error ? <ErrorBanner message={actions.error} onDismiss={actions.dismissError} /> : null}
      <ListState
        error={query.error && query.data === undefined ? query.error : null}
        loading={query.data === undefined && query.error === null}
        empty={runs.length === 0}
        emptyText={attention ? "Nothing needs attention" : "No run history"}
      >
        <ul>
          {runs.map((run) => {
            const available = runActions(run);
            const task = run.taskId ? tasks.get(run.taskId) : undefined;
            const push = describePush(run);
            const execution = executionSummary(run);
            return (
              <li key={run.id} className="space-y-1.5 border-b border-border-hairline px-4 py-3" data-run-id={run.id} data-run-state={run.state}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{run.scheduleTitle}</span>
                  <Badge tone={runTone(run.state)}>{RUN_STATE_LABELS[run.state]}</Badge>
                  {run.missCount > 1 ? <Badge tone="warning">Missed {run.missCount}×</Badge> : null}
                  {run.resolvedAt ? <Badge>Resolved</Badge> : null}
                  {run.historical ? <Badge>Imported</Badge> : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <ProjectChip project={projects.get(run.projectId)} />
                  <span>Scheduled {formatInZone(run.scheduledFor, browserTimeZone())}</span>
                  {run.startedAt ? <span>Started {formatInZone(run.startedAt, browserTimeZone())}</span> : null}
                </div>
                {run.reason ? <p className="text-xs text-foreground">{run.reason}</p> : null}
                {push ? <p className={cn("text-xs", run.pushState === "failed" ? "text-destructive" : "text-muted-foreground")}>{push}</p> : null}
                {execution.length > 0 ? <p className="truncate text-xs text-muted-foreground">Applied {execution.join(" · ")}</p> : null}
                {run.overlapRunIds.length > 0 ? <OverlapLinks scheduleId={run.scheduleId} runIds={run.overlapRunIds} /> : null}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {task ? <LinkButton onClick={() => navigation.go({ kind: "task", taskKey: task.key })}>{task.key} · {task.title}</LinkButton> : null}
                  {run.threadId ? <LinkButton label={`Open thread ${run.threadId}`} onClick={() => navigate.toThread(run.threadId!)}>Open thread</LinkButton> : null}
                </div>
                {available.retry || available.resolve || available.cancel ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {available.retry ? (
                      <Button type="button" size="sm" variant="outline" className="h-7" disabled={actions.busy !== null} onClick={() => void actions.perform(`retry:${run.id}`, () => rpc.call("retryScheduleRun", { runId: run.id, idempotencyKey: newIdempotencyKey() }))}>
                        <Icon name="RotateCcw" className="size-3.5" />
                        Retry
                      </Button>
                    ) : null}
                    {available.retry ? (
                      <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => onEdit(run.scheduleId)}>
                        <Icon name="Clock" className="size-3.5" />
                        Reschedule
                      </Button>
                    ) : null}
                    {available.cancel ? (
                      <Button type="button" size="sm" variant="outline" className="h-7" disabled={actions.busy !== null} onClick={() => void actions.perform(`cancel:${run.id}`, () => rpc.call("cancelScheduleRun", { runId: run.id }))}>
                        <Icon name="X" className="size-3.5" />
                        Cancel queued run
                      </Button>
                    ) : null}
                    {available.resolve ? (
                      <Button type="button" size="sm" variant="ghost" className="h-7" disabled={actions.busy !== null} onClick={() => setDismissing(run)}>
                        Dismiss
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </ListState>
      <Pager pager={pager} nextCursor={query.data?.nextCursor} />
      {dismissing ? (
        <DismissDialog
          run={dismissing}
          onClose={() => setDismissing(null)}
          onSubmit={(note) => {
            const target = dismissing;
            setDismissing(null);
            void actions.perform(`resolve:${target.id}`, () => rpc.call("resolveScheduleRun", { runId: target.id, note }));
          }}
        />
      ) : null}
    </>
  );
}

// ---- results ------------------------------------------------------------------------------

function ResultsList({ projectId, search, projects, refreshRef }: ListProps) {
  const pager = usePager();
  const navigation = useTasksNavigation();
  const query = useScheduledQuery(
    (client) => client.call("listScheduleResults", { limit: PAGE_SIZE, ...(projectId ? { projectId } : {}), ...(search ? { search } : {}), ...(pager.cursor ? { cursor: pager.cursor } : {}) }),
    [projectId, search, pager.cursor],
    { channels: ["schedules:changed", "tasks:changed"] },
  );
  refreshRef.current = query.refresh;
  const results = query.data?.results ?? [];
  return (
    <>
      <ListState
        error={query.error && query.data === undefined ? query.error : null}
        loading={query.data === undefined && query.error === null}
        empty={results.length === 0}
        emptyText="No results yet"
      >
        <ul>
          {results.map(({ task, source }) => (
            <li key={task.id} className="space-y-1.5 border-b border-border-hairline px-4 py-3" data-result-key={task.key}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusIcon projectId={task.projectId} status={task.status} />
                <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline" onClick={() => navigation.go({ kind: "task", taskKey: task.key })}>
                  {task.key} · {task.title}
                </button>
                <Badge>{source.role === "one_time_run" ? "One-time" : "Recurring"}</Badge>
                {source.startedAt === null ? <Badge tone="warning">Not started</Badge> : null}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <ProjectChip project={projects.get(task.projectId)} />
                <span>From “{source.scheduleTitle}”</span>
                {source.scheduledFor ? <span>Scheduled {formatInZone(source.scheduledFor, browserTimeZone())}</span> : null}
                {source.startedAt ? <span>Started {formatInZone(source.startedAt, browserTimeZone())}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </ListState>
      <Pager pager={pager} nextCursor={query.data?.nextCursor} />
    </>
  );
}

// ---- page ---------------------------------------------------------------------------------

export function ScheduledView({ tab }: { tab: ScheduledTab }) {
  const navigation = useTasksNavigation();
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<{ scheduleId: string | null; key: number } | null>(null);
  const refreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const projectMap = useMemo(() => new Map((projects.data ?? []).map((project) => [project.id, project])), [projects.data]);
  const listProps: ListProps = { projectId, search, projects: projectMap, onEdit: (scheduleId) => setDialog({ scheduleId, key: Date.now() }), refreshRef };
  // Changing any filter remounts the list so its page stack starts over.
  const listKey = `${tab}|${projectId ?? ""}|${search}`;
  return (
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-hairline px-4 py-3">
        <div role="tablist" aria-label="Scheduled sections" className="flex items-center rounded-md bg-muted p-0.5">
          {SCHEDULED_TABS.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => navigation.go({ kind: "scheduled", tab: value })}
              className={cn(
                "rounded-sm px-2.5 py-0.5 text-xs max-md:pointer-coarse:py-1.5",
                tab === value ? "bg-background text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {TAB_LABELS[value]}
            </button>
          ))}
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          <div className="w-40">
            <OptionPicker
              label="Project"
              value={projectId ?? ALL_PROJECTS}
              options={[{ value: ALL_PROJECTS, label: "All projects" }, ...(projects.data ?? []).map((project) => ({ value: project.id, label: project.name, hint: project.prefix }))]}
              onChange={(value) => setProjectId(value === ALL_PROJECTS ? null : value)}
            />
          </div>
          <Input aria-label="Search scheduled work" placeholder="Search…" className="h-8 w-44 text-xs" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
          <Button type="button" size="sm" className="h-8 gap-1.5" onClick={() => setDialog({ scheduleId: null, key: Date.now() })}>
            <Icon name="Plus" className="size-3.5" />
            New schedule
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {tab === "all" ? <SchedulesList key={listKey} {...listProps} /> : null}
        {tab === "attention" ? <RunsList key={listKey} attention {...listProps} /> : null}
        {tab === "history" ? <RunsList key={listKey} attention={false} {...listProps} /> : null}
        {tab === "results" ? <ResultsList key={listKey} {...listProps} /> : null}
      </div>
      {dialog ? (
        <ScheduleDialog
          key={dialog.key}
          scheduleId={dialog.scheduleId}
          defaultProjectId={projectId}
          onClose={() => setDialog(null)}
          onSaved={() => refreshRef.current?.()}
        />
      ) : null}
    </div>
  );
}
