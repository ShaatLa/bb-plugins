import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import type { tasksRpcContract } from "../shared/contract";
import { LOCK_HISTORY_LIMIT, type Lock, type LockEvent } from "../shared/locks";
import { assertNoSecrets } from "../shared/secret-guard";

interface LockRow {
  name: string;
  holder_thread_id: string | null;
  task_key: string | null;
  reason: string;
  acquired_at: string;
  expires_at: string | null;
}

interface EventRow {
  kind: LockEvent["kind"];
  thread_id: string | null;
  previous_thread_id: string | null;
  task_key: string | null;
  reason: string;
  forced: number;
  at: string;
}

type ThreadFault = Exclude<NonNullable<Lock["stale"]>, "expired">;
interface HolderProbe {
  title: string | null;
  fault: ThreadFault | null;
}

const UNKNOWN: HolderProbe = { title: null, fault: null };

function holderLabel(lock: Lock): string {
  return lock.holderThreadId
    ? `${lock.holderTitle ?? "thread"} (${lock.holderThreadId})`
    : "person";
}

function heldMessage(lock: Lock): string {
  return `lock ${lock.name} is held by ${holderLabel(lock)}: ${lock.reason} (since ${lock.acquiredAt}${lock.stale ? `, STALE: ${lock.stale}` : ""})`;
}

export function createLockHandlers(
  bb: BbPluginApi,
  store: TasksApiStore,
): Pick<
  PluginRpcHandlers<typeof tasksRpcContract>,
  "listLocks" | "lockHistory" | "acquireLock" | "releaseLock"
> {
  const db = bb.storage.database();
  const readRow = db.prepare<[string, string], LockRow>(
    "SELECT name, holder_thread_id, task_key, reason, acquired_at, expires_at FROM resource_locks WHERE project_id = ? AND name = ?",
  );

  // A read error leaves the holder unknown instead of stale; only a definitive
  // "not found" counts as deleted.
  async function probe(threadId: string | null): Promise<HolderProbe> {
    if (!threadId) return UNKNOWN;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return {
        title: thread.title,
        fault:
          thread.deletedAt != null
            ? "thread_deleted"
            : thread.archivedAt != null
              ? "thread_archived"
              : thread.status === "error"
                ? "thread_failed"
                : null,
      };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      return code === "thread_not_found"
        ? { title: null, fault: "thread_deleted" }
        : UNKNOWN;
    }
  }

  const staleOf = (
    row: LockRow,
    holder: HolderProbe,
    now: string,
  ): Lock["stale"] =>
    row.expires_at !== null && row.expires_at <= now ? "expired" : holder.fault;

  const toLock = (row: LockRow, holder: HolderProbe): Lock => ({
    name: row.name,
    holderThreadId: row.holder_thread_id,
    holderTitle: holder.title,
    taskKey: row.task_key,
    reason: row.reason,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    stale: staleOf(row, holder, new Date().toISOString()),
  });

  const requireProject = (projectId: string) => {
    if (!store.tasks.getProject(projectId)) {
      throw new Error(`Project not found: ${projectId}`);
    }
  };

  const recordEvent = (
    projectId: string,
    name: string,
    event: Omit<LockEvent, "at"> & { at: string },
  ) => {
    db.prepare(
      `INSERT INTO resource_lock_events
         (project_id, name, kind, thread_id, previous_thread_id, task_key, reason, forced, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      name,
      event.kind,
      event.threadId,
      event.previousThreadId,
      event.taskKey,
      event.reason,
      event.forced ? 1 : 0,
      event.at,
    );
    db.prepare(
      `DELETE FROM resource_lock_events WHERE project_id = ? AND name = ? AND id NOT IN (
         SELECT id FROM resource_lock_events WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT ?)`,
    ).run(projectId, name, projectId, name, LOCK_HISTORY_LIMIT);
  };

  const changed = (projectId: string) =>
    bb.realtime.publish("locks:changed", { projectId });

  return {
    async listLocks({ projectId }) {
      requireProject(projectId);
      const rows = db
        .prepare<[string], LockRow>(
          "SELECT name, holder_thread_id, task_key, reason, acquired_at, expires_at FROM resource_locks WHERE project_id = ? ORDER BY name",
        )
        .all(projectId);
      const probes = new Map(
        await Promise.all(
          [...new Set(rows.map((row) => row.holder_thread_id))].map(
            async (id) => [id, await probe(id)] as const,
          ),
        ),
      );
      return {
        locks: rows.map((row) => toLock(row, probes.get(row.holder_thread_id)!)),
      };
    },

    lockHistory({ projectId, name }) {
      requireProject(projectId);
      const rows = db
        .prepare<[string, string, number], EventRow>(
          `SELECT kind, thread_id, previous_thread_id, task_key, reason, forced, at
           FROM resource_lock_events WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(projectId, name, LOCK_HISTORY_LIMIT);
      return {
        events: rows.map((row) => ({
          kind: row.kind,
          threadId: row.thread_id,
          previousThreadId: row.previous_thread_id,
          taskKey: row.task_key,
          reason: row.reason,
          forced: row.forced === 1,
          at: row.at,
        })),
      };
    },

    async acquireLock(input) {
      assertNoSecrets(input.reason, "lock reason");
      requireProject(input.projectId);
      const { projectId, name, threadId } = input;
      // Thread state needs an async SDK call, so it is read before the
      // transaction and only trusted for the same holder inside it.
      const seen = readRow.get(projectId, name);
      const seenProbe = seen ? await probe(seen.holder_thread_id) : UNKNOWN;

      const outcome = db.transaction((): { held: LockRow } | { acquired: LockRow } => {
        const now = new Date();
        const at = now.toISOString();
        const current = readRow.get(projectId, name);
        const refresh = current?.holder_thread_id === threadId;
        let kind: "acquired" | "taken_over" = "acquired";
        if (current && !refresh) {
          const stale = staleOf(
            current,
            current.holder_thread_id === seen?.holder_thread_id
              ? seenProbe
              : UNKNOWN,
            at,
          );
          if (!stale || !input.takeover) return { held: current };
          kind = "taken_over";
          if (stale === "expired") {
            recordEvent(projectId, name, {
              kind: "expired",
              threadId: null,
              previousThreadId: current.holder_thread_id,
              taskKey: current.task_key,
              reason: current.reason,
              forced: false,
              at: current.expires_at!,
            });
          }
        }
        const row: LockRow = {
          name,
          holder_thread_id: threadId,
          task_key: input.taskKey ?? null,
          reason: input.reason,
          acquired_at: refresh ? current!.acquired_at : at,
          expires_at: input.ttlMinutes
            ? new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString()
            : null,
        };
        db.prepare(
          `INSERT OR REPLACE INTO resource_locks
             (project_id, name, holder_thread_id, task_key, reason, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          projectId,
          name,
          row.holder_thread_id,
          row.task_key,
          row.reason,
          row.acquired_at,
          row.expires_at,
        );
        if (!refresh) {
          recordEvent(projectId, name, {
            kind,
            threadId,
            previousThreadId: current?.holder_thread_id ?? null,
            taskKey: row.task_key,
            reason: row.reason,
            forced: false,
            at,
          });
        }
        return { acquired: row };
      })();

      if ("held" in outcome) {
        const lock = toLock(
          outcome.held,
          outcome.held.holder_thread_id === seen?.holder_thread_id
            ? seenProbe
            : await probe(outcome.held.holder_thread_id),
        );
        return {
          ok: false as const,
          error: { code: "held" as const, message: heldMessage(lock) },
          lock,
        };
      }
      changed(projectId);
      return {
        ok: true as const,
        lock: toLock(outcome.acquired, await probe(threadId)),
      };
    },

    async releaseLock(input) {
      assertNoSecrets(input.reason, "lock release reason");
      requireProject(input.projectId);
      const { projectId, name, threadId } = input;
      const outcome = db.transaction(() => {
        const current = readRow.get(projectId, name);
        if (!current) return { free: true as const };
        if (!input.force && current.holder_thread_id !== threadId) {
          return { current, released: false as const };
        }
        db.prepare(
          "DELETE FROM resource_locks WHERE project_id = ? AND name = ?",
        ).run(projectId, name);
        recordEvent(projectId, name, {
          kind: "released",
          threadId,
          previousThreadId: current.holder_thread_id,
          taskKey: current.task_key,
          reason: input.reason ?? current.reason,
          forced: input.force,
          at: new Date().toISOString(),
        });
        return { current, released: true as const };
      })();

      if ("free" in outcome) {
        return {
          ok: false as const,
          error: { code: "not_held" as const, message: `lock ${name} is not held` },
          lock: null,
        };
      }
      if (outcome.released) {
        changed(projectId);
        return { ok: true as const, lock: null };
      }
      const lock = toLock(
        outcome.current,
        await probe(outcome.current.holder_thread_id),
      );
      return {
        ok: false as const,
        error: {
          code: "not_holder" as const,
          message: `${heldMessage(lock)}; only the holder can release it (use --force with a reason)`,
        },
        lock,
      };
    },
  };
}
