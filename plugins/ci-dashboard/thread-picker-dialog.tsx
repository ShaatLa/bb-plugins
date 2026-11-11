import { useEffect, useId, useRef, useState } from "react";
import { useViewportDialog } from "./use-viewport-dialog";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";

const PAGE = 50;
const threadTitle = (thread: { title?: string | null; titleFallback?: string | null }) => thread.title ?? thread.titleFallback ?? "Untitled session";

/** Picks one of the BB sessions of the repository's project; `onSelect` rejects to keep the dialog open with the error. */
export function ThreadPickerDialog({ projectId, problemTitle, onSelect, onClose }: { projectId: string | null; problemTitle: string; onSelect: (threadId: string) => Promise<void>; onClose: () => void }) {
  const sdk = useSdk();
  type Threads = Awaited<ReturnType<typeof sdk.threads.list>>;
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId(), description = useId();
  const [threads, setThreads] = useState<Threads>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useViewportDialog(dialog, (element) => element.querySelector("input")?.focus());
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    sdk.threads.list({ archived: false, limit: PAGE, offset, ...(projectId ? { projectId } : {}) }).then((page) => {
      if (cancelled) return;
      setThreads((current) => offset === 0 ? page : [...current, ...page]);
      setHasMore(page.length === PAGE);
    }).catch(() => { if (!cancelled) setError("Unable to load sessions."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sdk, projectId, offset]);
  const matching = threads.filter((thread) => thread.deletedAt == null && thread.archivedAt == null && thread.visibility !== "hidden" && thread.status !== "stopping"
    && `${threadTitle(thread)} ${thread.id}`.toLowerCase().includes(query.toLowerCase()));
  const send = async (threadId: string) => {
    setSending(true); setError(null);
    try { await onSelect(threadId); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to send the problem to this session."); setSending(false); }
  };
  return <dialog ref={dialog} aria-labelledby={heading} aria-describedby={description}
    onCancel={(event) => { event.preventDefault(); if (!sending) onClose(); }}
    className="fixed right-auto bottom-auto m-0 box-border w-[32rem] min-w-0 -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-lg border border-border bg-background p-4 text-foreground shadow-xl backdrop:bg-black/60">
    <div className="flex items-start justify-between gap-3">
      <h2 id={heading} className="min-w-0 text-lg font-semibold">Send to existing session</h2>
      <Button variant="outline" size="sm" className="shrink-0" disabled={sending} onClick={onClose}>Close</Button>
    </div>
    <p id={description} className="my-3 break-words text-xs text-muted-foreground">“{problemTitle}” is sent with the session’s current settings. A busy session receives it in its queue.</p>
    <input aria-label="Filter sessions" placeholder="Filter sessions" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" />
    {error && <p role="alert" className="mt-3 text-sm text-destructive-text">{error}</p>}
    <div className="mt-3 max-h-72 space-y-1 overflow-y-auto" aria-busy={loading || sending}>
      {matching.map((thread) => <Button key={thread.id} variant="ghost" disabled={sending} className="h-auto w-full justify-between gap-3 py-2 text-left" onClick={() => void send(thread.id)}>
        <span className="min-w-0 truncate">{threadTitle(thread)}</span><span className="text-xs text-muted-foreground">{thread.status}</span>
      </Button>)}
      {!loading && matching.length === 0 && <p className="text-sm text-muted-foreground">No matching sessions.</p>}
      {loading && <p role="status" className="text-sm text-muted-foreground">Loading sessions…</p>}
    </div>
    {hasMore && <Button variant="outline" size="sm" className="mt-3" disabled={loading || sending} onClick={() => setOffset(threads.length)}>Load more sessions</Button>}
  </dialog>;
}
