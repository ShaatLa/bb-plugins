import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { publishProjectsChanged } from "../api";
import { managerProblemText, type ManagerLookup } from "../shared/attention";
import type { tasksRpcContract } from "../shared/contract";
import { getModeRow, kindState } from "./modes";
import { attentionService } from "./service";

interface AttemptRow { attempt_id: string; tracker_id: string; recipient_thread_id: string; started_at: string; error: string | null }

/** Starts the attention service: its listeners, receipt recovery, scheduled reconciliation and the initial drain. */
export function registerAttention(bb: BbPluginApi): void {
  attentionService(bb).register();
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
      const state = kindState(db, projectId);
      return {
        trackerId: projectId, linkedBbProjectId: project.linkedBbProjectId ?? null, state, changedAt: row.changed_at, previousMode: row.previous_mode,
        manager: manager?.manager ?? null, managerChangedAt: manager?.changed_at ?? null, managerPrevious: manager?.previous ?? null,
        managerLookup: lookup.status === "usable" ? { status: "usable" as const } : lookup.status === "unusable" ? { status: "unusable" as const, cause: lookup.cause, detectedAt: lookup.detectedAt } : { status: "unavailable" as const },
        managerWarning: managerProblemText(lookup, state.effective.mode),
        unresolvedAttempts: db.prepare<[string], AttemptRow>("SELECT * FROM attention_attempts WHERE tracker_id=? AND outcome='unknown' AND disposition IS NULL ORDER BY started_at").all(projectId).map((attempt) => ({
          attemptId: attempt.attempt_id,
          occurrenceIds: db.prepare<[string], { occurrence_id: string }>("SELECT occurrence_id FROM attention_attempt_items WHERE attempt_id=? ORDER BY occurrence_id").all(attempt.attempt_id).map((item) => item.occurrence_id),
          recipientThreadId: attempt.recipient_thread_id, startedAt: attempt.started_at, error: attempt.error, canRetry: service.canRetry(attempt),
        })),
      };
    },
    async updateAttentionMode({ projectId, mode }) {
      requireTracker(projectId);
      if (mode === "shadow") throw new Error("Shadow mode was removed: stale-status notices are either on (live) or off.");
      const state = await service.setMode({ trackerId: projectId, mode });
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
