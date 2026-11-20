import { createHash, randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { bumpRev, CURRENT_KEY_SQL, currentRev, invalidateAttentionCache, retireOpenOccurrences, scanTracker, ACCEPTED_OUTCOMES } from "./ledger";
import { ATTENTION_KIND, PILOT_SIGNALS } from "./observe";
import { assertChecksLinkChangeAllowed } from "../checks/ownership";
import { fenceMessage } from "../checks/transfer";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** The shadow observation the owner must have seen before the first live switch (the pilot gate length). */
export const SHADOW_GATE_MS = 48 * 3_600_000;
export type AttentionMode = "off" | "shadow" | "live";

export interface ModeRow {
  tracker_id: string;
  kind: string;
  bound_tracker_id: string | null;
  bound_bb_project_id: string | null;
  effective_mode: AttentionMode;
  effective_generation: number;
  requested_mode: "shadow" | "live" | null;
  requested_generation: number | null;
  transition_token: string | null;
  transition_direction: "to_live" | "to_shadow" | null;
  transition_state: "preparing" | "ready" | null;
  ready_at: string | null;
  ready_rev: number | null;
  parity_reviewed: number;
  shadow_started_at: string | null;
  changed_at: string | null;
  previous_mode: string | null;
}

export interface HandbackEntry { occurrenceId: string; taskId: string; taskKey: string; signal: string; firstSeenAt: string; eligibleAt: string }
export interface KindState {
  effective: { mode: AttentionMode; generation: number };
  requested: { mode: "shadow" | "live"; generation: number } | null;
  transition: null | {
    token: string;
    direction: "to_live" | "to_shadow";
    generation: number;
    state: "preparing" | "ready";
    readyAt: string | null;
    readyRev: number | null;
    handback: HandbackEntry[] | null;
  };
}
export type AckResult =
  | { ok: true; generation: number; direction: "to_live" | "to_shadow"; mode: AttentionMode; unmatched: { occurrenceId: string; reason: string }[]; baselined: string[]; readyRev: number | null; endRev: number }
  | { ok: false; code: "stale_ack" | "generation_mismatch"; current: KindState }
  | { ok: false; code: "ack_conflict" };

const nowIso = () => new Date().toISOString();

/** A pure read: a tracker never switched on has no row and reads as `off` at generation 0. */
export function getModeRow(db: Database, trackerId: string, kind = ATTENTION_KIND): ModeRow {
  return db.prepare<[string, string], ModeRow>("SELECT * FROM attention_modes WHERE tracker_id=? AND kind=?").get(trackerId, kind) ?? {
    tracker_id: trackerId, kind, bound_tracker_id: null, bound_bb_project_id: null, effective_mode: "off", effective_generation: 0, requested_mode: null, requested_generation: null,
    transition_token: null, transition_direction: null, transition_state: null, ready_at: null, ready_rev: null, parity_reviewed: 0, shadow_started_at: null, changed_at: null, previous_mode: null,
  };
}

export function handbackOf(db: Database, trackerId: string, kind: string, generation: number): HandbackEntry[] {
  return db.prepare<[string, string, number], { occurrenceId: string; taskId: string; taskKey: string; signal: string; firstSeenAt: string; eligibleAt: string }>(
    `SELECT o.id AS occurrenceId, o.task_id AS taskId, h.task_key AS taskKey, o.signal, o.first_seen_at AS firstSeenAt, o.eligible_at AS eligibleAt
     FROM attention_handback h JOIN manager_attention o ON o.id=h.occurrence_id
     WHERE h.tracker_id=? AND h.kind=? AND h.generation=? ORDER BY o.created_rev`,
  ).all(trackerId, kind, generation);
}

export function kindState(db: Database, trackerId: string, kind = ATTENTION_KIND): KindState {
  const row = getModeRow(db, trackerId, kind);
  const pending = row.requested_mode !== null && row.transition_token !== null;
  return {
    effective: { mode: row.effective_mode, generation: row.effective_generation },
    requested: pending ? { mode: row.requested_mode!, generation: row.requested_generation! } : null,
    transition: pending
      ? {
          token: row.transition_token!,
          direction: row.transition_direction!,
          generation: row.requested_generation!,
          state: row.transition_state!,
          readyAt: row.ready_at,
          readyRev: row.ready_rev,
          handback: row.transition_state === "ready" ? handbackOf(db, trackerId, kind, row.requested_generation!) : null,
        }
      : null,
  };
}

export const isPending = (row: ModeRow) => row.requested_mode !== null;

/** The bound tracker of a bb project for a kind, if any: later calls must resolve to the same one. */
export function boundTrackerOf(db: Database, bbProjectId: string, kind = ATTENTION_KIND): string | null {
  return db.prepare<[string, string], { tracker_id: string }>("SELECT tracker_id FROM attention_modes WHERE bound_bb_project_id=? AND kind=? AND bound_tracker_id IS NOT NULL").get(bbProjectId, kind)?.tracker_id ?? null;
}

/** A relink is refused while the tracker is bound or a transition is pending, and so is a second link to a bound bb project. */
export function assertLinkChangeAllowed(db: Database, trackerId: string, currentLink: string | null, nextLink: string | null): void {
  if (currentLink === nextLink) return;
  assertChecksLinkChangeAllowed(db, trackerId, currentLink);
  const mine = db.prepare<[string], { found: number }>("SELECT 1 AS found FROM attention_modes WHERE tracker_id=? AND (bound_tracker_id IS NOT NULL OR requested_mode IS NOT NULL) LIMIT 1").get(trackerId);
  if (mine) throw new Error("This project's manager attention is not off: switch it off in the project settings before changing the BB project link");
  const other = nextLink ? boundTrackerOf(db, nextLink) : null;
  if (other && other !== trackerId) throw new Error("Another tracker project is bound to that BB project's manager attention; its link cannot be shared");
}

/** The manager setting of a tracker: a thread id, or null when none is chosen. */
export const configuredManager = (db: Database, trackerId: string): string | null =>
  db.prepare<[string], { manager: string | null }>("SELECT manager FROM attention_manager WHERE tracker_id=?").get(trackerId)?.manager || null;

export interface RequestInput {
  trackerId: string; kind?: string; mode: AttentionMode; parityReviewed?: boolean;
  /** What a live request validated: it is written only if the manager and the shadow generation are still these. */
  guard?: { manager: string | null; generation: number };
}

const newToken = () => randomBytes(12).toString("base64url");

/** The owner's request. Returns the new state; every refusal is an Error whose message names the rule. */
export function requestMode(db: Database, input: RequestInput): KindState {
  const kind = input.kind ?? ATTENTION_KIND;
  if (kind !== ATTENTION_KIND) throw new Error(`Unknown attention kind: ${kind}`);
  const run = db.transaction((): KindState => {
    invalidateAttentionCache(db);
    const tracker = db.prepare<[string], { id: string; linked: string | null }>("SELECT id, linked_bb_project_id AS linked FROM projects WHERE id=?").get(input.trackerId);
    if (!tracker) throw new Error(`Project not found: ${input.trackerId}`);
    // A transfer in flight, or a send to Sweep that is not confirmed, freezes the tracker: no transition may start under it.
    const fence = fenceMessage(db, tracker.id, tracker.linked);
    if (fence) throw new Error(fence);
    const row = getModeRow(db, tracker.id, kind);
    if (isPending(row)) throw new Error("A mode transition is pending; wait for Sweep to acknowledge it");
    db.prepare<[string, string]>("INSERT OR IGNORE INTO attention_modes(tracker_id, kind) VALUES (?, ?)").run(tracker.id, kind);
    if (input.mode === row.effective_mode) throw new Error(`Attention is already ${row.effective_mode}`);
    const at = nowIso();
    const generation = row.effective_generation + 1;
    const record = (extra: string, ...values: unknown[]) =>
      db.prepare(`UPDATE attention_modes SET ${extra}, changed_at=?, previous_mode=? WHERE tracker_id=? AND kind=?`).run(...values, at, row.effective_mode, tracker.id, kind);
    if (row.effective_mode === "off" && input.mode === "shadow") {
      if (!tracker.linked) throw new Error("Link this project to a BB project before switching attention on");
      // Sweep reaches the tracker through the BB project, so a second tracker on the same link would make every call ambiguous.
      if (db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM projects WHERE linked_bb_project_id=?").get(tracker.linked)!.n !== 1)
        throw new Error("Another tracker project is linked to the same BB project; only one can use manager attention");
      const holder = boundTrackerOf(db, tracker.linked, kind);
      if (holder && holder !== tracker.id) throw new Error("Another tracker project is already bound to that BB project's manager attention");
      // A fresh observation: whatever was open before the off interval is not trusted.
      retireOpenOccurrences(db, tracker.id, kind, "observation restarted");
      record("bound_tracker_id=?, bound_bb_project_id=?, effective_mode='shadow', effective_generation=?, shadow_started_at=?, parity_reviewed=0", tracker.id, tracker.linked, generation, at);
      scanTracker(db, tracker.id);
    } else if (row.effective_mode === "shadow" && input.mode === "off") {
      retireOpenOccurrences(db, tracker.id, kind, "mode off");
      record("bound_tracker_id=NULL, bound_bb_project_id=NULL, effective_mode='off', effective_generation=?, shadow_started_at=NULL", generation);
    } else if (row.effective_mode === "shadow" && input.mode === "live") {
      const started = row.shadow_started_at ? Date.parse(row.shadow_started_at) : Date.now();
      if (Date.now() - started < SHADOW_GATE_MS) throw new Error("Live needs at least 48 hours of shadow observation first");
      if (input.parityReviewed !== true) throw new Error("Confirm that the parity differences were reviewed before switching to live");
      // The manager was read before this transaction: a change made meanwhile makes that read stale, so nothing is written.
      if (input.guard && (input.guard.generation !== row.effective_generation || input.guard.manager !== configuredManager(db, tracker.id)))
        throw new Error("The manager changed while it was being checked; try again");
      // Work Board is not the sender yet, so there is nothing to drain: the transition is ready as soon as it is requested.
      record("requested_mode='live', requested_generation=?, transition_token=?, transition_direction='to_live', transition_state='ready', ready_at=?, ready_rev=?, parity_reviewed=1", generation, newToken(), at, currentRev(db, tracker.id));
    } else if (row.effective_mode === "live" && input.mode === "shadow") {
      // The fence first: no new claims from here on; handback is written once in-flight attempts are reconciled.
      record("requested_mode='shadow', requested_generation=?, transition_token=?, transition_direction='to_shadow', transition_state='preparing', ready_at=NULL, ready_rev=NULL", generation, newToken());
      finishToShadow(db, tracker.id, kind);
    } else if (input.mode === "live") throw new Error("Live is reached from shadow only");
    else throw new Error("Live goes back through shadow before it can be switched off");
    return kindState(db, tracker.id, kind);
  });
  return run();
}

/** Attempts that still hold a to_shadow in `preparing`: undecided sends, and unknown ones the owner has not resolved. */
export function unresolvedAttempts(db: Database, trackerId: string, kind: string): { attempt_id: string; outcome: string }[] {
  return db.prepare<[string, string], { attempt_id: string; outcome: string }>(
    "SELECT attempt_id, outcome FROM attention_attempts WHERE tracker_id=? AND kind=? AND (outcome IN ('claimed', 'sending') OR (outcome='unknown' AND disposition IS NULL))",
  ).all(trackerId, kind);
}

/** Write the handback and mark a pending to_shadow ready, unless an attempt is still unresolved. */
export function finishToShadow(db: Database, trackerId: string, kind = ATTENTION_KIND): boolean {
  return db.transaction((): boolean => {
    const row = getModeRow(db, trackerId, kind);
    if (row.transition_direction !== "to_shadow" || row.transition_state !== "preparing") return false;
    if (unresolvedAttempts(db, trackerId, kind).length) return false;
    const generation = row.requested_generation!;
    // Open, unbaselined occurrences with no accepted attempt go back to Sweep; a waived loss is still unaccepted.
    db.prepare<[string, string, number, string, string]>(
      `INSERT OR IGNORE INTO attention_handback(tracker_id, kind, generation, occurrence_id, task_key)
       SELECT ?, ?, ?, o.id, ${CURRENT_KEY_SQL} FROM manager_attention o WHERE o.tracker_id=? AND o.kind=? AND o.cleared_at IS NULL AND o.sweep_baselined_generation IS NULL
       AND o.signal IN (${PILOT_SIGNALS.map((signal) => `'${signal}'`).join(", ")})
       AND NOT EXISTS (SELECT 1 FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id WHERE i.occurrence_id=o.id AND a.outcome IN (${ACCEPTED_OUTCOMES.map((o) => `'${o}'`).join(", ")}))`,
    ).run(trackerId, kind, generation, trackerId, kind);
    db.prepare<[string, number, string, string]>("UPDATE attention_modes SET transition_state='ready', ready_at=?, ready_rev=? WHERE tracker_id=? AND kind=?").run(nowIso(), currentRev(db, trackerId), trackerId, kind);
    return true;
  })();
}

const idsHash = (ids: readonly string[]) => createHash("sha256").update(JSON.stringify([...new Set(ids)].sort())).digest("hex");

export interface AckInput { trackerId: string; kind: string; token: string; generation: number; direction: "to_live" | "to_shadow"; fenceId: string; acceptedOccurrenceIds?: string[] }

/** Sweep's acknowledgement; the caller has already resolved the tracker and checked the binding and the Sweep identity. */
export function ackTransition(db: Database, input: AckInput): AckResult {
  return db.transaction((): AckResult => {
    invalidateAttentionCache(db);
    const hash = idsHash(input.acceptedOccurrenceIds ?? []);
    // A stored ack answers a replay first, even after a later transition began; it never changes state.
    const stored = db.prepare<[string, string, string], { generation: number; direction: string; fence_id: string; ids_hash: string; result_json: string }>("SELECT generation, direction, fence_id, ids_hash, result_json FROM attention_acks WHERE tracker_id=? AND kind=? AND token=?").get(input.trackerId, input.kind, input.token);
    if (stored) {
      if (stored.generation !== input.generation || stored.direction !== input.direction) return { ok: false, code: "ack_conflict" };
      return stored.fence_id === input.fenceId && stored.ids_hash === hash ? (JSON.parse(stored.result_json) as AckResult) : { ok: false, code: "ack_conflict" };
    }
    const row = getModeRow(db, input.trackerId, input.kind);
    const matches = isPending(row) && row.transition_token === input.token && row.requested_generation === input.generation && row.transition_direction === input.direction;
    if (!matches || row.transition_state !== "ready") {
      const finished = !isPending(row) || input.generation <= row.effective_generation || input.generation < (row.requested_generation ?? 0);
      return { ok: false, code: finished ? "stale_ack" : "generation_mismatch", current: kindState(db, input.trackerId, input.kind) };
    }
    const unmatched: { occurrenceId: string; reason: string }[] = [];
    const baselined: string[] = [];
    if (input.direction === "to_live") {
      for (const id of new Set(input.acceptedOccurrenceIds ?? [])) {
        const occurrence = db.prepare<[string], { tracker_id: string; kind: string; cleared_at: string | null; retired_reason: string | null }>("SELECT tracker_id, kind, cleared_at, retired_reason FROM manager_attention WHERE id=?").get(id);
        if (!occurrence || occurrence.tracker_id !== input.trackerId || occurrence.kind !== input.kind) unmatched.push({ occurrenceId: id, reason: "unknown" });
        else if (occurrence.cleared_at) unmatched.push({ occurrenceId: id, reason: occurrence.retired_reason ? `retired: ${occurrence.retired_reason}` : "cleared" });
        else {
          db.prepare<[number, number, string]>("UPDATE manager_attention SET sweep_baselined_generation=?, rev=? WHERE id=?").run(input.generation, bumpRev(db, input.trackerId), id);
          baselined.push(id);
        }
      }
    }
    const at = nowIso();
    const mode: AttentionMode = input.direction === "to_live" ? "live" : "shadow";
    db.prepare<[string, number, string, string, string, string, string, string]>(
      `UPDATE attention_modes SET effective_mode=?, effective_generation=?, requested_mode=NULL, requested_generation=NULL, transition_token=NULL, transition_direction=NULL,
       transition_state=NULL, ready_at=NULL, ready_rev=NULL, changed_at=?, previous_mode=?, shadow_started_at=CASE WHEN ?='shadow' THEN ? ELSE shadow_started_at END WHERE tracker_id=? AND kind=?`,
    ).run(mode, input.generation, at, row.effective_mode, mode, at, input.trackerId, input.kind);
    const result: AckResult = { ok: true, generation: input.generation, direction: input.direction, mode, unmatched, baselined, readyRev: row.ready_rev, endRev: currentRev(db, input.trackerId) };
    db.prepare<[string, string, string, number, string, string, string, string]>("INSERT INTO attention_acks(tracker_id, kind, token, generation, direction, fence_id, ids_hash, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.trackerId, input.kind, input.token, input.generation, input.direction, input.fenceId, hash, JSON.stringify(result));
    return result;
  })();
}
