import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { inPilotScope, projectPolicies, staleRows } from "../attention/observe";
import { endPauses, expireDuePauses, pauseArm, startSignalPause, type PauseRow } from "./store";
import { UNANSWERED_QUESTION } from "../db/waiting-on-owner";
import { doneSql } from "../db/status-sql";
import { drainPauseExpiryNotices } from "./expiry";

/** Reconcile a single snapshot in one transaction; a failed SDK read leaves signal state untouched. */
export async function sweepPauseSignals(bb: BbPluginApi): Promise<void> {
  const db = bb.storage.database();
  db.transaction(() => {
    expireDuePauses(db, new Date().toISOString());
  })();
  // After the commit, and without holding up the signal sweep below.
  void drainPauseExpiryNotices(bb);
  const modes = new Map(db.prepare<[], { project_id: string; mode: string }>("SELECT project_id,mode FROM pause_modes WHERE mode<>'off'").all().map(row => [row.project_id, row.mode]));
  const policies = projectPolicies(db);
  const cards = staleRows(db).filter(row => modes.has(row.project_id) && !row.archived && policies.has(row.project_id) && inPilotScope(policies.get(row.project_id)!, row.status));
  const ids = cards.map(card => card.id);
  const links = ids.length ? db.prepare<[string], { task_id: string; thread_id: string }>("SELECT task_id,thread_id FROM task_threads WHERE task_id IN (SELECT value FROM json_each(?)) AND live_status NOT IN ('completed','failed')").all(JSON.stringify(ids)) : [];
  const threadIds = [...new Set(links.map(link => link.thread_id))];
  const snapshots = new Map<string, Awaited<ReturnType<typeof bb.sdk.threads.list>>[number]>();
  try {
    for (let i = 0; i < threadIds.length; i += 200) {
      const batch = threadIds.slice(i, i + 200);
      for (const thread of await bb.sdk.threads.list({ threadIds: batch, limit: batch.length, includeHidden: true })) snapshots.set(thread.id, thread);
    }
  } catch (error) {
    bb.log.warn(`Pause signal read failed: ${String(error)}`);
    return;
  }
  db.transaction(() => {
    const currentCards = new Map(staleRows(db, ids).map(card => [card.id, card]));
    for (const original of cards) {
      const card = currentCards.get(original.id);
      if (!card || card.archived || card.project_id !== original.project_id || !policies.has(card.project_id) || !inPilotScope(policies.get(card.project_id)!, card.status)) continue;
      const mode = db.prepare<[string], { mode: string }>("SELECT mode FROM pause_modes WHERE project_id=?").get(card.project_id)?.mode ?? "off";
      if (mode === "off") continue;
      const applied = mode === "on" || pauseArm(card.id) === "auto";
      for (const [signal, present] of [["held", card.held], ["owner_question", card.waiting_owner]] as const) {
        const existing = db.prepare<[string, string], PauseRow>("SELECT * FROM task_pauses WHERE task_id=? AND signal=?").get(card.id, signal);
        if (present && !existing) {
          const detail = signal === "held"
            ? db.prepare<[string], { value: string }>(`SELECT p.prefix || '-' || b.number AS value FROM task_dependencies d JOIN tasks b ON b.id=d.blocking_task_id JOIN projects p ON p.id=b.project_id WHERE d.task_id=? AND NOT ${doneSql("b", "p")} LIMIT 1`).get(card.id)?.value
            : db.prepare<[string], { value: string }>(`SELECT q.id AS value FROM task_questions q WHERE q.task_id=? AND ${UNANSWERED_QUESTION} LIMIT 1`).get(card.id)?.value;
          startSignalPause(db, card.id, signal, "system", signal === "held" ? `waiting on ${detail ?? "a predecessor"}` : `waiting on owner question ${detail ?? "unknown"}`, true);
        }
        if (!present && existing) endPauses(db, card.id, "signal_cleared", "system", { signal });
      }
      for (const link of links.filter(link => link.task_id === card.id)) {
        if (!db.prepare<[string, string]>("SELECT 1 FROM task_threads WHERE task_id=? AND thread_id=? AND live_status NOT IN ('completed','failed')").get(link.task_id, link.thread_id)) continue;
        const thread = snapshots.get(link.thread_id);
        const running = Boolean(thread && !thread.archivedAt && !thread.deletedAt && (thread.activity.activeBackgroundCommandCount + thread.activity.activeBackgroundAgentCount + thread.activity.activeWorkflowCount > 0));
        const existing = db.prepare<[string, string], PauseRow>("SELECT * FROM task_pauses WHERE task_id=? AND signal='background' AND thread_id=?").get(card.id, link.thread_id);
        if (!running) {
          db.prepare<[string, string]>("DELETE FROM pause_latches WHERE task_id=? AND thread_id=? AND release_on='cleared'").run(card.id, link.thread_id);
          if (existing) endPauses(db, card.id, "signal_cleared", link.thread_id, { signal: "background", threadId: link.thread_id });
        } else if (thread?.status === "idle" && !existing && db.prepare<[string, string]>("SELECT 1 FROM task_threads WHERE task_id=? AND thread_id=? AND live_status='idle'").get(card.id, link.thread_id) && !db.prepare<[string, string]>("SELECT 1 FROM pause_latches WHERE task_id=? AND thread_id=?").get(card.id, link.thread_id)) {
          startSignalPause(db, card.id, "background", link.thread_id, `background work in @thread:${link.thread_id}`, applied);
        }
      }
    }
    // A removed or terminal link cannot keep its old background episode alive.
    for (const row of db.prepare<[], PauseRow>("SELECT * FROM task_pauses WHERE source='auto'").all()) {
      if (!ids.includes(row.task_id) || (row.signal === "background" && !db.prepare<[string, string]>("SELECT 1 FROM task_threads WHERE task_id=? AND thread_id=? AND live_status NOT IN ('completed','failed')").get(row.task_id, row.thread_id)))
        endPauses(db, row.task_id, "signal_cleared", row.thread_id, { signal: row.signal, threadId: row.thread_id });
    }
  })();
}
