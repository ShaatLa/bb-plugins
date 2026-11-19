import { useEffect, useMemo, useRef, useState } from "react";
import { experimental_copyToClipboard, experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { parseHeadings } from "../../shared/plan.js";
import { taskPlanMarkdownLink } from "../../shared/task-link.js";
import { useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { useOpenThread } from "../../components/open-thread.js";
import { TASK_TAB } from "../embed/index.js";
import { formatRelativeTime } from "../activity/time.js";
import { planDrafts, usePlanBody, usePlanOverview } from "./data.js";
import { PlanDiffView } from "./diff-view.js";
import { PlanEditor } from "./editor.js";
import { useActiveHeading, useRenderedHeadings } from "./headings.js";
import { PlanHistory } from "./history.js";
import { subscribePlanEditRequests, takePlanEditRequest } from "./open.js";
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
import { Skeleton } from "@/components/ui/skeleton";

type Mode = "read" | "compare" | "edit";

const noop = () => {};

function VersionSelect({ label, value, versions, current, onChange }: { label: string; value: number; versions: readonly number[]; current: number; onChange: (version: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger aria-label={label} className="h-7 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {versions.map((version) => (
          <SelectItem key={version} value={String(version)}>{`v${version}${version === current ? " (current)" : ""}`}</SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const navigate = useBbNavigate();
  const navigation = useTasksNavigation();
  const panel = experimental_useAppPanel();
  const openThread = useOpenThread();

  const [loadedId, setLoadedId] = useState<string | undefined>();
  const task = useTasksQuery(
    async (rpc) => (await rpc.call("getTaskByKey", { taskKey })).task,
    ["tasks:changed"],
    [taskKey],
    { relevantTaskIds: loadedId ? [loadedId] : undefined },
  );
  const taskId = task.data?.id ?? null;
  useEffect(() => setLoadedId(taskId ?? undefined), [taskId]);
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

  const header = (
    <header className="shrink-0 space-y-2 border-b border-border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {surface === "page" ? (
          <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground hover:text-foreground" aria-label={`Back to ${taskKey}`} onClick={openTask}>
            <Icon name="ArrowLeft" className="size-4" />
          </Button>
        ) : null}
        <button
          type="button"
          title="Open task"
          className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={openTask}
        >
          <span className="text-muted-foreground">{task.data?.key ?? taskKey}</span>
          {task.data ? <span> {task.data.title}</span> : null}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Plan actions">
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={display === null} onSelect={() => display && void copy(display.body, "Markdown copied")}>Copy Markdown</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copy(taskPlanMarkdownLink(task.data?.key ?? taskKey), "Link copied")}>Copy link</DropdownMenuItem>
            <DropdownMenuItem onSelect={openTask}>Open task</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {head && mode !== "edit" ? (
        <div className="flex flex-wrap items-center gap-2">
          {mode === "compare" ? (
            <>
              <VersionSelect label="Compare from" value={compare.from} versions={versions.map((version) => version.version)} current={headVersion} onChange={(from) => setCompare({ ...compare, from })} />
              <span aria-hidden className="text-xs text-muted-foreground">→</span>
              <VersionSelect label="Compare to" value={compare.to} versions={versions.map((version) => version.version)} current={headVersion} onChange={(to) => setCompare({ ...compare, to })} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setMode("read")}>Close compare</Button>
            </>
          ) : (
            <>
              <VersionSelect label="Plan version" value={target ?? headVersion} versions={versions.map((version) => version.version).reverse()} current={headVersion} onChange={showVersion} />
              <PlanStateChip state={head.state} />
              {!archived && viewedVersion === null ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setWantsEdit(true)}>Edit</Button>
              ) : null}
              <Button type="button" size="sm" variant="ghost" aria-pressed={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>History</Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={(target ?? 0) < 2}
                onClick={() => {
                  setCompare({ from: (target ?? 2) - 1, to: target ?? 2 });
                  setMode("compare");
                }}
              >
                Compare with previous
              </Button>
            </>
          )}
          <span role="status" className="text-xs text-muted-foreground">{copied}</span>
        </div>
      ) : (
        <span role="status" className="sr-only">{copied}</span>
      )}
    </header>
  );

  const draft = taskId === null ? undefined : planDrafts.get(taskId);
  const notices = (
    <>
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
  if (task.error && task.data === undefined) {
    content = <div role="alert" className="space-y-3 p-4 text-sm"><p className="text-destructive">{task.error}</p><Button variant="outline" size="sm" onClick={task.refresh}>Retry</Button></div>;
  } else if (task.data === undefined) {
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
        <div className="flex flex-col gap-3 p-3 @[56rem]:flex-row @[56rem]:gap-6 @[56rem]:p-5">
          {mode === "read" && head ? <PlanToc headings={headings} active={active} open={tocOpen} onToggle={() => setTocOpen(!tocOpen)} onSelect={(index) => { elements[index]?.scrollIntoView({ behavior: "smooth", block: "start" }); setActive(index); setTocOpen(false); }} /> : null}
          <div className="mx-auto w-full min-w-0 max-w-[72ch] flex-1 space-y-3">
            {head ? (
              <p className="text-xs text-muted-foreground">
                Updated by {head.updatedBy.name} <time dateTime={head.updatedAt} title={head.updatedAt}>{formatRelativeTime(head.updatedAt, Date.now())}</time>
              </p>
            ) : null}
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
        </div>
      </div>
    );
  }

  return (
    <section aria-label={`Plan ${taskKey}`} className="flex h-full min-h-0 flex-col bg-background">
      {header}
      {content}
    </section>
  );
}
