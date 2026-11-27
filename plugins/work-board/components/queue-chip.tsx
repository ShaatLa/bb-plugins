import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { CardQueue } from "../shared/contract";

const titles = new Map<string, string>();

/** The executor thread's title, falling back to its id; read once per thread. */
export function useThreadName(threadId: string): string {
  const sdk = useSdk();
  const [resolved, setResolved] = useState<{ id: string; name: string }>();
  useEffect(() => {
    if (titles.has(threadId)) return;
    let cancelled = false;
    sdk.threads.get({ threadId }).then((thread) => {
      const title = thread.title || thread.titleFallback;
      if (title) titles.set(threadId, title);
      if (!cancelled && title) setResolved({ id: threadId, name: title });
    }, () => {});
    return () => { cancelled = true; };
  }, [sdk, threadId]);
  return titles.get(threadId) ?? (resolved?.id === threadId ? resolved.name : threadId);
}

export const queueLabel = (queue: CardQueue, thread: string, total?: number) => `Queue of ${thread} · ${queue.position === 1 ? "current" : total === undefined ? `#${queue.position}` : `${queue.position} of ${total}`}`;

/** "Queued #N · thread" on a waiting card, "Current in queue · thread" on the first. */
export function QueueChip({ queue, total }: { queue?: CardQueue; total?: number }) {
  if (!queue) return null;
  return <QueueChipText queue={queue} total={total} />;
}
function QueueChipText({ queue, total }: { queue: CardQueue; total?: number }) {
  const name = useThreadName(queue.threadId);
  return <span className="inline-flex max-w-full items-center rounded-full border border-border px-1.5 py-0.5 text-2xs text-muted-foreground" title={queue.threadId}><span className="truncate">{queueLabel(queue, name, total)}</span></span>;
}
