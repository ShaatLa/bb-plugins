import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readDraft } from "./config";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * Runs in progress, by linked bb project id: the single-flight lock of the runner. It is process-local on purpose (Work Board runs
 * as one plugin instance per bb server) and also answers "is this tracker draining" for the link and reset guards.
 */
export const runs = new Map<string, string>();

/** The bb projects any state of this tracker (status, committed snapshot, staged report) was recorded for. */
export function stateProjects(db: Database, trackerId: string): string[] {
  const state = db.prepare<[string], { value: string }>("SELECT value FROM checks_state WHERE tracker_id=?").get(trackerId);
  const delivery = db.prepare<[string], { committed_project: string | null; pending_project: string | null }>("SELECT committed_project, pending_project FROM checks_delivery WHERE tracker_id=?").get(trackerId);
  const recorded = (JSON.parse(state?.value ?? "{}") as { bbProjectId?: string }).bbProjectId;
  return [...new Set([recorded, delivery?.committed_project, delivery?.pending_project].filter((id): id is string => !!id))];
}

/** The bb project another project's state belongs to, when it is not `link`; null when the state fits or there is none. */
export const stateMismatch = (db: Database, trackerId: string, link: string): string | null => stateProjects(db, trackerId).find((id) => id !== link) ?? null;

/**
 * Draining: a run in progress, or a staged report (which carries any unresolved attempt) for the linked project, even when the
 * runner is disabled. A report staged for another bb project is stale state to reset, not work to finish.
 */
export function isDraining(db: Database, trackerId: string, link: string | null): boolean {
  if ([...runs.values()].includes(trackerId)) return true;
  if (!link) return false;
  return db.prepare<[string, string], { found: number }>("SELECT 1 AS found FROM checks_delivery WHERE tracker_id=? AND report_id IS NOT NULL AND pending_project=?").get(trackerId, link) !== undefined;
}

/** A tracker owns the runner of its linked bb project while it is enabled or draining. */
export function owners(db: Database, link: string): string[] {
  return db.prepare<[string], { id: string }>("SELECT id FROM projects WHERE linked_bb_project_id=?").all(link).map((row) => row.id)
    .filter((id) => readDraft(db, id).enabled || isDraining(db, id, link));
}

/** Another tracker linked to the same bb project may neither enable nor run; the script itself may send messages. */
export function assertNoOtherOwner(db: Database, trackerId: string, link: string): void {
  const other = owners(db, link).find((id) => id !== trackerId);
  if (!other) return;
  const prefix = db.prepare<[string], { prefix: string }>("SELECT prefix FROM projects WHERE id=?").get(other)?.prefix ?? other;
  throw new Error(`Repository checks of this bb project belong to tracker ${prefix} while it is enabled or still delivering a report. Disable it and let it drain first.`);
}

/** The bb project link of a tracker is frozen while its runner is enabled or draining, so lock keys and an undelivered report never move. */
export function assertChecksLinkChangeAllowed(db: Database, trackerId: string, currentLink: string | null): void {
  if (readDraft(db, trackerId).enabled || isDraining(db, trackerId, currentLink)) {
    throw new Error("Repository checks are enabled or still delivering a report for this project: disable them and let the report drain, or reset the checks state, before changing the BB project link");
  }
}

/** Deleting a tracker cascades through its staged report, candidate and attempts, so it waits until the runner is off and drained. */
export function assertChecksDeleteAllowed(db: Database, trackerId: string): void {
  const link = db.prepare<[string], { link: string | null }>("SELECT linked_bb_project_id AS link FROM projects WHERE id=?").get(trackerId)?.link ?? null;
  if (readDraft(db, trackerId).enabled || isDraining(db, trackerId, link)) {
    throw new Error("Repository checks are enabled or still delivering a report for this project: disable them and let the report drain before deleting it");
  }
}
