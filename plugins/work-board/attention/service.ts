import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { deliverWithReceipt, findAttentionMarker, type Receipt } from "../steer";
import { errorMessage } from "../shared/errors";
import { SWEEP_PLUGIN_ID } from "../shared/attention";
import { isSideChatShapedThread } from "../shared/side-chat";
import { bumpRev, CURRENT_KEY_SQL, onAttentionChanged, onTrackerDirty, scanTracker } from "./ledger";
import { finishToShadow, getModeRow, kindState, requestMode, type AttentionMode, type KindState } from "./modes";
import { ATTENTION_KIND, PILOT_SIGNALS } from "./observe";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export const attentionMarker = (batchId: string) => `<!-- work-board-attention:${batchId} -->`;
const DEBOUNCE_MS = 2000;
const RECONCILE_CRON = "*/10 * * * *";
const FAILURE_BACKOFF_MS = 60_000;
const FAILURE_BACKOFF_CAP_MS = 30 * 60_000;
/** An inline send whose accepted-input event never arrives stops being "sending" and becomes unknown. */
const PENDING_INLINE_MS = 10 * 60_000;
const LATE_SEARCH_MS = 10 * 60_000;
const LATE_SEARCH_BATCH = 20;

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
  recipient_source: "manager" | "sweep_fallback" | "parent";
  started_at: string;
  transport_started_at: string | null;
  outcome: string;
  disposition: string | null;
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

  /** A receipt only moves an attempt forward: acceptance is final, and an empty search never overwrites it. */
  const advanceAttempt = (attempt: Pick<AttemptRow, "attempt_id" | "tracker_id">, from: readonly string[], assignments: string, ...values: unknown[]): boolean => {
    const current = db.prepare<[string], { outcome: string }>("SELECT outcome FROM attention_attempts WHERE attempt_id=?").get(attempt.attempt_id)?.outcome;
    if (!current || !from.includes(current)) return false;
    updateAttempt(attempt.attempt_id, attempt.tracker_id, assignments, ...values);
    return true;
  };

  /** The recipient: the Work Board manager setting, else Sweep's, with an archived or deleted target replaced by its eligible parent. */
  async function resolveRecipient(trackerId: string): Promise<{ threadId: string; source: "manager" | "sweep_fallback" | "parent" } | null> {
    const own = db.prepare<[string], { manager: string | null }>("SELECT manager FROM attention_manager WHERE tracker_id=?").get(trackerId)?.manager || null;
    let source: "manager" | "sweep_fallback" | "parent" = "manager";
    let target = own;
    if (!target) {
      const bound = getModeRow(db, trackerId).bound_bb_project_id;
      if (!bound) return null;
      try {
        const config = await bb.sdk.plugins.callRpc({ pluginId: SWEEP_PLUGIN_ID, method: "config.get", input: { projectId: bound, key: "manager" }, outputSchema: z.object({ manager: z.string().nullable().optional() }).passthrough() });
        target = config.manager || null;
      } catch { return null; }
      source = "sweep_fallback";
    }
    for (let hops = 0; target && hops < 5; hops++) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: target });
        if (!thread) return null;
        if (thread.archivedAt == null && thread.deletedAt == null) {
          // The same eligibility as comment delivery: a side chat or a stopping thread is not a manager.
          if (isSideChatShapedThread(thread) || thread.status === "stopping") return null;
          return { threadId: target, source };
        }
        target = thread.parentThreadId ?? null;
        source = "parent";
      } catch { return null; }
    }
    return null;
  }

  /** Occurrences a drain may claim now: open, unbaselined, valid, past grace and with no blocking attempt or recent failure. */
  function claimable(trackerId: string, at: number, upcoming = false): { id: string; task_key: string; signal: string; eligible_at: string }[] {
    const rows = db.prepare<[string, string, string], { id: string; task_key: string; signal: string; eligible_at: string }>(
      `SELECT o.id, ${CURRENT_KEY_SQL} AS task_key, o.signal, o.eligible_at FROM manager_attention o
       WHERE o.tracker_id=? AND o.kind=? AND o.cleared_at IS NULL AND o.sweep_baselined_generation IS NULL AND o.eligible_at${upcoming ? ">" : "<="}?
       AND o.signal IN (${PILOT_SIGNALS.map((signal) => `'${signal}'`).join(", ")})
       AND NOT EXISTS (SELECT 1 FROM attention_unknown u WHERE u.tracker_id=o.tracker_id AND u.kind=o.kind AND u.task_id=o.task_id AND u.signal=o.signal)
       AND NOT EXISTS (SELECT 1 FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id WHERE i.occurrence_id=o.id
         AND (a.outcome IN ('claimed', 'sending', 'appended', 'queued', 'inline') OR (a.outcome='unknown' AND COALESCE(a.disposition, '')<>'retry')))
       ORDER BY ${upcoming ? "o.eligible_at" : "o.created_rev"}`,
    ).all(trackerId, ATTENTION_KIND, new Date(at).toISOString());
    return rows.filter((row) => {
      const failures = db.prepare<[string], { n: number; last: string }>("SELECT COUNT(*) AS n, MAX(a.started_at) AS last FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id WHERE i.occurrence_id=? AND a.outcome='failed'").get(row.id);
      if (!failures?.n) return true;
      return at - Date.parse(failures.last) >= Math.min(FAILURE_BACKOFF_MS * 2 ** (failures.n - 1), FAILURE_BACKOFF_CAP_MS);
    });
  }

  /** One transaction: the generation and the fence are checked, then the ids are claimed, so overlapping drains cannot share one. */
  function claim(trackerId: string, recipient: { threadId: string; source: AttemptRow["recipient_source"] }): { attempt: string; ids: { id: string; task_key: string; signal: string }[]; batch: string } | null {
    return db.transaction(() => {
      const row = getModeRow(db, trackerId);
      if (row.effective_mode !== "live" || row.requested_mode !== null) return null;
      const ids = claimable(trackerId, Date.now());
      if (!ids.length) return null;
      const attempt = randomUUID();
      const batch = randomUUID();
      db.prepare<[string, string, string, number, string, string, string, string, number]>(
        "INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, outcome, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)",
      ).run(attempt, trackerId, ATTENTION_KIND, row.effective_generation, batch, recipient.threadId, recipient.source, nowIso(), bumpRev(db, trackerId));
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
  async function recover(trackerId: string, throttleLate = false): Promise<void> {
    for (const attempt of attemptsWhere(trackerId, "outcome IN ('claimed', 'sending') ")) {
      if (inflight.has(attempt.attempt_id)) continue;
      if (attempt.outcome === "claimed") {
        // Nothing was sent: the occurrences are claimable again.
        advanceAttempt(attempt, ["claimed"], "outcome='failed', error='Interrupted before sending'");
        continue;
      }
      const found = await findAttentionMarker(bb, attempt.recipient_thread_id, attentionMarker(attempt.batch_id), attempt.started_at);
      if (found) recordReceipt(attempt, found);
      else if (!pendingInline.has(attempt.attempt_id) || Date.now() - pendingInline.get(attempt.attempt_id)! > PENDING_INLINE_MS) recordReceipt(attempt, { outcome: "unknown", error: "No evidence of acceptance after a restart or timeout" });
    }
    await recoverLate(trackerId, throttleLate);
  }

  /**
   * Evidence that arrives late, even after an owner resolution or a rollback, is still the attempt's receipt. Each pass looks at
   * the attempts searched longest ago first, so no unknown attempt starves behind newer ones.
   */
  async function recoverLate(trackerId: string, throttle = false): Promise<void> {
    const due = attemptsWhere(trackerId, "outcome='unknown' ")
      .filter((attempt) => !throttle || Date.now() - (lateSearchedAt.get(attempt.attempt_id) ?? 0) >= LATE_SEARCH_MS)
      .sort((a, b) => (lateSearchedAt.get(a.attempt_id) ?? 0) - (lateSearchedAt.get(b.attempt_id) ?? 0))
      .slice(0, LATE_SEARCH_BATCH);
    for (const attempt of due) {
      lateSearchedAt.set(attempt.attempt_id, Date.now());
      const found = await findAttentionMarker(bb, attempt.recipient_thread_id, attentionMarker(attempt.batch_id), attempt.started_at);
      if (found) recordReceipt(attempt, found);
    }
  }

  /** A pending to_shadow: wait for in-flight sends, settle what is left, then publish the handback if nothing is unresolved. */
  async function reconcileFence(trackerId: string): Promise<boolean> {
    await Promise.allSettled([...inflight.values()]);
    await recover(trackerId);
    const ready = finishToShadow(db, trackerId);
    if (ready) notifyChanged(trackerId);
    return ready;
  }

  async function drainTracker(trackerId: string): Promise<void> {
    const row = getModeRow(db, trackerId);
    if (row.effective_mode !== "live") return;
    if (row.requested_mode !== null) {
      if (row.transition_direction === "to_shadow" && row.transition_state === "preparing") await reconcileFence(trackerId);
      return;
    }
    await recover(trackerId, true);
    if (!claimable(trackerId, Date.now()).length) return;
    const recipient = await resolveRecipient(trackerId);
    if (!recipient) return;
    const claimed = claim(trackerId, recipient);
    if (!claimed) return;
    const run = transport(claimed, recipient.threadId, trackerId).catch(warn).finally(() => inflight.delete(claimed.attempt));
    inflight.set(claimed.attempt, run);
    await run;
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
    // Late receipts for unknown attempts are looked for whatever the mode, so a rollback or a switch off never strands them;
    // this pass is the periodic one, so it is not throttled.
    for (const { tracker_id } of db.prepare<[], { tracker_id: string }>("SELECT DISTINCT tracker_id FROM attention_attempts WHERE outcome='unknown'").all())
      await recoverLate(tracker_id).catch(warn);
    await drain();
  }

  /** The owner's mode request; a to_shadow also settles in-flight sends before it can become ready. */
  async function setMode(input: { trackerId: string; mode: AttentionMode; parityReviewed?: boolean }): Promise<KindState> {
    const before = getModeRow(db, input.trackerId).effective_mode;
    const state = requestMode(db, input);
    bb.log.info(`attention ${ATTENTION_KIND} for ${input.trackerId}: ${before} → ${input.mode}`);
    if (state.transition?.direction === "to_shadow" && state.transition.state === "preparing") await reconcileFence(input.trackerId);
    scheduleDrain();
    return kindState(db, input.trackerId);
  }

  /** The owner's decision on an unknown attempt: accept the loss, or let its occurrences be claimed again. */
  async function resolveAttempt(attemptId: string, disposition: "waived_loss" | "retry"): Promise<void> {
    const attempt = db.prepare<[string], AttemptRow>("SELECT * FROM attention_attempts WHERE attempt_id=?").get(attemptId);
    if (!attempt) throw new Error(`Attempt not found: ${attemptId}`);
    if (attempt.outcome !== "unknown" || attempt.disposition) throw new Error("Only an unresolved unknown attempt can be resolved");
    db.transaction(() => updateAttempt(attemptId, attempt.tracker_id, "disposition=?, disposition_at=?", disposition, nowIso()))();
    log(`attention attempt ${attemptId}: ${disposition}`);
    await reconcileFence(attempt.tracker_id);
    scheduleDrain();
  }
  const log = (message: string) => bb.log.info(message);

  function register() {
    const stops = [onAttentionChanged(notifyChanged), onTrackerDirty(scheduleScan)];
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

  return { register, drain, drainTracker, nextEligibleDelay, recoverLate, reconcileAll, reconcileFence, setMode, resolveAttempt, scheduleDrain, recover, resolveRecipient };
}
