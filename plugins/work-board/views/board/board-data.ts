import type { Label, Task, TaskThread } from "../../shared/contract.js";
import { listAllTasks, type TasksRpc } from "../../shell/data.js";
import {
  signalTaskIds,
  type TaskSignal,
} from "../../shell/signal-scheduler.js";
import { isActiveThread } from "../detail/meta.js";

export interface BoardCardMeta {
  workingThreads: TaskThread[];
  attachmentCount: number;
  subDone: number;
  subTotal: number;
}

export interface BoardData {
  tasks: Task[];
  subtasks: Task[];
  labelsById: Map<string, Label>;
  metaByTaskId: Map<string, BoardCardMeta>;
}

export const EMPTY_META: BoardCardMeta = {
  workingThreads: [],
  attachmentCount: 0,
  subDone: 0,
  subTotal: 0,
};

export async function fetchBoard(
  rpc: TasksRpc,
  projectId: string,
): Promise<BoardData> {
  const tasks = await listAllTasks(rpc, { projectId });
  const topLevel = tasks.filter((task) => task.parentTaskId === null && !task.archivedAt);

  const [labels, metadata] = await Promise.all([
    rpc.call("listLabels", { projectId }).then((result) => result.labels, () => []),
    cardMetadata(rpc, topLevel.map((task) => task.id)),
  ]);
  const subProgress = new Map<string, { done: number; total: number }>();
  for (const task of tasks) {
    const parentId = task.parentTaskId ?? task.epicId;
    if (parentId === null) continue;
    const entry = subProgress.get(parentId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.status === "done") entry.done += 1;
    subProgress.set(parentId, entry);
  }
  return {
    tasks: topLevel,
    subtasks: tasks.filter((task) => task.parentTaskId !== null),
    labelsById: new Map(labels.map((label) => [label.id, label])),
    metaByTaskId: new Map(
      topLevel.map((task) => [
        task.id,
        {
          ...(metadata.get(task.id) ?? EMPTY_META),
          subDone: subProgress.get(task.id)?.done ?? 0,
          subTotal: subProgress.get(task.id)?.total ?? 0,
        },
      ]),
    ),
  };
}

async function cardMetadata(rpc: TasksRpc, taskIds: string[]) {
  const metadata = new Map<string, BoardCardMeta>();
  for (let offset = 0; offset < taskIds.length; offset += 500) {
    const result = await rpc.call("listTaskCardMeta", { taskIds: taskIds.slice(offset, offset + 500) })
      .catch(() => ({ metadata: [] }));
    for (const entry of result.metadata) metadata.set(entry.taskId, {
      ...EMPTY_META,
      workingThreads: entry.taskThreads.filter(isActiveThread),
      attachmentCount: entry.attachmentCount,
    });
  }
  return metadata;
}

export async function patchBoard(
  rpc: TasksRpc,
  projectId: string,
  current: BoardData,
  signals: readonly TaskSignal[],
): Promise<BoardData | null> {
  if (signals.some((signal) => signal.channel === "projects:changed")) {
    return null;
  }
  const changedIds = signalTaskIds(signals, "tasks:changed");
  const fetched = await Promise.all(
    changedIds.map(async (taskId) => {
      const { task } = await rpc.call("getTask", { taskId });
      return [taskId, task] as const;
    }),
  );
  const changed = new Map(fetched);
  const keep = (task: Task) => !changed.has(task.id);
  const tasks = current.tasks.filter(keep);
  const subtasks = current.subtasks.filter(keep);
  const metaByTaskId = new Map(current.metaByTaskId);
  for (const taskId of changed.keys()) metaByTaskId.delete(taskId);
  const refreshedCards: Task[] = [];
  for (const task of changed.values()) {
    if (task === null || task.archivedAt || task.projectId !== projectId) continue;
    if (task.parentTaskId === null) {
      tasks.push(task);
      refreshedCards.push(task);
    } else {
      subtasks.push(task);
    }
  }
  const topLevelIds = new Set(tasks.map((task) => task.id));
  const threadIds = signalTaskIds(signals, "threads:changed").filter(
    (taskId) => topLevelIds.has(taskId) && !changed.has(taskId),
  );
  const metadata = await cardMetadata(rpc, [
    ...refreshedCards.map((task) => task.id), ...threadIds,
  ]);
  for (const [taskId, meta] of metadata) metaByTaskId.set(taskId, meta);
  const progress = new Map<string, { done: number; total: number }>();
  for (const task of [...tasks, ...subtasks]) {
    const parentId = task.parentTaskId ?? task.epicId;
    if (parentId === null) continue;
    const entry = progress.get(parentId) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.status === "done") entry.done += 1;
    progress.set(parentId, entry);
  }
  for (const task of tasks) {
    const meta = metaByTaskId.get(task.id) ?? EMPTY_META;
    const entry = progress.get(task.id);
    metaByTaskId.set(task.id, {
      ...meta,
      subDone: entry?.done ?? 0,
      subTotal: entry?.total ?? 0,
    });
  }
  tasks.sort(
    (a, b) =>
      a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { ...current, tasks, subtasks, metaByTaskId };
}
