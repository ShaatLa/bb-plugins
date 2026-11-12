import type { TaskAdvisory } from "../../shared/task-advisories";
import { samePolledMetadata, useActivityPoll } from "../../shell/activity-poll";
import { useEffect, useRef } from "react";
import { tasksRpcContract, type Label, type Task, type TaskThread, type ThreadHealth, type DependencyTask } from "../../shared/contract.js";
import { useTasksQuery, type TasksRpc, type QueryPublish } from "../../shell/data.js";
import {
  signalTaskIds,
  type TaskSignal,
} from "../../shell/signal-scheduler.js";
import { taskBatches } from "../../shell/task-batches";
import { getSharedTask, loadTaskDataset, taskDatasetEpoch } from "../../shell/task-dataset";
import { isActiveThread } from "../detail/meta.js";

import type { TaskActivity } from "../../shared/task-activity.js";

export interface BoardCardMeta {
  blockedBy?: DependencyTask[];
  advisories?: TaskAdvisory[];
  activity?: TaskActivity;
  workingThreads: TaskThread[];
  threadHealth?: ThreadHealth;
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
async function readBoardMeta(rpc: TasksRpc, taskIds: string[]) {
  return taskBatches(taskIds, async (batch) => (await rpc.call("listTaskCardMeta", { taskIds: batch })).metadata);
}

export async function pollBoardMetadata(rpc: TasksRpc, current: MetadataRow[]): Promise<MetadataRow[]> {
  const activeIds = current.filter((row) => (row.activity?.attachedCount ?? 0) > 0 || row.taskThreads.some(isActiveThread)).map((row) => row.taskId);
  if (!activeIds.length) return current;
  const next = new Map(current.map((row) => [row.taskId, row]));
  for (const row of await readBoardMeta(rpc, activeIds)) next.set(row.taskId, row);
  const result = [...next.values()];
  return samePolledMetadata(result, current) ? current : result;
}

export async function syncBoardMetadata(rpc: TasksRpc, current: MetadataRow[], ids: string[]): Promise<MetadataRow[]> {
  const present = new Set(current.map((row) => row.taskId));
  const added = ids.filter((id) => !present.has(id));
  if (!added.length && current.every((row) => ids.includes(row.taskId))) return current;
  const next = new Map(current.filter((row) => ids.includes(row.taskId)).map((row) => [row.taskId, row]));
  for (const row of await readBoardMeta(rpc, added)) next.set(row.taskId, row);
  return [...next.values()];
}

export function useBoardMetadata(tasks: readonly Task[], projectId: string, enabled: boolean) {
  const ids = tasks.map((task) => task.id).sort();
  const idsKey = ids.join();
  const previousIds = useRef<{ projectId: string; ids: string[] } | null>(null);
  const query = useTasksQuery<MetadataRow[]>(
    async (rpc) => {
      const rows = await readBoardMeta(rpc, ids);
      previousIds.current = { projectId, ids };
      return rows;
    },
    enabled ? ["tasks:changed", "threads:changed", "prs:changed"] : [],
    [projectId],
    {
      enabled,
      dataScope: projectId,
      snapshot: { name: `board-metadata:${projectId}`, schema: tasksRpcContract.listTaskCardMeta.output.shape.metadata },
      relevantTaskIds: ids,
      applySignals: async (rpc, current, signals) => {
        const changed = [...new Set([...signalTaskIds(signals, "tasks:changed"), ...signalTaskIds(signals, "threads:changed"), ...signalTaskIds(signals, "prs:changed")])].filter((id) => ids.includes(id));
        const rows = await readBoardMeta(rpc, changed);
        const next = new Map(current.map((row) => [row.taskId, row]));
        for (const id of changed) next.delete(id);
        for (const row of rows) next.set(row.taskId, row);
        const result = [...next.values()];
        return samePolledMetadata(result, current) ? current : result;
      },
    },
  );
  useEffect(() => {
    if (!enabled || query.isFetching || !query.data) return;
    const previous = previousIds.current;
    previousIds.current = { projectId, ids };
    if (!previous || previous.projectId !== projectId) return;
    const added = ids.filter((id) => !previous.ids.includes(id));
    if (!added.length && previous.ids.length === ids.length) return;
    void query.patch((rpc, current) => syncBoardMetadata(rpc, current, ids)).catch(() => query.refresh());
  }, [projectId, idsKey, enabled, query.isFetching, query.data, query.patch]);
  const hasActive = !!query.data?.some((row) => (row.activity?.attachedCount ?? 0) > 0 || row.taskThreads.some(isActiveThread));
  useActivityPoll(() => {
    void query.patch(pollBoardMetadata).catch(() => query.refresh());
  }, query.isFetching, enabled && hasActive);
  return query;
}

async function cardMetadata(rpc: TasksRpc, taskIds: string[]) {
  const metadata = new Map<string, BoardCardMeta>();
  const rows = await taskBatches(taskIds, async (batch) => (await rpc.call("listTaskCardMeta", { taskIds: batch })
    .catch(() => ({ metadata: [] }))).metadata);
  for (const entry of rows) metadata.set(entry.taskId, {
    ...EMPTY_META,
    workingThreads: entry.taskThreads.filter(isActiveThread),
    threadHealth: entry.threadHealth,
    activity: entry.activity,
    blockedBy: entry.blockedBy,
    advisories: entry.advisories,
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
  if (changedIds.length > 25) return null;
  if (!changedIds.length && !refreshMetadata) return current;
  const fetched = await Promise.all(
    changedIds.map(async (taskId) => {
      const task = await getSharedTask(rpc, taskId);
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
  if (refreshMetadata) for (const id of threadIds) metaByTaskId.delete(id);
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
