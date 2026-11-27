import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { errorMessage } from "../shared/errors";
import { endPauses } from "../pause/store";
import { EXECUTOR_MARKER_PREFIX, isExecutorReminderText } from "../steer";
import { isClosedStatus } from "../shared/workflow-policy";
import { capacityCandidates, checkCapacityCandidates } from "./capacity-wait";
import { createTasksStore } from "../db/store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type QueuedRow = MessageDispatchHookContext["queuedMessages"][number];

/** Waits before the next attempt after a failed deletion: a reminder-only group backs off to 30 minutes; a group carrying real input never waits longer than 30 seconds. */
const REMINDER_BACKOFF_MS = [5_000, 30_000, 300_000, 1_800_000];
const MIXED_BACKOFF_MS = [5_000, 30_000];

const MARKER = new RegExp(`${EXECUTOR_MARKER_PREFIX}(\\S+?) -->`, "g");

const rowText = (row: QueuedRow) => row.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

/** The occurrence ids a reminder text names. */
const occurrenceIds = (text: string) => [...text.matchAll(MARKER)].map((match) => match[1]!);

/**
 * A reminder is valid while at least one occurrence it names is open and its card is neither paused, closed nor archived.
 * Paused is read as the attention scan reads it: an applied pause that has not run out.
 */
function reminderCard(db: Database, text: string): { valid: boolean; key: string } {
  const now = new Date().toISOString();
  let key = "";
  for (const id of occurrenceIds(text)) {
    const row = db.prepare<[string, string], { task_key: string; cleared_at: string | null; status: string | null; archived_at: string | null; workflow_policy: string | null; paused: number }>(
      `SELECT o.task_key, o.cleared_at, t.status, t.archived_at, p.workflow_policy,
        EXISTS(SELECT 1 FROM task_pauses x WHERE x.task_id=o.task_id AND x.applied=1 AND x.signal IN ('manual','background') AND x.until > ?) AS paused
       FROM manager_attention o LEFT JOIN tasks t ON t.id=o.task_id LEFT JOIN projects p ON p.id=t.project_id WHERE o.id=?`).get(now, id);
    if (!row) continue;
    key ||= row.task_key;
    if (row.cleared_at === null && row.status !== null && !row.archived_at && !row.paused
      && !isClosedStatus({ workflowPolicy: row.workflow_policy === null ? null : JSON.parse(row.workflow_policy) }, row.status)) return { valid: true, key };
  }
  return { valid: false, key };
}

/**
 * Admission of Work Board's own executor reminders, and the end of card pauses.
 *
 * A reminder that went stale while it waited (its card was paused, closed or archived, or its occurrence cleared) is never
 * delivered: inline it is rejected, queued it is deleted. Only real input that starts a turn ends the pauses of the thread's
 * cards, so a reminder, which may arrive long after it was sent, never clears one. The handler reads local SQLite only and
 * never awaits the SDK: the deletion runs after the answer and asks core to decide again.
 */
export function registerDispatchGate(bb: BbPluginApi): void {
  const db = bb.storage.database();
  const passes = new Map<string, number>();
  const deleting = new Set<string>();
  const rounds = new Map<string, { key: string; ready: boolean }>();
  const store = createTasksStore(db);
  const batchId = (text: string, origin: string | null) => origin === bb.pluginId ? /<!-- work-board-attention:(\S+?) -->/.exec(text)?.[1] : undefined;
  const attemptFor = (batch: string) => db.prepare<[string], { attempt_id: string }>("SELECT attempt_id FROM attention_attempts WHERE batch_id=?").get(batch)?.attempt_id;
  const batchItems = (attempt: string) => db.prepare<[string, string], { id: string; task_id: string; signal: string; cleared_at: string | null; status: string | null; archived_at: string | null; workflow_policy: string | null; paused: number }>(`SELECT o.id,o.task_id,o.signal,o.cleared_at,t.status,t.archived_at,p.workflow_policy,
    EXISTS(SELECT 1 FROM task_pauses x WHERE x.task_id=o.task_id AND x.applied=1 AND x.signal IN ('manual','background') AND x.until > ?) AS paused
    FROM attention_attempt_items i JOIN manager_attention o ON o.id=i.occurrence_id LEFT JOIN tasks t ON t.id=o.task_id LEFT JOIN projects p ON p.id=t.project_id WHERE i.attempt_id=?`).all(new Date().toISOString(), attempt);
  const staleItem = (row: ReturnType<typeof batchItems>[number]) => row.cleared_at !== null || row.status === null || !!row.archived_at || !!row.paused || isClosedStatus({ workflowPolicy: row.workflow_policy ? JSON.parse(row.workflow_policy) : null }, row.status);
  async function checkRound(threadId: string, attempts: string[], round: { key: string; ready: boolean }) {
    try {
      const tasks = new Set(attempts.flatMap(attempt => batchItems(attempt)).filter(row => row.signal === "no_active_thread").map(row => row.task_id));
      const candidates = capacityCandidates(bb).filter(row => {
        const link = db.prepare<[string], { task_id: string }>("SELECT task_id FROM task_threads WHERE id=?").get(row.id);
        return !!link && tasks.has(link.task_id);
      });
      await checkCapacityCandidates(bb, store, candidates);
    } catch (error) { bb.log.warn(`Attention freshness check failed: ${errorMessage(error)}`); }
    finally {
      if (rounds.get(threadId) === round) round.ready = true;
      await bb.experimental_hooks.recheck("message.dispatch");
    }
  }
  async function withdraw(threadId: string, rowId: string, attempt: string) {
    try {
      db.transaction(() => {
        for (const item of batchItems(attempt)) db.prepare("INSERT OR IGNORE INTO attention_withdrawals(attempt_id,occurrence_id,state,at,reason) VALUES (?,?,'pending',?,'stale batch')").run(attempt, item.id, new Date().toISOString());
      })();
      await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: rowId });
      db.prepare("UPDATE attention_withdrawals SET state='done' WHERE attempt_id=? AND state='pending'").run(attempt);
      passes.delete(rowId);
      await bb.experimental_hooks.recheck("message.dispatch");
    } catch (error) { bb.log.warn(`stale_attention_delete_failed thread=${threadId}: ${errorMessage(error)}`); }
    finally { deleting.delete(rowId); }
  }

  const isReminder = (text: string, origin: string | null) => origin === bb.pluginId && isExecutorReminderText(text);

  async function purge(threadId: string, rows: { id: string; key: string }[]): Promise<void> {
    let removed = false;
    for (const row of rows) {
      try {
        await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id });
        removed = true;
        passes.delete(row.id);
      } catch (error) {
        bb.log.warn(`stale_reminder_delete_failed card=${row.key} thread=${threadId}: ${errorMessage(error)}`);
      } finally { deleting.delete(row.id); }
    }
    if (removed) await bb.experimental_hooks.recheck("message.dispatch");
  }

  function decide(ctx: MessageDispatchHookContext): MessageDispatchHookDecision {
    const batches = ctx.queuedMessages.length
      ? ctx.queuedMessages.map(row => ({ id: row.id, batch: batchId(rowText(row), row.originPluginId) })).filter(row => row.batch)
      : [{ id: "", batch: batchId(ctx.input.text, ctx.originPluginId) }].filter(row => row.batch);
    const attempts = batches.map(row => ({ ...row, attempt: attemptFor(row.batch!) }));
    if (attempts.some(row => !row.attempt)) return { action: "wait", reason: "Work Board cannot check a notice", sendAt: Date.now() + 30_000 };
    if (attempts.length) {
      const key = JSON.stringify(attempts.map(row => row.attempt!).sort());
      let round = rounds.get(ctx.thread.id);
      if (!round || round.key !== key) {
        round = { key, ready: false };
        rounds.set(ctx.thread.id, round);
        void checkRound(ctx.thread.id, attempts.map(row => row.attempt!), round).catch(error => bb.log.warn(`Attention recheck failed: ${errorMessage(error)}`));
      }
      if (!round.ready) return { action: "wait", reason: "checking linked sessions", sendAt: Date.now() + 30_000 };
      rounds.delete(ctx.thread.id);
    } else {
      rounds.delete(ctx.thread.id);
    }
    for (const row of attempts) {
      const attempt = row.attempt!;
      const pending = db.prepare<[string], { found: number }>("SELECT 1 AS found FROM attention_withdrawals WHERE attempt_id=? AND state='pending' LIMIT 1").get(attempt);
      if (pending || batchItems(attempt).some(staleItem)) {
        if (!row.id) return { action: "reject", message: "Work Board withdrew a stale notice" };
        const pass = (passes.get(row.id) ?? 0) + 1;
        passes.set(row.id, pass);
        if (!deleting.has(row.id)) { deleting.add(row.id); void withdraw(ctx.thread.id, row.id, attempt); }
        return { action: "wait", reason: "removing a stale Work Board notice", sendAt: Date.now() + REMINDER_BACKOFF_MS[Math.min(pass, REMINDER_BACKOFF_MS.length) - 1]! };
      }
    }
    if (ctx.queuedMessages.length === 0) {
      if (!isReminder(ctx.input.text, ctx.originPluginId)) return proceedWith(ctx, true);
      const { valid, key } = reminderCard(db, ctx.input.text);
      return valid ? { action: "proceed" } : { action: "reject", message: `Work Board withdrew a stale reminder for ${key || "a card"}` };
    }
    const stale: { id: string; key: string }[] = [];
    let real = false;
    for (const row of ctx.queuedMessages) {
      const text = rowText(row);
      if (!isReminder(text, row.originPluginId)) { real = true; continue; }
      const { valid, key } = reminderCard(db, text);
      if (!valid) stale.push({ id: row.id, key });
    }
    if (!stale.length) return proceedWith(ctx, real);
    const schedule = real ? MIXED_BACKOFF_MS : REMINDER_BACKOFF_MS;
    let pass = 0;
    for (const row of stale) {
      const count = (passes.get(row.id) ?? 0) + 1;
      passes.set(row.id, count);
      pass = Math.max(pass, count);
    }
    const fresh = stale.filter((row) => !deleting.has(row.id));
    for (const row of fresh) deleting.add(row.id);
    if (fresh.length) void purge(ctx.thread.id, fresh).catch((error) => bb.log.warn(`stale_reminder_purge_failed thread=${ctx.thread.id}: ${errorMessage(error)}`));
    return { action: "wait", reason: "removing a stale Work Board reminder", sendAt: Date.now() + schedule[Math.min(pass, schedule.length) - 1]! };
  }

  /** Real input that starts a turn ends the manual and background pauses of every card linked to the thread. */
  function proceedWith(ctx: MessageDispatchHookContext, real: boolean): MessageDispatchHookDecision {
    if (real && ctx.attempt === "start-turn") {
      db.transaction(() => {
        for (const { task_id } of db.prepare<[string], { task_id: string }>("SELECT DISTINCT task_id FROM task_threads WHERE thread_id=?").all(ctx.thread.id))
          endPauses(db, task_id, "turn_started", ctx.thread.id);
      })();
    }
    return { action: "proceed" };
  }

  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    try {
      return decide(ctx);
    } catch (error) {
      // Answering is mandatory (a throw fails the attempt). Without its database the gate cannot tell a stale reminder,
      // so an attempt carrying one waits (never delivered unjudged); anything else goes through.
      bb.log.warn(`Dispatch gate failed for ${ctx.thread.id}: ${errorMessage(error)}`);
      const reminder = ctx.queuedMessages.length
        ? ctx.queuedMessages.some((row) => isReminder(rowText(row), row.originPluginId) || !!batchId(rowText(row), row.originPluginId))
        : isReminder(ctx.input.text, ctx.originPluginId) || !!batchId(ctx.input.text, ctx.originPluginId);
      return reminder ? { action: "wait", reason: "Work Board cannot check a reminder", sendAt: Date.now() + 30_000 } : { action: "proceed" };
    }
  });
}
