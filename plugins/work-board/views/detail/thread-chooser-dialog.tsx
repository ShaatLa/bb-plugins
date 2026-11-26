import { useEffect, useState } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract";
import { errorMessage } from "../../shared/errors";
import { NO_MANAGER } from "../../components/manager-change-dialog";
import { useTasksRpc } from "../../shell/data";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "../manage/shared";
import { storeDefaultThread, useDefaultThread } from "./thread-preference";

type Thread = Awaited<ReturnType<ReturnType<typeof useSdk>["threads"]["list"]>>[number];
const titleOf = (thread: Thread) => thread.title || thread.titleFallback || "Untitled thread";
const selectable = (thread: Thread) => thread.deletedAt == null && thread.archivedAt == null && thread.visibility !== "hidden" && thread.status !== "stopping";
const THREAD_ID = /^thr_[a-zA-Z0-9_-]+$/;
const PAGE = 50;

const MODES = {
  send: { label: "Send the task", title: "Send to a thread", description: "The task context will be sent using the thread’s current settings. Busy threads receive it in their queue." },
  assign: { label: "Only assign (no message)", title: "Assign a thread", description: "Assign responsibility without sending a message or changing the task status. Idle sessions keep their assignment until removed, archived or deleted." },
} as const;

/**
 * One thread search for two jobs: on a task card it sends the task to a thread or only assigns it (the choice sits at the
 * top); in the project header it picks the project's manager. The project's manager is pinned first in both.
 */
export function ThreadChooserDialog(props: { onClose: () => void } & (
  | { kind: "task"; taskId: string; projectId: string }
  | { kind: "manager"; bbProjectId: string; current: string; onPick: (id: string, title: string) => void }
)) {
  const { onClose } = props;
  const sdk = useSdk();
  const rpc = useRpc<DelegationRpcContract>();
  const tasksRpc = useTasksRpc();
  const isManager = props.kind === "manager";
  const trackerProjectId = props.kind === "task" ? props.projectId : null;
  const listProjectId = props.kind === "manager" ? props.bbProjectId : undefined;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<keyof typeof MODES>("send");
  const assignOnly = mode === "assign";
  const defaultThread = useDefaultThread(trackerProjectId ?? "");
  const [remember, setRemember] = useState(defaultThread !== null);
  const [settingsManager, setSettingsManager] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Thread>();
  const [idMatch, setIdMatch] = useState<Thread>();
  const managerId = props.kind === "manager" ? props.current : settingsManager;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sdk.threads.list({ archived: false, limit: PAGE, offset, ...(listProjectId ? { projectId: listProjectId } : {}) }).then((page) => {
      if (cancelled) return;
      setThreads((current) => offset === 0 ? page : [...current, ...page]);
      setHasMore(page.length === PAGE);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sdk, offset, listProjectId]);

  // A failed settings read leaves the list unpinned; it never blocks the thread list.
  useEffect(() => {
    if (!trackerProjectId) return;
    let cancelled = false;
    tasksRpc.call("getAttentionSettings", { projectId: trackerProjectId }).then(
      (settings) => { if (!cancelled) setSettingsManager(settings.manager); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [tasksRpc, trackerProjectId]);

  const loadedManager = managerId ? threads.find((thread) => thread.id === managerId) : undefined;
  useEffect(() => {
    if (!managerId || loadedManager || loading) return;
    const abort = new AbortController();
    sdk.threads.list({ threadIds: [managerId], archived: false, limit: 1, signal: abort.signal }).then(
      (result) => { if (!abort.signal.aborted) setFetched(result[0]); },
      () => {},
    );
    return () => abort.abort();
  }, [sdk, managerId, loadedManager, loading]);

  // The manager picker takes a pasted thread ID and looks the thread up, as the Manager card's picker did.
  const exactId = query.trim();
  const idKnown = threads.some((thread) => thread.id === exactId);
  useEffect(() => {
    setIdMatch(undefined);
    if (!isManager || !THREAD_ID.test(exactId) || idKnown) return;
    const abort = new AbortController();
    sdk.threads.list({ threadIds: [exactId], archived: false, limit: 1, signal: abort.signal }).then(
      (result) => { if (!abort.signal.aborted) setIdMatch(result.find(selectable)); },
      () => {},
    );
    return () => abort.abort();
  }, [sdk, isManager, exactId, idKnown]);

  const dispatch = async (threadId: string, title: string) => {
    if (props.kind === "manager") { props.onPick(threadId, title); onClose(); return; }
    setSending(true);
    setError(null);
    try {
      await rpc.call(assignOnly ? "taskThreadsAttach" : "delegateToThread", { taskId: props.taskId, threadId });
      if (!assignOnly) storeDefaultThread(props.projectId, remember ? { id: threadId, title } : null);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };
  const filter = query.toLowerCase();
  const matches = (thread: Thread) => `${titleOf(thread)} ${thread.id}`.toLowerCase().includes(filter);
  const pinnedThread = managerId ? (loadedManager ?? (fetched?.id === managerId ? fetched : undefined)) : undefined;
  const pinned = pinnedThread && selectable(pinnedThread) && matches(pinnedThread) ? pinnedThread : undefined;
  const matching = threads.filter((thread) => selectable(thread) && thread.id !== managerId && matches(thread));
  const rows = [...(pinned ? [pinned] : []), ...matching, ...(idMatch && !matching.some(({ id }) => id === idMatch.id) && idMatch.id !== pinned?.id ? [idMatch] : [])];
  const text = props.kind === "manager"
    ? { title: "Choose the manager thread", description: "Stale-status notices and copied PR messages go to the manager thread." }
    : MODES[mode];

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !sending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        {props.kind === "task" ? <fieldset disabled={sending} className="space-y-1">
          <legend className="sr-only">What to do with the chosen thread</legend>
          {(Object.keys(MODES) as Array<keyof typeof MODES>).map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input type="radio" name="thread-chooser-mode" checked={mode === key} onChange={() => setMode(key)} />
              {MODES[key].label}
            </label>
          ))}
        </fieldset> : null}
        <Input aria-label="Filter loaded threads or enter a thread ID" placeholder="Filter loaded threads or paste thr_…" value={query} onChange={(event) => setQuery(event.target.value)} />
        {props.kind === "task" && !assignOnly ? <fieldset disabled={sending} className="space-y-1">
          <CheckboxField checked={remember} onCheckedChange={setRemember} label="Use this thread by default" />
          <p className="text-xs text-muted-foreground">Remember the selected thread for this project on this device.</p>
          {defaultThread ? <Button size="sm" variant="ghost" onClick={() => { storeDefaultThread(props.projectId, null); setRemember(false); }}>Clear default thread</Button> : null}
        </fieldset> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="max-h-72 space-y-1 overflow-y-auto" aria-busy={loading || sending}>
          {isManager && managerId && !filter ? <Button variant="ghost" className="h-auto w-full justify-start py-2 text-left" onClick={() => void dispatch("", NO_MANAGER)}>{NO_MANAGER}</Button> : null}
          {rows.map((thread) => (
            <Button key={thread.id} variant="ghost" disabled={sending} className="h-auto w-full justify-between gap-3 py-2 text-left" onClick={() => void dispatch(thread.id, titleOf(thread))}>
              <span className="min-w-0 truncate">{titleOf(thread)}</span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                {thread.id === managerId ? <span className="rounded-full border border-border px-1.5 py-0.5 font-medium text-foreground">Manager</span> : null}
                {thread.status}
              </span>
            </Button>
          ))}
          {!loading && rows.length === 0 ? <p className="text-sm text-muted-foreground">No matching loaded threads.</p> : null}
          {loading ? <p role="status" className="text-sm text-muted-foreground">Loading threads…</p> : null}
        </div>
        {hasMore ? <Button variant="outline" disabled={loading || sending} onClick={() => setOffset(threads.length)}>Load more threads</Button> : null}
        {/* A pasted id whose row is already listed has that row as its one control. */}
        {props.kind === "task" && THREAD_ID.test(exactId) && !rows.some(({ id }) => id === exactId) ? <Button disabled={sending} onClick={() => void dispatch(exactId, threads.find(({ id }) => id === exactId)?.title ?? "Existing thread")}>{assignOnly ? "Assign to" : "Send to"} {exactId}</Button> : null}
      </DialogContent>
    </Dialog>
  );
}
