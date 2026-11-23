import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import type { ClosedThread } from "../shared/contract";
import { errorMessage } from "../shared/errors";
import { statusLabel } from "../shared/statuses";
import { isClosedStatus } from "../shared/workflow-policy";
import { notifyThread } from "../steer";
import { environmentFingerprint, otherActivity, SAMPLE_TIMEOUT_MS } from "./environment";
import { PENDING } from "./format";
import { NOTICE_ATTEMPT_CAP, REASON, UNKNOWN_BASELINE, type ClosureThread, type NoticeState, type Recipient } from "./store";

const MAX_PARENT_HOPS = 5;
const MAX_MEMO = 256;

type TurnThread = { id: string; parentThreadId: string | null; environmentId: string | null };

const claimable = (state: NoticeState, attempts: number) => (state === "none" || state === "failed") && attempts < NOTICE_ATTEMPT_CAP;
/** A row is sampled only while one of its recipients can still get the notice. */
const owesNotice = (entry: ClosureThread, hasParent: boolean) =>
  claimable(entry.selfNotice, entry.selfAttempts) || (hasParent && claimable(entry.parentNotice, entry.parentAttempts));

/**
 * Everything that happens to the sessions of a closed card after the status write committed: the archive decision with
 * its re-checks, the turn-bound intents, and the notices to a session that works inside the closed card.
 */
export function createClosureService(bb: BbPluginApi, tasks: TasksStore) {
  const closures = tasks.closures;
  const evaluations = new Map<string, Promise<ClosedThread[]>>();
  // Archive decisions in flight, by closure and thread: the close evaluation joins one an idle started meanwhile.
  const decisions = new Map<string, Promise<void>>();
  // Live turn comparisons by thread, from the turn start until the final Git read at its idle. Any other thread's turn
  // start on the same environment latches one as ambiguous: Git cannot tell whose edits it sees. A restart drops them
  // together with the stored baselines.
  // `reading` marks a comparison whose idle took it and is doing the final read: that idle alone releases it.
  const comparisons = new Map<string, { environmentId: string; ambiguous: boolean; reading: boolean }>();

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

  /** What the thread's other work says about archiving it; shared by closure rows and plan reviewers. */
  function otherWork(threadId: string, exceptTaskId: string): string | null {
    const open = closures.otherLinks(threadId, exceptTaskId).find((link) => link.open);
    if (open) return `linked to ${open.key}`;
    if (closures.reviewsOpenFor(threadId)) return "reviewer of an open plan";
    if (closures.scheduleTarget(threadId)) return "scheduled executor";
    return null;
  }

  /** The disqualifiers that do not depend on the turn: known at the close, and again just before the archive. */
  function eligibility(entry: ClosureThread): string | null {
    const card = closedCard(entry.closureId, entry.taskId);
    if (!card) return "card reopened";
    if (card.project.archiveThreadsOnClose === "off") return REASON.off;
    if (!entry.linkCreated || !closures.linkUnchanged(entry)) return "link changed";
    return otherWork(entry.threadId, entry.taskId);
  }

  /** The synchronous part of the decision of a claimed row; it runs before the SDK reads and again right before the call. */
  function guard(entry: ClosureThread): string | null {
    const current = closures.row(entry.closureId, entry.threadId);
    if (!current || current.action !== "evaluating") return "decided elsewhere";
    if (current.seenActive) return REASON.newTurn;
    return eligibility(current);
  }

  /**
   * The reads every archive needs, for a closure row or a reviewer; any doubt keeps the thread. At the close of a
   * working session (`idle` false) the same disqualifiers apply except that it is, of course, not idle yet.
   */
  async function threadReason(threadId: string, idle = true): Promise<string | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt != null || thread.deletedAt != null) return "already archived or deleted";
      if (thread.pinnedAt != null) return "pinned";
      if (idle && (thread.status !== "idle" || thread.runtime.displayStatus !== "idle")) return "not idle";
      if ((await bb.sdk.threads.queue.list({ threadId })).length > 0) return "has queued input";
      if ((await bb.sdk.threads.childSummary({ threadId })).unarchivedDescendantCount > 0) return "has live child threads";
      return null;
    } catch (error) {
      bb.log.warn(`Could not check ${threadId} before archiving: ${errorMessage(error)}`);
      return "could not verify";
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
  function release(entry: ClosureThread, text: string, always = false): void {
    const linked = closures.linkUnchanged(entry);
    if (!linked && !always) return;
    if (linked) tasks.deleteTaskThread(entry.linkId!);
    tasks.createComment({ taskId: entry.taskId, threadId: entry.threadId, kind: "system", authorName: "Work Board", body: text });
    publish(entry.taskId, "threads:changed", "comments:changed");
  }

  /**
   * Decides one claimed (`evaluating`) row. `afterTurn` is the first live idle of an `on_idle` row: the link was held
   * back from the 0.59.3 release, so it is released here, whether the thread was archived or kept.
   */
  function decide(entry: ClosureThread, afterTurn: boolean): Promise<void> {
    const key = `${entry.closureId}/${entry.threadId}`;
    const running: Promise<void> = decideNow(entry, afterTurn).finally(() => { if (decisions.get(key) === running) decisions.delete(key); });
    decisions.set(key, running);
    return running;
  }

  async function decideNow(entry: ClosureThread, afterTurn: boolean): Promise<void> {
    const key = tasks.getTask(entry.taskId)?.key ?? entry.taskId;
    const keep = (reason: string, from: "evaluating" | "archiving") => {
      // The 0.59.3 release is only for the link this row was made for, on a card that is still closed.
      if (closures.claim(entry.closureId, entry.threadId, [from], "kept", { reason }) && afterTurn && closedCard(entry.closureId, entry.taskId))
        release(entry, `Thread detached (automatic): @thread:${entry.threadId} finished its turn after ${key} was closed`);
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
      release(entry, `Thread archived (automatic): @thread:${entry.threadId} — ${key} was closed`, true);
      bb.log.info(`Archived ${entry.threadId}: ${key} was closed (closure ${entry.closureId}, attempt ${attemptId})`);
    }
  }

  /** One candidate row at its close (or late link): an idle session is checked at once, a working one waits for its idle. */
  async function settle(closureId: string, threadId: string): Promise<void> {
    const entry = closures.row(closureId, threadId);
    if (!entry || entry.action !== "candidate") return;
    const closer = closures.closedBy(closureId);
    if (closer === threadId || entry.liveStatus === "working" || entry.liveStatus === "starting") {
      // What is known now (other work, a pin) is said now, not after the agent was told to start fresh.
      // The local checks run again after the reads, which took time.
      let reason = eligibility(entry);
      if (!reason) reason = await threadReason(threadId, false);
      if (!reason) reason = eligibility(entry);
      const fresh = closures.row(closureId, threadId);
      if (!fresh || fresh.action !== "candidate") return;
      if (reason) closures.claim(closureId, threadId, ["candidate"], "kept", { reason });
      else if (fresh.seenActive) closures.claim(closureId, threadId, ["candidate"], "kept", { reason: REASON.newTurn });
      else closures.claim(closureId, threadId, ["candidate"], "on_idle");
    } else if (entry.liveStatus === "idle") {
      if (closures.claim(closureId, threadId, ["candidate"], "evaluating")) await decide({ ...entry, action: "evaluating" }, false);
    } else closures.claim(closureId, threadId, ["candidate"], "kept", { reason: `thread ${entry.liveStatus}` });
  }

  function summarize(closureId: string): ClosedThread[] {
    return closures.rows(closureId).map((entry): ClosedThread => {
      if (entry.action === "archived") return { threadId: entry.threadId, action: "archived", reason: null };
      if (entry.action === "kept") return { threadId: entry.threadId, action: "kept", reason: entry.reason };
      // A decision still running is not yet a promise: it is reported as pending and the agent is not told to start fresh.
      return { threadId: entry.threadId, action: "on_idle", reason: entry.action === "on_idle" ? null : PENDING };
    });
  }

  /** The evaluation of one closure, made once however many paths ask (the post-commit hook, the CLI, the RPC). */
  function onClosed(closureId: string): Promise<ClosedThread[]> {
    let evaluation = evaluations.get(closureId);
    if (!evaluation) {
      evaluation = (async () => {
        try {
          for (const entry of closures.rows(closureId)) await settle(closureId, entry.threadId);
          // A decision an idle started meanwhile is part of this result.
          await Promise.all([...decisions].filter(([key]) => key.startsWith(`${closureId}/`)).map(([, running]) => running.catch(() => undefined)));
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
        if (closures.reviewerSeenActive(review.id)) return "new turn after approval";
        if (closures.reviewsOpenFor(threadId)) return "reviewer of an open plan";
        if (closures.scheduleTarget(threadId)) return "scheduled executor";
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
   * A turn start (`thread.active`), called right after `markActive` and before any await. It latches every other live
   * comparison on the thread's environment, then stores this turn's baseline on the kept rows that may still notify.
   * Anything unreadable, or another thread already running on the environment, stores the unknown baseline.
   */
  async function turnStarted(thread: TurnThread, kept: ClosureThread[]): Promise<void> {
    const environmentId = thread.environmentId;
    if (environmentId) for (const [id, comparison] of comparisons) if (id !== thread.id && comparison.environmentId === environmentId) comparison.ambiguous = true;
    const rows = kept.filter((entry) => !entry.workSeen && owesNotice(entry, thread.parentThreadId !== null));
    if (!rows.length) return;
    const store = (baseline: string, at: number) => rows.map((entry) => closures.setBaseline(entry, baseline, new Date(at).toISOString())).some(Boolean);
    if (!environmentId) {
      bb.log.info(`No closed-card comparison for ${thread.id}: the thread has no environment`);
      store(UNKNOWN_BASELINE, Date.now());
      return;
    }
    const comparison = { environmentId, ambiguous: false, reading: false };
    comparisons.set(thread.id, comparison);
    const at = Date.now();
    const signal = AbortSignal.timeout(SAMPLE_TIMEOUT_MS);
    const [fingerprint, busy] = await Promise.all([environmentFingerprint(bb, environmentId, signal), otherActivity(bb, environmentId, thread.id, null, signal)]);
    // A stored baseline hands the latch to the idle that takes it; otherwise (unreadable, or retired by an early idle
    // or a terminal event) nobody compares, and the latch goes now.
    if (fingerprint && !busy && store(JSON.stringify({ environmentId, fingerprint }), at)) return;
    if (!fingerprint || busy) {
      bb.log.info(`No closed-card comparison for ${thread.id}: ${fingerprint ? "another thread is running on its environment" : "its Git state could not be read"}`);
      store(UNKNOWN_BASELINE, at);
    }
    if (comparisons.get(thread.id) === comparison) comparisons.delete(thread.id);
  }

  /**
   * A turn end (`thread.idle`). The comparisons are taken synchronously at the call; Git is read again, and a change
   * no other thread can explain is recorded as work. Owed notices are then delivered, so a failed recipient is retried
   * at the end of a later turn, even one that only answered.
   */
  async function turnEnded(thread: TurnThread): Promise<void> {
    const taken = closures.takeTurn(thread.id).filter((entry) => entry.turnBaseline !== UNKNOWN_BASELINE);
    const comparison = comparisons.get(thread.id);
    if (taken.length) {
      if (comparison) comparison.reading = true;
      try {
        await compare(thread, taken, comparison);
      } finally {
        if (comparison && comparisons.get(thread.id) === comparison) comparisons.delete(thread.id);
      }
    } else if (comparison && !comparison.reading) {
      // Nothing to compare (a reopened card, an early idle): the turn's latch is orphaned. A latch whose final read is
      // in flight belongs to the idle before this duplicate one and stays.
      comparisons.delete(thread.id);
    }
    const hasParent = thread.parentThreadId !== null;
    await notify(thread, closures.owedNotices(thread.id).filter((entry) => owesNotice(entry, hasParent)));
  }

  /** A failed, deleted or archived thread: its turn is not compared, and reads still in flight cannot record or store. */
  function turnAbandoned(threadId: string): void {
    closures.abandonTurn(threadId);
    comparisons.delete(threadId);
  }

  async function compare(thread: TurnThread, rows: ClosureThread[], comparison: { ambiguous: boolean } | undefined): Promise<void> {
    // One turn start wrote every row's baseline, so the first one stands for all.
    const base = JSON.parse(rows[0]!.turnBaseline!) as { environmentId: string; fingerprint: string };
    const skip = (why: string) => bb.log.info(`No closed-card notice for ${thread.id}: ${why}`);
    if (thread.environmentId !== base.environmentId) return skip("its environment changed during the turn");
    const signal = AbortSignal.timeout(SAMPLE_TIMEOUT_MS);
    const [fingerprint, busy] = await Promise.all([
      environmentFingerprint(bb, base.environmentId, signal),
      otherActivity(bb, base.environmentId, thread.id, Date.parse(rows[0]!.turnBaselineAt!), signal),
    ]);
    if (!fingerprint) return skip("its Git state could not be read");
    if (busy || !comparison || comparison.ambiguous) return skip("another thread was active on its environment");
    if (fingerprint !== base.fingerprint) closures.recordWork(rows);
  }

  /**
   * The notice owed by a turn that changed files after the card closed: the thread hears about it once, and its
   * parent gets one informational copy. Each recipient has its own state; a failed one is retried while it has
   * attempts left, and a delivery whose outcome is unknown is never resent.
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
          // The card may have been reopened while the recipient was being resolved or the previous send was pending.
          // The card is checked again inside the serialized delivery, right before the transport call.
          const delivered = await notifyThread(bb, to, text(to), () => closedCard(entry.closureId, entry.taskId) !== null);
          closures.finishNotice(entry.closureId, thread.id, who, delivered ? "sent" : "failed");
        } catch (error) {
          closures.finishNotice(entry.closureId, thread.id, who, "failed");
          bb.log.warn(`Closed-card notice to the ${who} of ${thread.id} failed (attempt ${attempt}): ${errorMessage(error)}`);
        }
      };
      // Git compares the whole environment, so the text says what changed, not who changed it.
      const key = card.task.key;
      await send("self", () =>
        `${key} is ${status}. Files in this session's environment changed during a turn after ${key} closed. If this is work for another card, it is fine; if ${key} is not finished, reopen it.`,
        async () => thread.id);
      if (thread.parentThreadId)
        await send("parent", () =>
          `${key} is ${status}. Files in the environment of @thread:${thread.id} changed during a turn after ${key} closed. If this is work for another card, it is fine; if ${key} is not finished, reopen it.`,
          () => liveParent(thread.parentThreadId));
    }
  }

  return { onClosed, lateLink, claimIdle, settleIdle, reviewerIdle, turnStarted, turnEnded, turnAbandoned, liveComparisons: () => comparisons.size };
}

export type ClosureService = ReturnType<typeof createClosureService>;
