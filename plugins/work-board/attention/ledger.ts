import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ATTENTION_KIND, ATTENTION_SIGNALS, staleStatusObservations, type AttentionSignal, type CardObservation } from "./observe";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** A condition must hold this long before its first notice (BP-3). */
export const GRACE_MS = 10 * 60_000;
export const ACCEPTED_OUTCOMES = ["appended", "queued", "inline"] as const;
const ACCEPTED_SQL = ACCEPTED_OUTCOMES.map((outcome) => `'${outcome}'`).join(", ");

export interface OccurrenceRow {
  id: string;
  tracker_id: string;
  task_id: string;
  task_key: string;
  kind: string;
  signal: AttentionSignal;
  first_seen_at: string;
  eligible_at: string;
  cleared_at: string | null;
  retired_reason: string | null;
  sweep_baselined_generation: number | null;
  created_rev: number;
  rev: number;
}

const nowIso = () => new Date().toISOString();

// Listeners learn which tracker's ledger moved, so the delivery service can schedule a drain; they must not touch the database.
const listeners = new Set<(trackerId: string) => void>();
export function onAttentionChanged(listener: (trackerId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function notifyAttentionChanged(trackerId: string): void {
  for (const listener of listeners) listener(trackerId);
}

export function currentRev(db: Database, trackerId: string): number {
  return db.prepare<[string], { rev: number }>("SELECT rev FROM attention_rev WHERE tracker_id=?").get(trackerId)?.rev ?? 0;
}

/** Every change to an occurrence, attempt, observation or baseline takes the next revision of its tracker. */
export function bumpRev(db: Database, trackerId: string): number {
  db.prepare<[string]>("INSERT INTO attention_rev(tracker_id, rev) VALUES (?, 1) ON CONFLICT(tracker_id) DO UPDATE SET rev = rev + 1").run(trackerId);
  return currentRev(db, trackerId);
}

export function hasAcceptedAttempt(db: Database, occurrenceId: string): boolean {
  return Boolean(db.prepare<[string], { found: number }>(`SELECT 1 AS found FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id WHERE i.occurrence_id=? AND a.outcome IN (${ACCEPTED_SQL}) LIMIT 1`).get(occurrenceId));
}

/** Close an occurrence; one without an accepted attempt also retires, so it never acknowledges a later recurrence. */
export function closeOccurrence(db: Database, occurrence: Pick<OccurrenceRow, "id" | "tracker_id">, reason: string): void {
  const retired = hasAcceptedAttempt(db, occurrence.id) ? null : reason;
  db.prepare<[string, string | null, number, string]>("UPDATE manager_attention SET cleared_at=?, retired_reason=?, rev=? WHERE id=? AND cleared_at IS NULL")
    .run(nowIso(), retired, bumpRev(db, occurrence.tracker_id), occurrence.id);
}

/** Close every open occurrence of a tracker and kind (observation restart, mode off). */
export function retireOpenOccurrences(db: Database, trackerId: string, kind: string, reason: string): number {
  const open = db.prepare<[string, string], OccurrenceRow>("SELECT * FROM manager_attention WHERE tracker_id=? AND kind=? AND cleared_at IS NULL").all(trackerId, kind);
  for (const occurrence of open) closeOccurrence(db, occurrence, reason);
  db.prepare<[string, string]>("DELETE FROM attention_unknown WHERE tracker_id=? AND kind=?").run(trackerId, kind);
  return open.length;
}

/** A deleted card has no later observation to clear its occurrences, so they close with it. */
export function closeTaskOccurrences(db: Database, taskId: string, reason: string): void {
  const open = db.prepare<[string], OccurrenceRow>("SELECT * FROM manager_attention WHERE task_id=? AND cleared_at IS NULL").all(taskId);
  for (const occurrence of open) closeOccurrence(db, occurrence, reason);
  db.prepare<[string]>("DELETE FROM attention_unknown WHERE task_id=?").run(taskId);
}

function recordUnknown(db: Database, trackerId: string, kind: string, taskId: string, signal: AttentionSignal): boolean {
  const added = db.prepare<[string, string, string, string]>("INSERT OR IGNORE INTO attention_unknown(tracker_id, kind, task_id, signal) VALUES (?, ?, ?, ?)").run(trackerId, kind, taskId, signal).changes > 0;
  // One observation per unknown spell, not one per recompute that sees it again.
  if (added) db.prepare<[string, string, string, string, string, number]>("INSERT INTO attention_observations(tracker_id, kind, at, task_id, signal, validity, rev) VALUES (?, ?, ?, ?, ?, 'unknown', ?)")
    .run(trackerId, kind, nowIso(), taskId, signal, bumpRev(db, trackerId));
  return added;
}

/** Apply one card's observation to its occurrences; returns whether the ledger changed. */
function applyCard(db: Database, trackerId: string, kind: string, card: CardObservation, at: number): boolean {
  let changed = false;
  const open = new Map(db.prepare<[string, string, string], OccurrenceRow>("SELECT * FROM manager_attention WHERE tracker_id=? AND kind=? AND task_id=? AND cleared_at IS NULL").all(trackerId, kind, card.taskId).map((row) => [row.signal, row]));
  for (const signal of ATTENTION_SIGNALS) {
    const scoped = signal === "no_merge_or_outcome" ? card.doneScope : card.inScope;
    const occurrence = open.get(signal);
    const observed = card.signals[signal];
    if (!scoped) {
      db.prepare<[string, string, string, string]>("DELETE FROM attention_unknown WHERE tracker_id=? AND kind=? AND task_id=? AND signal=?").run(trackerId, kind, card.taskId, signal);
      if (occurrence) { closeOccurrence(db, occurrence, signal === "no_merge_or_outcome" ? "status_changed" : card.scopeReason); changed = true; }
      continue;
    }
    // An unknown signal neither creates nor clears: the previous state stays and the observation is journalled.
    if (observed.validity === "unknown") { changed = recordUnknown(db, trackerId, kind, card.taskId, signal) || changed; continue; }
    db.prepare<[string, string, string, string]>("DELETE FROM attention_unknown WHERE tracker_id=? AND kind=? AND task_id=? AND signal=?").run(trackerId, kind, card.taskId, signal);
    if (observed.present && !occurrence) {
      const rev = bumpRev(db, trackerId);
      db.prepare<[string, string, string, string, string, string, string, string, number, number]>(
        "INSERT INTO manager_attention(id, tracker_id, task_id, task_key, kind, signal, first_seen_at, eligible_at, created_rev, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(randomUUID(), trackerId, card.taskId, card.key, kind, signal, new Date(at).toISOString(), new Date(at + GRACE_MS).toISOString(), rev, rev);
      changed = true;
    } else if (!observed.present && occurrence) {
      closeOccurrence(db, occurrence, "cleared");
      changed = true;
    }
  }
  return changed;
}

// Most writes happen with every mode off; remembering that for a moment spares them a query. A mode change on this handle
// clears it, and the short lifetime covers a change made through another handle.
const quietSince = new WeakMap<object, number>();
const QUIET_MS = 2000;
export function invalidateAttentionCache(db: Database): void {
  quietSince.delete(db);
}
function anyAttentionActive(db: Database): boolean {
  const quiet = quietSince.get(db);
  if (quiet !== undefined && Date.now() - quiet < QUIET_MS) return false;
  const active = Boolean(db.prepare("SELECT 1 FROM attention_modes WHERE effective_mode<>'off' LIMIT 1").get());
  if (active) quietSince.delete(db);
  else quietSince.set(db, Date.now());
  return active;
}

/** Observation of a tracker's pilot kind is live only outside `off`. */
function activeTrackers(db: Database, trackerIds: readonly string[]): string[] {
  if (!trackerIds.length) return [];
  return db.prepare<[string, string], { tracker_id: string }>(
    "SELECT tracker_id FROM attention_modes WHERE kind=? AND effective_mode<>'off' AND tracker_id IN (SELECT value FROM json_each(?))",
  ).all(ATTENTION_KIND, JSON.stringify(trackerIds)).map((row) => row.tracker_id);
}

/**
 * The source write's own transaction calls this with the cards it touched: the observations of those cards, and of every card
 * they block, are recomputed and applied as occurrence diffs before the write commits. A clear and a recurrence at two commits
 * therefore stay two diffs, each with its own occurrence id and grace.
 */
export function touchAttention(db: Database, taskIds: readonly string[]): void {
  if (!taskIds.length) return;
  if (!anyAttentionActive(db)) return;
  const ids = JSON.stringify([...new Set(taskIds)]);
  const affected = db.prepare<[string, string], { id: string }>(
    "SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT d.task_id FROM task_dependencies d WHERE d.blocking_task_id IN (SELECT value FROM json_each(?))",
  ).all(ids, ids).map((row) => row.id);
  const at = Date.now();
  const touched = new Set<string>();
  // A card moved to another tracker leaves its old tracker's ledger.
  for (const row of db.prepare<[string], OccurrenceRow & { project_id: string | null }>(
    "SELECT o.*, t.project_id FROM manager_attention o LEFT JOIN tasks t ON t.id=o.task_id WHERE o.cleared_at IS NULL AND o.task_id IN (SELECT value FROM json_each(?))",
  ).all(ids)) {
    if (row.project_id !== row.tracker_id) { closeOccurrence(db, row, row.project_id ? "moved" : "deleted"); touched.add(row.tracker_id); }
  }
  const observations = staleStatusObservations(db, affected);
  const active = new Set(activeTrackers(db, [...new Set(observations.map((card) => card.trackerId))]));
  for (const card of observations) if (active.has(card.trackerId) && applyCard(db, card.trackerId, ATTENTION_KIND, card, at)) touched.add(card.trackerId);
  for (const trackerId of touched) notifyAttentionChanged(trackerId);
}

/** The debounced wide pass (policy, labels, relinks) and the ten-minute reconciliation: every card of the tracker. */
export function scanTracker(db: Database, trackerId: string): void {
  if (activeTrackers(db, [trackerId]).length === 0) return;
  const at = Date.now();
  const observations = staleStatusObservations(db, undefined, trackerId);
  let changed = false;
  for (const card of observations) changed = applyCard(db, trackerId, ATTENTION_KIND, card, at) || changed;
  const seen = new Set(observations.map((card) => card.taskId));
  for (const row of db.prepare<[string, string], OccurrenceRow>("SELECT * FROM manager_attention WHERE tracker_id=? AND kind=? AND cleared_at IS NULL").all(trackerId, ATTENTION_KIND))
    if (!seen.has(row.task_id)) { closeOccurrence(db, row, "deleted"); changed = true; }
  if (changed) notifyAttentionChanged(trackerId);
}

// The wide scan is deferred to the attention service; a store write only says which tracker needs one.
const projectListeners = new Set<(trackerId: string) => void>();
export function onTrackerDirty(listener: (trackerId: string) => void): () => void {
  projectListeners.add(listener);
  return () => projectListeners.delete(listener);
}
export function markTrackerDirty(trackerId: string): void {
  for (const listener of projectListeners) listener(trackerId);
}
