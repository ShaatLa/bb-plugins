import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HistoryCursor } from "../steer";
import type { ReportChanges } from "./reports";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export interface Receipt { mode: "inline" | "queued" | "appended"; id: string }
interface Baseline { fingerprint: string; manager?: string }

/** The status of one tracker's runner. JSON in one row; every writer runs under the tracker's single-flight tick. */
export interface State {
  /** The bb project this state was recorded for; a relink never applies it to another. */
  bbProjectId?: string;
  tickId?: string;
  lastRun?: number;
  nextRun?: number;
  exitCode?: number | null;
  /** The most recent execution failure: a refresh or the script. A delivery that cannot complete is `deliveryError`, kept apart. */
  failureStage?: "refresh" | "script" | null;
  error?: string | null;
  /** Why the staged report is not delivered yet; cleared by the acceptance that resolves it. */
  deliveryError?: string | null;
  refreshFailures?: number;
  refreshRetryAt?: number;
  lastFailure?: Baseline;
  lastReport?: Baseline & { at: number; changes?: ReportChanges };
  deliveredAt?: number;
  deliveredTickId?: string;
  deliveredReportId?: string;
  /** The actual destination of the last accepted report. */
  deliveredTo?: string;
  receipt?: Receipt;
  /** Why the last delivery attempt failed; stored apart from the push failure. */
  managerError?: string | null;
  pushError?: string | null;
  /** Archived-worktree paths already delivered; a path leaves only after a complete scan finds it gone. */
  reportedWorktrees?: string[];
  /** Paths of the staged report; they become reported only when its delivery is accepted. */
  pendingWorktrees?: string[];
  /** The last path the scan tried to measure; the next scan resumes after it. */
  lastMeasuredWorktree?: string;
}

export interface DeliveryRow {
  tracker_id: string;
  committed: Buffer | null;
  committed_project: string | null;
  report_id: string | null;
  pending_project: string | null;
  pending_exit: number | null;
  pending_tick: string | null;
  pending_body: string | null;
  pending_snapshot: Buffer | null;
  pending_at: string | null;
}

export type AttemptOutcome = "sending" | "appended" | "queued" | "inline" | "failed" | "unknown" | "superseded";
export interface AttemptRow {
  attempt_id: string;
  tracker_id: string;
  report_id: string;
  tick_id: string;
  bb_project_id: string;
  manager_thread_id: string;
  marker: string;
  started_at: string;
  transport_started_at: string | null;
  pending_since: string | null;
  outcome: AttemptOutcome;
  queued_message_id: string | null;
  inline_event_ref: string | null;
  accepted_at: string | null;
  error: string | null;
  recovery_cursor: string | null;
}

export type { HistoryCursor };

export function checksStore(db: Database) {
  const readState = db.prepare<[string], { value: string }>("SELECT value FROM checks_state WHERE tracker_id = ?");
  const readDelivery = db.prepare<[string], DeliveryRow>("SELECT * FROM checks_delivery WHERE tracker_id = ?");
  return {
    state: (trackerId: string): State => JSON.parse(readState.get(trackerId)?.value ?? "{}"),
    save: (trackerId: string, value: State) => db.prepare("INSERT INTO checks_state VALUES (?, ?) ON CONFLICT(tracker_id) DO UPDATE SET value = excluded.value").run(trackerId, JSON.stringify(value)),
    delivery: (trackerId: string) => readDelivery.get(trackerId),
    /** Stages the full raw report, its tick and the candidate in one statement; a pending report is never overwritten. */
    stage(trackerId: string, report: { reportId: string; project: string; exit: number; tick: string; body: string; snapshot: Buffer | null }) {
      const result = db.prepare(`INSERT INTO checks_delivery (tracker_id, report_id, pending_project, pending_exit, pending_tick, pending_body, pending_snapshot, pending_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tracker_id) DO UPDATE SET report_id = excluded.report_id, pending_project = excluded.pending_project, pending_exit = excluded.pending_exit,
          pending_tick = excluded.pending_tick, pending_body = excluded.pending_body, pending_snapshot = excluded.pending_snapshot, pending_at = excluded.pending_at
        WHERE checks_delivery.report_id IS NULL`).run(trackerId, report.reportId, report.project, report.exit, report.tick, report.body, report.snapshot, new Date().toISOString());
      if (!result.changes) throw new Error("A report is already pending");
    },
    /** Durable delivery: the candidate becomes the committed snapshot and the pending report clears, guarded by its report id. */
    promote(trackerId: string, reportId: string): boolean {
      return db.prepare(`UPDATE checks_delivery SET committed = COALESCE(pending_snapshot, committed),
        committed_project = CASE WHEN pending_snapshot IS NOT NULL THEN pending_project ELSE committed_project END,
        report_id = NULL, pending_project = NULL, pending_exit = NULL, pending_tick = NULL, pending_body = NULL, pending_snapshot = NULL, pending_at = NULL
        WHERE tracker_id = ? AND report_id = ?`).run(trackerId, reportId).changes > 0;
    },
    attempts(trackerId: string, reportId: string, outcomes?: AttemptOutcome[]): AttemptRow[] {
      const rows = db.prepare<[string, string], AttemptRow>("SELECT * FROM checks_attempts WHERE tracker_id = ? AND report_id = ? ORDER BY started_at, rowid").all(trackerId, reportId);
      return outcomes ? rows.filter((row) => outcomes.includes(row.outcome)) : rows;
    },
    attempt: (attemptId: string) => db.prepare<[string], AttemptRow>("SELECT * FROM checks_attempts WHERE attempt_id = ?").get(attemptId),
    /** Persisted before any transport call. */
    openAttempt(row: Pick<AttemptRow, "attempt_id" | "tracker_id" | "report_id" | "tick_id" | "bb_project_id" | "manager_thread_id" | "marker">) {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO checks_attempts (attempt_id, tracker_id, report_id, tick_id, bb_project_id, manager_thread_id, marker, started_at, transport_started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending')")
        .run(row.attempt_id, row.tracker_id, row.report_id, row.tick_id, row.bb_project_id, row.manager_thread_id, row.marker, now, now);
    },
    /** Moves an attempt only forward from one of `from`; returns whether it moved. */
    advance(attemptId: string, from: AttemptOutcome[], assignments: string, ...values: unknown[]): boolean {
      const marks = from.map(() => "?").join(", ");
      return db.prepare(`UPDATE checks_attempts SET ${assignments} WHERE attempt_id = ? AND outcome IN (${marks})`).run(...values, attemptId, ...from).changes > 0;
    },
    /** Every other open attempt of the report is closed: the report is delivered. */
    supersedeOpen(trackerId: string, reportId: string, exceptAttemptId: string) {
      db.prepare("UPDATE checks_attempts SET outcome = 'superseded' WHERE tracker_id = ? AND report_id = ? AND attempt_id <> ? AND outcome IN ('sending', 'unknown')").run(trackerId, reportId, exceptAttemptId);
    },
    /** Drops the stored state of a tracker: used by the owner's reset. */
    reset(trackerId: string) {
      db.transaction(() => {
        for (const table of ["checks_state", "checks_delivery", "checks_attempts"]) db.prepare(`DELETE FROM ${table} WHERE tracker_id = ?`).run(trackerId);
      })();
    },
  };
}
