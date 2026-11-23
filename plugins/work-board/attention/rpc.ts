import type { BbPluginApi, ExperimentalPluginRpcHandlersWithContext, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { publishProjectsChanged } from "../api";
import { attentionRpcContract, managerProblemText, SWEEP_PLUGIN_ID, type ManagerLookup } from "../shared/attention";
import type { tasksRpcContract } from "../shared/contract";
import { CURRENT_KEY_SQL, currentRev } from "./ledger";
import { ackTransition, boundTrackerOf, getModeRow, kindState, SHADOW_GATE_MS } from "./modes";
import { ATTENTION_KIND } from "./observe";
import { fenceMessage, readOwner } from "../checks/transfer";
import { attentionService } from "./service";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type Handlers = ExperimentalPluginRpcHandlersWithContext<typeof attentionRpcContract>;
type Refusal = { ok: false; code: string; [key: string]: unknown };

interface AttemptRow {
  attempt_id: string; batch_id: string; recipient_thread_id: string; recipient_source: "manager" | "sweep_fallback" | "parent"; started_at: string;
  outcome: "claimed" | "sending" | "appended" | "queued" | "inline" | "failed" | "unknown"; queued_message_id: string | null; inline_event_ref: string | null; accepted_at: string | null;
  disposition: "waived_loss" | "retry" | null; disposition_at: string | null; error: string | null; rev: number;
}

const attemptWire = (db: Database, row: AttemptRow) => ({
  attemptId: row.attempt_id, batchId: row.batch_id,
  occurrenceIds: db.prepare<[string], { occurrence_id: string }>("SELECT occurrence_id FROM attention_attempt_items WHERE attempt_id=? ORDER BY occurrence_id").all(row.attempt_id).map((item) => item.occurrence_id),
  recipientThreadId: row.recipient_thread_id, recipientSource: row.recipient_source, startedAt: row.started_at, outcome: row.outcome,
  queuedMessageId: row.queued_message_id, inlineEventRef: row.inline_event_ref, acceptedAt: row.accepted_at, disposition: row.disposition, dispositionAt: row.disposition_at, error: row.error, rev: row.rev,
});

export function registerAttention(bb: BbPluginApi, store: TasksApiStore): void {
  const db = bb.storage.database();
  const service = attentionService(bb);
  service.register();

  /** Resolve a bb project to its single tracker, then require it to be the one the mode is bound to. */
  function resolve(projectId: string, kind = ATTENTION_KIND): { ok: true; trackerId: string } | Refusal {
    if (kind !== ATTENTION_KIND) return { ok: false, code: "unknown_kind" };
    const trackers = store.tasks.listProjects().filter((project) => project.linkedBbProjectId === projectId);
    if (trackers.length === 0) return { ok: false, code: "not_linked" };
    if (trackers.length > 1) return { ok: false, code: "ambiguous_link", trackers: trackers.map((tracker) => ({ id: tracker.id, name: tracker.name, prefix: tracker.prefix })) };
    const bound = boundTrackerOf(db, projectId, kind);
    if (bound && bound !== trackers[0]!.id) return { ok: false, code: "binding_changed", boundTrackerId: bound };
    return { ok: true, trackerId: trackers[0]!.id };
  }

  const handlers: Handlers = {
    "attention.modes"({ projectId }) {
      const found = resolve(projectId);
      if (!found.ok) return found;
      return { projectId, trackerId: found.trackerId, kinds: { [ATTENTION_KIND]: kindState(db, found.trackerId) } };
    },
    "attention.ack"(input, context) {
      // The host verifies a plugin caller with a per-load token; the app, the CLI and agents all arrive as `client`.
      if (context.experimental_caller.kind !== "plugin" || context.experimental_caller.pluginId !== SWEEP_PLUGIN_ID) return { ok: false, code: "forbidden" };
      const found = resolve(input.projectId, input.kind);
      if (!found.ok) return found;
      if (input.trackerId !== found.trackerId) return { ok: false, code: "binding_changed", boundTrackerId: found.trackerId };
      const result = ackTransition(db, { trackerId: found.trackerId, kind: input.kind, token: input.token, generation: input.generation, direction: input.direction, fenceId: input.fenceId, acceptedOccurrenceIds: input.acceptedOccurrenceIds });
      if (result.ok) { publishProjectsChanged(bb, found.trackerId); service.scheduleDrain(); }
      return result;
    },
    "attention.ledger"({ projectId, kind, sinceRev = 0, limit = 200 }) {
      const found = resolve(projectId, kind);
      if (!found.ok) return found;
      const trackerId = found.trackerId;
      const occurrences = db.prepare<[string, string, number, number], Record<string, string | number | null>>(
        `SELECT o.*, ${CURRENT_KEY_SQL} AS current_key FROM manager_attention o WHERE o.tracker_id=? AND o.kind=? AND o.rev>? ORDER BY o.rev LIMIT ?`,
      ).all(trackerId, kind, sinceRev, limit);
      const attempts = db.prepare<[string, string, number, number], AttemptRow>("SELECT * FROM attention_attempts WHERE tracker_id=? AND kind=? AND rev>? ORDER BY rev LIMIT ?").all(trackerId, kind, sinceRev, limit);
      const observations = db.prepare<[string, string, number, number], { at: string; task_id: string; signal: string; validity: "valid" | "unknown"; rev: number }>("SELECT at, task_id, signal, validity, rev FROM attention_observations WHERE tracker_id=? AND kind=? AND rev>? ORDER BY rev LIMIT ?").all(trackerId, kind, sinceRev, limit);
      // One revision counter spans the three lists, so the first `limit` changes by revision are an exact page.
      const taken = [...occurrences.map((row) => ({ t: "o" as const, rev: row.rev as number, row })), ...attempts.map((row) => ({ t: "a" as const, rev: row.rev, row })), ...observations.map((row) => ({ t: "b" as const, rev: row.rev, row }))].sort((a, b) => a.rev - b.rev).slice(0, limit);
      return {
        occurrences: taken.filter((entry) => entry.t === "o").map(({ row }) => ({
          occurrenceId: row.id as string, taskId: row.task_id as string, taskKey: row.current_key as string, signal: row.signal as string, firstSeenAt: row.first_seen_at as string, eligibleAt: row.eligible_at as string,
          clearedAt: row.cleared_at as string | null, retiredReason: row.retired_reason as string | null, sweepBaselinedGeneration: row.sweep_baselined_generation as number | null, createdRev: row.created_rev as number, rev: row.rev as number,
        })),
        attempts: taken.filter((entry) => entry.t === "a").map(({ row }) => attemptWire(db, row as AttemptRow)),
        observations: taken.filter((entry) => entry.t === "b").map(({ row }) => { const o = row as (typeof observations)[number]; return { at: o.at, taskId: o.task_id, signal: o.signal, validity: o.validity, rev: o.rev }; }),
        nextRev: taken.length < limit ? currentRev(db, trackerId) : taken.at(-1)!.rev,
      };
    },
    "attention.resolveKeys"({ projectId, keys }) {
      const found = resolve(projectId);
      if (!found.ok) return found;
      const resolved: Record<string, string> = {};
      const unknown: string[] = [];
      for (const key of new Set(keys)) {
        const task = store.tasks.getTaskByKey(key);
        if (task && task.projectId === found.trackerId) resolved[key] = task.id;
        else unknown.push(key);
      }
      return { resolved, unknown };
    },
  };
  bb.rpc.register(attentionRpcContract, handlers);
}

/** The owner's settings calls, served on the app's tasks contract. */
export function attentionUiHandlers(bb: BbPluginApi, store: TasksApiStore): Pick<PluginRpcHandlers<typeof tasksRpcContract>, "getAttentionSettings" | "updateAttentionMode" | "updateAttentionManager" | "resolveAttentionAttempt"> {
  const db = bb.storage.database();
  const service = attentionService(bb);
  const requireTracker = (projectId: string) => {
    const project = store.tasks.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  };
  return {
    async getAttentionSettings({ projectId }) {
      const project = requireTracker(projectId);
      const managerRow = () => db.prepare<[string], { manager: string | null; changed_at: string | null; previous: string | null }>("SELECT manager, changed_at, previous FROM attention_manager WHERE tracker_id=?").get(projectId);
      const read = async () => { const id = managerRow()?.manager || null; return { id, lookup: await service.lookupManager(id) }; };
      // Everything after the lookup is read in one synchronous snapshot, so the mode and the warning cannot disagree. If the
      // manager changed while it was read, the read is made once more; a second change reports it as unverified for now.
      let result = await read();
      if ((managerRow()?.manager || null) !== result.id) result = await read();
      const manager = managerRow();
      // A second change leaves the read for another manager: an empty setting is "none", anything else is unverified for now.
      const lookup: ManagerLookup = (manager?.manager || null) === result.id ? result.lookup
        : !manager?.manager ? { status: "unusable", cause: "none", detectedAt: new Date().toISOString() } : { status: "unavailable", error: "The manager changed while it was read" };
      const row = getModeRow(db, projectId);
      const started = row.shadow_started_at ? Date.parse(row.shadow_started_at) : null;
      const runner = project.linkedBbProjectId ? readOwner(db, project.linkedBbProjectId) : undefined;
      return {
        trackerId: projectId, linkedBbProjectId: project.linkedBbProjectId ?? null, state: kindState(db, projectId), changedAt: row.changed_at, previousMode: row.previous_mode, shadowStartedAt: row.shadow_started_at,
        gateRemainingMs: row.effective_mode === "shadow" && started !== null ? Math.max(0, Math.round(SHADOW_GATE_MS - (Date.now() - started))) : SHADOW_GATE_MS,
        workBoardRunsChecks: runner?.owner === "work-board" && runner.tracker_id === projectId,
        checksFence: fenceMessage(db, projectId, project.linkedBbProjectId ?? null),
        manager: manager?.manager ?? null, managerChangedAt: manager?.changed_at ?? null, managerPrevious: manager?.previous ?? null,
        managerLookup: lookup.status === "usable" ? { status: "usable" as const } : lookup.status === "unusable" ? { status: "unusable" as const, cause: lookup.cause, detectedAt: lookup.detectedAt } : { status: "unavailable" as const },
        managerWarning: managerProblemText(lookup, row.effective_mode),
        unresolvedAttempts: db.prepare<[string], AttemptRow>("SELECT * FROM attention_attempts WHERE tracker_id=? AND outcome='unknown' AND disposition IS NULL ORDER BY started_at").all(projectId).map((row) => attemptWire(db, row)),
      };
    },
    async updateAttentionMode({ projectId, mode, parityReviewed }) {
      requireTracker(projectId);
      const state = await service.setMode({ trackerId: projectId, mode, parityReviewed });
      publishProjectsChanged(bb, projectId);
      return state;
    },
    updateAttentionManager({ projectId, manager }) {
      requireTracker(projectId);
      const before = db.prepare<[string], { manager: string | null }>("SELECT manager FROM attention_manager WHERE tracker_id=?").get(projectId)?.manager ?? null;
      db.prepare<[string, string | null, string, string | null]>(
        "INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?, ?, ?, ?) ON CONFLICT(tracker_id) DO UPDATE SET manager=excluded.manager, changed_at=excluded.changed_at, previous=excluded.previous",
      ).run(projectId, manager, new Date().toISOString(), before);
      // The platform cannot tell the app from another caller, so a change is only made visible: a log entry.
      bb.log.info(`attention manager for ${projectId}: ${before ?? "none"} → ${manager ?? "none"}`);
      service.invalidateLookups();
      publishProjectsChanged(bb, projectId);
      return { manager };
    },
    async resolveAttentionAttempt({ attemptId, disposition }) {
      await service.resolveAttempt(attemptId, disposition);
      return { ok: true as const };
    },
  };
}
