import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import type { ClosedThread } from "../shared/contract";
import { errorMessage } from "../shared/errors";
import { statusLabel } from "../shared/statuses";
import { isClosedStatus } from "../shared/workflow-policy";
import { notifyThread } from "../steer";
import { REASON, type ClosureThread, type Recipient } from "./store";

const MAX_PARENT_HOPS = 5;
const MAX_MEMO = 256;

/**
 * Everything that happens to the sessions of a closed card after the status write committed: the archive decision with
 * its re-checks, the turn-bound intents, and the notices to a session that works inside the closed card.
 */
export function createClosureService(bb: BbPluginApi, tasks: TasksStore) {
  const closures = tasks.closures;
  const evaluations = new Map<string, Promise<ClosedThread[]>>();

  const publish = (taskId: string, ...channels: string[]) => {
    for (const channel of channels) bb.realtime.publish(channel, { taskId });
  };

  /** The card behind a closure when it is still closed (current closure, status closed under the project's policy). */
  function closedCard(closureId: string, taskId: string) {
    if (!closures.isCurrent(closureId)) return null;
    const task = tasks.getTask(taskId);
    const project = task && tasks.getProject(task.projectId);
    if (!task || !project || !isClosedStatus(project, task.status)) return null;
    return { task, project };
  }

  /** The synchronous part of every archive decision; it runs before the SDK reads and again right before the call. */
  function guard(entry: ClosureThread): string | null {
    const card = closedCard(entry.closureId, entry.taskId);
    if (!card) return "card reopened";
    if (card.project.archiveThreadsOnClose === "off") return REASON.off;
    const current = closures.row(entry.closureId, entry.threadId);
    if (!current || current.action !== "evaluating") return "decided elsewhere";
    if (current.seenActive) return REASON.newTurn;
    if (!closures.linkIsSpawned(current.linkId, entry.taskId, entry.threadId)) return "link changed";
    const open = closures.otherLinks(entry.threadId, entry.taskId).find((link) => link.open);
    if (open) return `linked to ${open.key}`;
    if (closures.reviewsOpenFor(entry.threadId)) return "reviewer of an open plan";
    return null;
  }

  /** The reads every archive needs, for a closure row or a reviewer; any doubt keeps the thread. */
  async function threadReason(threadId: string): Promise<string | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt != null || thread.deletedAt != null) return "already archived or deleted";
      if (thread.pinnedAt != null) return "pinned";
      if (thread.status !== "idle" || thread.runtime.displayStatus !== "idle") return "not idle";
      if ((await bb.sdk.threads.queue.list({ threadId })).length > 0) return "has queued input";
      if ((await bb.sdk.threads.childSummary({ threadId })).unarchivedDescendantCount > 0) return "has live child threads";
      return null;
    } catch (error) {
      bb.log.warn(`Could not check ${threadId} before archiving: ${errorMessage(error)}`);
      return "could not check the thread";
    }
  }

  /** Calls the archive; true only when the SDK reports the thread archived. */
  async function archive(threadId: string): Promise<boolean> {
    try {
      return (await bb.sdk.threads.archive({ threadId })).archivedThreadIds.includes(threadId);
    } catch (error) {
      bb.log.warn(`Could not archive ${threadId}: ${errorMessage(error)}`);
      return false;
    }
  }

  /**
   * Writes a closed card's line and releases its link once. A link that was detached or replaced meanwhile is left
   * alone and, for a plain release, gets no line; `always` writes the line even when the archive event removed the link first.
   */
  function release(taskId: string, linkId: string | null, threadId: string, text: string, always = false): void {
    const linked = linkId !== null && tasks.getTaskThread(linkId) !== undefined;
    if (!linked && !always) return;
    if (linked) tasks.deleteTaskThread(linkId!);
    tasks.createComment({ taskId, threadId, kind: "system", authorName: "Work Board", body: text });
    publish(taskId, "threads:changed", "comments:changed");
  }

  /**
   * Decides one claimed (`evaluating`) row. `afterTurn` is the first live idle of an `on_idle` row: the link was held
   * back from the 0.59.3 release, so it is released here, whether the thread was archived or kept.
   */
  async function decide(entry: ClosureThread, afterTurn: boolean): Promise<void> {
    const key = tasks.getTask(entry.taskId)?.key ?? entry.taskId;
    const keep = (reason: string, from: "evaluating" | "archiving") => {
      if (closures.claim(entry.closureId, entry.threadId, [from], "kept", { reason }) && afterTurn)
        release(entry.taskId, entry.linkId, entry.threadId, `Thread detached (automatic): @thread:${entry.threadId} finished its turn after ${key} was closed`);
    };
    let reason = guard(entry);
    if (!reason) reason = await threadReason(entry.threadId);
    if (!reason) reason = guard(entry);
    if (reason) return keep(reason, "evaluating");
    const attemptId = crypto.randomUUID();
    if (!closures.claim(entry.closureId, entry.threadId, ["evaluating"], "archiving", { attemptId })) return;
    if (!(await archive(entry.threadId))) return keep(REASON.failed, "archiving");
    // The archived event may have come first; the row is ours either way, and the line is written once.
    if (closures.claim(entry.closureId, entry.threadId, ["archiving"], "archived")) {
      release(entry.taskId, entry.linkId, entry.threadId, `Thread archived (automatic): @thread:${entry.threadId} — ${key} was closed`, true);
      bb.log.info(`Archived ${entry.threadId}: ${key} was closed (closure ${entry.closureId}, attempt ${attemptId})`);
    }
  }

  /** One candidate row at its close (or late link): an idle session is checked at once, a working one waits for its idle. */
  async function settle(closureId: string, threadId: string): Promise<void> {
    const entry = closures.row(closureId, threadId);
    if (!entry || entry.action !== "candidate") return;
    const closer = closures.closedBy(closureId);
    if (closer === threadId || entry.liveStatus === "working" || entry.liveStatus === "starting") {
      if (entry.seenActive) closures.claim(closureId, threadId, ["candidate"], "kept", { reason: REASON.newTurn });
      else closures.claim(closureId, threadId, ["candidate"], "on_idle");
    } else if (entry.liveStatus === "idle") {
      if (closures.claim(closureId, threadId, ["candidate"], "evaluating")) await decide({ ...entry, action: "evaluating" }, false);
    } else closures.claim(closureId, threadId, ["candidate"], "kept", { reason: `thread ${entry.liveStatus}` });
  }

  function summarize(closureId: string): ClosedThread[] {
    return closures.rows(closureId).map((entry) => ({
      threadId: entry.threadId,
      action: entry.action === "archived" ? "archived" : entry.action === "kept" ? "kept" : "on_idle",
      reason: entry.action === "kept" ? entry.reason : null,
    }));
  }

  /** The evaluation of one closure, made once however many paths ask (the post-commit hook, the CLI, the RPC). */
  function onClosed(closureId: string): Promise<ClosedThread[]> {
    let evaluation = evaluations.get(closureId);
    if (!evaluation) {
      evaluation = (async () => {
        try {
          for (const entry of closures.rows(closureId)) await settle(closureId, entry.threadId);
        } catch (error) {
          bb.log.warn(`Could not evaluate the threads of a closed card: ${errorMessage(error)}`);
        }
        return summarize(closureId);
      })();
      evaluations.set(closureId, evaluation);
      if (evaluations.size > MAX_MEMO) evaluations.delete(evaluations.keys().next().value!);
    }
    return evaluation;
  }

  /** A link written after the close: its row is added by the writer, and settled here. */
  async function lateLink(closureId: string | null, threadId: string): Promise<void> {
    if (closureId) await settle(closureId, threadId).catch((error) => bb.log.warn(`Could not settle a late link: ${errorMessage(error)}`));
  }

  /** The first live idle of a thread: the closure rows bound to its turn are claimed now, synchronously. */
  function claimIdle(threadId: string): ClosureThread[] {
    return closures.claimIdle(threadId).map((closureId) => closures.row(closureId, threadId)!);
  }

  /** Decides the rows `claimIdle` returned. */
  async function settleIdle(claimed: ClosureThread[]): Promise<void> {
    await Promise.all(claimed.map((entry) => decide(entry, true).catch((error) => bb.log.warn(`Could not decide ${entry.threadId}: ${errorMessage(error)}`))));
  }

  /** The reviewer of an approved plan, archived on its first idle after the approving turn when it was dedicated. */
  async function reviewerIdle(threadId: string): Promise<void> {
    for (const review of closures.claimReviewerIdle(threadId)) {
      if (!review.claimed) continue;
      const keepReviewer = () => closures.setReviewerState(review.id, "archiving", "kept");
      const guardReviewer = (): string | null => {
        const project = tasks.getProject(tasks.getTask(review.taskId)?.projectId ?? "");
        if (project?.archiveReviewerOnApproval !== "on") return "archiving off";
        const latest = closures.latestReviewId(review.taskId);
        if (latest !== review.id) return "a newer review attempt exists";
        if (closures.reviewPending(threadId)) return "reviewer of another pending review";
        if (closures.reviewsOpenFor(threadId)) return "reviewer of an open plan";
        const own = closures.otherLinks(threadId, "").filter((link) => link.open);
        // One review-only link to the reviewed card is the reviewer's own; any other open link is card work.
        const work = own.filter((link) => !(link.task_id === review.taskId && link.link_origin === "discovery" && link.created_for_task === 0));
        return work.length ? `linked to ${work[0]!.key}` : null;
      };
      try {
        let reason = guardReviewer() ?? (await threadReason(threadId));
        if (!reason) reason = guardReviewer();
        if (reason || !(await archive(threadId))) {
          keepReviewer();
          continue;
        }
        closures.setReviewerState(review.id, "archiving", "archived");
        bb.log.info(`Archived plan reviewer ${threadId} after approval (review attempt ${review.id})`);
      } catch (error) {
        keepReviewer();
        bb.log.warn(`Could not archive reviewer ${threadId}: ${errorMessage(error)}`);
      }
    }
  }

  /** The nearest ancestor that is not archived or deleted; null when there is none or a read fails. */
  async function liveParent(parentThreadId: string | null): Promise<string | null> {
    let id = parentThreadId;
    for (let hop = 0; id && hop < MAX_PARENT_HOPS; hop++) {
      const parent = await bb.sdk.threads.get({ threadId: id });
      if (parent.archivedAt == null && parent.deletedAt == null) return parent.id;
      id = parent.parentThreadId;
    }
    return null;
  }

  /**
   * A live `thread.active` of a thread that is still linked to, or kept under, a closed card: it hears about it once,
   * and its parent gets one informational copy. Each recipient has its own state; a failed one is retried while it
   * has attempts left, and a delivery whose outcome is unknown is never resent.
   */
  async function notify(thread: { id: string; parentThreadId: string | null }, rows: ClosureThread[]): Promise<void> {
    for (const entry of rows) {
      const card = closedCard(entry.closureId, entry.taskId);
      if (!card) continue;
      const status = statusLabel(card.task.status, card.project.statuses);
      const send = async (who: Recipient, text: (target: string) => string, target: () => Promise<string | null>) => {
        const attempt = closures.claimNotice(entry.closureId, thread.id, who);
        if (attempt === null) return;
        try {
          const to = await target();
          if (!to) throw new Error("no recipient");
          await notifyThread(bb, to, text(to));
          closures.finishNotice(entry.closureId, thread.id, who, "sent");
        } catch (error) {
          closures.finishNotice(entry.closureId, thread.id, who, "failed");
          bb.log.warn(`Closed-card notice to the ${who} of ${thread.id} failed (attempt ${attempt}): ${errorMessage(error)}`);
        }
      };
      await send("self", () =>
        `${card.task.key} is ${status}, but this session started new work while still linked to it. If this is new work for another card, it is fine; if ${card.task.key} is not finished, reopen it.`,
        async () => thread.id);
      if (thread.parentThreadId)
        await send("parent", () =>
          `${card.task.key} is ${status}, and @thread:${thread.id} started new work while still linked to it. Informational: reopen ${card.task.key} if it is not finished.`,
          () => liveParent(thread.parentThreadId));
    }
  }

  return { onClosed, lateLink, claimIdle, settleIdle, reviewerIdle, notify };
}

export type ClosureService = ReturnType<typeof createClosureService>;
