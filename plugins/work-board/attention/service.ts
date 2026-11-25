import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { deliverWithReceipt, searchAttentionMarker, type HistoryCursor, type Receipt } from "../steer";
import { errorMessage } from "../shared/errors";
import { managerProblemText, type ManagerLookup } from "../shared/attention";
import { publishProjectsChanged, publishSettingsChanged } from "../api";
import { isSideChatShapedThread } from "../shared/side-chat";
import { bumpRev, CURRENT_KEY_SQL, onAttentionChanged, onTrackerDirty, scanTracker } from "./ledger";
import { completeTransition, configuredManager, getModeRow, kindState, normalizeLegacyModes, requestMode, type AttentionMode, type KindState } from "./modes";
import { ATTENTION_KIND, PILOT_SIGNALS } from "./observe";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export const attentionMarker = (batchId: string) => `<!-- work-board-attention:${batchId} -->`;
const DEBOUNCE_MS = 2000;
const RECONCILE_CRON = "*/10 * * * *";
const FAILURE_BACKOFF_MS = 60_000;
const FAILURE_BACKOFF_CAP_MS = 30 * 60_000;
/** An inline send whose accepted-input event never arrives stops being "sending" and becomes unknown. */
export const PENDING_INLINE_MS = 10 * 60_000;
export const LATE_SEARCH_MS = 10 * 60_000;
const LATE_SEARCH_BATCH = 20;
/** An unreadable history gives an attempt up as unknown after this many failed passes spread over at least this long. */
export const HISTORY_ERROR_PASSES = 5;
export const HISTORY_ERROR_SPAN_MS = 30 * 60_000;

const SIGNAL_TEXT: Record<string, string> = {
  no_active_thread: "in progress with no active thread",
  no_open_pr: "in review or testing with no open PR",
  pr_state_unavailable: "in review or testing and the PR state could not be read",
  closed_unmerged_pr: "a linked PR was closed without merging",
};

interface AttemptRow {
  attempt_id: string;
  tracker_id: string;
  kind: string;
  generation: number;
  batch_id: string;
  recipient_thread_id: string;
  /** Old attempts may carry `sweep_fallback` or `parent`; new ones are always `manager`. */
  recipient_source: "manager" | "sweep_fallback" | "parent";
  started_at: string;
  transport_started_at: string | null;
  outcome: string;
  disposition: string | null;
  recovery_cursor: string | null;
}

const instances = new WeakMap<BbPluginApi, ReturnType<typeof createService>>();
export function attentionService(bb: BbPluginApi): ReturnType<typeof createService> {
  const found = instances.get(bb);
  if (found) return found;
  const created = createService(bb);
  instances.set(bb, created);
  return created;
}

function createService(bb: BbPluginApi) {
  const db: Database = bb.storage.database();
  const inflight = new Map<string, Promise<void>>();
  const pendingInline = new Map<string, number>();
  const lateSearchedAt = new Map<string, number>();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let eligibleTimer: ReturnType<typeof setTimeout> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Set<string>();
  let draining: Promise<void> | undefined;
  let closed = false;

  const warn = (error: unknown) => { if (!closed) bb.log.warn(`Attention: ${errorMessage(error)}`); };
  const nowIso = () => new Date().toISOString();

  const updateAttempt = (attemptId: string, trackerId: string, assignments: string, ...values: unknown[]) =>
    db.prepare(`UPDATE attention_attempts SET ${assignments}, rev=? WHERE attempt_id=?`).run(...values, bumpRev(db, trackerId), attemptId);

  /**
   * One bounded pass of the history search for an attempt's marker, resumed from its stored cursor. A pass whose read failed is
   * counted in the cursor; after enough failures over enough time the search gives up (`unreadable`), keeping the cursor so later
   * evidence can still record the receipt.
   */
  async function search(attempt: AttemptRow) {
    const read = attempt.recovery_cursor;
    const cursor = read ? (JSON.parse(read) as HistoryCursor) : {};
    const result = await searchAttentionMarker(bb, attempt.recipient_thread_id, attentionMarker(attempt.batch_id), attempt.started_at, cursor);
    let saved = result.cursor;
    let unreadable = false;
    if (result.error !== undefined) {
      const errors = cursor.errors ?? { count: 0, since: nowIso(), last: "" };
      saved = { ...result.cursor, errors: { count: errors.count + 1, since: errors.since, last: result.error } };
      unreadable = saved.errors!.count >= HISTORY_ERROR_PASSES && Date.now() - Date.parse(saved.errors!.since) >= HISTORY_ERROR_SPAN_MS;
    }
    // Written only if nobody moved the cursor since it was read (a second process); then this pass decides nothing negative.
    const written = db.prepare<[string, string, string | null]>("UPDATE attention_attempts SET recovery_cursor=? WHERE attempt_id=? AND recovery_cursor IS ?").run(JSON.stringify(saved), attempt.attempt_id, read).changes > 0;
    return { ...result, unreadable: written && unreadable, stale: !written, complete: written && result.complete, error: saved.errors?.last };
  }

  // Recovery of one attempt runs one pass at a time: an overlapping drain and switch-off would otherwise race on its cursor.
  const attemptLocks = new Map<string, Promise<unknown>>();
  function withAttemptLock<T>(attemptId: string, job: () => Promise<T>): Promise<T> {
    const run = (attemptLocks.get(attemptId) ?? Promise.resolve()).then(job);
    const tail = run.then(() => undefined, () => undefined);
    attemptLocks.set(attemptId, tail);
    void tail.then(() => { if (attemptLocks.get(attemptId) === tail) attemptLocks.delete(attemptId); });
    return run;
  }
  const reload = (attemptId: string) => db.prepare<[string], AttemptRow>("SELECT * FROM attention_attempts WHERE attempt_id=?").get(attemptId);

  /** A receipt only moves an attempt forward: acceptance is final, and an empty search never overwrites it. */
  const advanceAttempt = (attempt: Pick<AttemptRow, "attempt_id" | "tracker_id">, from: readonly string[], assignments: string, ...values: unknown[]): boolean => {
    const current = db.prepare<[string], { outcome: string }>("SELECT outcome FROM attention_attempts WHERE attempt_id=?").get(attempt.attempt_id)?.outcome;
    if (!current || !from.includes(current)) return false;
    updateAttempt(attempt.attempt_id, attempt.tracker_id, assignments, ...values);
    return true;
  };

  // A deletion event is authoritative even when a later read of the thread fails; the time is kept with the evidence.
  const deletedAt = new Map<string, string>();
  // Any archive, unarchive or delete event, and any change of a manager setting, moves the epoch: a read that started earlier
  // cannot be trusted, whichever thread it was about (a manager can be replaced and chosen again while a read is out).
  let epoch = 0;
  const invalidateLookups = () => { epoch++; };
  /** The first record of a deletion also invalidates reads still outstanding, whichever path established it. */
  const recordDeletion = (id: string) => { if (!deletedAt.has(id)) { deletedAt.set(id, nowIso()); invalidateLookups(); } };

  /**
   * The manager session as a recipient. `unusable` needs evidence (the setting is empty, a deletion event, or a successful read
   * that shows the cause); a read that failed for any other reason is only `unavailable`. A read that overlapped an event of the
   * manager is discarded and made again, so the answer is never older than the latest event.
   */
  async function lookupManager(manager: string | null): Promise<ManagerLookup> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = epoch;
      const result = await readManager(manager);
      if (epoch === started) return result;
    }
    return { status: "unavailable", error: "The manager session kept changing while it was read" };
  }

  async function readManager(manager: string | null): Promise<ManagerLookup> {
    const unusable = (cause: Extract<ManagerLookup, { status: "unusable" }>["cause"], detectedAt = nowIso()): ManagerLookup => ({ status: "unusable", cause, detectedAt });
    if (!manager) return unusable("none");
    if (deletedAt.has(manager)) return unusable("deleted", deletedAt.get(manager));
    try {
      const thread = await bb.sdk.threads.get({ threadId: manager });
      if (!thread) return { status: "unavailable", error: "The thread read returned nothing" };
      if (thread.deletedAt != null) {
        // The deletion is recorded like an event's, once, so a later failed read keeps it and its time.
        recordDeletion(manager);
        return unusable("deleted", deletedAt.get(manager));
      }
      if (thread.archivedAt != null) return unusable("archived");
      // The same eligibility as comment delivery: a side chat or a stopping thread is not a manager.
      if (isSideChatShapedThread(thread)) return unusable("side_chat");
      if (thread.status === "stopping") return unusable("stopping");
      return { status: "usable", threadId: manager };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "thread_not_found") return unusable("not_found");
      return { status: "unavailable", error: errorMessage(error) };
    }
  }

  /** Re-read a tracker's manager and tell the settings view; every pass publishes, so no open view stays on an older answer. */
  async function refreshManagerStatus(trackerId: string): Promise<void> {
    const manager = configuredManager(db, trackerId);
    await lookupManager(manager);
    // The setting may have moved while the read was outstanding: that read says nothing about the current manager.
    if (configuredManager(db, trackerId) !== manager) return;
    publishSettingsChanged(bb, trackerId);
  }

  /**
   * Occurrences a drain may claim now: open, unbaselined, valid, past grace and with no blocking attempt or recent failure. `except`
   * names an undecided unknown attempt whose own items do not block, so its Send again can be judged.
   */
  function claimable(trackerId: string, at: number, upcoming = false, except: string | null = null): { id: string; task_key: string; signal: string; eligible_at: string }[] {
    const rows = db.prepare<[string, string, string, string | null], { id: string; task_key: string; signal: string; eligible_at: string }>(
      `SELECT o.id, ${CURRENT_KEY_SQL} AS task_key, o.signal, o.eligible_at FROM manager_attention o
       WHERE o.tracker_id=? AND o.kind=? AND o.cleared_at IS NULL AND o.sweep_baselined_generation IS NULL AND o.eligible_at${upcoming ? ">" : "<="}?
       AND o.signal IN (${PILOT_SIGNALS.map((signal) => `'${signal}'`).join(", ")})
       AND COALESCE(o.executor_state,'') NOT IN ('pending','sending')
       AND NOT EXISTS (SELECT 1 FROM attention_unknown u WHERE u.tracker_id=o.tracker_id AND u.kind=o.kind AND u.task_id=o.task_id AND u.signal=o.signal)
       AND NOT EXISTS (SELECT 1 FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id WHERE i.occurrence_id=o.id AND a.attempt_id IS NOT ?
         AND (a.outcome IN ('claimed', 'sending', 'appended', 'queued', 'inline') OR (a.outcome='unknown' AND COALESCE(a.disposition, '')<>'retry')))
       ORDER BY ${upcoming ? "o.eligible_at" : "o.created_rev"}`,
    ).all(trackerId, ATTENTION_KIND, new Date(at).toISOString(), except);
    return rows.filter((row) => {
      const failures = db.prepare<[string], { n: number; last: string }>("SELECT COUNT(*) AS n, MAX(a.started_at) AS last FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id WHERE i.occurrence_id=? AND a.outcome='failed'").get(row.id);
      if (!failures?.n) return true;
      return at - Date.parse(failures.last) >= Math.min(FAILURE_BACKOFF_MS * 2 ** (failures.n - 1), FAILURE_BACKOFF_CAP_MS);
    });
  }

  /** One transaction: the generation and the fence are checked, then the ids are claimed, so overlapping drains cannot share one. */
  function claim(trackerId: string, recipient: { threadId: string }, generation: number): { attempt: string; ids: { id: string; task_key: string; signal: string }[]; batch: string } | null {
    return db.transaction(() => {
      const row = getModeRow(db, trackerId);
      if (row.effective_mode !== "live" || row.requested_mode !== null || row.effective_generation !== generation) return null;
      // The manager was verified before this transaction: a replacement made meanwhile makes that lookup stale.
      if (configuredManager(db, trackerId) !== recipient.threadId) return null;
      const ids = claimable(trackerId, Date.now());
      if (!ids.length) return null;
      const attempt = randomUUID();
      const batch = randomUUID();
      db.prepare<[string, string, string, number, string, string, string, string, number]>(
        "INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)",
      ).run(attempt, trackerId, ATTENTION_KIND, row.effective_generation, batch, recipient.threadId, "manager", nowIso(), bumpRev(db, trackerId));
      for (const { id } of ids) db.prepare<[string, string]>("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES (?, ?)").run(attempt, id);
      return { attempt, ids, batch };
    })();
  }

  function recordReceipt(attempt: Pick<AttemptRow, "attempt_id" | "tracker_id">, receipt: Receipt): void {
    const at = nowIso();
    const accepting = ["claimed", "sending", "unknown"];
    if (receipt.outcome === "appended" || receipt.outcome === "queued") advanceAttempt(attempt, accepting, "outcome=?, queued_message_id=?, accepted_at=COALESCE(accepted_at, ?)", receipt.outcome, receipt.queuedMessageId, at);
    else if (receipt.outcome === "inline") advanceAttempt(attempt, accepting, "outcome='inline', inline_event_ref=?, accepted_at=COALESCE(accepted_at, ?)", receipt.inlineEventRef, at);
    else if (receipt.outcome === "failed") advanceAttempt(attempt, ["sending"], "outcome='failed', error=?", receipt.error);
    else if (receipt.outcome === "unknown") advanceAttempt(attempt, ["sending"], "outcome='unknown', error=?", receipt.error);
    else { pendingInline.set(attempt.attempt_id, Date.now()); return; }
    pendingInline.delete(attempt.attempt_id);
  }

  function messageText(ids: { task_key: string; signal: string }[]): string {
    const lines = ids.map((row) => `- [${row.task_key}](/plugins/work-board/work-board/task/${row.task_key}): ${SIGNAL_TEXT[row.signal] ?? row.signal}`);
    return `\`Stale status\`: ${ids.length === 1 ? "1 card needs" : `${ids.length} cards need`} attention\n${lines.join("\n")}\n\nCheck each card: move it, ask the owner on the task, or leave a comment with the reason.`;
  }

  async function transport(claimed: NonNullable<ReturnType<typeof claim>>, recipientThreadId: string, trackerId: string): Promise<void> {
    const marker = attentionMarker(claimed.batch);
    // `sending` is its own write, made right before transport, so a restart can tell a claimed-only attempt from one that may have gone out.
    const moved = db.prepare<[string, number, string]>("UPDATE attention_attempts SET outcome='sending', transport_started_at=?, rev=? WHERE attempt_id=? AND outcome='claimed'")
      .run(nowIso(), bumpRev(db, trackerId), claimed.attempt).changes;
    if (!moved) return;
    let receipt: Receipt;
    try {
      receipt = await deliverWithReceipt(bb, recipientThreadId, messageText(claimed.ids), marker);
    } catch (error) {
      receipt = { outcome: "unknown", error: errorMessage(error) };
    }
    recordReceipt({ attempt_id: claimed.attempt, tracker_id: trackerId }, receipt);
  }

  const attemptsWhere = (trackerId: string, condition: string) =>
    db.prepare<[string], AttemptRow>(`SELECT * FROM attention_attempts WHERE tracker_id=? AND ${condition} ORDER BY started_at`).all(trackerId);

  /** Settle attempts nothing is currently driving, from evidence in the recipient's queue and accepted-input history. */
  async function recover(trackerId: string, throttleLate = false, withLate = true): Promise<void> {
    for (const listed of attemptsWhere(trackerId, "outcome IN ('claimed', 'sending') ")) {
      if (inflight.has(listed.attempt_id)) continue;
      await withAttemptLock(listed.attempt_id, async () => {
        // Another pass may have decided it while this one waited.
        const attempt = reload(listed.attempt_id);
        if (!attempt || inflight.has(attempt.attempt_id)) return;
        if (attempt.outcome === "claimed") {
          // Nothing was sent: the occurrences are claimable again.
          advanceAttempt(attempt, ["claimed"], "outcome='failed', error='Interrupted before sending'");
          return;
        }
        if (attempt.outcome !== "sending") return;
        const { receipt: found, complete, unreadable, error } = await search(attempt);
        if (found) recordReceipt(attempt, found);
        else if (unreadable) recordReceipt(attempt, { outcome: "unknown", error: `History unreadable: ${error}` });
        // No evidence is a conclusion only once the whole history back to the attempt's start has been read.
        else if (complete && (!pendingInline.has(attempt.attempt_id) || Date.now() - pendingInline.get(attempt.attempt_id)! > PENDING_INLINE_MS)) recordReceipt(attempt, { outcome: "unknown", error: "No evidence of acceptance after a restart or timeout" });
      });
    }
    if (withLate) await recoverLate(trackerId, throttleLate);
  }

  /**
   * Evidence that arrives late, even after an owner resolution or a switch-off, is still the attempt's receipt. Each pass looks at
   * the attempts searched longest ago first, so no unknown attempt starves behind newer ones.
   */
  async function recoverLate(trackerId: string, throttle = false): Promise<void> {
    const due = attemptsWhere(trackerId, "outcome='unknown' ")
      .filter((attempt) => !throttle || Date.now() - (lateSearchedAt.get(attempt.attempt_id) ?? 0) >= LATE_SEARCH_MS)
      .sort((a, b) => (lateSearchedAt.get(a.attempt_id) ?? 0) - (lateSearchedAt.get(b.attempt_id) ?? 0))
      .slice(0, LATE_SEARCH_BATCH);
    for (const listed of due) {
      lateSearchedAt.set(listed.attempt_id, Date.now());
      await withAttemptLock(listed.attempt_id, async () => {
        const attempt = reload(listed.attempt_id);
        if (!attempt || attempt.outcome !== "unknown") return;
        const { receipt: found } = await search(attempt);
        if (found) recordReceipt(attempt, found);
      });
    }
  }

  /** A pending switch-off: wait for in-flight sends, settle what is left, then complete it once nothing is claimed or sending. */
  async function settleSwitchOff(trackerId: string): Promise<boolean> {
    // Only this tracker's claimed and sending attempts; unknown ones and other trackers' sends never hold it.
    const own = attemptsWhere(trackerId, "outcome IN ('claimed', 'sending') ").map((attempt) => inflight.get(attempt.attempt_id)).filter((run) => run !== undefined);
    await Promise.allSettled(own);
    await recover(trackerId, false, false);
    const done = completeTransition(db, trackerId);
    if (done) {
      bb.log.info(`attention ${ATTENTION_KIND} for ${trackerId}: switched off`);
      publishProjectsChanged(bb, trackerId);
      notifyChanged(trackerId);
    }
    return done;
  }

  async function drainTracker(trackerId: string): Promise<void> {
    const row = getModeRow(db, trackerId);
    if (row.effective_mode !== "live") return;
    if (row.requested_mode !== null) {
      if (row.transition_direction === "to_shadow") await settleSwitchOff(trackerId);
      return;
    }
    await recover(trackerId, true);
    await drainExecutors(trackerId);
    if (!claimable(trackerId, Date.now()).length) return;
    // Only a verified, usable manager receives claims; otherwise the open occurrences stay pending and the lookup is retried next pass.
    const lookup = await lookupManager(configuredManager(db, trackerId));
    if (lookup.status !== "usable") return;
    const recipient = { threadId: lookup.threadId };
    const claimed = claim(trackerId, recipient, row.effective_generation);
    if (!claimed) return;
    const run = transport(claimed, recipient.threadId, trackerId).catch(warn).finally(() => inflight.delete(claimed.attempt));
    inflight.set(claimed.attempt, run);
    await run;
  }

  async function drainExecutors(trackerId: string): Promise<void> {
    const pending = db.prepare<[string], { id: string; task_id: string; task_key: string; signal: string }>("SELECT o.id,o.task_id,o.task_key,o.signal FROM manager_attention o WHERE o.tracker_id=? AND o.kind='stale-status' AND o.cleared_at IS NULL AND o.executor_state='pending' AND NOT EXISTS (SELECT 1 FROM attention_unknown u WHERE u.tracker_id=o.tracker_id AND u.kind=o.kind AND u.task_id=o.task_id AND u.signal=o.signal) ORDER BY o.created_rev").all(trackerId);
    for (const taskId of new Set(pending.map(row => row.task_id))) {
      const group = db.transaction(() => {
        const rows = pending.filter(row => row.task_id === taskId);
        return rows.filter(row => db.prepare<[string]>("UPDATE manager_attention SET executor_state='sending' WHERE id=? AND executor_state='pending' AND cleared_at IS NULL").run(row.id).changes > 0);
      })();
      if (!group.length) continue;
      const ids = db.prepare<[string], { thread_id: string }>("SELECT DISTINCT thread_id FROM task_threads WHERE task_id=? AND live_status NOT IN ('completed','failed')").all(taskId).map(row => row.thread_id);
      let outcome: "sent" | "none" | "failed" | "unknown" = ids.length ? "failed" : "none";
      try {
        const threads = ids.length ? await bb.sdk.threads.list({ threadIds: ids, limit: ids.length, includeHidden: true }) : [];
        const executors = threads.filter(thread => !thread.archivedAt && !thread.deletedAt);
        if (!executors.length) outcome = "none";
        const fixes: Record<string, string> = { no_active_thread: "continue the work", no_open_pr: "open or link the PR", pr_state_unavailable: "check that the linked PR is reachable", closed_unmerged_pr: "reopen, replace or exclude the closed PR" };
        const text = `${group[0]!.task_key} is flagged by Work Board: ${group.map(row => SIGNAL_TEXT[row.signal] ?? row.signal).join("; ")}. Within 10 minutes: ${group.map(row => fixes[row.signal]).join("; ")}; or, if you wait for something, \`bb work-board pause ${group[0]!.task_key} --reason \"<why>\" --for <duration>\`; or, if you are not working on it, \`bb work-board update ${group[0]!.task_key} --status todo\`. Otherwise the project manager is told.`;
        for (const thread of executors) {
          const receipt = await deliverWithReceipt(bb, thread.id, text, `<!-- work-board-executor:${group[0]!.id} -->`);
          if (receipt.outcome === "appended" || receipt.outcome === "queued" || receipt.outcome === "inline") outcome = "sent";
          else if (receipt.outcome !== "failed" && outcome !== "sent") outcome = "unknown";
          else if (receipt.outcome === "failed") bb.log.warn(`Executor notice failed for ${thread.id}: ${receipt.error}`);
        }
      } catch (error) { bb.log.warn(`Executor notice failed: ${errorMessage(error)}`); }
      const at = nowIso();
      const eligible = new Date(Date.now() + (outcome === "sent" || outcome === "unknown" ? 600_000 : 0)).toISOString();
      db.transaction(() => {
        for (const row of group) db.prepare<[string, string, string, string]>("UPDATE manager_attention SET executor_state=?,executor_at=?,eligible_at=MAX(eligible_at,?) WHERE id=? AND executor_state='sending'").run(outcome, at, eligible, row.id);
      })();
    }
  }

  const activeTrackerIds = () => db.prepare<[string], { tracker_id: string }>("SELECT tracker_id FROM attention_modes WHERE kind=? AND (effective_mode<>'off' OR requested_mode IS NOT NULL)").all(ATTENTION_KIND).map((row) => row.tracker_id);

  function drain(): Promise<void> {
    draining ??= (async () => {
      for (const trackerId of activeTrackerIds()) await drainTracker(trackerId).catch(warn);
      scheduleEligible();
    })().finally(() => { draining = undefined; });
    return draining;
  }

  const notifyChanged = (_trackerId: string) => scheduleDrain();
  function scheduleDrain(delay = DEBOUNCE_MS) {
    if (closed || drainTimer) return;
    drainTimer = setTimeout(() => { drainTimer = undefined; void drain().catch(warn); }, delay);
    drainTimer.unref?.();
  }
  /** Milliseconds until the next occurrence that could actually be claimed comes due; accepted, blocked and unknown ones never count. */
  function nextEligibleDelay(): number | null {
    let soonest: number | null = null;
    for (const trackerId of activeTrackerIds()) {
      const row = getModeRow(db, trackerId);
      if (row.effective_mode !== "live" || row.requested_mode !== null) continue;
      const next = claimable(trackerId, Date.now(), true)[0];
      if (next && (soonest === null || Date.parse(next.eligible_at) < soonest)) soonest = Date.parse(next.eligible_at);
    }
    return soonest === null ? null : Math.min(Math.max(soonest - Date.now() + 1000, 1000), 10 * 60_000);
  }
  // Grace is a time threshold, not a write, so the next occurrence to come due schedules its own drain.
  function scheduleEligible() {
    if (closed) return;
    clearTimeout(eligibleTimer);
    const delay = nextEligibleDelay();
    if (delay === null) return;
    eligibleTimer = setTimeout(() => scheduleDrain(0), delay);
    eligibleTimer.unref?.();
  }

  function scheduleScan(trackerId: string) {
    if (closed) return;
    dirty.add(trackerId);
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      for (const id of dirty) { try { db.transaction(() => scanTracker(db, id))(); } catch (error) { warn(error); } }
      dirty.clear();
    }, DEBOUNCE_MS);
    scanTimer.unref?.();
  }

  /** Startup and the ten-minute pass: rescan every active tracker, settle attempts, drain. */
  async function reconcileAll(): Promise<void> {
    for (const trackerId of activeTrackerIds()) {
      try { db.transaction(() => scanTracker(db, trackerId))(); } catch (error) { warn(error); }
    }
    // Late receipts for unknown attempts are looked for whatever the mode, so a switch-off never strands them;
    // this pass is the periodic one, so it is not throttled.
    for (const { tracker_id } of db.prepare<[], { tracker_id: string }>("SELECT DISTINCT tracker_id FROM attention_attempts WHERE outcome='unknown'").all())
      await recoverLate(tracker_id).catch(warn);
    for (const { tracker_id } of db.prepare<[], { tracker_id: string }>("SELECT tracker_id FROM attention_manager WHERE manager IS NOT NULL").all())
      await refreshManagerStatus(tracker_id).catch(warn);
    await drain();
  }

  /** The owner's On or Off; a switch-off that waits for a send returns `switchingOff` at once and completes later. */
  async function setMode(input: { trackerId: string; mode: AttentionMode }): Promise<KindState> {
    const row = getModeRow(db, input.trackerId);
    const before = row.effective_mode;
    let guard: { manager: string | null; generation: number } | undefined;
    if (input.mode === "live" && before !== "live" && row.requested_mode === null) {
      // Read the manager first; the request transaction then checks that neither the manager nor the generation moved.
      const manager = configuredManager(db, input.trackerId);
      const problem = managerProblemText(await lookupManager(manager));
      if (problem) throw new Error(problem);
      guard = { manager, generation: row.effective_generation };
    }
    const state = requestMode(db, { ...input, guard });
    bb.log.info(`attention ${ATTENTION_KIND} for ${input.trackerId}: ${before} → ${input.mode}`);
    // A send still in flight finishes in the background; its completion publishes the Off state, so the settings never wait on it.
    if (state.switchingOff) void settleSwitchOff(input.trackerId).catch(warn);
    scheduleDrain();
    return state;
  }

  /** Send again can reopen something: notices are on and at least one of the attempt's own occurrences is claimable without it. */
  function canRetry(attempt: Pick<AttemptRow, "attempt_id" | "tracker_id">): boolean {
    const row = getModeRow(db, attempt.tracker_id);
    if (row.effective_mode !== "live" || row.requested_mode !== null) return false;
    const items = new Set(db.prepare<[string], { occurrence_id: string }>("SELECT occurrence_id FROM attention_attempt_items WHERE attempt_id=?").all(attempt.attempt_id).map((item) => item.occurrence_id));
    return claimable(attempt.tracker_id, Date.now(), false, attempt.attempt_id).some((occurrence) => items.has(occurrence.id));
  }

  /** The owner's decision on an unknown attempt: accept the loss, or let its occurrences be claimed again. */
  async function resolveAttempt(attemptId: string, disposition: "waived_loss" | "retry"): Promise<void> {
    db.transaction(() => {
      const attempt = reload(attemptId);
      if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
      if (attempt.outcome !== "unknown" || attempt.disposition) throw new Error("Only an unresolved unknown attempt can be resolved");
      // Rechecked in the write: a retry that could reopen nothing would hide the attempt and send nothing.
      if (disposition === "retry" && !canRetry(attempt)) throw new Error("Nothing in this notice can be sent again: notices are off or its cards are no longer stale. Accept the loss instead.");
      updateAttempt(attemptId, attempt.tracker_id, "disposition=?, disposition_at=?", disposition, nowIso());
    })();
    log(`attention attempt ${attemptId}: ${disposition}`);
    scheduleDrain();
  }
  const log = (message: string) => bb.log.info(message);

  function register() {
    // Before the startup reconciliation and the first drain, so no legacy Shadow row is ever read as live.
    normalizeLegacyModes(db);
    db.prepare<[string, string]>("UPDATE manager_attention SET executor_state='unknown', executor_at=?, eligible_at=MAX(eligible_at,?) WHERE executor_state='sending'").run(nowIso(), new Date(Date.now() + 600_000).toISOString());
    const stops = [onAttentionChanged(notifyChanged), onTrackerDirty(scheduleScan)];
    // The settings follow the configured manager: an event for any other thread changes nothing.
    for (const type of ["thread.archived", "thread.unarchived", "thread.deleted"] as const) {
      bb.events.on(type, ({ thread }) => {
        invalidateLookups();
        if (type === "thread.deleted") recordDeletion(thread.id);
        for (const { tracker_id } of db.prepare<[string], { tracker_id: string }>("SELECT tracker_id FROM attention_manager WHERE manager=?").all(thread.id)) publishSettingsChanged(bb, tracker_id);
      });
    }
    bb.background.schedule("attention-reconcile", RECONCILE_CRON, () => reconcileAll());
    bb.onDispose(() => {
      closed = true;
      for (const stop of stops) stop();
      clearTimeout(drainTimer); clearTimeout(scanTimer); clearTimeout(eligibleTimer);
      instances.delete(bb);
    });
    // Events are not replayed: settle what a restart left half-sent without delaying plugin load.
    void reconcileAll().catch(warn);
  }

  return { register, drain, drainTracker, nextEligibleDelay, recoverLate, reconcileAll, settleSwitchOff, setMode, resolveAttempt, canRetry, scheduleDrain, recover, lookupManager, invalidateLookups };
}
