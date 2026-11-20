import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { errorMessage } from "../shared/errors";
import { notifyThread } from "../steer";

export type PlanDelivery = "sent" | "failed" | "no_thread";

const MAX_PARENT_HOPS = 5;

/**
 * Where a plan review result goes: the session waiting on the review. When that thread is archived or deleted, its
 * parent takes over (the rule question answers follow). There is no fallback to the task's worker thread. Null when
 * nobody can be reached.
 */
export async function planReviewThread(bb: BbPluginApi, authorThread: string | null): Promise<string | null> {
  let threadId = authorThread;
  for (let hop = 0; threadId && hop <= MAX_PARENT_HOPS; hop++) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt == null && thread.deletedAt == null) return threadId;
      threadId = thread.parentThreadId ?? null;
    } catch {
      // A thread that cannot be read cannot be woken either.
      return null;
    }
  }
  return null;
}

export interface PlanDeliveryEntry {
  /** `actor` gets the actionable message, `copy` an informational one. */
  role: "actor" | "copy";
  delivered: PlanDelivery;
  threadId: string | null;
}
export interface PlanDeliveryResult {
  /** `failed` when any recipient was not reached, else the actor's outcome (`sent`, or `no_thread` when nobody can act). */
  delivered: PlanDelivery;
  /** The actor's thread. */
  threadId: string | null;
  deliveries: PlanDeliveryEntry[];
}

/**
 * Tells the threads waiting on a plan review about a result (feedback or approval). The actor, the session that
 * submitted the attempt, gets `text`; the other recipient gets `copyText` for information. Archived recipients are
 * replaced by their parents first, then the list is de-duplicated: a thread that is both gets one actionable message.
 * A failure never throws: the decision is already saved, and the caller reports it.
 */
export async function deliverPlanReview(
  bb: BbPluginApi,
  input: { taskId: string; recipients: { actor: string | null; copy: string | null }; text: string; copyText: (actor: string | null) => string },
): Promise<PlanDeliveryResult> {
  const actor = await planReviewThread(bb, input.recipients.actor);
  const copy = await planReviewThread(bb, input.recipients.copy);
  const targets: Array<{ role: "actor" | "copy"; threadId: string | null; text: string }> = [{ role: "actor", threadId: actor, text: input.text }];
  if (copy && copy !== actor) targets.push({ role: "copy", threadId: copy, text: input.copyText(actor ?? input.recipients.actor) });
  const deliveries: PlanDeliveryEntry[] = [];
  for (const target of targets) {
    if (!target.threadId) {
      deliveries.push({ role: target.role, delivered: "no_thread", threadId: null });
      continue;
    }
    try {
      await notifyThread(bb, target.threadId, target.text);
      deliveries.push({ role: target.role, delivered: "sent", threadId: target.threadId });
    } catch (error) {
      bb.log.warn(`failed to deliver the plan review of ${input.taskId} to ${target.threadId}: ${errorMessage(error)}`);
      deliveries.push({ role: target.role, delivered: "failed", threadId: target.threadId });
    }
  }
  return { delivered: deliveries.some((entry) => entry.delivered === "failed") ? "failed" : deliveries[0]!.delivered, threadId: deliveries[0]!.threadId, deliveries };
}

/**
 * Why a reviewer thread cannot be woken, written for the plan author; null when it can. A missing or deleted thread is
 * gone for good, an archived one can be unarchived with the bb CLI (plugins cannot do it).
 */
export async function reviewerProblem(bb: BbPluginApi, threadId: string, taskKey: string): Promise<string | null> {
  try {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.deletedAt != null) return `${threadId} was deleted. Deletion is permanent: submit with a different --reviewer`;
    if (thread.archivedAt != null)
      return `${threadId} is archived. Run \`bb thread unarchive ${threadId}\`, then repeat \`bb work-board plan submit ${taskKey} --reviewer ${threadId}\` to send the wake again, or submit with a different --reviewer`;
    return null;
  } catch {
    return `${threadId} does not exist. Submit with a different --reviewer`;
  }
}

/** Wakes the reviewer thread itself; there is no fallback to another thread. A failure never throws: the submission is saved, and the caller reports it. */
export async function wakeReviewer(
  bb: BbPluginApi,
  input: { taskId: string; taskKey: string; threadId: string; text: string },
): Promise<{ delivered: "sent" | "failed"; hint: string | null }> {
  const problem = await reviewerProblem(bb, input.threadId, input.taskKey);
  if (problem) return { delivered: "failed", hint: problem };
  try {
    await notifyThread(bb, input.threadId, input.text);
    return { delivered: "sent", hint: null };
  } catch (error) {
    bb.log.warn(`failed to wake the plan reviewer ${input.threadId} of ${input.taskId}: ${errorMessage(error)}`);
    return { delivered: "failed", hint: `Could not reach ${input.threadId}: ${errorMessage(error)}. Repeat \`bb work-board plan submit ${input.taskKey} --reviewer ${input.threadId}\` to send the wake again` };
  }
}
