import { tasksRpcContract, type Label, type Task, type TaskThread } from "../../shared/contract.js";
import { useTasksQuery, type TasksRpc, type QueryPublish } from "../../shell/data.js";
import {
  signalTaskIds,
  type TaskSignal,
} from "../../shell/signal-scheduler.js";
import { taskBatches } from "../../shell/task-batches";
import { loadTaskDataset, taskDatasetEpoch } from "../../shell/task-dataset";
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

const snapshots = new Map<string, { epoch: number; board: BoardData }>();
function remember(projectId: string, board: BoardData) {
  snapshots.delete(projectId);
  snapshots.set(projectId, { epoch: taskDatasetEpoch, board });
  if (snapshots.size > 6) snapshots.delete(snapshots.keys().next().value!);
  return board;
}

function assembleBoard(tasks: Task[], labelsById: Map<string, Label>, metaByTaskId: Map<string, BoardCardMeta>): BoardData {
  const topLevel = tasks.filter((task) => task.parentTaskId === null && !task.archivedAt);
  const progress = new Map<string, { done: number; total: number }>();
  for (const task of tasks) {
    const parentId = task.parentTaskId ?? task.epicId;
    if (parentId === null) continue;
    const entry = progress.get(parentId) ?? { done: 0, total: 0 };
    entry.total++;
    if (task.status === "done") entry.done++;
    progress.set(parentId, entry);
  }
  return {
    tasks: topLevel,
    subtasks: tasks.filter((task) => task.parentTaskId !== null && !task.archivedAt),
    labelsById,
    metaByTaskId: new Map(topLevel.map((task) => [task.id, {
      ...(metaByTaskId.get(task.id) ?? EMPTY_META),
      subDone: progress.get(task.id)?.done ?? 0,
      subTotal: progress.get(task.id)?.total ?? 0,
    }])),
  };
}

export async function fetchBoard(rpc: TasksRpc, projectId: string, publish?: QueryPublish<BoardData>): Promise<BoardData> {
  const entry = snapshots.get(projectId);
  const cached = entry?.epoch === taskDatasetEpoch ? entry.board : undefined;
  if (cached) publish?.(cached);
  const tasks = await loadTaskDataset(rpc, projectId, (partial) => {
    publish?.(assembleBoard(partial, cached?.labelsById ?? new Map(), cached?.metaByTaskId ?? new Map()));
  });
  if (publish) return remember(projectId, assembleBoard(tasks, cached?.labelsById ?? new Map(), cached?.metaByTaskId ?? new Map()));
  const [labels, metadata] = await Promise.all([
    rpc.call("listLabels", { projectId }).then((result) => new Map(result.labels.map((label) => [label.id, label])), () => new Map<string, Label>()),
    cardMetadata(rpc, tasks.filter((task) => task.parentTaskId === null).map((task) => task.id)),
  ]);
  return remember(projectId, assembleBoard(tasks, labels, metadata));
}

type MetadataRow = (typeof tasksRpcContract.listTaskCardMeta.output._output.metadata)[number];
export function useBoardMetadata(tasks: readonly Task[], projectId: string, enabled: boolean) {
  const ids = tasks.map((task) => task.id).sort();
  const read = (rpc: TasksRpc, taskIds: string[]) => taskBatches(taskIds, async (batch) => (await rpc.call("listTaskCardMeta", { taskIds: batch })).metadata);
  return useTasksQuery<MetadataRow[]>(
    (rpc) => read(rpc, ids),
    enabled ? ["tasks:changed", "threads:changed"] : [],
    [projectId, ids.join()],
    {
      enabled,
      dataScope: projectId,
      snapshot: { name: `board-metadata:${projectId}`, schema: tasksRpcContract.listTaskCardMeta.output.shape.metadata },
      relevantTaskIds: ids,
      applySignals: async (rpc, current, signals) => {
        const changed = [...new Set([...signalTaskIds(signals, "tasks:changed"), ...signalTaskIds(signals, "threads:changed")])].filter((id) => ids.includes(id));
        const rows = await read(rpc, changed);
        const next = new Map(current.map((row) => [row.taskId, row]));
        for (const id of changed) next.delete(id);
        for (const row of rows) next.set(row.taskId, row);
        return [...next.values()];
      },
    },
  );
}

async function cardMetadata(rpc: TasksRpc, taskIds: string[]) {
  const metadata = new Map<string, BoardCardMeta>();
  const rows = await taskBatches(taskIds, async (batch) => (await rpc.call("listTaskCardMeta", { taskIds: batch })
    .catch(() => ({ metadata: [] }))).metadata);
  for (const entry of rows) metadata.set(entry.taskId, {
    ...EMPTY_META,
    workingThreads: entry.taskThreads.filter(isActiveThread),
    attachmentCount: entry.attachmentCount,
  });
  return metadata;
}

export async function patchBoard(
  rpc: TasksRpc,
  projectId: string,
  current: BoardData,
  signals: readonly TaskSignal[],
  refreshMetadata = true,
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
  const metadata = refreshMetadata ? await cardMetadata(rpc, [
    ...refreshedCards.map((task) => task.id), ...threadIds,
  ]) : new Map<string, BoardCardMeta>();
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
  return remember(projectId, { ...current, tasks, subtasks, metaByTaskId });
}
