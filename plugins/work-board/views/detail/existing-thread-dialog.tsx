import { useEffect, useState } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract";
import { errorMessage } from "../../shared/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "../manage/shared";
import { storeDefaultThread, useDefaultThread } from "./thread-preference";

export function ExistingThreadDialog({ taskId, projectId, onClose }: { taskId: string; projectId: string; onClose: () => void }) {
  const sdk = useSdk();
  const rpc = useRpc<DelegationRpcContract>();
  type Threads = Awaited<ReturnType<typeof sdk.threads.list>>;
  const [threads, setThreads] = useState<Threads>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultThread = useDefaultThread(projectId);
  const [remember, setRemember] = useState(defaultThread !== null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sdk.threads.list({ archived: false, limit: 50, offset }).then((page) => {
      if (cancelled) return;
      setThreads((current) => offset === 0 ? page : [...current, ...page]);
      setHasMore(page.length === 50);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sdk, offset]);

  const dispatch = async (threadId: string, title: string) => {
    setSending(true);
    setError(null);
    try {
      await rpc.call("delegateToThread", { taskId, threadId });
      storeDefaultThread(projectId, remember ? { id: threadId, title } : null);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  };
  const matching = threads.filter((thread) =>
    thread.deletedAt == null && thread.archivedAt == null && thread.visibility !== "hidden" && thread.status !== "stopping" &&
    `${thread.title ?? thread.titleFallback ?? ""} ${thread.id}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !sending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to existing thread</DialogTitle>
          <DialogDescription>The task context will be sent using the thread’s current settings. Busy threads receive it in their queue.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Filter loaded threads or enter a thread ID" placeholder="Filter loaded threads or paste thr_…" value={query} onChange={(event) => setQuery(event.target.value)} />
        <fieldset disabled={sending} className="space-y-1">
          <CheckboxField checked={remember} onCheckedChange={setRemember} label="Use this thread by default" />
          <p className="text-xs text-muted-foreground">Remember the selected thread for this project on this device.</p>
          {defaultThread ? <Button size="sm" variant="ghost" onClick={() => { storeDefaultThread(projectId, null); setRemember(false); }}>Clear default thread</Button> : null}
        </fieldset>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="max-h-72 space-y-1 overflow-y-auto" aria-busy={loading || sending}>
          {matching.map((thread) => (
            <Button key={thread.id} variant="ghost" disabled={sending} className="h-auto w-full justify-between gap-3 py-2 text-left" onClick={() => void dispatch(thread.id, thread.title ?? thread.titleFallback ?? "Untitled thread")}>
              <span className="min-w-0 truncate">{thread.title ?? thread.titleFallback ?? "Untitled thread"}</span>
              <span className="text-xs text-muted-foreground">{thread.status}</span>
            </Button>
          ))}
          {!loading && matching.length === 0 ? <p className="text-sm text-muted-foreground">No matching loaded threads.</p> : null}
          {loading ? <p role="status" className="text-sm text-muted-foreground">Loading threads…</p> : null}
        </div>
        {hasMore ? <Button variant="outline" disabled={loading || sending} onClick={() => setOffset(threads.length)}>Load more threads</Button> : null}
        {/^thr_[a-zA-Z0-9_-]+$/.test(query.trim()) ? <Button disabled={sending} onClick={() => void dispatch(query.trim(), threads.find(({ id }) => id === query.trim())?.title ?? "Existing thread")}>Send to {query.trim()}</Button> : null}
      </DialogContent>
    </Dialog>
  );
}
