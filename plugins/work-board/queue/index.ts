import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { publishTasksChanged } from "../api";
import { drainQueueNotices, recoverQueueNotices } from "./notices";
import { dropThreadQueues, onNoticeQueued } from "./store";
import { sampleQueueTrial } from "./trial";

/** Starts the queue's delivery and trial scans; the queue itself is written by the store and the queue calls. */
export function registerQueue(bb: BbPluginApi, _store: TasksApiStore): void {
  const db = bb.storage.database();
  const drain = () => { void drainQueueNotices(bb).catch((error: unknown) => bb.log.warn(`next-card notices failed: ${String(error)}`)); };
  const interrupted = recoverQueueNotices(db);
  if (interrupted) bb.log.warn(`${interrupted} next-card notice(s) were interrupted by a restart; their delivery is unknown and they are not resent`);
  bb.onDispose(onNoticeQueued(drain));
  drain();
  bb.background.schedule("queue-scan", "*/10 * * * *", () => {
    try { sampleQueueTrial(db); } catch (error) { bb.log.warn(`queue trial sample failed: ${String(error)}`); }
    return drainQueueNotices(bb);
  });
  // An executor thread that is archived or deleted leaves nobody to work its queue: the cards leave it.
  for (const type of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(type, ({ thread }) => {
      const cards = db.prepare<[string], { task_id: string; project_id: string }>("SELECT task_id, project_id FROM task_queue WHERE thread_id=?").all(thread.id);
      if (!cards.length) return;
      dropThreadQueues(db, thread.id, type === "thread.archived" ? "thread archived" : "thread deleted");
      for (const card of cards) publishTasksChanged(bb, card.task_id, card.project_id);
    });
  }
}
