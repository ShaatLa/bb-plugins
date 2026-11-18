import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Copy of work-board/steer/index.ts (the reference): plugins are separate packages and must not import each other.
export const QUEUED_NOTICE_SEPARATOR = "\n\n---\n\n";

// Concurrent sends to one thread would both see the same last row, so each thread's append-or-send runs in turn.
const threadChains = new Map<string, Promise<unknown>>();
function serialPerThread<T>(threadId: string, job: () => Promise<T>): Promise<T> {
  const run = (threadChains.get(threadId) ?? Promise.resolve()).then(job);
  const tail = run.then(() => undefined, () => undefined);
  threadChains.set(threadId, tail);
  void tail.then(() => { if (threadChains.get(threadId) === tail) threadChains.delete(threadId); });
  return run;
}

// Extends our own notice while it is still the last unsent row; any doubt falls back to a normal send.
async function appendToQueuedNotice(bb: BbPluginApi, threadId: string, text: string, guard: Guard): Promise<string | null> {
  // A conflict means the row changed under us, so list once more before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const last = (await guard(bb.sdk.threads.queuedMessages.list({ threadId }))).at(-1);
      const part = last?.content.length === 1 ? last.content[0] : undefined;
      if (!last || !part || part.type !== "text" || last.originPluginId !== bb.pluginId || (last.state !== "queued" && last.state !== "waiting") || !last.editable) return null;
      await guard(bb.sdk.threads.queuedMessages.update({ threadId, queuedMessageId: last.id, expectedUpdatedAt: last.updatedAt, input: [{ ...part, text: part.text + QUEUED_NOTICE_SEPARATOR + text }] }));
      return last.id;
    } catch { /* retry once, then send */ }
  }
  return null;
}

type Guard = <T>(call: Promise<T>) => Promise<T>;
type ThreadReceipt = { mode: 'inline' } | { mode: 'queued' | 'appended'; id: string };

/** Merges into this plugin's last queued row on the thread, else queues a new message; throws when the send fails. */
export function sendOrAppend(bb: BbPluginApi, { threadId, text, header = true, guard = (call) => call }: { threadId: string; text: string; header?: boolean; guard?: Guard }): Promise<ThreadReceipt> {
  return serialPerThread(threadId, async () => {
    const appendedId = await appendToQueuedNotice(bb, threadId, text, guard);
    if (appendedId) return { mode: 'appended', id: appendedId };
    const sent = await guard(bb.sdk.threads.send({ threadId, originPluginId: bb.pluginId, mode: "queue-if-active", input: [{ type: "text", text: header ? `[bb message from plugin:${bb.pluginId}]\n\n${text}` : text, mentions: [] }] }));
    return sent?.delivery === 'queued' ? { mode: 'queued', id: sent.queuedMessage.id } : { mode: 'inline' };
  });
}
