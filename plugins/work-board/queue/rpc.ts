import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { publishProjectsChanged, publishTasksChanged } from "../api";
import type { tasksRpcContract } from "../shared/contract";
import { listQueue, queueAdd, queueMove, queueRemove, setQueueMode, type QueueResult } from "./store";
import { queueReport } from "./trial";

type Names = "queueList" | "queueAdd" | "queueMove" | "queueRemove" | "queueReport" | "updateQueueMode";

/** The queue calls of the CLI and the app. The caller's identity is the `actor` (a thread id, or `owner` from the app). */
// shortcut: plugin RPC carries no caller identity in this SDK, so the `actor` here is trusted like every owner-only app call
// (planning, attention); the CLI derives it from its own context. Check it against the caller once the SDK exposes one.
export function queueHandlers(bb: BbPluginApi, store: TasksApiStore): Pick<PluginRpcHandlers<typeof tasksRpcContract>, Names> {
  const db = bb.storage.database();
  /** Everything in the touched queue refreshes: positions of several cards change at once. */
  const publish = (result: QueueResult, extra: readonly string[] = []) => {
    const ids = new Set([result.taskId, ...extra, ...listQueue(db, { threadId: result.threadId, projectId: result.projectId }).flatMap((queue) => queue.entries.map((entry) => entry.taskId))]);
    for (const id of ids) publishTasksChanged(bb, id, result.projectId);
  };
  const run = <T extends QueueResult>(write: () => T): T => store.transaction(write);
  return {
    queueList: ({ threadId, projectId }) => ({ queues: listQueue(db, { threadId, ...(projectId ? { projectId } : {}) }) }),
    async queueAdd(input) {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId }).catch(() => null);
      if (!thread) throw new Error(`Thread ${input.threadId} was not found`);
      if (thread.archivedAt != null || thread.deletedAt != null) throw new Error(`Thread ${input.threadId} is archived or deleted; queue the card for a live thread`);
      const result = run(() => queueAdd(db, input));
      publish(result);
      return result;
    },
    queueMove(input) {
      const result = run(() => queueMove(db, input));
      publish(result);
      return result;
    },
    queueRemove(input) {
      const result = run(() => queueRemove(db, input));
      publish(result, [input.taskId]);
      return result;
    },
    queueReport: ({ projectId, since }) => queueReport(db, projectId, since ? { since } : {}),
    updateQueueMode({ projectId, mode }) {
      if (!store.tasks.getProject(projectId)) throw new Error("Project not found");
      setQueueMode(db, projectId, mode);
      publishProjectsChanged(bb, projectId);
      return { mode };
    },
  };
}
