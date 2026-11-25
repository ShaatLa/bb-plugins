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
  /** The link as it was at the snapshot: a link that changed since is not the one this row was made for. */
  linkOrigin: string | null;
  linkCreated: boolean;
  liveStatus: string;
  action: ClosureAction;
  reason: string | null;
  attemptId: string | null;
  seenActive: boolean;
  selfNotice: NoticeState;
  parentNotice: NoticeState;
  selfAttempts: number;
  parentAttempts: number;
  /** Reserved by each turn start; a baseline is written, and a comparison taken, only for the generation that owns the row. */
  turnGeneration: number;
  /** The environment fingerprint at the turn start, or `UNKNOWN_BASELINE`; null when no comparison is pending. */
  turnBaseline: string | null;
  turnBaselineAt: string | null;
  /** A turn after the close changed the session's files: the notice is owed. */
  workSeen: boolean;
}

interface ClosureThreadRow {
  closure_id: string;
  task_id: string;
  thread_id: string;
  link_id: string | null;
  link_origin: string | null;
  link_created: number;
  live_status: string;
  action: ClosureAction;
  reason: string | null;
  attempt_id: string | null;
  seen_active: number;
  self_notice: NoticeState;
  parent_notice: NoticeState;
  self_attempts: number;
  parent_attempts: number;
  turn_generation: number;
  turn_baseline: string | null;
  turn_baseline_at: string | null;
  work_seen: number;
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
    linkOrigin: row.link_origin,
    linkCreated: row.link_created === 1,
    liveStatus: row.live_status,
    action: row.action,
    reason: row.reason,
    attemptId: row.attempt_id,
    seenActive: row.seen_active === 1,
    selfNotice: row.self_notice,
    parentNotice: row.parent_notice,
    selfAttempts: row.self_attempts,
    parentAttempts: row.parent_attempts,
    turnGeneration: row.turn_generation,
    turnBaseline: row.turn_baseline,
    turnBaselineAt: row.turn_baseline_at,
    workSeen: row.work_seen === 1,
  };
}

/** A baseline that could not be read: its turn is never compared, so it can never count as a change. */
export const UNKNOWN_BASELINE = "unknown";
/** The turn's idle came: nothing is left to compare, and a baseline read still in flight cannot be stored. */
const RETIRED_BASELINE = "retired";

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
    `INSERT INTO closure_threads (closure_id, thread_id, link_id, live_status, link_origin, link_created, action, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Threads that have a closure row, and reviewers with a pending archive intent: a lifecycle event of any other
  // thread costs no query here. Loaded once; a rolled-back insert only leaves a harmless extra entry.
  let watched: Set<string> | null = null;
  const reviewers = new Set<string>();
  const watching = (threadId: string): boolean => {
    watched ??= new Set(db.prepare<[], { thread_id: string }>("SELECT DISTINCT thread_id FROM closure_threads").all().map((entry) => entry.thread_id));
    return watched.has(threadId);
  };
  const insertRow = (closureId: string, threadId: string, link: { id: string; liveStatus: string; origin: string | null; created: boolean }, action: ClosureAction, reason: string | null) => {
    insertStatement.run(closureId, threadId, link.id, link.liveStatus, link.origin, link.created ? 1 : 0, action, reason);
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
    const links = db.prepare<[string], { id: string; thread_id: string; live_status: string; created_for_task: number; link_origin: string | null }>(
      "SELECT id, thread_id, live_status, created_for_task, link_origin FROM task_threads WHERE task_id = ?",
    ).all(taskId);
    for (const link of links) {
      const candidate = link.created_for_task === 1 && archiveOn;
      insertRow(id, link.thread_id, { id: link.id, liveStatus: link.live_status, origin: link.link_origin, created: link.created_for_task === 1 }, candidate ? "candidate" : "kept", candidate ? null : archiveOn ? REASON.notCreated : REASON.off);
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
  function addLate(taskId: string, link: { id: string; threadId: string; liveStatus: string; spawned: boolean; origin: string | null }, archiveOn: boolean): string | null {
    const closureId = currentId(taskId);
    if (!closureId) return null;
    const candidate = link.spawned && archiveOn;
    const existing = row(closureId, link.threadId);
    const snapshot = { id: link.id, liveStatus: link.liveStatus, origin: link.origin, created: link.spawned };
    if (!existing) insertRow(closureId, link.threadId, snapshot, candidate ? "candidate" : "kept", candidate ? null : archiveOn ? REASON.notCreated : REASON.off);
    else if (existing.action === "kept" && candidate)
      db.prepare("UPDATE closure_threads SET action = 'candidate', reason = NULL, link_id = ?, live_status = ?, link_origin = ?, link_created = 1 WHERE closure_id = ? AND thread_id = ?").run(link.id, link.liveStatus, link.origin, closureId, link.threadId);
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
    if (reviewers.has(threadId)) db.prepare("UPDATE task_plan_reviews SET archive_seen_active = 1 WHERE reviewer_thread = ? AND archive_state IN ('pending', 'archiving')").run(threadId);
    if (!watching(threadId)) return [];
    const found = db.prepare<[string], ClosureThreadRow>(
      `UPDATE closure_threads SET seen_active = 1, turn_generation = turn_generation + 1, turn_baseline = NULL, turn_baseline_at = NULL,
         reason = CASE WHEN action IN ('on_idle', 'candidate', 'evaluating') THEN '${REASON.newTurn}' ELSE reason END,
         action = CASE WHEN action IN ('on_idle', 'candidate', 'evaluating') THEN 'kept' ELSE action END
       WHERE thread_id = ? AND action NOT IN ('archiving', 'archived')
         AND closure_id IN (SELECT c.id FROM task_closures c WHERE ${CURRENT_CLOSURE})
       RETURNING *, (SELECT task_id FROM task_closures WHERE id = closure_id) AS task_id`,
    ).all(threadId);
    return found.map(fromRow).filter((entry) => entry.action === "kept");
  }

  /** Stores a turn's baseline, only while the generation the turn reserved still owns the row. */
  function setBaseline(entry: ClosureThread, baseline: string, at: string): boolean {
    return db.prepare(
      "UPDATE closure_threads SET turn_baseline = ?, turn_baseline_at = ? WHERE closure_id = ? AND thread_id = ? AND turn_generation = ? AND turn_baseline IS NULL",
    ).run(baseline, at, entry.closureId, entry.threadId, entry.turnGeneration).changes > 0;
  }

  /**
   * A live `thread.idle` takes the turn's comparisons: the kept rows of current closures that hold a baseline are
   * returned, and every row of the thread is marked retired, so a baseline read still in flight, or a duplicate idle,
   * finds nothing to compare. The generation stays: it is the token the comparison records its result with.
   */
  function takeTurn(threadId: string): ClosureThread[] {
    if (!watching(threadId)) return [];
    return db.transaction(() => {
      const taken = db.prepare<[string, string], ClosureThreadRow>(
        `${SELECT_ROWS} WHERE ct.thread_id = ? AND ct.action = 'kept' AND ct.turn_baseline IS NOT NULL AND ct.turn_baseline <> ? AND ${CURRENT_CLOSURE} ORDER BY ct.rowid`,
      ).all(threadId, RETIRED_BASELINE).map(fromRow);
      db.prepare("UPDATE closure_threads SET turn_baseline = ?, turn_baseline_at = NULL WHERE thread_id = ?").run(RETIRED_BASELINE, threadId);
      return taken;
    })();
  }

  /** A failed, deleted or archived thread: a new generation with no baseline voids every read of its turn still in flight. */
  function abandonTurn(threadId: string): void {
    if (!watching(threadId)) return;
    db.prepare("UPDATE closure_threads SET turn_generation = turn_generation + 1, turn_baseline = NULL, turn_baseline_at = NULL WHERE thread_id = ?").run(threadId);
  }

  /**
   * The durable fact that a turn after the close changed files; delivery is driven from it. Only a comparison whose
   * generation still owns a kept row of a current closure records it: a newer turn, or a terminal event, voids it.
   */
  function recordWork(entries: readonly ClosureThread[]): void {
    const mark = db.prepare(
      `UPDATE closure_threads SET work_seen = 1 WHERE closure_id = ? AND thread_id = ? AND turn_generation = ? AND action = 'kept'
         AND closure_id IN (SELECT c.id FROM task_closures c WHERE ${CURRENT_CLOSURE})`,
    );
    db.transaction(() => { for (const entry of entries) mark.run(entry.closureId, entry.threadId, entry.turnGeneration); })();
  }

  /** The kept rows of current closures whose notice is owed. */
  function owedNotices(threadId: string): ClosureThread[] {
    if (!watching(threadId)) return [];
    return db.prepare<[string], ClosureThreadRow>(
      `${SELECT_ROWS} WHERE ct.thread_id = ? AND ct.action = 'kept' AND ct.work_seen = 1 AND ${CURRENT_CLOSURE} ORDER BY ct.rowid`,
    ).all(threadId).map(fromRow);
  }

  /** A live `thread.idle`: claims the turn-bound rows whose turn was not followed by a new one. */
  function claimIdle(threadId: string): string[] {
    if (!watching(threadId)) return [];
    return db.prepare<[string], { closure_id: string }>(
      `UPDATE closure_threads SET action = 'evaluating'
       WHERE thread_id = ? AND seen_active = 0
         AND (action = 'on_idle' OR (action = 'candidate' AND (live_status IN ('working', 'starting')
           OR closure_id IN (SELECT id FROM task_closures WHERE closed_by_thread = closure_threads.thread_id))))
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

  /** The row of an archive this plugin started or finished for the card's current closure. */
  function ownArchive(taskId: string, threadId: string): ClosureThread | undefined {
    const found = db.prepare<[string, string], ClosureThreadRow>(
      `${SELECT_ROWS} WHERE c.task_id = ? AND ct.thread_id = ? AND ct.action IN ('archiving', 'archived') AND ${CURRENT_CLOSURE} LIMIT 1`,
    ).get(taskId, threadId);
    return found && fromRow(found);
  }

  /**
   * The one holder predicate: every link holds the card except a parent fallback, and only the recorded origin says
   * so. A legacy or imported link (no origin) counts as a holder whatever its label, which is the conservative side:
   * its child becomes a helper, never an independent worker. The preset name is never evidence.
   */
  function holders(taskId: string): string[] {
    return db.prepare<[string], { thread_id: string }>(
      "SELECT thread_id FROM task_threads WHERE task_id = ? AND link_origin IS NOT 'parent'",
    ).all(taskId).map((link) => link.thread_id);
  }

  /** `thread.unarchived` clears the match of an archive that was ours: a later archive is the owner's. */
  function clearArchived(threadId: string): void {
    db.prepare("UPDATE closure_threads SET action = 'kept', reason = 'unarchived' WHERE thread_id = ? AND action = 'archived'").run(threadId);
  }

  /** The link the row was snapshotted from: same id, thread, origin and provenance (a reattach or a manual upsert changes them). */
  function linkUnchanged(entry: ClosureThread): boolean {
    return entry.linkId !== null && db.prepare<[string, string, string, number, string | null], { one: number }>(
      "SELECT 1 AS one FROM task_threads WHERE id = ? AND task_id = ? AND thread_id = ? AND created_for_task = ? AND link_origin IS ?",
    ).get(entry.linkId, entry.taskId, entry.threadId, entry.linkCreated ? 1 : 0, entry.linkOrigin) !== undefined;
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
    if (!reviewers.has(threadId)) return [];
    // The reviewer stays watched until its final claim: a turn that starts during the checks must still be seen.
    const claimed = db.prepare<[string], { id: number; task_id: string; archive_state: string }>(
      `UPDATE task_plan_reviews SET archive_state = CASE WHEN archive_seen_active = 1 THEN 'kept' ELSE 'archiving' END
       WHERE reviewer_thread = ? AND archive_state = 'pending' RETURNING id, task_id, archive_state`,
    ).all(threadId);
    if (claimed.length && !claimed.some((review) => review.archive_state === "archiving")) reviewers.delete(threadId);
    return claimed.map((review) => ({ id: review.id, taskId: review.task_id, claimed: review.archive_state === "archiving" }));
  }

  function setReviewerState(id: number, from: "archiving", to: "archived" | "kept"): boolean {
    const changed = db.prepare("UPDATE task_plan_reviews SET archive_state = ? WHERE id = ? AND archive_state = ?").run(to, id, from).changes > 0;
    const thread = db.prepare<[number], { reviewer_thread: string | null }>("SELECT reviewer_thread FROM task_plan_reviews WHERE id = ?").get(id)?.reviewer_thread;
    if (thread && !db.prepare<[string], { one: number }>("SELECT 1 AS one FROM task_plan_reviews WHERE reviewer_thread = ? AND archive_state IN ('pending', 'archiving') LIMIT 1").get(thread)) reviewers.delete(thread);
    return changed;
  }

  const reviewerSeenActive = (id: number): boolean =>
    db.prepare<[number], { seen: number }>("SELECT archive_seen_active AS seen FROM task_plan_reviews WHERE id = ?").get(id)?.seen === 1;

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
    const armed = db.prepare(
      `UPDATE task_plan_reviews SET archive_state = 'pending', archive_seen_active = 0
       WHERE id = (SELECT MAX(id) FROM task_plan_reviews WHERE task_id = ?) AND outcome = 'approved' AND dedicated_reviewer = 1 AND reviewer_thread = ?
         AND (SELECT archive_reviewer_on_approval FROM projects WHERE id = (SELECT project_id FROM tasks WHERE id = ?)) = 'on'`,
    ).run(taskId, reviewerThread, taskId).changes > 0;
    // Only a reviewer whose intent was really armed is watched; an ordinary review or a switched-off project costs nothing.
    if (armed) reviewers.add(reviewerThread);
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
    // An unfinished turn comparison may have missed its events: it is dropped, so a restart can miss a notice but never invent one.
    db.prepare("UPDATE closure_threads SET turn_baseline = NULL, turn_baseline_at = NULL WHERE turn_baseline IS NOT NULL").run();
    reviewers.clear();
    watched = null;
    watching("");
    return { unknownNotices: unknown };
  }

  return { open, reopen, currentId, isCurrent, closedBy, rows, row, addLate, claim, markActive, setBaseline, takeTurn, abandonTurn, recordWork, owedNotices, claimIdle, linkUnchanged, claimReviewerIdle, setReviewerState, latestReviewId, reviewPending, reviewerSeenActive, holdsLink, ownArchive, holders, clearArchived, otherLinks, reviewsOpenFor, claimNotice, finishNotice, reviewerIntent, recoverOnStartup };
}

export type ClosureStore = ReturnType<typeof createClosureStore>;
