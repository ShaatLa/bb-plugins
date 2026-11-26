import { useEffect, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { CardQueue } from "../shared/contract";

const titles = new Map<string, string>();

/** The executor thread's title, falling back to its id; read once per thread. */
function useThreadName(threadId: string): string {
  const sdk = useSdk();
  const [name, setName] = useState(titles.get(threadId) ?? threadId);
  useEffect(() => {
    if (titles.has(threadId)) return;
    let cancelled = false;
    sdk.threads.get({ threadId }).then((thread) => {
      const title = thread.title || thread.titleFallback;
      if (title) titles.set(threadId, title);
      if (!cancelled && title) setName(title);
    }, () => {});
    return () => { cancelled = true; };
  }, [sdk, threadId]);
  return name;
}

export const queueLabel = (queue: CardQueue, thread: string) => queue.position === 1 ? `Current in queue · ${thread}` : `Queued #${queue.position} · ${thread}`;

/** "Queued #N · thread" on a waiting card, "Current in queue · thread" on the first. */
export function QueueChip({ queue }: { queue?: CardQueue }) {
  if (!queue) return null;
  return <QueueChipText queue={queue} />;
}
function QueueChipText({ queue }: { queue: CardQueue }) {
  const name = useThreadName(queue.threadId);
  return <span className="inline-flex max-w-full items-center rounded-full border border-border px-1.5 py-0.5 text-2xs text-muted-foreground" title={`${queue.threadId} · ${queue.position === 1 ? "this is its current card" : "waiting for its turn"}`}><span className="truncate">{queueLabel(queue, name)}</span></span>;
}
