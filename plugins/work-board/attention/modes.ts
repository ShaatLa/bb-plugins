import { randomBytes } from "node:crypto";
import { transitionExecutors } from "../pause/executor";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { currentRev, invalidateAttentionCache, retireOpenOccurrences, scanTracker } from "./ledger";
import { ATTENTION_KIND } from "./observe";
import { assertChecksLinkChangeAllowed } from "../checks/ownership";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type AttentionMode = "off" | "live";

/**
 * One row per tracker and kind. `shadow` is a legacy stored value, normalized to `off` at startup. A pending switch-off is stored
 * as `requested_mode='shadow'`, `transition_direction='to_shadow'`: since Shadow mode was removed, `to_shadow` means "switching off".
 */
export interface ModeRow {
  tracker_id: string;
  kind: string;
  bound_tracker_id: string | null;
  bound_bb_project_id: string | null;
  effective_mode: AttentionMode | "shadow";
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

export interface KindState {
  effective: { mode: AttentionMode; generation: number };
  switchingOff: boolean;
}

const nowIso = () => new Date().toISOString();

/** A pure read: a tracker never switched on has no row and reads as `off` at generation 0. */
export function getModeRow(db: Database, trackerId: string, kind = ATTENTION_KIND): ModeRow {
  return db.prepare<[string, string], ModeRow>("SELECT * FROM attention_modes WHERE tracker_id=? AND kind=?").get(trackerId, kind) ?? {
    tracker_id: trackerId, kind, bound_tracker_id: null, bound_bb_project_id: null, effective_mode: "off", effective_generation: 0, requested_mode: null, requested_generation: null,
    transition_token: null, transition_direction: null, transition_state: null, ready_at: null, ready_rev: null, parity_reviewed: 0, shadow_started_at: null, changed_at: null, previous_mode: null,
  };
}

export function kindState(db: Database, trackerId: string, kind = ATTENTION_KIND): KindState {
  const row = getModeRow(db, trackerId, kind);
  return { effective: { mode: row.effective_mode === "live" ? "live" : "off", generation: row.effective_generation }, switchingOff: row.transition_direction === "to_shadow" };
}

export const isPending = (row: ModeRow) => row.requested_mode !== null;

/** The bound tracker of a bb project for a kind, if any: later calls must resolve to the same one. */
export function boundTrackerOf(db: Database, bbProjectId: string, kind = ATTENTION_KIND): string | null {
  return db.prepare<[string, string], { tracker_id: string }>("SELECT tracker_id FROM attention_modes WHERE bound_bb_project_id=? AND kind=? AND bound_tracker_id IS NOT NULL").get(bbProjectId, kind)?.tracker_id ?? null;
}

/** A relink is refused while notices are on or switching off, and so is a second link to a bound bb project. */
export function assertLinkChangeAllowed(db: Database, trackerId: string, currentLink: string | null, nextLink: string | null): void {
  if (currentLink === nextLink) return;
  assertChecksLinkChangeAllowed(db, trackerId, currentLink);
  const mine = db.prepare<[string], { found: number }>("SELECT 1 AS found FROM attention_modes WHERE tracker_id=? AND (bound_tracker_id IS NOT NULL OR requested_mode IS NOT NULL) LIMIT 1").get(trackerId);
  if (mine) throw new Error("Stale-status notices are on for this project: turn them off in the project settings before changing the BB project link");
  const other = nextLink ? boundTrackerOf(db, nextLink) : null;
  if (other && other !== trackerId) throw new Error("Another Work Board project sends stale-status notices for that BB project; its link cannot be shared");
}

/** The manager setting of a tracker: a thread id, or null when none is chosen. */
export const configuredManager = (db: Database, trackerId: string): string | null =>
  db.prepare<[string], { manager: string | null }>("SELECT manager FROM attention_manager WHERE tracker_id=?").get(trackerId)?.manager || null;

export interface RequestInput {
  trackerId: string; kind?: string; mode: AttentionMode;
  /** What a request to turn notices on validated: it is written only if the manager and the generation are still these. */
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
    const row = getModeRow(db, tracker.id, kind);
    if (isPending(row)) throw new Error("Notices are switching off; wait for the notice being sent to settle");
    db.prepare<[string, string]>("INSERT OR IGNORE INTO attention_modes(tracker_id, kind) VALUES (?, ?)").run(tracker.id, kind);
    const current: AttentionMode = row.effective_mode === "live" ? "live" : "off";
    if (input.mode === current) throw new Error(`Stale-status notices are already ${current === "live" ? "on" : "off"}`);
    const at = nowIso();
    const generation = row.effective_generation + 1;
    const record = (extra: string, ...values: unknown[]) =>
      db.prepare(`UPDATE attention_modes SET ${extra}, changed_at=?, previous_mode=? WHERE tracker_id=? AND kind=?`).run(...values, at, row.effective_mode, tracker.id, kind);
    if (input.mode === "live") {
      if (!tracker.linked) throw new Error("Link this project to a BB project to turn notices on.");
      if (db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM projects WHERE linked_bb_project_id=?").get(tracker.linked)!.n !== 1)
        throw new Error("Another Work Board project is linked to the same BB project; only one of them can send notices.");
      const holder = boundTrackerOf(db, tracker.linked, kind);
      if (holder && holder !== tracker.id) throw new Error("Another Work Board project already sends notices for that BB project.");
      // The manager was read before this transaction: a change made meanwhile makes that read stale, so nothing is written.
      if (input.guard && (input.guard.generation !== row.effective_generation || input.guard.manager !== configuredManager(db, tracker.id)))
        throw new Error("The manager changed while it was being checked; try again");
      // A fresh observation: whatever was open before the off interval is not trusted, and every card gets its grace again.
      retireOpenOccurrences(db, tracker.id, kind, "observation restarted");
      record("bound_tracker_id=?, bound_bb_project_id=?, effective_mode='live', effective_generation=?, shadow_started_at=NULL", tracker.id, tracker.linked, generation);
      scanTracker(db, tracker.id);
    } else {
      // The fence first: no new claims from here on; the switch completes once the sends in flight settle.
      record("requested_mode='shadow', requested_generation=?, transition_token=?, transition_direction='to_shadow', transition_state='preparing', ready_at=NULL, ready_rev=NULL", generation, newToken());
      completeTransition(db, tracker.id, kind);
    }
    transitionExecutors(db, tracker.id);
    return kindState(db, tracker.id, kind);
  });
  return run();
}

/** Attempts that still hold a switch-off: sends that were claimed or may be on their way. An unknown outcome no longer holds it. */
export function inFlightAttempts(db: Database, trackerId: string, kind: string): { attempt_id: string; outcome: string }[] {
  return db.prepare<[string, string], { attempt_id: string; outcome: string }>(
    "SELECT attempt_id, outcome FROM attention_attempts WHERE tracker_id=? AND kind=? AND outcome IN ('claimed', 'sending')",
  ).all(trackerId, kind);
}

/**
 * Complete a pending switch-off, unless a send is still in flight: the row becomes `off`, its binding is cleared, open occurrences
 * retire, and exactly one `to_shadow` ack row records the switch, which the checks runner reads as its rollback marker. One transaction.
 */
export function completeTransition(db: Database, trackerId: string, kind = ATTENTION_KIND): boolean {
  return db.transaction((): boolean => {
    const row = getModeRow(db, trackerId, kind);
    if (row.transition_direction !== "to_shadow") return false;
    if (row.transition_state === "preparing" && inFlightAttempts(db, trackerId, kind).length) return false;
    invalidateAttentionCache(db);
    const generation = row.requested_generation!;
    retireOpenOccurrences(db, trackerId, kind, "mode off");
    db.prepare<[number, string, string, string, string]>(
      `UPDATE attention_modes SET effective_mode='off', effective_generation=?, requested_mode=NULL, requested_generation=NULL, transition_token=NULL, transition_direction=NULL,
       transition_state=NULL, ready_at=NULL, ready_rev=NULL, bound_tracker_id=NULL, bound_bb_project_id=NULL, shadow_started_at=NULL, changed_at=?, previous_mode=? WHERE tracker_id=? AND kind=?`,
    ).run(generation, nowIso(), row.effective_mode, trackerId, kind);
    const result = { ok: true, generation, direction: "to_shadow", mode: "off", endRev: currentRev(db, trackerId) };
    db.prepare<[string, string, string, number, string]>("INSERT OR IGNORE INTO attention_acks(tracker_id, kind, token, generation, direction, fence_id, ids_hash, result_json) VALUES (?, ?, ?, ?, 'to_shadow', 'work-board', '', ?)")
      .run(trackerId, kind, row.transition_token!, generation, JSON.stringify(result));
    return true;
  })();
}

/**
 * Rows left by the removed Shadow mode, normalized once at startup before any reconciliation or drain. A stored Shadow state never
 * turns delivery on: Shadow, and a pending switch to live, become `off`; a pending switch-off still waiting for its sends stays one,
 * and one that was only waiting for an acknowledgement completes now. Idempotent: with no legacy row it changes nothing.
 */
export function normalizeLegacyModes(db: Database): void {
  db.transaction(() => {
    const rows = db.prepare<[], ModeRow>("SELECT * FROM attention_modes WHERE effective_mode='shadow' OR transition_direction IS NOT NULL").all();
    for (const row of rows) {
      if (row.transition_direction === "to_shadow") {
        if (row.transition_state === "ready") completeTransition(db, row.tracker_id, row.kind);
        continue;
      }
      invalidateAttentionCache(db);
      retireOpenOccurrences(db, row.tracker_id, row.kind, "shadow mode removed");
      db.prepare<[number, string, string, string]>(
        `UPDATE attention_modes SET effective_mode='off', effective_generation=?, requested_mode=NULL, requested_generation=NULL, transition_token=NULL, transition_direction=NULL,
         transition_state=NULL, ready_at=NULL, ready_rev=NULL, bound_tracker_id=NULL, bound_bb_project_id=NULL, shadow_started_at=NULL, changed_at=?, previous_mode='shadow' WHERE tracker_id=? AND kind=?`,
      ).run(row.effective_generation + 1, nowIso(), row.tracker_id, row.kind);
    }
  })();
}
