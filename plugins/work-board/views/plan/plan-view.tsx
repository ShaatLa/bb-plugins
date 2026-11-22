import { useEffect, useMemo, useRef, useState } from "react";
import { experimental_copyToClipboard, experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Task } from "../../shared/contract.js";
import { parseHeadings } from "../../shared/plan.js";
import { taskPlanMarkdownLink } from "../../shared/task-link.js";
import { useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { useOpenThread } from "../../components/open-thread.js";
import { TASK_TAB } from "../embed/index.js";
import { formatRelativeTime } from "../activity/time.js";
import { ACTIVE_NOTE_HIGHLIGHT, NOTE_HIGHLIGHT, NOTE_HIGHLIGHT_CSS, paintHighlight, rangeOfSpan, useBodyText } from "./anchors.js";
import { ActorLabel, ThreadChip } from "../../components/thread-chip.js";
import { planDrafts, usePlanBody, usePlanning, usePlanOverview } from "./data.js";
import { PlanDiffView } from "./diff-view.js";
import { PlanEditor } from "./editor.js";
import { useActiveHeading, useRenderedHeadings } from "./headings.js";
import { PlanHistory } from "./history.js";
import { deliveryNotice, usePlacements, usePlanNotes, usePlanReviewActions } from "./notes-data.js";
import { PlanNotesList } from "./notes-panel.js";
import { subscribePlanEditRequests, takePlanEditRequest } from "./open.js";
import { PlanRail, type RailTab } from "./rail.js";
import { ApproveButton, GeneralNoteButton, SendFeedbackButton } from "./review-actions.js";
import { CommentPopover, SelectionToolbar, useBodySelection, type Selected } from "./selection-toolbar.js";
import { PlanStateChip } from "./state-chip.js";
import { PlanToc } from "./toc.js";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type Mode = "read" | "compare" | "edit";

const noop = () => {};

/** A compact, borderless version picker: `v3`, with "current" muted for the newest. */
function VersionSelect({ label, value, versions, current, onChange }: { label: string; value: number; versions: readonly number[]; current: number; onChange: (version: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger aria-label={label} className="h-7 w-auto gap-1 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-state-hover">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {versions.map((version) => (
          <SelectItem key={version} value={String(version)}>
            v{version}
            {version === current ? <span className="text-muted-foreground"> current</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A ghost icon button with a tooltip, like the buttons of the Work Board top bar. */
function ActionButton({ label, icon, fallback, tooltip = label, pressed, disabled, onClick }: { label: string; icon: string; fallback?: string; tooltip?: string; pressed?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>
          {/* The span keeps the tooltip reachable when the button is disabled. */}
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn("size-7 shrink-0 text-muted-foreground hover:text-foreground", pressed && "bg-state-hover text-foreground")}
              aria-label={label}
              aria-pressed={pressed}
              disabled={disabled}
              onClick={onClick}
            >
              <Icon name={icon} fallback={fallback} className="size-3.5" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PlanSkeleton() {
  return (
    <DelayedLoading>
      <div className="space-y-2 p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </DelayedLoading>
  );
}

/**
 * A task's plan: reading with a table of contents, version history and compare, and editing by a person.
 * It is the content of the Plan side panel tab (`panel`) and of the plan route in the main area (`page`).
 */
export function PlanView({ taskKey, surface }: { taskKey: string; surface: "panel" | "page" }) {
  // Every way into the plan (a persisted tab, an old link, a setting changed while it is open) passes this check.
  // One read serves both this gate and the body; once the task id is known, only its own changes refetch.
  const [loaded, setLoaded] = useState<{ key: string; id: string } | undefined>();
  const task = useTasksQuery(
    async (rpc) => (await rpc.call("getTaskByKey", { taskKey })).task,
    ["tasks:changed"],
    [taskKey],
    { relevantTaskIds: loaded?.key === taskKey ? [loaded.id] : undefined },
  );
  const taskId = task.data?.id;
  useEffect(() => setLoaded(taskId === undefined ? undefined : { key: taskKey, id: taskId }), [taskKey, taskId]);
  const planning = usePlanning(task.data?.projectId ?? null);
  if (task.error && task.data === undefined) return <PlanError message={task.error} onRetry={task.refresh} />;
  // The body mounts once, after the setting is known, so a pending "Write plan" request is not lost to a remount.
  if (task.data === undefined || (task.data !== null && planning === undefined)) return <PlanSkeleton />;
  if (planning === "off") return <p role="status" className="p-4 text-sm text-muted-foreground">Planning is off for this project</p>;
  return <PlanViewBody taskKey={taskKey} surface={surface} task={task} />;
}

function PlanError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="space-y-3 p-4 text-sm"><p className="text-destructive">{message}</p><Button variant="outline" size="sm" onClick={onRetry}>Retry</Button></div>;
}

function PlanViewBody({ taskKey, surface, task }: { taskKey: string; surface: "panel" | "page"; task: ReturnType<typeof useTasksQuery<Task | null>> }) {
  const navigate = useBbNavigate();
  const navigation = useTasksNavigation();
  const panel = experimental_useAppPanel();
  const openThread = useOpenThread();

  const taskId = task.data?.id ?? null;
  const overview = usePlanOverview(taskId);
  const head = overview.data?.plan ?? null;
  const versions = overview.data?.versions ?? [];
  const headVersion = head?.version ?? 0;

  const [mode, setMode] = useState<Mode>("read");
  /** The older version on screen; null follows the current one. */
  const [viewing, setViewing] = useState<number | null>(null);
  const [compare, setCompare] = useState({ from: 0, to: 0 });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [followed, setFollowed] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [, rerender] = useState(0);

  const following = viewing === null && mode === "read";
  useEffect(() => {
    if (following) setFollowed(headVersion);
  }, [following, headVersion]);
  // The version that was current when the reader left "current" is the one they are looking past.
  const newerVersion = !following && headVersion > followed ? headVersion : null;
  const viewedVersion = viewing !== null && viewing < headVersion ? viewing : null;
  const target = viewedVersion ?? (headVersion > 0 ? headVersion : null);

  const headBody = usePlanBody(taskId, headVersion > 0 ? headVersion : null);
  const olderBody = usePlanBody(taskId, viewedVersion);
  const readBody = viewedVersion === null ? headBody : olderBody;
  const compareFrom = usePlanBody(taskId, mode === "compare" ? compare.from : null);
  const compareTo = usePlanBody(taskId, mode === "compare" ? compare.to : null);

  // Keep showing what is on screen until the next body has arrived, so a live update never blanks the page.
  const [shown, setShown] = useState<{ taskId: string; version: number; body: string } | null>(null);
  useEffect(() => {
    if (taskId !== null && target !== null && readBody.body !== undefined) setShown({ taskId, version: target, body: readBody.body });
  }, [taskId, target, readBody.body]);
  const display = shown !== null && shown.taskId === taskId ? shown : null;

  const headings = useMemo(() => parseHeadings(display?.body ?? ""), [display?.body]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const elements = useRenderedHeadings(bodyRef, headings, `${mode}:${display?.version}`);
  const [active, setActive] = useActiveHeading(scrollRef, elements);

  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async (text: string, done: string) => {
    try {
      setCopied((await experimental_copyToClipboard({ text })) ? done : "Could not copy");
    } catch {
      setCopied("Could not copy");
    }
  };

  const archived = Boolean(task.data?.archivedAt);

  // Owner notes: anchored by quote in the text on screen, highlighted without touching the editor DOM.
  const notesQuery = usePlanNotes(taskId);
  const allNotes = useMemo(() => notesQuery.data?.notes ?? [], [notesQuery.data]);
  // Drafts are scoped per author: the owner sends and counts only their own; a reviewer thread's drafts are not theirs to send.
  const draftCount = allNotes.filter((note) => note.state === "draft" && note.authorKind === "person").length;
  const showsBody = mode === "read" && display !== null;
  const bodyText = useBodyText(bodyRef, `${mode}:${display?.version}`);
  const placements = usePlacements(allNotes, bodyText, showsBody);
  const canReview = head !== null && mode === "read" && viewedVersion === null && !archived;
  const canAnnotate = canReview && display !== null && display.version === headVersion;
  const actions = usePlanReviewActions(taskId, () => {
    notesQuery.refresh();
    overview.refresh();
  });
  const [selected, clearSelected] = useBodySelection(bodyRef, canAnnotate, elements, headings);
  const [pending, setPending] = useState<Selected | null>(null);
  // Until the reader chooses, the notes are what to look at when there are drafts to send, or nothing yet to look at.
  const [railChoice, setRailTab] = useState<RailTab | null>(null);
  const [notesChoice, setNotesOpen] = useState<boolean | null>(null);
  const railTab: RailTab = railChoice ?? (draftCount > 0 ? "notes" : "contents");
  const notesOpen = notesChoice ?? (draftCount > 0 || (canReview && allNotes.length === 0));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pulse, setPulse] = useState<string | null>(null);
  const [review, setReview] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const activeNote = pulse ?? hovered;

  useEffect(() => {
    const root = bodyRef.current;
    const ranges = root && placements ? allNotes.flatMap((note) => {
      const span = note.state === "resolved" ? null : placements.get(note.id);
      const range = span ? rangeOfSpan(root, span) : null;
      return range ? [range] : [];
    }) : [];
    paintHighlight(NOTE_HIGHLIGHT, ranges);
  }, [allNotes, placements, display?.version, mode]);
  useEffect(() => {
    const root = bodyRef.current;
    const span = activeNote ? placements?.get(activeNote) : null;
    const range = root && span ? rangeOfSpan(root, span) : null;
    paintHighlight(ACTIVE_NOTE_HIGHLIGHT, range ? [range] : []);
  }, [activeNote, placements, mode]);
  useEffect(() => () => {
    paintHighlight(NOTE_HIGHLIGHT, []);
    paintHighlight(ACTIVE_NOTE_HIGHLIGHT, []);
  }, []);
  useEffect(() => {
    if (pulse === null) return;
    const timer = window.setTimeout(() => setPulse(null), 1600);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  const showNotes = () => {
    setRailTab("notes");
    setNotesOpen(true);
  };
  const jumpToNote = (noteId: string) => {
    const span = placements?.get(noteId);
    const range = bodyRef.current && span ? rangeOfSpan(bodyRef.current, span) : null;
    if (!range) return;
    range.startContainer.parentElement?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    setPulse(noteId);
  };
  const anchorFields = (found: Selected) => ({ exact: found.anchor.exact, prefix: found.anchor.prefix, suffix: found.anchor.suffix, headingPath: found.headingPath, madeOnVersion: display?.version });
  const pickKind = async (kind: "comment" | "remove") => {
    if (!selected) return;
    clearSelected();
    if (kind === "comment") return setPending(selected);
    // A removal needs no text; its reason is optional and is asked in the list right away.
    const result = await actions.create({ kind: "remove", body: "", ...anchorFields(selected) });
    if (result.ok) {
      showNotes();
      setEditingId(result.note.id);
    } else setReview({ tone: "warn", text: result.message });
  };
  const addComment = async (body: string) => {
    if (!pending) return null;
    const result = await actions.create({ kind: "comment", body, ...anchorFields(pending) });
    if (!result.ok) return result.message;
    setPending(null);
    showNotes();
    return null;
  };
  const addGeneral = async (body: string) => {
    const result = await actions.create({ kind: "general", body, madeOnVersion: headVersion });
    if (!result.ok) return result.message;
    showNotes();
    return null;
  };
  const sendFeedback = async () => {
    setSending(true);
    const result = await actions.send();
    setSending(false);
    setReview(result.ok ? deliveryNotice(result, "Feedback", { key: taskKey, version: result.version, verdict: "needs changes" }) : { tone: "warn", text: result.message });
  };
  const approve = async (note: string) => {
    const result = await actions.approve(note);
    if (!result.ok) return result.message;
    setReview(deliveryNotice(result, "Approval", { key: taskKey, version: result.version, verdict: "is approved" }));
    return null;
  };

  const startEdit = () => {
    setMode("edit");
    setViewing(null);
  };
  // Edit, and "Write plan" elsewhere, ask for editing; it starts as soon as there is a text to edit.
  const [wantsEdit, setWantsEdit] = useState(() => takePlanEditRequest(taskKey));
  useEffect(() => subscribePlanEditRequests(() => { if (takePlanEditRequest(taskKey)) setWantsEdit(true); }), [taskKey]);
  const editReady = taskId !== null && overview.data !== undefined && (head === null || headBody.body !== undefined);
  useEffect(() => {
    if (!wantsEdit || !editReady) return;
    setWantsEdit(false);
    if (!archived) startEdit();
  }, [wantsEdit, editReady, archived]);

  const openTask = () => {
    if (surface === "panel" && panel.openTab({ tab: TASK_TAB, target: { taskKey } })) return;
    navigation.go({ kind: "task", taskKey });
  };
  const showVersion = (version: number) => {
    setMode("read");
    setViewing(version >= headVersion ? null : version);
  };
  const showCurrent = () => {
    setMode("read");
    setViewing(null);
  };

  const versionNumbers = versions.map((version) => version.version);
  const shownVersion = versions.find((version) => version.version === (target ?? headVersion));
  const meta = shownVersion ? { name: shownVersion.author.name, threadId: shownVersion.author.threadId, at: shownVersion.createdAt } : head ? { name: head.updatedBy.name, threadId: head.updatedBy.threadId, at: head.updatedAt } : null;
  const menu = (
    <DropdownMenu>
      <TooltipProvider delayDuration={300}>
        <Tooltip disableHoverableContent>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" aria-label="Plan actions">
                <Icon name="MoreHorizontal" className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Plan actions</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={display === null} onSelect={() => display && void copy(display.body, "Markdown copied")}>Copy Markdown</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copy(taskPlanMarkdownLink(task.data?.key ?? taskKey), "Link copied")}>Copy link</DropdownMenuItem>
        <DropdownMenuItem onSelect={openTask}>Open task</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // On a narrow panel the row wraps: the badge stays with the title, the version and actions stay together on the right.
  const header = (
    <header className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-48 flex-1 items-center gap-2">
          {surface === "page" ? (
            <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Back to ${taskKey}`} onClick={openTask}>
              <Icon name="ArrowLeft" className="size-4" />
            </Button>
          ) : null}
          <button
            type="button"
            title="Open task"
            className="min-w-0 truncate rounded-sm text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={openTask}
          >
            <span className="text-muted-foreground">{task.data?.key ?? taskKey}</span>
            {task.data ? <span> {task.data.title}</span> : null}
          </button>
          {head ? <PlanStateChip state={head.state} /> : null}
          {head && overview.data?.paused ? <span role="status" className="shrink-0 text-xs text-warning">Waiting for the owner's decision</span> : null}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          {head && mode === "compare" ? (
            <>
              <VersionSelect label="Compare from" value={compare.from} versions={versionNumbers} current={headVersion} onChange={(from) => setCompare({ ...compare, from })} />
              <span aria-hidden className="text-xs text-muted-foreground">→</span>
              <VersionSelect label="Compare to" value={compare.to} versions={versionNumbers} current={headVersion} onChange={(to) => setCompare({ ...compare, to })} />
              <ActionButton label="Close compare" icon="X" onClick={() => setMode("read")} />
            </>
          ) : head && mode !== "edit" ? (
            <>
              <VersionSelect label="Plan version" value={target ?? headVersion} versions={[...versionNumbers].reverse()} current={headVersion} onChange={showVersion} />
              {!archived && viewedVersion === null ? <ActionButton label="Edit" icon="Edit" onClick={() => setWantsEdit(true)} /> : null}
              <ActionButton label="History" icon="History" fallback="Clock" pressed={historyOpen} onClick={() => setHistoryOpen(!historyOpen)} />
              <ActionButton
                label="Compare with previous"
                icon="GitCompare"
                fallback="GitBranch"
                tooltip={(target ?? 0) < 2 ? "Compare with previous: v1 has no previous version" : "Compare with previous"}
                disabled={(target ?? 0) < 2}
                onClick={() => {
                  setCompare({ from: (target ?? 2) - 1, to: target ?? 2 });
                  setMode("compare");
                }}
              />
              {canReview ? (
                <>
                  <GeneralNoteButton onAdd={addGeneral} />
                  <ApproveButton state={head.state} version={headVersion} drafts={draftCount} busy={sending} onApprove={approve} />
                  <SendFeedbackButton drafts={draftCount} busy={sending} onSend={() => void sendFeedback()} />
                </>
              ) : null}
            </>
          ) : null}
          {menu}
        </div>
      </div>
      {head && mode !== "edit" && meta ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Updated by <ActorLabel name={meta.name} threadId={meta.threadId} /> · <time dateTime={meta.at} title={meta.at}>{formatRelativeTime(meta.at, Date.now())}</time>
          {head ? <span> · Reviewer: {head.reviewer.kind === "thread" && head.reviewer.threadId ? <ThreadChip threadId={head.reviewer.threadId} /> : "owner"}</span> : null}
          {copied ? <span role="status"> · {copied}</span> : null}
        </p>
      ) : (
        <span role="status" className="sr-only">{copied}</span>
      )}
    </header>
  );

  const draft = taskId === null ? undefined : planDrafts.get(taskId);
  const notices = (
    <>
      {review ? (
        <div role="status" className={cn("flex flex-wrap items-center gap-1 rounded-md border px-2 py-1 text-xs", review.tone === "ok" ? "border-success/40" : "border-warning/40")}>
          <span>{review.text}</span>·
          <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => setReview(null)}>Dismiss</button>
        </div>
      ) : null}
      {newerVersion !== null ? (
        <div role="status" className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs">
          <span>v{newerVersion} is available</span>·
          <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={showCurrent}>Show</button>
        </div>
      ) : null}
      {draft && mode !== "edit" ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 px-2 py-1 text-xs">
          <span>Unsaved draft{draft.baseVersion > 0 ? ` from v${draft.baseVersion}` : ""}</span>
          {!archived ? <Button type="button" size="sm" variant="ghost" className="h-6" onClick={startEdit}>Continue editing</Button> : null}
          <Button type="button" size="sm" variant="ghost" className="h-6" onClick={() => void copy(draft.text, "Draft copied")}>Copy my text</Button>
          <Button type="button" size="sm" variant="ghost" className="h-6" onClick={() => { planDrafts.delete(taskId!); rerender((count) => count + 1); }}>Discard</Button>
        </div>
      ) : null}
    </>
  );

  let content;
  if (task.data === undefined) {
    content = <PlanSkeleton />;
  } else if (task.data === null) {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Icon name="FileQuestion" className="size-5" />
        Task {taskKey} was not found.
      </div>
    );
  } else if (overview.error && overview.data === undefined) {
    content = <div role="alert" className="space-y-3 p-4 text-sm"><p className="text-destructive">{overview.error}</p><Button variant="outline" size="sm" onClick={overview.refresh}>Retry</Button></div>;
  } else if (overview.data === undefined) {
    content = <PlanSkeleton />;
  } else if (mode === "edit") {
    content = (
      <div className="flex min-h-0 flex-1 flex-col">
        {newerVersion !== null ? <div className="px-3 pt-3">{notices}</div> : null}
        <div className="min-h-0 flex-1">
          <PlanEditor
            taskId={task.data.id}
            taskKey={task.data.key}
            start={{ text: headBody.body ?? "", version: headVersion }}
            headVersion={headVersion}
            onSaved={() => { showCurrent(); overview.refresh(); }}
            onCancel={showCurrent}
            onShowNew={showCurrent}
            onConflict={overview.refresh}
          />
        </div>
      </div>
    );
  } else {
    let body;
    if (head === null) {
      body = (
        <div className="space-y-2 rounded-md border border-dashed border-border p-4 text-sm">
          <p className="text-muted-foreground">No plan yet</p>
          <p className="text-xs text-muted-foreground">Agents create it with <code>bb work-board plan set</code>.</p>
          {!archived ? <Button size="sm" onClick={startEdit}>Write plan</Button> : null}
        </div>
      );
    } else if (mode === "compare") {
      body = compareFrom.body === undefined || compareTo.body === undefined
        ? <PlanSkeleton />
        : <PlanDiffView from={compareFrom.body} to={compareTo.body} />;
    } else if (display === null) {
      body = readBody.error ? <p role="alert" className="text-sm text-destructive">{readBody.error}</p> : <PlanSkeleton />;
    } else {
      body = (
        <div ref={bodyRef}>
          <TasksEditor
            key={`${display.taskId}:${display.version}`}
            value={display.body}
            onChange={noop}
            readOnly
            variant="doc"
            className="min-h-0"
            onOpenThread={openThread}
            onOpenUrl={(url) => navigate.openUrl(url)}
          />
        </div>
      );
    }
    content = (
      <div ref={scrollRef} className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3 p-3 @[56rem]:flex-row @[56rem]:justify-center @[56rem]:gap-8 @[56rem]:p-5">
          <div className="w-full min-w-0 max-w-[72ch] flex-1 space-y-3">
            {notices}
            {viewedVersion !== null && mode === "read" ? (
              <div role="status" className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs">
                <span>Viewing v{viewedVersion} of v{headVersion}</span>·
                <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={showCurrent}>Back to current</button>
              </div>
            ) : null}
            {historyOpen && head ? (
              <PlanHistory
                versions={versions}
                current={headVersion}
                shown={target ?? headVersion}
                onSelect={showVersion}
                onCompare={(version) => { setCompare({ from: version - 1, to: version }); setMode("compare"); }}
              />
            ) : null}
            {body}
          </div>
          {head ? (
            <PlanRail
              contents={
                mode === "read" && headings.length > 0 ? (
                  <PlanToc headings={headings} active={active} open={tocOpen} onToggle={() => setTocOpen(!tocOpen)} onSelect={(index) => { elements[index]?.scrollIntoView({ behavior: "smooth", block: "start" }); setActive(index); setTocOpen(false); }} />
                ) : null
              }
              noteCount={allNotes.length}
              tab={railTab}
              onTab={setRailTab}
              notesOpen={notesOpen}
              onNotesToggle={() => setNotesOpen(!notesOpen)}
              notes={
                <PlanNotesList
                  notes={allNotes}
                  placements={mode === "read" ? placements : null}
                  readOnly={!canReview || viewedVersion !== null}
                  editingId={editingId}
                  onEditingChange={setEditingId}
                  actions={actions}
                  onJump={jumpToNote}
                  onHover={setHovered}
                  onAddGeneral={addGeneral}
                />
              }
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section aria-label={`Plan ${taskKey}`} className="flex h-full min-h-0 flex-col bg-background">
      <style>{NOTE_HIGHLIGHT_CSS}</style>
      {header}
      {content}
      {selected && !pending && canAnnotate ? <SelectionToolbar selected={selected} onPick={(kind) => void pickKind(kind)} onClose={clearSelected} /> : null}
      {pending ? <CommentPopover quote={pending.anchor.exact} at={pending} onAdd={addComment} onCancel={() => setPending(null)} /> : null}
    </section>
  );
}
