import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { reconcileTaskThreads } from "../lifecycle/thread-links";
import { errorMessage } from "../shared/errors";
import { isSideChatShapedThread } from "../shared/side-chat";

interface DeliverCommentInput {
  taskId: string;
  commentId: string;
  body: string;
  authorName: string;
  threadId?: string;
  mode?: "steer-if-active" | "queue-if-active";
  /** Question answers carry their own next step, so they skip the reply hint. */
  replyHint?: boolean;
}

function steerPrompt(
  taskKey: string,
  authorName: string,
  body: string,
  replyHint = true,
): string {
  return (
    "`New comment`\n" +
    `- Task: [${taskKey}](/plugins/work-board/work-board/task/${taskKey})\n` +
    `- From: ${authorName}\n\n${body}` +
    (replyHint
      ? "\n\nTreat this as updated context for your work on this task. Reflect it in Current state " +
        `(\`bb work-board update ${taskKey} --progress ...\`); comment only results or evidence, and ask the owner ` +
        `on the task, not in chat, with \`bb work-board question add ${taskKey}\` when you need a decision.`
      : "")
  );
}

/**
 * The thread a message about a task goes to when nothing names one: the first linked session, else the thread of the
 * latest agent comment (other than `excludeCommentId`). Question answers and plan reviews use the same rule.
 */
export function defaultTaskThreadId(store: TasksStore, taskId: string, excludeCommentId = ""): string | undefined {
  return store.listTaskThreads(taskId)[0]?.threadId ?? store.getLatestAgentComment(taskId, excludeCommentId)?.threadId;
}

export const QUEUED_NOTICE_SEPARATOR = "\n\n---\n\n";

/** bb's origin line, so the receiving agent reads a Work Board message as the plugin's, not the owner's words. */
export const withPluginHeader = (pluginId: string, text: string) => `[bb message from plugin:${pluginId}]\n\n${text}`;

// Extend our own notice when it is still the last queued row, so a busy thread
// gets one message instead of a stack of them; that message already starts with the header. Any doubt falls back to send.
async function appendToQueuedNotice(
  bb: BbPluginApi,
  threadId: string,
  text: string,
  wanted?: () => boolean,
): Promise<"appended" | "skipped" | "none"> {
  // A conflict means the row changed under us, so list once more before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const last = (await bb.sdk.threads.queuedMessages.list({ threadId })).at(-1);
      const part = last?.content.length === 1 ? last.content[0] : undefined;
      if (
        !last ||
        !part ||
        part.type !== "text" ||
        last.originPluginId !== bb.pluginId ||
        // bb marks a row held for a busy thread `waiting`; both states are still unsent.
        (last.state !== "queued" && last.state !== "waiting") ||
        !last.editable
      )
        return "none";
      // Right before the transport call: a notice that went stale is dropped, and said so.
      if (wanted && !wanted()) return "skipped";
      await bb.sdk.threads.queuedMessages.update({
        threadId,
        queuedMessageId: last.id,
        expectedUpdatedAt: last.updatedAt,
        input: [{ ...part, text: part.text + QUEUED_NOTICE_SEPARATOR + text }],
      });
      return "appended";
    } catch {
      // Retry once, then fall back to a normal send.
    }
  }
  return "none";
}

// Concurrent deliveries to one thread would both see the same last row, so each thread's append-or-send runs in turn.
const threadChains = new Map<string, Promise<unknown>>();
function serialPerThread<T>(threadId: string, job: () => Promise<T>): Promise<T> {
  const run = (threadChains.get(threadId) ?? Promise.resolve()).then(job);
  const tail = run.then(() => undefined, () => undefined);
  threadChains.set(threadId, tail);
  void tail.then(() => {
    if (threadChains.get(threadId) === tail) threadChains.delete(threadId);
  });
  return run;
}

/** Merge into the thread's queued notice, else send a new message; throws when the send fails. */
function appendOrSend(
  bb: BbPluginApi,
  threadId: string,
  text: string,
  mode: "steer-if-active" | "queue-if-active",
  wanted?: () => boolean,
): Promise<boolean> {
  return serialPerThread(threadId, async () => {
    // The check runs inside the serialized job, right before each transport call, so a notice that went stale while it
    // waited for its turn or for the queue read is dropped.
    if (wanted && !wanted()) return false;
    // The outcome is the transport's own: once the update or send has started, its success is a delivery.
    const appended = await appendToQueuedNotice(bb, threadId, text, wanted);
    if (appended === "appended") return true;
    if (appended === "skipped" || (wanted && !wanted())) return false;
    await bb.sdk.threads.send({
      threadId,
      originPluginId: bb.pluginId,
      input: [{ type: "text", text: withPluginHeader(bb.pluginId, text), mentions: [] }],
      mode,
    });
    return true;
  });
}

/**
 * Wake one known thread, merged into its queued Work Board notice when there is one. Throws on failure. With `wanted`,
 * the notice is dropped (false) when it says no right before the transport call.
 */
export function notifyThread(
  bb: BbPluginApi,
  threadId: string,
  text: string,
  wanted?: () => boolean,
): Promise<boolean> {
  return appendOrSend(bb, threadId, text, "queue-if-active", wanted);
}

export async function deliverCommentToLatestAgent(
  bb: BbPluginApi,
  store: TasksStore,
  input: DeliverCommentInput,
): Promise<number> {
  const task = store.getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);

  const previous = store.listTaskThreads(input.taskId);
  const links = await reconcileTaskThreads(bb, store, input.taskId);
  const preferred =
    input.threadId ??
    store.getLatestAgentComment(input.taskId, input.commentId)?.threadId;
  const detached = store
    .listComments(input.taskId)
    .filter(
      (comment) =>
        comment.kind === "system" && comment.body.startsWith("Thread detached"),
    );
  const canUsePreferred =
    input.threadId ||
    (!detached.some((comment) => comment.threadId === preferred) &&
      (links.length > 0 || (previous.length === 0 && detached.length === 0)));
  const candidates = [
    ...new Set([
      ...(preferred && canUsePreferred ? [preferred] : []),
      ...links.map((link) => link.threadId),
    ]),
  ];
  const prompt = steerPrompt(task.key, input.authorName, input.body, input.replyHint);
  for (const threadId of candidates) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (isSideChatShapedThread(thread)) continue;
      if (thread.archivedAt != null || thread.deletedAt != null) {
        // An archived asker's work moved up to its parent, so the message follows it there.
        if (thread.parentThreadId && !candidates.includes(thread.parentThreadId)) candidates.push(thread.parentThreadId);
        continue;
      }
      if (thread.status === "stopping") continue;
      await appendOrSend(bb, threadId, prompt, input.mode ?? "steer-if-active");
      return 1;
    } catch (error) {
      bb.log.warn(
        `failed to deliver comment ${input.commentId} to thread ${threadId}: ${errorMessage(error)}`,
      );
      return 0;
    }
  }
  return 0;
}

export type Receipt =
  | { outcome: "appended" | "queued"; queuedMessageId: string }
  | { outcome: "inline"; inlineEventRef: string }
  /** Sent to an idle thread; its accepted-input event has not arrived yet. */
  | { outcome: "pending" }
  /** The write may or may not have happened and nothing proves either; it is never resent automatically. */
  | { outcome: "unknown"; error: string }
  /** Definitely not delivered: an explicit rejection, so a later pass may send again. */
  | { outcome: "failed"; error: string };

/** How long an inline send waits for its accepted-input event before it stays `sending`; tests shorten it. */
export const receiptPolling = { tries: 3, delayMs: 300 };

const statusOf = (error: unknown) => (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined);
// An update refused on its precondition (the row changed under us) proves the write did not commit; a 404 does not, since a dispatched row also vanishes.
const isPreconditionRejection = (error: unknown) => [409, 412].includes(statusOf(error) ?? 0);
const isDefiniteSendFailure = (error: unknown) => [400, 401, 403, 404, 409, 412, 422].includes(statusOf(error) ?? 0);

type QueueRow = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>[number];
const rowText = (row: QueueRow) => row.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

const HISTORY_PAGE = 50;
/** Pages of history one search pass may read; a longer history takes several passes, resumed from the cursor. */
export const HISTORY_PASS_PAGES = 40;

/**
 * Where a history search got to, so the next pass continues instead of rereading the newest pages: `high` is the newest request seen
 * (events above it are new), each gap is a stretch of history not yet read, and `hit` is a matching request whose acceptance is
 * still being looked for.
 */
export interface HistoryCursor {
  high?: number;
  gaps?: { from?: number; to?: number }[];
  hit?: { requestIds: string[]; after: number };
}
export interface MarkerSearch { receipt: Receipt | null; cursor: HistoryCursor; /** False while history older than this pass's budget is still unread. */ complete: boolean }

/**
 * A marker is evidence only in the recipient's own queue or in its accepted-input history, never in a send response. The history is
 * read back to `since` (default five minutes ago), at most `HISTORY_PASS_PAGES` pages per pass, continuing from `cursor`.
 */
export async function searchAttentionMarker(bb: BbPluginApi, threadId: string, marker: string, since?: string, cursor: HistoryCursor = {}): Promise<MarkerSearch> {
  try {
    for (const row of await bb.sdk.threads.queuedMessages.list({ threadId })) {
      const text = rowText(row);
      const at = text.indexOf(marker);
      if (at >= 0) return { receipt: { outcome: text.slice(0, at).includes(QUEUED_NOTICE_SEPARATOR) ? "appended" : "queued", queuedMessageId: row.id }, cursor, complete: true };
    }
  } catch { /* An unreadable queue is no evidence either way. */ }
  const floor = since ? Date.parse(since) : Date.now() - 5 * 60_000;
  const next: HistoryCursor = { ...cursor, gaps: (cursor.gaps ?? []).map((gap) => ({ ...gap })) };
  let budget = HISTORY_PASS_PAGES;
  try {
    // Requests newer than the last pass, then the stretches left unread, newest first.
    const gaps: { from?: number; to?: number }[] = cursor.high !== undefined ? [{ to: cursor.high }, ...next.gaps!] : next.gaps!.length ? next.gaps! : [{}];
    const requestIds = new Set(next.hit?.requestIds ?? []);
    let hitSeq = next.hit?.after;
    let high = cursor.high;
    const remaining: { from?: number; to?: number }[] = [];
    for (const gap of gaps) {
      let before = gap.from;
      let reachedEnd = false;
      let first = gap.from === undefined;
      while (!reachedEnd) {
        if (budget <= 0) { remaining.push({ from: before, to: gap.to }); break; }
        budget--;
        const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: String(HISTORY_PAGE), ...(before !== undefined ? { beforeSeq: String(before) } : {}), signal: AbortSignal.timeout(5000) });
        for (const event of events) {
          if (gap.to !== undefined && event.seq <= gap.to) { reachedEnd = true; break; }
          if (first) { high = Math.max(high ?? 0, event.seq); first = false; }
          if (event.type === "client/turn/requested" && JSON.stringify(event.data).includes(marker)) {
            const requestId = (event.data as { requestId?: string }).requestId;
            if (requestId) requestIds.add(requestId);
            hitSeq = Math.min(hitSeq ?? event.seq, event.seq);
          }
          before = event.seq;
        }
        if (events.length < HISTORY_PAGE || (events.at(-1)?.createdAt ?? Infinity) < floor) reachedEnd = true;
      }
    }
    next.high = high;
    next.gaps = remaining;
    if (requestIds.size && hitSeq !== undefined) {
      // The acceptance follows its request, so page forward from the earliest matching request.
      let after = hitSeq;
      next.hit = { requestIds: [...requestIds], after };
      while (budget > 0) {
        budget--;
        const accepted = await bb.sdk.threads.events.list({ threadId, types: ["turn/input/accepted"], order: "asc", limit: String(HISTORY_PAGE), afterSeq: String(after), signal: AbortSignal.timeout(5000) });
        const hit = accepted.find((event) => event.type === "turn/input/accepted" && requestIds.has((event.data as { clientRequestId?: string }).clientRequestId ?? ""));
        if (hit) return { receipt: { outcome: "inline", inlineEventRef: `${threadId}:${hit.seq}` }, cursor: next, complete: true };
        if (accepted.length < HISTORY_PAGE) { next.hit = { requestIds: [...requestIds], after }; break; }
        after = accepted.at(-1)!.seq;
        next.hit = { requestIds: [...requestIds], after };
      }
    }
    return { receipt: null, cursor: next, complete: remaining.length === 0 && (budget > 0 || !next.hit) };
  } catch {
    return { receipt: null, cursor, complete: false };
  }
}

export async function findAttentionMarker(bb: BbPluginApi, threadId: string, marker: string, since?: string): Promise<Receipt | null> {
  return (await searchAttentionMarker(bb, threadId, marker, since)).receipt;
}

type AppendResult = { kind: "none" } | { kind: "done"; receipt: Receipt };

// Like appendToQueuedNotice, but a failed update is judged by re-reading the row, never by guessing.
async function appendMarked(bb: BbPluginApi, threadId: string, text: string, marker: string): Promise<AppendResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let last: QueueRow | undefined;
    try {
      last = (await bb.sdk.threads.queuedMessages.list({ threadId })).at(-1);
    } catch {
      return { kind: "none" };
    }
    const part = last?.content.length === 1 ? last.content[0] : undefined;
    if (!last || !part || part.type !== "text" || last.originPluginId !== bb.pluginId || (last.state !== "queued" && last.state !== "waiting") || !last.editable) return { kind: "none" };
    try {
      await bb.sdk.threads.queuedMessages.update({ threadId, queuedMessageId: last.id, expectedUpdatedAt: last.updatedAt, input: [{ ...part, text: part.text + QUEUED_NOTICE_SEPARATOR + text }] });
      return { kind: "done", receipt: { outcome: "appended", queuedMessageId: last.id } };
    } catch (error) {
      if (isPreconditionRejection(error)) continue;
      const message = errorMessage(error);
      let again: QueueRow | undefined;
      try {
        again = (await bb.sdk.threads.queuedMessages.list({ threadId })).find((row) => row.id === last.id);
      } catch {
        return { kind: "done", receipt: { outcome: "unknown", error: message } };
      }
      if (again && rowText(again).includes(marker)) return { kind: "done", receipt: { outcome: "appended", queuedMessageId: again.id } };
      // A row that left the queue may have dispatched with our text, so the accepted-input history decides; otherwise nothing more is written.
      const found = again ? null : await findAttentionMarker(bb, threadId, marker);
      return { kind: "done", receipt: found ?? { outcome: "unknown", error: message } };
    }
  }
  return { kind: "none" };
}

/**
 * Deliver `text` carrying `marker` and report what is provable: `appended` (merged into our queued notice, with its row id),
 * `queued` (a new row), `inline` (accepted-input event seen), `pending` (sent inline, event not yet seen), `failed` (explicitly
 * rejected) or `unknown` (possibly written, never resent). Runs under the same per-thread serialization as the other notice writers.
 */
export function deliverWithReceipt(bb: BbPluginApi, threadId: string, text: string, marker: string): Promise<Receipt> {
  const body = `${text}\n\n${marker}`;
  return serialPerThread(threadId, async (): Promise<Receipt> => {
    const appended = await appendMarked(bb, threadId, body, marker);
    if (appended.kind === "done") return appended.receipt;
    try {
      const sent = await bb.sdk.threads.send({ threadId, originPluginId: bb.pluginId, input: [{ type: "text", text: withPluginHeader(bb.pluginId, body), mentions: [] }], mode: "queue-if-active" });
      if (sent.delivery === "queued") return { outcome: "queued", queuedMessageId: sent.queuedMessage.id };
      for (let attempt = 0; attempt < receiptPolling.tries; attempt++) {
        const found = await findAttentionMarker(bb, threadId, marker);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, receiptPolling.delayMs));
      }
      return { outcome: "pending" };
    } catch (error) {
      if (isDefiniteSendFailure(error)) return { outcome: "failed", error: errorMessage(error) };
      return (await findAttentionMarker(bb, threadId, marker)) ?? { outcome: "unknown", error: errorMessage(error) };
    }
  });
}
