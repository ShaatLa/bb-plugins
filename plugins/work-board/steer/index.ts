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
/** Page budgets of one search pass; a longer history takes several passes, resumed from the cursor. Tests shrink them to make the bounds bite. */
export const historyLimits = { passPages: 40, acceptancePages: 10 };

/*
 * Receipt recovery: the history search for one attempt's marker, one bounded pass at a time.
 *
 * Every wait is bounded by a value fixed on the FIRST pass and never moved afterwards, and every completion test is computed
 * from the cursor, never remembered in a flag that outlives its inputs:
 *
 *   input / loop                         fixed bound (first pass)               done when (derived from the cursor)           later arrivals
 *   -----------------------------------  -------------------------------------  --------------------------------------------  ------------------------------------
 *   requests, newest to attempt start    `high` of pass 1 (gaps above it are    no saved gap that is not `late`               `late` gaps: searched, never block
 *                                        marked `late`)
 *   acceptances after a matching request `accBound`: newest acceptance present  `hit.after >= accBound` (the pointer has    acceptances above `accBound`: scanned
 *                                        on pass 1                              passed every acceptance of the window)        as late evidence, never block
 *   a new candidate request              (adds its id; the pointer rewinds to   the pointer is below `accBound` again, so   a candidate above `accBound` cannot
 *                                        min(pointer, its seq))                 the decision waits for its acceptance         have an acceptance inside the window
 *   history read errors                  5 failed passes over 30 minutes        the service records unknown, cursor kept      later success clears the count
 *
 * Decision: `complete` = every non-late request gap is read AND (no candidate OR the acceptance pointer reached `accBound`).
 * A receipt found at any time, in or after the window, wins. Per pass the newest traffic takes at most half the budget while older
 * gaps wait, a stored acceptance scan goes first, so no stream of new events can postpone the decision.
 */
const headShare = () => historyLimits.passPages / 2;

/** `late` marks traffic that arrived after the decision window was fixed: it is searched as late evidence and never delays the decision. */
type Gap = { from?: number; to?: number; late?: boolean };
/** The search cursor persisted per attempt; see the table above. */
export interface HistoryCursor {
  high?: number;
  gaps?: Gap[];
  /** Newest acceptance seq present on the first pass: the upper bound of the acceptance window. */
  accBound?: number;
  hit?: { requestIds: string[]; after: number };
  errors?: { count: number; since: string; last: string };
}
export interface MarkerSearch {
  receipt: Receipt | null;
  cursor: HistoryCursor;
  /** The decision window is read: no receipt in it means none exists. False while it is unread, or when the read failed. */
  complete: boolean;
  /** Set when the history could not be read at all this pass; the cursor is unchanged. */
  error?: string;
}

/**
 * A marker is evidence only in the recipient's own queue or in its accepted-input history, never in a send response. The history is
 * read back to `since` (default five minutes ago), at most `historyLimits.passPages` pages per pass, continuing from `cursor`.
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
  const next: HistoryCursor = { ...cursor };
  delete next.errors;
  let budget = historyLimits.passPages;
  const requestIds = new Set(cursor.hit?.requestIds ?? []);
  let hitAfter = cursor.hit?.after;
  let high = cursor.high;
  let fresh = false;

  // The acceptance follows its request, so page forward from the earliest matching request; the pointer only moves forward, except
  // that a newly found candidate rewinds it to its own seq.
  const scanAcceptance = async (cap: number): Promise<Receipt | null> => {
    fresh = false;
    let after = hitAfter!;
    next.hit = { requestIds: [...requestIds], after };
    for (let page = 0; page < cap && budget > 0; page++) {
      budget--;
      const accepted = await bb.sdk.threads.events.list({ threadId, types: ["turn/input/accepted"], order: "asc", limit: String(HISTORY_PAGE), afterSeq: String(after), signal: AbortSignal.timeout(5000) });
      const hit = accepted.find((event) => event.type === "turn/input/accepted" && requestIds.has((event.data as { clientRequestId?: string }).clientRequestId ?? ""));
      if (hit) return { outcome: "inline", inlineEventRef: `${threadId}:${hit.seq}` };
      if (accepted.length) after = hitAfter = accepted.at(-1)!.seq;
      next.hit = { requestIds: [...requestIds], after };
      if (accepted.length < HISTORY_PAGE) return null;
    }
    return null;
  };

  // Reads one stretch of requests newest first, spending at most `cap` pages; returns what is left unread of it, if anything.
  const scanRequests = async (gap: Gap, cap: number): Promise<Gap | null> => {
    let before = gap.from;
    let first = gap.from === undefined;
    for (let page = 0; ; page++) {
      if (page >= cap || budget <= 0) return { from: before, to: gap.to };
      budget--;
      const events = await bb.sdk.threads.events.list({ threadId, types: ["client/turn/requested"], order: "desc", limit: String(HISTORY_PAGE), ...(before !== undefined ? { beforeSeq: String(before) } : {}), signal: AbortSignal.timeout(5000) });
      for (const event of events) {
        if (gap.to !== undefined && event.seq <= gap.to) return null;
        if (first) { high = Math.max(high ?? 0, event.seq); first = false; }
        if (event.type === "client/turn/requested" && JSON.stringify(event.data).includes(marker)) {
          const requestId = (event.data as { requestId?: string }).requestId;
          if (requestId && !requestIds.has(requestId)) {
            requestIds.add(requestId);
            // A new candidate: its acceptance may lie anywhere after it, so the pointer rewinds to it.
            hitAfter = Math.min(hitAfter ?? event.seq, event.seq);
            fresh = true;
          }
        }
        before = event.seq;
      }
      if (events.length < HISTORY_PAGE || (events.at(-1)?.createdAt ?? Infinity) < floor) return null;
    }
  };

  try {
    if (cursor.accBound === undefined) {
      // Pass 1 fixes the acceptance window: whatever acceptances exist now. One page of the budget.
      budget--;
      const newest = await bb.sdk.threads.events.list({ threadId, types: ["turn/input/accepted"], order: "desc", limit: "1", signal: AbortSignal.timeout(5000) });
      next.accBound = newest[0]?.seq ?? 0;
    }
    if (cursor.hit) {
      const found = await scanAcceptance(historyLimits.acceptancePages);
      if (found) return { receipt: found, cursor: next, complete: true };
    }
    const saved: Gap[] = [...(cursor.gaps ?? [])].sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity));
    if (cursor.high === undefined && !saved.length) saved.push({});
    const remaining: Gap[] = [];
    // Requests newer than the last pass first, but only up to their share while older ranges wait.
    if (cursor.high !== undefined) {
      const spent = historyLimits.passPages - budget;
      const head = await scanRequests({ to: cursor.high }, saved.length ? Math.max(0, headShare() - spent) : budget);
      if (head) remaining.push({ ...head, late: true });
    }
    for (const gap of saved) {
      const left = await scanRequests(gap, budget);
      if (left) remaining.push({ ...left, ...(gap.late ? { late: true } : {}) });
    }
    next.high = high;
    next.gaps = remaining;
    if (requestIds.size && hitAfter !== undefined) {
      next.hit = { requestIds: [...requestIds], after: hitAfter };
      // A request found in this pass: look for its acceptance with whatever pages are left.
      if (fresh && budget > 0) {
        const found = await scanAcceptance(budget);
        if (found) return { receipt: found, cursor: next, complete: true };
      }
    }
    return { receipt: null, cursor: next, complete: remaining.every((gap) => gap.late) && (!next.hit || next.hit.after >= next.accBound!) };
  } catch (error) {
    // A failed read is not unfinished pagination: the cursor stays as it was and the caller decides when to give up.
    return { receipt: null, cursor, complete: false, error: error instanceof Error ? error.message : String(error) };
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
