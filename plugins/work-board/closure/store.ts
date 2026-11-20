import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isClosedStatus } from "../shared/workflow-policy";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type ClosureAction = "candidate" | "on_idle" | "evaluating" | "archiving" | "archived" | "kept";
export type NoticeState = "none" | "sending" | "sent" | "failed" | "unknown";
export type Recipient = "self" | "parent";

/** A recipient is tried at most this many times. */
export const NOTICE_ATTEMPT_CAP = 2;

export interface ClosureThread {
  closureId: string;
  taskId: string;
  threadId: string;
  linkId: string | null;
  liveStatus: string;
  action: ClosureAction;
  reason: string | null;
  attemptId: string | null;
  seenActive: boolean;
  selfNotice: NoticeState;
  parentNotice: NoticeState;
  selfAttempts: number;
  parentAttempts: number;
}

interface ClosureThreadRow {
  closure_id: string;
  task_id: string;
  thread_id: string;
  link_id: string | null;
  live_status: string;
  action: ClosureAction;
  reason: string | null;
  attempt_id: string | null;
  seen_active: number;
  self_notice: NoticeState;
  parent_notice: NoticeState;
  self_attempts: number;
  parent_attempts: number;
}

const SELECT_ROWS = `SELECT ct.*, c.task_id FROM closure_threads ct JOIN task_closures c ON c.id = ct.closure_id`;

/** The newest closure of its card, and not reopened. */
const CURRENT_CLOSURE = `c.reopened_at IS NULL AND NOT EXISTS (SELECT 1 FROM task_closures n WHERE n.task_id = c.task_id AND n.rowid > c.rowid)`;

function fromRow(row: ClosureThreadRow): ClosureThread {
  return {
    closureId: row.closure_id,
    taskId: row.task_id,
    threadId: row.thread_id,
    linkId: row.link_id,
    liveStatus: row.live_status,
    action: row.action,
    reason: row.reason,
    attemptId: row.attempt_id,
    seenActive: row.seen_active === 1,
    selfNotice: row.self_notice,
    parentNotice: row.parent_notice,
    selfAttempts: row.self_attempts,
    parentAttempts: row.parent_attempts,
  };
}

export const REASON = {
  notCreated: "not created by Work Board",
  off: "archiving off",
  newTurn: "new turn after close",
  restart: "restarted before the turn ended",
  unknownOutcome: "archive outcome unknown",
  failed: "archive failed",
} as const;

export function createClosureStore(db: Database) {
  const insertStatement = db.prepare(
    `INSERT INTO closure_threads (closure_id, thread_id, link_id, live_status, action, reason) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  // Threads that have a closure row, and reviewers with a pending archive intent: a lifecycle event of any other
  // thread costs no query here. Loaded once; a rolled-back insert only leaves a harmless extra entry.
  let watched: Set<string> | null = null;
  const reviewers = new Set<string>();
  const watching = (threadId: string): boolean => {
    watched ??= new Set(db.prepare<[], { thread_id: string }>("SELECT DISTINCT thread_id FROM closure_threads").all().map((entry) => entry.thread_id));
    return watched.has(threadId);
  };
  const insertRow = (closureId: string, threadId: string, linkId: string | null, liveStatus: string, action: ClosureAction, reason: string | null) => {
    insertStatement.run(closureId, threadId, linkId, liveStatus, action, reason);
    watching(threadId);
    watched!.add(threadId);
  };

  /**
   * Opens a closure inside the status transaction: one row per link of the card, a candidate only where Work Board
   * spawned the session and the project archives, kept (with the reason) otherwise.
   */
  function open(taskId: string, closerThreadId: string | null, archiveOn: boolean): string {
    const id = randomUUID();
    db.prepare("INSERT INTO task_closures (id, task_id, closed_at, closed_by_thread) VALUES (?, ?, ?, ?)").run(id, taskId, new Date().toISOString(), closerThreadId);
    const links = db.prepare<[string], { id: string; thread_id: string; live_status: string; created_for_task: number }>(
      "SELECT id, thread_id, live_status, created_for_task FROM task_threads WHERE task_id = ?",
    ).all(taskId);
    for (const link of links) {
      const candidate = link.created_for_task === 1 && archiveOn;
      insertRow(id, link.thread_id, link.id, link.live_status, candidate ? "candidate" : "kept", candidate ? null : archiveOn ? REASON.notCreated : REASON.off);
    }
    return id;
  }

  function reopen(taskId: string): void {
    db.prepare("UPDATE task_closures SET reopened_at = ? WHERE task_id = ? AND reopened_at IS NULL").run(new Date().toISOString(), taskId);
  }

  function currentId(taskId: string): string | null {
    return db.prepare<[string], { id: string }>(
      "SELECT c.id FROM task_closures c WHERE c.task_id = ? AND " + CURRENT_CLOSURE + " ORDER BY c.rowid DESC LIMIT 1",
    ).get(taskId)?.id ?? null;
  }

  function isCurrent(closureId: string): boolean {
    return db.prepare<[string], { one: number }>("SELECT 1 AS one FROM task_closures c WHERE c.id = ? AND " + CURRENT_CLOSURE).get(closureId) !== undefined;
  }

  function closedBy(closureId: string): string | null {
    return db.prepare<[string], { closed_by_thread: string | null }>("SELECT closed_by_thread FROM task_closures WHERE id = ?").get(closureId)?.closed_by_thread ?? null;
  }

  function rows(closureId: string): ClosureThread[] {
    return db.prepare<[string], ClosureThreadRow>(`${SELECT_ROWS} WHERE ct.closure_id = ? ORDER BY ct.rowid`).all(closureId).map(fromRow);
  }

  function row(closureId: string, threadId: string): ClosureThread | undefined {
    const found = db.prepare<[string, string], ClosureThreadRow>(`${SELECT_ROWS} WHERE ct.closure_id = ? AND ct.thread_id = ?`).get(closureId, threadId);
    return found && fromRow(found);
  }

  /**
   * A link written after the close: it gets its own snapshot row under the current closure. An authoritative spawn
   * link upgrades a row title discovery already wrote as kept, instead of adding a second one.
   */
  function addLate(taskId: string, link: { id: string; threadId: string; liveStatus: string; spawned: boolean }, archiveOn: boolean): string | null {
    const closureId = currentId(taskId);
    if (!closureId) return null;
    const candidate = link.spawned && archiveOn;
    const existing = row(closureId, link.threadId);
    if (!existing) insertRow(closureId, link.threadId, link.id, link.liveStatus, candidate ? "candidate" : "kept", candidate ? null : archiveOn ? REASON.notCreated : REASON.off);
    else if (existing.action === "kept" && candidate)
      db.prepare("UPDATE closure_threads SET action = 'candidate', reason = NULL, link_id = ?, live_status = ? WHERE closure_id = ? AND thread_id = ?").run(link.id, link.liveStatus, closureId, link.threadId);
    return closureId;
  }

  /** Moves a row from one of the `from` actions; false when another path got there first. */
  function claim(closureId: string, threadId: string, from: readonly ClosureAction[], to: ClosureAction, extra: { reason?: string | null; attemptId?: string } = {}): boolean {
    return db.prepare(
      `UPDATE closure_threads SET action = ?, reason = ?, attempt_id = COALESCE(?, attempt_id)
       WHERE closure_id = ? AND thread_id = ? AND action IN (${from.map(() => "?").join(",")})`,
    ).run(to, extra.reason ?? null, extra.attemptId ?? null, closureId, threadId, ...from).changes > 0;
  }

  /**
   * A live `thread.active`: every row of a current closure learns the thread started a turn after the snapshot, a turn
   * bound to `on_idle` is retired, and the rows that may still notify the thread are returned.
   */
  function markActive(threadId: string): ClosureThread[] {
    if (reviewers.has(threadId)) db.prepare("UPDATE task_plan_reviews SET archive_seen_active = 1 WHERE reviewer_thread = ? AND archive_state = 'pending'").run(threadId);
    if (!watching(threadId)) return [];
    const found = db.prepare<[string], ClosureThreadRow>(
      `UPDATE closure_threads SET seen_active = 1,
         reason = CASE WHEN action = 'on_idle' THEN '${REASON.newTurn}' ELSE reason END,
         action = CASE WHEN action = 'on_idle' THEN 'kept' ELSE action END
       WHERE thread_id = ? AND action NOT IN ('archiving', 'archived')
         AND closure_id IN (SELECT c.id FROM task_closures c WHERE ${CURRENT_CLOSURE})
       RETURNING *, (SELECT task_id FROM task_closures WHERE id = closure_id) AS task_id`,
    ).all(threadId);
    return found.map(fromRow).filter((entry) => entry.action === "kept");
  }

  /** A live `thread.idle`: claims the turn-bound rows whose turn was not followed by a new one. */
  function claimIdle(threadId: string): string[] {
    if (!watching(threadId)) return [];
    return db.prepare<[string], { closure_id: string }>(
      `UPDATE closure_threads SET action = 'evaluating'
       WHERE thread_id = ? AND action = 'on_idle' AND seen_active = 0
         AND closure_id IN (SELECT c.id FROM task_closures c WHERE ${CURRENT_CLOSURE})
       RETURNING closure_id`,
    ).all(threadId).map((entry) => entry.closure_id);
  }

  /** The row that still holds the card's link back from the 0.59.3 release: its decision is not made yet. */
  function holdsLink(taskId: string, threadId: string): boolean {
    return db.prepare<[string, string], { one: number }>(
      `SELECT 1 AS one FROM closure_threads ct JOIN task_closures c ON c.id = ct.closure_id
       WHERE c.task_id = ? AND ct.thread_id = ? AND ct.action IN ('candidate', 'on_idle', 'evaluating', 'archiving') AND ${CURRENT_CLOSURE} LIMIT 1`,
    ).get(taskId, threadId) !== undefined;
  }

  /** An archive this plugin started or finished for the card's current closure. */
  function ownArchive(taskId: string, threadId: string): boolean {
    return db.prepare<[string, string], { one: number }>(
      `SELECT 1 AS one FROM closure_threads ct JOIN task_closures c ON c.id = ct.closure_id
       WHERE c.task_id = ? AND ct.thread_id = ? AND ct.action IN ('archiving', 'archived') AND ${CURRENT_CLOSURE} LIMIT 1`,
    ).get(taskId, threadId) !== undefined;
  }

  /** `thread.unarchived` clears the match of an archive that was ours: a later archive is the owner's. */
  function clearArchived(threadId: string): void {
    db.prepare("UPDATE closure_threads SET action = 'kept', reason = 'unarchived' WHERE thread_id = ? AND action = 'archived'").run(threadId);
  }

  /** The link the row was snapshotted from, still there and still marked as spawned by Work Board. */
  function linkIsSpawned(linkId: string | null, taskId: string, threadId: string): boolean {
    return linkId !== null && db.prepare<[string, string, string], { one: number }>(
      "SELECT 1 AS one FROM task_threads WHERE id = ? AND task_id = ? AND thread_id = ? AND created_for_task = 1",
    ).get(linkId, taskId, threadId) !== undefined;
  }

  /** The other cards a thread is linked to, with their status and policy, for the "other open work" check. */
  function otherLinks(threadId: string, exceptTaskId: string) {
    return db.prepare<[string, string], { id: string; task_id: string; key: string; status: string; policy: string | null; created_for_task: number; link_origin: string | null }>(
      `SELECT tt.id, tt.task_id, p.prefix || '-' || t.number AS key, t.status, p.workflow_policy AS policy, tt.created_for_task, tt.link_origin
       FROM task_threads tt JOIN tasks t ON t.id = tt.task_id JOIN projects p ON p.id = t.project_id
       WHERE tt.thread_id = ? AND tt.task_id <> ?`,
    ).all(threadId, exceptTaskId).map((link) => ({
      ...link,
      open: !isClosedStatus({ workflowPolicy: link.policy ? JSON.parse(link.policy) : null }, link.status),
    }));
  }

  /** A reviewer's idle: a pending intent that saw a new turn is retired, the others are claimed for the archive check. */
  function claimReviewerIdle(threadId: string): Array<{ id: number; taskId: string; claimed: boolean }> {
    if (!reviewers.delete(threadId)) return [];
    return db.prepare<[string], { id: number; task_id: string; archive_state: string }>(
      `UPDATE task_plan_reviews SET archive_state = CASE WHEN archive_seen_active = 1 THEN 'kept' ELSE 'archiving' END
       WHERE reviewer_thread = ? AND archive_state = 'pending' RETURNING id, task_id, archive_state`,
    ).all(threadId).map((review) => ({ id: review.id, taskId: review.task_id, claimed: review.archive_state === "archiving" }));
  }

  function setReviewerState(id: number, from: "archiving", to: "archived" | "kept"): boolean {
    return db.prepare("UPDATE task_plan_reviews SET archive_state = ? WHERE id = ? AND archive_state = ?").run(to, id, from).changes > 0;
  }

  const latestReviewId = (taskId: string): number | null =>
    db.prepare<[string], { id: number | null }>("SELECT MAX(id) AS id FROM task_plan_reviews WHERE task_id = ?").get(taskId)?.id ?? null;

  const reviewPending = (threadId: string): boolean =>
    db.prepare<[string], { one: number }>("SELECT 1 AS one FROM task_plan_reviews WHERE reviewer_thread = ? AND outcome = 'pending' LIMIT 1").get(threadId) !== undefined;

  function reviewsOpenFor(threadId: string): boolean {
    return db.prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM task_plans WHERE reviewer_thread = ? AND state <> 'approved' LIMIT 1",
    ).get(threadId) !== undefined;
  }

  /** Notice bookkeeping: claims a recipient for a send, or returns null when it was sent, is sending or is out of attempts. */
  function claimNotice(closureId: string, threadId: string, who: Recipient): number | null {
    const state = `${who}_notice`;
    const attempts = `${who}_attempts`;
    const changed = db.prepare(
      `UPDATE closure_threads SET ${state} = 'sending', ${attempts} = ${attempts} + 1
       WHERE closure_id = ? AND thread_id = ? AND ${state} IN ('none', 'failed') AND ${attempts} < ?`,
    ).run(closureId, threadId, NOTICE_ATTEMPT_CAP).changes > 0;
    if (!changed) return null;
    return db.prepare<[string, string], { n: number }>(`SELECT ${attempts} AS n FROM closure_threads WHERE closure_id = ? AND thread_id = ?`).get(closureId, threadId)!.n;
  }

  function finishNotice(closureId: string, threadId: string, who: Recipient, state: "sent" | "failed"): void {
    db.prepare(`UPDATE closure_threads SET ${who}_notice = ? WHERE closure_id = ? AND thread_id = ? AND ${who}_notice = 'sending'`).run(state, closureId, threadId);
  }

  /** Reviewer archive intents (plan §5). */
  function reviewerIntent(taskId: string, reviewerThread: string): void {
    reviewers.add(reviewerThread);
    db.prepare(
      `UPDATE task_plan_reviews SET archive_state = 'pending', archive_seen_active = 0
       WHERE id = (SELECT MAX(id) FROM task_plan_reviews WHERE task_id = ?) AND outcome = 'approved' AND dedicated_reviewer = 1 AND reviewer_thread = ?
         AND (SELECT archive_reviewer_on_approval FROM projects WHERE id = (SELECT project_id FROM tasks WHERE id = ?)) = 'on'`,
    ).run(taskId, reviewerThread, taskId);
  }

  /** A restart cannot tell a missed idle from none: nothing pending survives it, and nothing is archived by it. */
  function recoverOnStartup(): { unknownNotices: number } {
    db.prepare(`UPDATE closure_threads SET action = 'kept', reason = ? WHERE action IN ('candidate', 'on_idle', 'evaluating')`).run(REASON.restart);
    db.prepare(`UPDATE closure_threads SET action = 'kept', reason = ? WHERE action = 'archiving'`).run(REASON.unknownOutcome);
    const unknown = db.prepare(
      `UPDATE closure_threads SET
         self_notice = CASE WHEN self_notice = 'sending' THEN 'unknown' ELSE self_notice END,
         parent_notice = CASE WHEN parent_notice = 'sending' THEN 'unknown' ELSE parent_notice END
       WHERE self_notice = 'sending' OR parent_notice = 'sending'`,
    ).run().changes;
    db.prepare("UPDATE task_plan_reviews SET archive_state = 'kept' WHERE archive_state IN ('pending', 'archiving')").run();
    reviewers.clear();
    watched = null;
    watching("");
    return { unknownNotices: unknown };
  }

  return { open, reopen, currentId, isCurrent, closedBy, rows, row, addLate, claim, markActive, claimIdle, linkIsSpawned, claimReviewerIdle, setReviewerState, latestReviewId, reviewPending, holdsLink, ownArchive, clearArchived, otherLinks, reviewsOpenFor, claimNotice, finishNotice, reviewerIntent, recoverOnStartup };
}

export type ClosureStore = ReturnType<typeof createClosureStore>;
