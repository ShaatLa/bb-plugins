import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { OPEN_QUESTION_SQL } from "../shared/questions";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** The open owner decisions of a card: open questions whose kind is decision, or missing (read as decision). Oldest first. */
export function openDecisionIds(db: Database, taskId: string): string[] {
  return db
    .prepare<[string], { id: string }>(`SELECT q.id FROM task_questions q WHERE q.task_id = ? AND ${OPEN_QUESTION_SQL} AND COALESCE(json_extract(q.payload, '$.kind'), 'decision') = 'decision' ORDER BY q.id`)
    .all(taskId)
    .map((row) => row.id);
}

/** The review a pause is bound to: the plan is in review and has a pending attempt. Null when no review is waiting. */
export interface ReviewBinding {
  /** The pending attempt's row id; a different one later means the review moved on. */
  attemptId: number;
  version: number;
  /** The reviewer thread; null when the owner reviews, which has nothing to wake. */
  reviewerThread: string | null;
}

export function reviewBinding(db: Database, taskId: string): ReviewBinding | null {
  const row = db
    .prepare<[string], { id: number; version: number; reviewer_thread: string | null }>(
      `SELECT r.id, r.version, r.reviewer_thread FROM task_plan_reviews r JOIN task_plans p ON p.task_id = r.task_id
       WHERE r.task_id = ? AND r.outcome = 'pending' AND p.state = 'in_review' ORDER BY r.id DESC LIMIT 1`,
    )
    .get(taskId);
  return row ? { attemptId: row.id, version: row.version, reviewerThread: row.reviewer_thread } : null;
}

/** A plan is paused when it is in review and its card has an open owner decision; derived, never stored. */
export const isPaused = (db: Database, taskId: string): boolean => reviewBinding(db, taskId) !== null && openDecisionIds(db, taskId).length > 0;

/** Why a plan cannot go to review while the card has an open owner decision, or null. */
export function submitRefusal(db: Database, key: string, taskId: string): string | null {
  const [open] = openDecisionIds(db, taskId);
  return open ? `${key} has an open owner decision (${open}); submit after it is answered.` : null;
}

/** Why a reviewer cannot approve or send feedback while the card has an open owner decision, or null. */
export function reviewerRefusal(db: Database, key: string, version: number, taskId: string): string | null {
  const [open] = openDecisionIds(db, taskId);
  return open ? `${key} plan v${version}: review paused, the owner has an open decision (${open}). Wait for the message that it is settled, read the decisions on the card, then approve or send feedback.` : null;
}
