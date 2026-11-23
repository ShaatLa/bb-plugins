import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { publishProjectsChanged, publishSettingsChanged } from "../api";
import { HISTORY_ERROR_PASSES, HISTORY_ERROR_SPAN_MS, LATE_SEARCH_MS, PENDING_INLINE_MS } from "../attention/service";
import { configuredManager, getModeRow } from "../attention/modes";
import { ATTENTION_KIND } from "../attention/observe";
import { getChecksEnvironment } from "../global-settings";
import { errorMessage } from "../shared/errors";
import { deliverWithReceipt, searchAttentionMarker, type HistoryCursor, type Receipt as SteerReceipt } from "../steer";
import { CHECK_FIELDS, CHECKS_PREFIX, completeConfig, effectiveConfig, parseField, readDraft, writeEnabled, writeField, type CheckField, type ChecksConfig } from "./config";
import { checksHistory } from "./history";
import { scanArchivedWorktrees, scanTuning, type ScanProject } from "./archived-worktrees";
import { formatNotification } from "./notification";
import { agentHubEnabled, callNotice, choosePayload, classifyNoticeError, noticeTitle, type NoticeReply } from "./notice";
import { assertNoOtherOwner, isDraining, owners, runs, stateMismatch } from "./ownership";
import { reportContents, staleStatusKind } from "./reports";
import { CheckoutRefreshError, execute, KILL_GRACE_MS, GIT_TIMEOUT_MS } from "./runner";
import { checksStore, type AttemptRow, type NoticeRow, type State } from "./store";
import { createTransfer } from "./transfer";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

const MAX_REFRESH_BACKOFF_MS = 3_600_000;
const LATE_SEARCH_BATCH = 20;
const PUSH_TITLE = "Sweep manager unreachable";
const repositoryUrl = z.string().min(1).max(2000).refine((url) => !url.startsWith("-"));
const MANAGER_UNSET = "Manager is unset. Set the manager field to an available thread ID.";
const NOTICE_WAITING = "Waiting for Agent Hub to confirm the notice";
const NOTICE_UNKNOWN = "Notice outcome unknown: Agent Hub may already have it. Choose Retry to send the report to the manager; it may duplicate.";
export const checksMarker = (reportId: string, attemptId: string) => `<!-- work-board-checks:${reportId}:${attemptId} -->`;

/** Tests shorten these; production uses the defaults of the 0.61 recovery and the 60 s Git limit. */
export const checksTuning = { lateSearchMs: LATE_SEARCH_MS, gitTimeoutMs: GIT_TIMEOUT_MS, killGraceMs: KILL_GRACE_MS };

type Outcome = { status: "none" | "cleared" | "blocked"; error?: string };
const instances = new WeakMap<BbPluginApi, ReturnType<typeof createService>>();
export function checksService(bb: BbPluginApi): ReturnType<typeof createService> {
  const found = instances.get(bb);
  if (found) return found;
  const created = createService(bb);
  instances.set(bb, created);
  return created;
}

function createService(bb: BbPluginApi) {
  const db: Database = bb.storage.database();
  const store = checksStore(db);
  const history = checksHistory(db);
  const controller = new AbortController();
  const lateSearchedAt = new Map<string, number>();
  bb.onDispose(() => { controller.abort(); instances.delete(bb); });

  const tracker = (trackerId: string) => {
    const row = db.prepare<[string], { link: string | null; prefix: string }>("SELECT linked_bb_project_id AS link, prefix FROM projects WHERE id=?").get(trackerId);
    if (!row) throw new Error(`Project not found: ${trackerId}`);
    return row;
  };
  const dataDir = () => {
    const file = db.prepare<[], { name: string; file: string }>("PRAGMA database_list").all().find((row) => row.name === "main")?.file;
    if (!file) throw new Error("Repository checks need a file-backed database");
    return dirname(file);
  };
  /** Explicit commands (UI, CLI, config, transfer) keep the wide channel; only the scheduled tick uses the settings-only one. */
  const changed = (trackerId: string) => publishProjectsChanged(bb, trackerId);
  const tickChanged = (trackerId: string) => publishSettingsChanged(bb, trackerId);

  /** The manager as a recipient, with Sweep's rules: a missing, archived, deleted, failed or unreachable thread cannot receive a report. */
  async function usableManager(manager: string) {
    const thread = await bb.sdk.threads.get({ threadId: manager });
    if (!thread || thread.archivedAt || thread.deletedAt) throw new Error("Manager missing, archived or deleted. Set the manager field to an available thread ID.");
    if (thread.status === "error" || thread.runtime.displayStatus === "error") throw new Error("Manager thread failed. Recover the thread or set the manager field to an available thread ID.");
    if (thread.runtime.displayStatus === "waiting-for-host") throw new Error("Manager host unreachable. Bring the host online or set the manager field to an available thread ID.");
  }

  async function push(link: string, state: State, error: unknown) {
    try {
      await bb.sdk.plugins.callRpc({ pluginId: "push-notifications", method: "notifications.send", input: { title: PUSH_TITLE, body: `${link}: ${String(error)}` }, outputSchema: z.unknown() });
      state.pushError = null;
    } catch (alert) {
      if (controller.signal.aborted) throw alert;
      state.pushError = String(alert);
      bb.log.error(`Repository checks push failed: ${String(alert)}`);
    }
  }

  const committedFor = (trackerId: string, link: string): Buffer | null => {
    const row = store.delivery(trackerId);
    return row?.committed && row.committed_project === link ? row.committed : null;
  };

  const transfer = createTransfer({ bb, db, store, signal: controller.signal, tracker, committedFor, changed });
  /** A tick that finds nothing to do (busy, idle, another owner) returns quietly, as it always has. */
  class Skipped extends Error {}

  // ---- delivery -------------------------------------------------------------------------------------------------

  /**
   * Durable delivery: promote the candidate, clear the pending report and record the delivery, in one transaction. First confirmed
   * receipt wins. The new state is built on a copy and published into the caller's object only after the commit, so a failed
   * promotion leaves both the database and the in-memory state as they were.
   */
  function accept(attempt: AttemptRow, receipt: Extract<SteerReceipt, { outcome: "appended" | "queued" | "inline" }>, state: State, tickId: string): boolean {
    let next: State | undefined;
    const accepted = db.transaction(() => {
      const row = store.delivery(attempt.tracker_id);
      if (!row?.report_id || row.report_id !== attempt.report_id) {
        // The report is delivered already (or reset): a late receipt acknowledges nothing.
        store.advance(attempt.attempt_id, ["sending", "unknown"], "outcome='superseded'");
        return false;
      }
      const at = new Date().toISOString();
      store.advance(attempt.attempt_id, ["sending", "unknown", "superseded"], "outcome=?, queued_message_id=?, inline_event_ref=?, accepted_at=COALESCE(accepted_at, ?)",
        receipt.outcome, receipt.outcome === "inline" ? null : receipt.queuedMessageId, receipt.outcome === "inline" ? receipt.inlineEventRef : null, at);
      store.supersedeOpen(attempt.tracker_id, row.report_id, attempt.attempt_id);
      store.supersedeOpenNotices(attempt.tracker_id, row.report_id);
      const code = row.pending_exit ?? 0;
      const { fingerprint, changes } = reportContents(code, row.pending_body ?? "");
      next = structuredClone(state);
      // The baseline belongs to the manager this attempt was sent to, not to whatever the setting says now.
      if (code >= 2) next.lastFailure = { fingerprint, manager: attempt.manager_thread_id };
      else next.lastReport = { fingerprint, changes, at: Date.now(), manager: attempt.manager_thread_id };
      next.deliveredAt = Date.now(); next.deliveredTickId = row.pending_tick ?? undefined; next.deliveredReportId = row.report_id;
      next.deliveredTo = attempt.manager_thread_id;
      // The paths of the delivered report are reported now, in the same transaction as the promotion.
      if (next.pendingWorktrees) { next.reportedWorktrees = [...new Set([...(next.reportedWorktrees ?? []), ...next.pendingWorktrees])]; next.pendingWorktrees = undefined; }
      next.receipt = { mode: receipt.outcome, id: receipt.outcome === "inline" ? receipt.inlineEventRef : receipt.queuedMessageId };
      // The delivery problem this acceptance resolves goes; an execution failure (script or refresh) stays.
      next.deliveryError = null; next.managerError = null; next.pushError = null; next.fallbackReason = null;
      store.promote(attempt.tracker_id, row.report_id);
      history.delivered(tickId);
      store.save(attempt.tracker_id, next);
      return true;
    })();
    return publish(accepted, next, state);
  }

  /** Publishes a committed state into the caller's object. */
  function publish(accepted: boolean, next: State | undefined, state: State): boolean {
    if (accepted && next) { for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key]; Object.assign(state, next); }
    return accepted;
  }

  /**
   * The notice route's acceptance, guarded by the report id like `accept`: any valid `{ id, created }` reply counts, since a replay can be the
   * call that creates the item. The baseline belongs to the manager at the first call (none when it was unset), and no Work Board push goes out.
   */
  function acceptNotice(notice: NoticeRow, reply: NoticeReply, state: State, tickId: string): boolean {
    let next: State | undefined;
    const accepted = db.transaction(() => {
      const row = store.delivery(notice.tracker_id);
      if (!row?.report_id || row.report_id !== notice.report_id) {
        store.advanceNotice(notice.attempt_id, ["sending", "unknown"], "outcome='superseded'");
        return false;
      }
      if (!store.advanceNotice(notice.attempt_id, ["sending", "unknown"], "outcome='accepted', notice_id=?, accepted_at=?", reply.id, new Date().toISOString())) return false;
      store.supersedeOpen(notice.tracker_id, row.report_id);
      const code = row.pending_exit ?? 0;
      const { fingerprint, changes } = reportContents(code, row.pending_body ?? "");
      const manager = notice.manager_thread_id ? { manager: notice.manager_thread_id } : {};
      next = structuredClone(state);
      if (code >= 2) next.lastFailure = { fingerprint, ...manager };
      else next.lastReport = { fingerprint, changes, at: Date.now(), ...manager };
      next.deliveredAt = Date.now(); next.deliveredTickId = row.pending_tick ?? undefined; next.deliveredReportId = row.report_id;
      next.deliveredTo = "agent-hub";
      if (next.pendingWorktrees) { next.reportedWorktrees = [...new Set([...(next.reportedWorktrees ?? []), ...next.pendingWorktrees])]; next.pendingWorktrees = undefined; }
      next.receipt = { mode: "notice", id: reply.id };
      next.deliveryError = null; next.pushError = null;
      store.promote(notice.tracker_id, row.report_id);
      history.delivered(tickId);
      history.noticed(tickId);
      store.save(notice.tracker_id, next);
      return true;
    })();
    return publish(accepted, next, state);
  }

  /** One bounded pass of the history search for an attempt's marker; a pass that cannot read is counted, and enough of them give up. */
  async function search(attempt: AttemptRow) {
    const read = attempt.recovery_cursor;
    const cursor = read ? (JSON.parse(read) as HistoryCursor) : {};
    const result = await searchAttentionMarker(bb, attempt.manager_thread_id, attempt.marker, attempt.started_at, cursor);
    let saved = result.cursor, unreadable = false;
    if (result.error !== undefined) {
      const errors = cursor.errors ?? { count: 0, since: new Date().toISOString(), last: "" };
      saved = { ...result.cursor, errors: { count: errors.count + 1, since: errors.since, last: result.error } };
      unreadable = saved.errors!.count >= HISTORY_ERROR_PASSES && Date.now() - Date.parse(saved.errors!.since) >= HISTORY_ERROR_SPAN_MS;
    }
    const written = db.prepare<[string, string, string | null]>("UPDATE checks_attempts SET recovery_cursor=? WHERE attempt_id=? AND recovery_cursor IS ?").run(JSON.stringify(saved), attempt.attempt_id, read).changes > 0;
    return { ...result, unreadable: written && unreadable, complete: written && result.complete, error: saved.errors?.last };
  }

  async function markUnknown(attempt: AttemptRow, reason: string, state: State, link: string) {
    // The outcome and its count commit together: a failure between them leaves neither.
    const marked = db.transaction(() => {
      if (!store.advance(attempt.attempt_id, ["sending"], "outcome='unknown', error=?", reason)) return false;
      history.deliveryUnknown(attempt.tick_id);
      return true;
    })();
    if (!marked) return;
    state.deliveryError = `Delivery outcome unknown (${reason}). Choose Retry in the repository checks settings to send the report again; it may duplicate.`;
    await push(link, state, new Error(state.deliveryError));
  }

  const isConfirmed = (receipt: SteerReceipt): receipt is Extract<SteerReceipt, { outcome: "appended" | "queued" | "inline" }> =>
    receipt.outcome === "appended" || receipt.outcome === "queued" || receipt.outcome === "inline";

  /** Settles what a stored attempt can still tell: open attempts every pass, unknown and superseded ones as late evidence. */
  async function settle(trackerId: string, link: string, reportId: string, state: State, tickId: string) {
    const stillPending = () => store.delivery(trackerId)?.report_id === reportId;
    for (const listed of store.attempts(trackerId, reportId, ["sending"])) {
      if (!stillPending()) return;
      const attempt = store.attempt(listed.attempt_id);
      if (!attempt || attempt.outcome !== "sending") continue;
      const { receipt, complete, unreadable, error } = await search(attempt);
      if (receipt && isConfirmed(receipt)) accept(attempt, receipt, state, tickId);
      else if (unreadable) await markUnknown(attempt, `History unreadable: ${error}`, state, link);
      // No evidence is a conclusion only once the whole history back to the attempt's start has been read, and an inline send gets its grace.
      else if (complete && (!attempt.pending_since || Date.now() - Date.parse(attempt.pending_since) > PENDING_INLINE_MS)) await markUnknown(attempt, "No evidence of acceptance after a restart or timeout", state, link);
    }
    const late = store.attempts(trackerId, reportId, ["unknown", "superseded"])
      .filter((attempt) => Date.now() - (lateSearchedAt.get(attempt.attempt_id) ?? 0) >= checksTuning.lateSearchMs)
      .sort((a, b) => (lateSearchedAt.get(a.attempt_id) ?? 0) - (lateSearchedAt.get(b.attempt_id) ?? 0))
      .slice(0, LATE_SEARCH_BATCH);
    for (const listed of late) {
      if (!stillPending()) return;
      lateSearchedAt.set(listed.attempt_id, Date.now());
      const attempt = store.attempt(listed.attempt_id);
      if (!attempt || !["unknown", "superseded"].includes(attempt.outcome)) continue;
      const { receipt } = await search(attempt);
      if (receipt && isConfirmed(receipt)) accept(attempt, receipt, state, tickId);
    }
  }

  /** The report stays pending on this pass: counted on its staged tick and pushed, with the notice route's problem (if any) in the alert. */
  async function deliveryFailed(link: string, state: State, pendingTick: string, error: unknown, note?: string): Promise<Outcome> {
    state.managerError = String(error);
    history.deliveryFailed(pendingTick);
    await push(link, state, note ? `${String(error)} (${note})` : error);
    return { status: "blocked", error: String(error) };
  }

  // ---- notice route ---------------------------------------------------------------------------------------------

  /** One call of the receiver for a stored row. Only the first call can prove a refusal; a replay that fails proves nothing. */
  async function tryNotice(notice: NoticeRow, markdown: string, state: State, tickId: string, first: boolean):
    Promise<{ kind: "reply"; accepted: boolean } | { kind: "refused" | "unavailable" | "possible"; error: string }> {
    let reply: NoticeReply;
    try {
      reply = await callNotice(bb, controller.signal, { tickId: notice.tick_id, projectId: notice.bb_project_id, threadId: notice.manager_thread_id, title: noticeTitle(tracker(notice.tracker_id).prefix), markdown });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const kind = first ? classifyNoticeError(error) : "possible";
      if (kind !== "possible") store.advanceNotice(notice.attempt_id, ["sending"], "outcome=?, error=?", kind, errorMessage(error));
      return { kind, error: errorMessage(error) };
    }
    return { kind: "reply", accepted: acceptNotice(notice, reply, state, tickId) };
  }

  /** A replay that proved nothing is a pass; enough of them over enough time end the row as unknown, with one count and one push. */
  async function recordPass(notice: NoticeRow, error: string, state: State, link: string) {
    const firstErrorAt = notice.first_error_at ?? new Date().toISOString();
    const passes = notice.passes + 1;
    const exhausted = passes >= HISTORY_ERROR_PASSES && Date.now() - Date.parse(firstErrorAt) >= HISTORY_ERROR_SPAN_MS;
    // The terminal diagnostic is saved with the outcome and its count, on a copy published after the commit: a stop in between never leaves Retry with the old message.
    let next: State | undefined;
    const marked = db.transaction(() => {
      if (!store.advanceNotice(notice.attempt_id, ["sending"], "outcome=?, error=?, passes=?, first_error_at=?", exhausted ? "unknown" : "sending", error, passes, firstErrorAt)) return false;
      if (!exhausted) return false;
      history.deliveryUnknown(notice.tick_id);
      next = structuredClone(state); next.deliveryError = NOTICE_UNKNOWN;
      store.save(notice.tracker_id, next);
      return true;
    })();
    if (!marked) return;
    publish(true, next, state);
    // The late-evidence interval starts at the transition: the row is not replayed again in this pass.
    lateSearchedAt.set(notice.attempt_id, Date.now());
    await push(link, state, new Error(NOTICE_UNKNOWN));
  }

  /** Replays a stored row with its original key; the receiver keeps the first body, so only the staged bytes are needed again. */
  async function replayNotice(notice: NoticeRow, state: State, tickId: string) {
    const row = store.delivery(notice.tracker_id)!;
    const payload = choosePayload(formatNotification(row.pending_exit ?? 0, row.pending_body ?? ""), row.pending_body ?? "");
    return "tooLarge" in payload ? { kind: "possible" as const, error: payload.tooLarge } : tryNotice(notice, payload.markdown, state, tickId, false);
  }

  /** Open notice rows of the report: `sending` ones every pass, `unknown` ones as late evidence. */
  async function settleNotices(trackerId: string, link: string, reportId: string, state: State, tickId: string) {
    const stillPending = () => store.delivery(trackerId)?.report_id === reportId;
    // Read before the replays below, so a row that becomes unknown in this pass is not replayed again in it.
    const late = store.notices(trackerId, reportId, ["unknown"]);
    for (const listed of store.notices(trackerId, reportId, ["sending"])) {
      if (!stillPending()) return;
      const notice = store.notice(listed.attempt_id);
      if (!notice || notice.outcome !== "sending") continue;
      const result = await replayNotice(notice, state, tickId);
      if (result.kind === "possible") await recordPass(notice, result.error, state, link);
    }
    for (const listed of late) {
      if (!stillPending()) return;
      if (Date.now() - (lateSearchedAt.get(listed.attempt_id) ?? 0) < checksTuning.lateSearchMs) continue;
      lateSearchedAt.set(listed.attempt_id, Date.now());
      await replayNotice(listed, state, tickId);
    }
  }

  /**
   * The fresh manager attempt failed for certain: the same staged report goes to Agent Hub as a notice, written before the call. Without
   * Agent Hub, after a refusal, or when the report is too large, it stays pending and is pushed.
   */
  async function fallback(trackerId: string, link: string, state: State, tickId: string, error: unknown, manager: string | null): Promise<Outcome> {
    const row = store.delivery(trackerId)!;
    const stagedTick = row.pending_tick ?? tickId;
    // A refusal suppresses the payload (a same-key replay is refused the same way); `unavailable` rows do not, so an upgraded receiver is tried again.
    if (store.notices(trackerId, row.report_id!).some((notice) => ["sending", "unknown", "accepted", "refused"].includes(notice.outcome))) return deliveryFailed(link, state, stagedTick, error);
    if (!(await agentHubEnabled(bb, controller.signal))) return deliveryFailed(link, state, stagedTick, error);
    const payload = choosePayload(formatNotification(row.pending_exit ?? 0, row.pending_body ?? ""), row.pending_body ?? "");
    const attemptId = randomUUID();
    const base = { attempt_id: attemptId, tracker_id: trackerId, report_id: row.report_id!, tick_id: stagedTick, bb_project_id: link, manager_thread_id: manager };
    // The opening state is built on a copy, saved with the row and published after the commit: a failed insert leaves no fallback reason behind.
    const opening = structuredClone(state);
    opening.managerError = String(error); opening.fallbackReason = String(error);
    if ("tooLarge" in payload) {
      db.transaction(() => { store.openNotice(base, "refused", payload.tooLarge); store.save(trackerId, opening); })();
      publish(true, opening, state);
      return deliveryFailed(link, state, stagedTick, error, `notice not sent: ${payload.tooLarge}`);
    }
    db.transaction(() => { store.openNotice(base); store.save(trackerId, opening); })();
    publish(true, opening, state);
    const notice = store.notice(attemptId)!;
    const result = await tryNotice(notice, payload.markdown, state, tickId, true);
    if (result.kind === "reply") return result.accepted ? { status: "cleared" } : { status: "blocked" };
    if (result.kind === "possible") {
      // The first call is not a replay: nothing is counted yet, the next tick's replay starts the bounds.
      store.advanceNotice(notice.attempt_id, ["sending"], "error=?", result.error);
      return { status: "blocked", error: `${NOTICE_WAITING} (${result.error})` };
    }
    return deliveryFailed(link, state, stagedTick, error, `Agent Hub ${result.kind === "refused" ? "refused the notice" : "cannot take notices"}: ${result.error}`);
  }

  /** A fresh attempt to the current manager: persisted before any transport call, then judged by its receipt. */
  async function dispatch(trackerId: string, link: string, state: State, tickId: string): Promise<Outcome> {
    const row = store.delivery(trackerId)!;
    const manager = configuredManager(db, trackerId);
    try {
      if (!manager) throw new Error(MANAGER_UNSET);
      await usableManager(manager);
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return fallback(trackerId, link, state, tickId, error, manager);
    }
    const attemptId = randomUUID();
    store.openAttempt({ attempt_id: attemptId, tracker_id: trackerId, report_id: row.report_id!, tick_id: row.pending_tick ?? tickId, bb_project_id: link, manager_thread_id: manager, marker: checksMarker(row.report_id!, attemptId) });
    const attempt = store.attempt(attemptId)!;
    let receipt: SteerReceipt;
    try {
      receipt = await deliverWithReceipt(bb, manager, formatNotification(row.pending_exit ?? 0, row.pending_body ?? ""), attempt.marker);
    } catch (error) {
      // An exception after a possible write is never a failure: the marker search decides.
      receipt = { outcome: "unknown", error: errorMessage(error) };
    }
    if (isConfirmed(receipt)) return accept(attempt, receipt, state, tickId) ? { status: "cleared" } : { status: "blocked" };
    if (receipt.outcome === "failed") {
      store.advance(attemptId, ["sending"], "outcome='failed', error=?", receipt.error);
      return fallback(trackerId, link, state, tickId, new Error(receipt.error), manager);
    }
    if (receipt.outcome === "pending") {
      store.advance(attemptId, ["sending"], "pending_since=?", new Date().toISOString());
      return { status: "blocked", error: "Waiting for evidence that the manager received the report" };
    }
    store.advance(attemptId, ["sending"], "error=?", receipt.error);
    return { status: "blocked", error: `Waiting for evidence that the manager received the report (${receipt.error})` };
  }

  /** The staged report comes first, on every tick: recover an open attempt on its stored thread, or dispatch afresh to the current manager. */
  async function processPending(trackerId: string, link: string, state: State, tickId: string): Promise<Outcome> {
    const row = store.delivery(trackerId);
    if (!row?.report_id) return { status: "none" };
    await settle(trackerId, link, row.report_id, state, tickId);
    if (store.delivery(trackerId)?.report_id !== row.report_id) return { status: "cleared" };
    await settleNotices(trackerId, link, row.report_id, state, tickId);
    if (store.delivery(trackerId)?.report_id !== row.report_id) return { status: "cleared" };
    const open = store.attempts(trackerId, row.report_id, ["sending", "unknown"]);
    if (open.some((attempt) => attempt.outcome === "unknown")) return { status: "blocked", error: state.deliveryError ?? "Delivery outcome unknown. Choose Retry in the repository checks settings." };
    // A notice that may exist fences the manager route: no automatic dispatch while its outcome is uncertain.
    const notices = store.notices(trackerId, row.report_id, ["sending", "unknown"]);
    if (notices.some((notice) => notice.outcome === "unknown")) return { status: "blocked", error: state.deliveryError ?? NOTICE_UNKNOWN };
    if (notices.length) return { status: "blocked", error: NOTICE_WAITING };
    // An open attempt keeps the report: no second attempt starts while its receipt may still arrive.
    if (open.length) return { status: "blocked", error: "Waiting for evidence that the manager received the report" };
    return dispatch(trackerId, link, state, tickId);
  }

  // ---- running --------------------------------------------------------------------------------------------------

  /** The generation of the latest return to shadow whose current stale-status lines the runner has not sent since, or null. */
  const unconsumedRollback = (trackerId: string): number | null => db.prepare<[string, string, string], { generation: number | null }>(
    `SELECT MAX(generation) AS generation FROM attention_acks WHERE tracker_id=? AND kind=? AND direction='to_shadow'
     AND generation > COALESCE((SELECT consumed_generation FROM checks_stale_rollback WHERE tracker_id=?), 0)`,
  ).get(trackerId, ATTENTION_KIND, trackerId)?.generation ?? null;
  // Conditional, so two overlapping ticks cannot both consume one return.
  const consumeRollback = (trackerId: string, generation: number) => db.prepare<[string, number]>(
    "INSERT INTO checks_stale_rollback (tracker_id, consumed_generation) VALUES (?, ?) ON CONFLICT(tracker_id) DO UPDATE SET consumed_generation=excluded.consumed_generation WHERE consumed_generation < excluded.consumed_generation",
  ).run(trackerId, generation);

  /** Runs the script; also returns the bb project it read (null when the lookup failed), which the worktree scan reuses. */
  async function runScript(trackerId: string, link: string, config: ChecksConfig, manager: string, committed: Buffer | null) {
    let project: ScanProject | null = null;
    try {
      project = (await bb.sdk.projects.get({ projectId: link }).catch((cause) => { throw new CheckoutRefreshError("Could not read the bb project repository settings", { cause }); })) ?? null;
      const remote = repositoryUrl.safeParse(project?.gitRemoteUrl);
      if (!remote.success) throw new CheckoutRefreshError("Set a valid Git remote URL in the bb project settings");
      const { bbCli, runtimePath } = await getChecksEnvironment(bb);
      const result = await execute(dataDir(), trackerId, {
        remote: remote.data, branch: config.branch, script: config.script, args: config.args, timeoutSeconds: config.timeoutSeconds, snapshots: config.snapshots,
        bbProjectId: link, manager, committed, bbCli, runtimePath, gitTimeoutMs: checksTuning.gitTimeoutMs, killGraceMs: checksTuning.killGraceMs,
      }, controller.signal);
      return { result, refreshFailed: false, project };
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return { result: { code: 2, output: `ERROR ${String(error)}`, snapshot: null as Buffer | null }, refreshFailed: error instanceof CheckoutRefreshError, project };
    }
  }

  /** One scheduled pass: the staged report first, then (when enabled, with a manager and a valid configuration) a new run. */
  async function scheduledTick(trackerId: string): Promise<void> {
    const { link } = tracker(trackerId);
    if (!link || runs.has(link)) return;
    // A due callback re-checks `enabled` when it starts, so disabling while it waited prevents the run.
    if (!readDraft(db, trackerId).enabled && !isDraining(db, trackerId, link)) return;
    if (owners(db, link).some((id) => id !== trackerId)) return;
    try {
      // The run is reserved in the same synchronous step that admits it, after any lookup of Sweep.
      await transfer.claimForWorkBoard(trackerId, (current) => {
        if (!current || runs.has(current) || (!readDraft(db, trackerId).enabled && !isDraining(db, trackerId, current)) || owners(db, current).some((id) => id !== trackerId)) throw new Skipped();
        // State recorded for another bb project is refused before the project is claimed.
        const mismatch = stateMismatch(db, trackerId, current);
        if (mismatch) throw new Error(`State belongs to ${mismatch}; reset it`);
      }, (current) => { runs.set(current, trackerId); });
    } catch (error) {
      if (error instanceof Skipped || controller.signal.aborted) return;
      // Not admitted: nothing ran. The refusal is shown as the tracker's error and the next try is a minute away; no push.
      const refused = store.state(trackerId);
      refused.error = errorMessage(error); refused.nextRun = Date.now() + 60_000;
      store.save(trackerId, refused);
      tickChanged(trackerId);
      return;
    }
    const state = store.state(trackerId);
    try {
      const now = Date.now();
      const interval = effectiveConfig(readDraft(db, trackerId)).intervalMinutes * 60_000;
      state.nextRun = now + interval;
      state.bbProjectId ??= link;
      const tickId = `${trackerId}:${Math.max(now, (Number(state.tickId?.split(":")[1]) || 0) + 1)}`;
      state.tickId = tickId; state.lastRun = now;
      db.transaction(() => { history.start(trackerId, link, tickId, now); store.save(trackerId, state); })();

      const pending = await processPending(trackerId, link, state, tickId);
      controller.signal.throwIfAborted();
      if (pending.status === "blocked") {
        state.deliveryError = pending.error ?? state.deliveryError ?? null;
        store.save(trackerId, state);
        return;
      }
      const draft = readDraft(db, trackerId);
      if (!draft.enabled) { store.save(trackerId, state); return; }
      // A pending delivery was retried above, at the normal cadence; only a new run waits for the refresh backoff.
      if (state.refreshRetryAt && state.refreshRetryAt > Date.now()) { state.nextRun = state.refreshRetryAt; store.save(trackerId, state); return; }
      const manager = configuredManager(db, trackerId);
      if (!manager) { state.error = MANAGER_UNSET; store.save(trackerId, state); return; }
      const full = completeConfig(draft);
      if (!full.ok) { state.error = full.error; store.save(trackerId, state); return; }
      const config = full.config;

      const committed = committedFor(trackerId, link);
      const { result, refreshFailed, project } = await runScript(trackerId, link, config, manager, committed);
      controller.signal.throwIfAborted();
      // Archived worktrees are scanned after the script, also after a failed one; the project is the one the script run read.
      let scanFailed = false;
      const worktrees = project ? await scanArchivedWorktrees(bb, project, state.reportedWorktrees ?? [], state.lastMeasuredWorktree, state.worktreeRootFailures ?? [], AbortSignal.any([controller.signal, AbortSignal.timeout(scanTuning.deadlineMs)])).catch((error) => {
        controller.signal.throwIfAborted();
        bb.log.warn(`Archived worktree scan failed for ${trackerId}: ${String(error)}`);
        scanFailed = true;
        return null;
      }) : null;
      if (worktrees) { state.lastMeasuredWorktree = worktrees.lastMeasuredPath; state.worktreeRootFailures = worktrees.failures.length ? worktrees.failures : undefined; for (const { level, message } of worktrees.notes) bb.log[level](message); }
      // Only a complete observation of absence clears history.
      if (worktrees?.complete && state.reportedWorktrees) { const present = new Set(worktrees.present); state.reportedWorktrees = state.reportedWorktrees.filter((path) => present.has(path)); }
      const newWorktrees = worktrees?.newPaths.length ? worktrees.newPaths : undefined;
      const raw = worktrees?.lines.length ? [result.output.trimEnd(), ...worktrees.lines].filter(Boolean).join("\n") : result.output;
      let code = newWorktrees && result.code === 0 ? 1 : result.code;
      // Read only now, so a run that crossed a mode switch is judged by the mode in force when its output is. While live, Work Board's
      // attention sends stale-status notices, so the script's own lines are dropped.
      const live = getModeRow(db, trackerId).effective_mode === "live";
      let report = reportContents(code, raw, live ? { drop: staleStatusKind } : {});
      // A dropped finding is no diagnostic: exit 1 with nothing else left is a quiet run.
      if (code === 1 && report.dropped && !report.items.size && !report.diagnostics) { code = 0; report = reportContents(0, report.body); }
      const output = report.body;
      // After a return from live, the current stale-status lines are sent as new: live kept them from the manager, while the baseline may still hold them.
      const rollback = live ? null : unconsumedRollback(trackerId);
      // Only a successful judgement resends and consumes the return; a failed run, or a scan that failed, timed out, is still outstanding
      // or was incomplete, leaves both to the next tick, so a lasting failure wakes the manager once, on recovery. A scan that cannot
      // run here (no host or storage) returns null and does not block it.
      const consume = rollback !== null && code < 2 && !scanFailed && worktrees?.complete !== false;
      const resendStale = consume && [...report.items.values()].includes(staleStatusKind);
      state.exitCode = code;
      state.refreshFailures = refreshFailed ? (state.refreshFailures ?? 0) + 1 : 0;
      state.refreshRetryAt = refreshFailed ? Date.now() + Math.min(interval * 2 ** Math.min(state.refreshFailures - 1, 6), Math.max(interval, MAX_REFRESH_BACKOFF_MS)) : undefined;
      state.failureStage = refreshFailed ? "refresh" : code >= 2 ? "script" : null;
      // The execution diagnostic is part of the state the staging transaction saves, so a restart shows the right one.
      state.error = code >= 2 ? result.output : null;
      history.result(trackerId, link, tickId, now, report.items, refreshFailed ? "refresh" : code >= 2 ? "script" : undefined);

      const candidateChanged = result.snapshot !== null && (!committed || !result.snapshot.equals(committed));
      const answerWithoutCandidate = config.snapshots && result.snapshot === null && [...report.items.values()].includes("ANSWER");
      const lastReport = state.lastReport?.manager === manager ? state.lastReport : undefined;
      const previous = lastReport?.changes;
      // An unknown baseline (a report that crossed a transfer without its item hashes) with the same fingerprint has the same items, so they are not compared.
      const sameUnknown = !!lastReport && !previous && lastReport.fingerprint === report.fingerprint;
      const waitingChanged = code < 2 && !sameUnknown && report.changes.waiting !== (previous?.waiting ?? "");
      const knownItems = new Set(previous?.noteworthy);
      const newItem = !sameUnknown && report.changes.noteworthy.some((id) => !knownItems.has(id));
      const changedFailure = state.lastFailure?.manager !== manager || state.lastFailure?.fingerprint !== report.fingerprint;
      const changedDiagnostic = code === 1 && !report.items.size && lastReport?.fingerprint !== report.fingerprint;
      // An unknown baseline (a report that crossed a transfer without its item hashes): a different fingerprint is news, and an empty Waiting list is never suppressed.
      const fingerprintChanged = !!lastReport && !previous && code < 2 && lastReport.fingerprint !== report.fingerprint;
      const notify = !!newWorktrees || (code >= 2 ? changedFailure : waitingChanged || newItem || candidateChanged || answerWithoutCandidate || changedDiagnostic || fingerprintChanged || resendStale);
      // Any run below 2 ends a failure streak, even when it sends nothing: the same failure after a quiet success notifies again.
      if (code < 2) state.lastFailure = undefined;
      let delivery: Outcome = { status: "none" };
      if (notify) {
        // A report already being sent from an unknown baseline always says when the Waiting list is empty.
        const body = (waitingChanged || fingerprintChanged || (!!lastReport && !previous && code < 2)) && !report.changes.waiting ? `${output.trimEnd()}\nSTATE Waiting list is clear.\n` : output;
        // The pending paths are saved with the report and published into the live state only after the commit.
        const staged: State = { ...state, pendingWorktrees: newWorktrees };
        db.transaction(() => {
          store.stage(trackerId, { reportId: randomUUID(), project: link, exit: code, tick: tickId, body, snapshot: result.snapshot });
          store.save(trackerId, staged);
          if (consume) consumeRollback(trackerId, rollback!);
        })();
        state.pendingWorktrees = newWorktrees;
        delivery = await processPending(trackerId, link, state, tickId);
        controller.signal.throwIfAborted();
      } else {
        if (code !== 0 || report.changes.waiting || result.snapshot !== null) history.suppress(tickId);
        // Nothing staged: no stale-status line is current, so there is nothing to resend.
        if (consume) consumeRollback(trackerId, rollback!);
      }
      // A report still pending is retried at the normal cadence, whatever the refresh deadline says.
      if (state.refreshRetryAt && !store.delivery(trackerId)?.report_id) state.nextRun = state.refreshRetryAt;
      if (delivery.status === "blocked") state.deliveryError = delivery.error ?? state.deliveryError ?? null;
      store.save(trackerId, state);
    } catch (error) {
      if (!controller.signal.aborted) {
        // An error with a report pending is that report's delivery error, cleared by its acceptance; otherwise it is the run's.
        if (store.delivery(trackerId)?.report_id) state.deliveryError = String(error); else state.error = String(error);
        store.save(trackerId, state);
        // A notice that may exist is Agent Hub's own alert; a second push from here would duplicate it.
        const reportId = store.delivery(trackerId)?.report_id;
        if (!reportId || !store.notices(trackerId, reportId, ["sending", "unknown"]).length) await push(link, state, error);
        store.save(trackerId, state);
      }
      throw error;
    } finally {
      runs.delete(link);
      tickChanged(trackerId);
    }
  }

  /** A manual run refreshes the checkout and runs the script, and nothing else: it never stages, delivers, promotes or counts. */
  async function manualRun(trackerId: string) {
    let plan!: { link: string; config: ChecksConfig; manager: string };
    await transfer.claimForWorkBoard(trackerId, (link) => {
      if (!link) throw new Error("Link a bb project to this tracker before running its checks.");
      assertNoOtherOwner(db, trackerId, link);
      const mismatch = stateMismatch(db, trackerId, link);
      if (mismatch) throw new Error(`State belongs to ${mismatch}; reset it before running.`);
      const full = completeConfig(readDraft(db, trackerId));
      if (!full.ok) throw new Error(full.error);
      const manager = configuredManager(db, trackerId);
      if (!manager) throw new Error(MANAGER_UNSET);
      if (runs.has(link)) throw new Error("Repository checks are already running for this project. Wait for the active check to finish and retry.");
      plan = { link, config: full.config, manager };
    }, (link) => { runs.set(link, trackerId); });
    const { link, config, manager } = plan;
    try {
      const { result } = await runScript(trackerId, link, config, manager, committedFor(trackerId, link));
      return { exitCode: result.code, output: result.output, manual: true as const };
    } finally { runs.delete(link); }
  }

  // ---- owner and settings operations ----------------------------------------------------------------------------

  const running = (trackerId: string) => [...runs.values()].includes(trackerId);
  /** A settings edit makes the next pass due; a branch change forgets the refresh backoff. Skipped while a tick holds the state. */
  function touchState(trackerId: string, branchChanged = false) {
    if (running(trackerId)) return;
    const state = store.state(trackerId);
    if (branchChanged) { state.refreshFailures = 0; state.refreshRetryAt = undefined; }
    store.save(trackerId, { ...state, nextRun: Date.now() });
  }

  /** Counts the disables of each tracker: an enable that waited for Sweep's status is void once a disable has happened since it began. */
  const disables = new Map<string, number>();
  async function setEnabled(trackerId: string, enabled: boolean) {
    const { prefix } = tracker(trackerId);
    const began = disables.get(trackerId) ?? 0;
    const apply = () => {
      const before = readDraft(db, trackerId);
      writeEnabled(db, trackerId, enabled);
      // The platform cannot tell the app from another caller, so a change is only made visible: a log entry.
      bb.log.info(`repository checks for ${prefix}: ${before.enabled ? "enabled" : "disabled"} → ${enabled ? "enabled" : "disabled"}`);
      if (enabled) touchState(trackerId);
      changed(trackerId);
    };
    // Disabling is always allowed, even for a fenced tracker; enabling is an admission and needs the runner ownership.
    if (!enabled) { disables.set(trackerId, began + 1); apply(); }
    else await transfer.claimForWorkBoard(trackerId, (link) => {
      if ((disables.get(trackerId) ?? 0) !== began) throw new Error("Repository checks were disabled while this enable waited for Sweep. Enable them again.");
      if (!link) throw new Error("Link a bb project to this tracker before enabling repository checks.");
      assertNoOtherOwner(db, trackerId, link);
      const mismatch = stateMismatch(db, trackerId, link);
      if (mismatch) throw new Error(`State belongs to ${mismatch}; reset it before enabling.`);
      const full = completeConfig(readDraft(db, trackerId));
      if (!full.ok) throw new Error(full.error);
    }, apply);
    return { enabled };
  }

  function setField(trackerId: string, field: CheckField, value: unknown) {
    tracker(trackerId);
    const parsed = parseField(field, value);
    const before = readDraft(db, trackerId)[field];
    writeField(db, trackerId, field, parsed);
    touchState(trackerId, field === "branch" && before !== parsed);
    changed(trackerId);
    return parsed;
  }

  /** The owner's Retry: closes the unknown attempt and makes the next pass send the exact pending bytes to the current manager. */
  function retry(trackerId: string) {
    const { link } = tracker(trackerId);
    if (running(trackerId)) throw new Error("A check is running for this project; retry in a moment.");
    const row = store.delivery(trackerId);
    if (!row?.report_id || !link || row.pending_project !== link) throw new Error("No report is pending for this project.");
    if (!store.attempts(trackerId, row.report_id, ["unknown"]).length && !store.notices(trackerId, row.report_id, ["unknown"]).length) throw new Error("Retry applies only to a report whose delivery outcome is unknown.");
    db.transaction(() => {
      store.supersedeOpen(trackerId, row.report_id!);
      store.supersedeOpenNotices(trackerId, row.report_id!);
      const state = store.state(trackerId);
      state.deliveryError = null; state.nextRun = Date.now();
      store.save(trackerId, state);
    })();
    bb.log.info(`repository checks for ${trackerId}: retry of report ${row.report_id}`);
    changed(trackerId);
    return { ok: true as const };
  }

  /** The owner's reset of stored state (status, committed snapshot, staged report, attempts); refused while the runner owns it. */
  function reset(trackerId: string) {
    const { link } = tracker(trackerId);
    const fence = transfer.fenceMessage(trackerId, link);
    if (fence) throw new Error(fence);
    if (readDraft(db, trackerId).enabled || isDraining(db, trackerId, link)) throw new Error("Disable repository checks and let the pending report drain before resetting their state.");
    store.reset(trackerId);
    bb.log.info(`repository checks for ${trackerId}: state reset`);
    changed(trackerId);
    return { ok: true as const };
  }

  function configValues(trackerId: string): Record<string, unknown> {
    tracker(trackerId);
    const config = effectiveConfig(readDraft(db, trackerId));
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [`${CHECKS_PREFIX}${key}`, value]));
  }

  /** Scheduled-run statistics of the tracker's current bb project; history of a previous link is never mixed in. */
  function stats(trackerId: string, days: number) {
    return history.stats(trackerId, tracker(trackerId).link ?? "", days);
  }

  function status(trackerId: string) {
    const { link, prefix } = tracker(trackerId);
    const draft = readDraft(db, trackerId);
    const state = store.state(trackerId);
    const delivery = store.delivery(trackerId);
    const draining = isDraining(db, trackerId, link);
    const pending = delivery?.report_id ? {
      reportId: delivery.report_id, tickId: delivery.pending_tick, exitCode: delivery.pending_exit, stagedAt: delivery.pending_at, projectId: delivery.pending_project,
      raw: delivery.pending_body, hasCandidate: delivery.pending_snapshot !== null,
      attempts: store.attempts(trackerId, delivery.report_id).map((a) => ({ attemptId: a.attempt_id, manager: a.manager_thread_id, outcome: a.outcome, startedAt: a.started_at, error: a.error })),
      notices: store.notices(trackerId, delivery.report_id).map((n) => ({ attemptId: n.attempt_id, manager: n.manager_thread_id, outcome: n.outcome, startedAt: n.started_at, error: n.error, passes: n.passes })),
    } : null;
    const unknownOutcome = !!pending && (pending.attempts.some((a) => a.outcome === "unknown") || pending.notices.some((n) => n.outcome === "unknown"));
    const mismatch = link ? stateMismatch(db, trackerId, link) : null;
    const other = link ? owners(db, link).find((id) => id !== trackerId) : undefined;
    return {
      trackerId, prefix, bbProjectId: link, ...transfer.ownerStatus(link), config: effectiveConfig(draft), enabledChangedAt: draft.enabledChangedAt, enabledPrevious: draft.enabledPrevious,
      manager: configuredManager(db, trackerId), draining, ownedByOtherTracker: other ?? null,
      lastRun: state.lastRun ?? null, nextRun: draft.enabled || draining ? state.nextRun ?? Date.now() : null, tickId: state.tickId ?? null,
      exitCode: state.exitCode ?? null, error: state.error ?? null,
      // A report that cannot be delivered is the current problem, whatever the last run did; an unknown outcome blocks until Retry.
      failureStage: pending && state.deliveryError ? ("delivery" as const) : state.failureStage ?? null,
      deliveryError: pending ? state.deliveryError ?? null : null,
      blocked: unknownOutcome ? "blocked: delivery unknown, Retry needed" : null,
      refreshFailures: state.refreshFailures ?? 0, refreshRetryAt: state.refreshRetryAt ?? null,
      reportedWorktrees: state.reportedWorktrees?.length ?? 0, pendingWorktrees: state.pendingWorktrees?.length ?? 0, worktreeRootFailures: state.worktreeRootFailures?.length ?? 0,
      managerError: state.managerError ?? null, fallbackReason: state.fallbackReason ?? null, pushError: state.pushError ?? null,
      lastDelivery: state.deliveredAt ? { at: state.deliveredAt, to: state.deliveredTo ?? null, receipt: state.receipt ?? null, reportId: state.deliveredReportId ?? null, tickId: state.deliveredTickId ?? null } : null,
      pending, awaitingRetry: unknownOutcome,
      stateMismatch: mismatch ? `State belongs to ${mismatch}; reset it` : null,
      stats: stats(trackerId, 1),
    };
  }

  // ---- scheduling -----------------------------------------------------------------------------------------------

  const dueTrackers = () => db.prepare<[], { id: string }>("SELECT tracker_id AS id FROM checks_config WHERE enabled = 1 UNION SELECT tracker_id FROM checks_delivery WHERE report_id IS NOT NULL").all().map((row) => row.id);
  async function runDue() {
    for (const id of dueTrackers()) {
      let link: string | null;
      try { link = tracker(id).link; } catch { continue; }
      if (!link || runs.has(link) || (store.state(id).nextRun ?? 0) > Date.now()) continue;
      await scheduledTick(id).catch((error) => bb.log.error(String(error)));
    }
  }

  function register() {
    transfer.registerRpc();
    bb.background.schedule("checks", "* * * * *", runDue);
    // Recover due ticks if the host cron dispatcher stalls; nextRun and the run lock prevent repeats.
    bb.background.service("checks-due", {
      async start(signal) {
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (signal.aborted) return;
          while (!signal.aborted) {
            await runDue();
            try { await delay(30_000, undefined, { signal }); } catch { break; }
          }
        } finally { signal.removeEventListener("abort", abort); }
      },
    });
  }

  return {
    register, runDue, scheduledTick, manualRun, status, stats,
    setEnabled, setField, retry, reset, configValues, fieldKeys: CHECK_FIELDS, transfer,
  };
}
