import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { notifyThread } from "../steer";
import { taskMarkdownLink } from "../shared/task-link";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** A notice is tried at most this many times; only a definite failure is tried again. */
export const QUEUE_NOTICE_ATTEMPTS = 3;

interface NoticeRow { id: string; thread_id: string; to_task: string; from_key: string; reason: string }

/** A row still `sending` at startup lost its outcome: it is `unknown` and never sent again. */
export function recoverQueueNotices(db: Database): number {
  return db.prepare("UPDATE task_queue_notices SET state='unknown' WHERE state='sending'").run().changes;
}

function claim(db: Database, skip: ReadonlySet<string>): NoticeRow | undefined {
  return db.transaction(() => {
    const row = db.prepare<[number], NoticeRow>("SELECT id, thread_id, to_task, from_key, reason FROM task_queue_notices WHERE state IN ('pending','failed') AND attempts<? ORDER BY created_at, rowid").all(QUEUE_NOTICE_ATTEMPTS).find((candidate) => !skip.has(candidate.id));
    if (!row) return undefined;
    db.prepare<[string]>("UPDATE task_queue_notices SET state='sending', attempts=attempts+1 WHERE id=?").run(row.id);
    return row;
  })();
}

export function queueNoticeText(db: Database, row: Pick<NoticeRow, "to_task" | "from_key" | "reason">): string | null {
  const next = db.prepare<[string], { key: string; title: string }>("SELECT p.prefix || '-' || t.number AS key, t.title FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?").get(row.to_task);
  if (!next) return null;
  return `${row.from_key} left work (${row.reason}). Next in your queue: ${next.key} · ${next.title} (${taskMarkdownLink(next.key)}). Nothing was started or moved.`;
}

const draining = new WeakMap<BbPluginApi, Promise<void>>();

/**
 * Sends each pending notice once: claimed first, then sent, then recorded. A definite failure is tried again on a later
 * drain up to the cap; a crash between the send and the record leaves the row `unknown`, which is never sent again.
 */
export function drainQueueNotices(bb: BbPluginApi): Promise<void> {
  const running = draining.get(bb);
  if (running) return running;
  // Deferred, so the map holds `run` before the body can reach its `finally` (with no rows it never awaits).
  const run = Promise.resolve().then(async () => {
    const db = bb.storage.database();
    const tried = new Set<string>();
    try {
      for (let row = claim(db, tried); row; row = claim(db, tried)) {
        tried.add(row.id);
        let sent = false;
        try {
          const text = queueNoticeText(db, row);
          if (text === null) throw new Error("the next card no longer exists");
          await notifyThread(bb, row.thread_id, text);
          sent = true;
        } catch (error) {
          db.prepare<[string]>("UPDATE task_queue_notices SET state='failed' WHERE id=?").run(row.id);
          bb.log.warn(`next-card notice ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (sent) db.prepare<[string]>("UPDATE task_queue_notices SET state='sent' WHERE id=?").run(row.id);
      }
    } finally {
      draining.delete(bb);
    }
  });
  draining.set(bb, run);
  return run;
}
