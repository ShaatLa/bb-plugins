import { tasksRpcContract } from "../../shared/contract";
import { useMemo } from "react";
import { loadTaskDataset, taskDatasetSnapshot } from "../../shell/task-dataset";
import { taskBatches } from "../../shell/task-batches";
import {
  listAllTasks,
  patchTasks,
  useTasksQuery,
  type TasksRpc,
} from "../../shell/data.js";
import {
  signalTaskIds,
  type TaskSignal,
} from "../../shell/signal-scheduler.js";
import type {
  Label,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";
import { isActiveThread } from "../detail/meta.js";

interface ListTaskFilters {
  type?: Task["type"];
  executionTarget?: Task["executionTarget"];
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  labelIds: readonly string[] | null;
}

function belongsToList(
  task: Task,
  projectId: string | null,
  filters: ListTaskFilters,
): boolean {
  if (task.parentTaskId !== null || task.archivedAt) return false;
  if (
    filters.executionTarget !== undefined &&
    task.executionTarget !== filters.executionTarget
  )
    return false;
  if (filters.type !== undefined && task.type !== filters.type) return false;
  if (projectId !== null && task.projectId !== projectId) return false;
  if (filters.statuses.length > 0 && !filters.statuses.includes(task.status)) {
    return false;
  }
  if (
    filters.priorities.length > 0 &&
    !filters.priorities.includes(task.priority)
  ) {
    return false;
  }
  if (filters.labelIds !== null) {
    const wanted = new Set(filters.labelIds);
    if (!task.labelIds.some((labelId) => wanted.has(labelId))) return false;
  }
  return true;
}

export function listTasksQuery(
  projectId: string | null,
  activeOnly: boolean,
  filters: ListTaskFilters,
) {
  return {
    ...(projectId === null ? {} : { projectId }),
    ...(filters.statuses.length > 0 ? { statuses: [...filters.statuses] } : {}),
    ...(filters.priorities.length > 0
      ? { priorities: [...filters.priorities] }
      : {}),
    ...(filters.labelIds !== null ? { labelIds: [...filters.labelIds] } : {}),
    activeOnly,
    ...(filters.executionTarget === undefined
      ? {}
      : { executionTarget: filters.executionTarget }),
    ...(filters.type === undefined ? {} : { type: filters.type }),
    parentTaskId: null,
  };
}

export function useListTasks(
  projectId: string | null,
  activeOnly: boolean,
  filters: ListTaskFilters,
) {
  const query = useTasksQuery<Task[]>(
    (rpc, publish) => activeOnly
      ? listAllTasks(rpc, { ...(projectId ? { projectId } : {}), activeOnly: true, parentTaskId: null })
      : loadTaskDataset(rpc, projectId, publish),
    activeOnly ? ["tasks:changed", "threads:changed"] : ["tasks:changed", "projects:changed"],
    [projectId, activeOnly],
    activeOnly ? {} : {
      snapshot: taskDatasetSnapshot(projectId),
      applySignals: (rpc, current, signals) => signals.some((signal) => signal.channel === "projects:changed")
        ? Promise.resolve(null)
        : patchTasks(rpc, current, signalTaskIds(signals, "tasks:changed"), (task) => !task.archivedAt && (projectId === null || task.projectId === projectId)),
    },
  );
  const data = useMemo(() => query.data?.filter((task) => belongsToList(task, projectId, filters)), [
    query.data, projectId, filters.type, filters.executionTarget, filters.statuses.join(), filters.priorities.join(), filters.labelIds?.join(),
  ]);
  return { ...query, data };
}

export function useLabels(projectIds: readonly string[]) {
  return useTasksQuery<Label[]>(
    async (rpc) => {
      const results = await Promise.all(
        projectIds.map((projectId) => rpc.call("listLabels", { projectId })),
      );
      return results.flatMap((result) => result.labels);
    },
    ["projects:changed"],
    [projectIds.join()],
    { snapshot: { name: `labels:${[...projectIds].sort().join()}`, schema: tasksRpcContract.listLabels.output.shape.labels } },
  );
}

export interface TaskRowMeta {
  activeThreads: TaskThread[];
}

async function readListMeta(rpc: TasksRpc, ids: string[]) {
  const rows = await taskBatches(ids, async (taskIds) => (await rpc.call("listTaskCardMeta", { taskIds })).metadata);
  return new Map(rows.filter((row) => row.taskThreads.some(isActiveThread)).map((row) => [row.taskId, { activeThreads: row.taskThreads.filter(isActiveThread) }]));
}
async function patchListMeta(rpc: TasksRpc, current: ReadonlyMap<string, TaskRowMeta>, signals: readonly TaskSignal[]) {
  const ids = [...new Set([...signalTaskIds(signals, "threads:changed"), ...signalTaskIds(signals, "tasks:changed")])];
  const next = new Map(current);
  for (const id of ids) next.delete(id);
  for (const [id, meta] of await readListMeta(rpc, ids)) next.set(id, meta);
  return next;
}

export function useTaskListMeta(projectId: string | null) {
  return useTasksQuery<Map<string, TaskRowMeta>>(
    async (rpc) => {
      const activeTasks = await listAllTasks(rpc, {
        ...(projectId === null ? {} : { projectId }),
        activeOnly: true,
        parentTaskId: null,
      });
      return readListMeta(rpc, activeTasks.map((task) => task.id));
    },
    ["threads:changed", "tasks:changed"],
    [projectId],
    { applySignals: patchListMeta },
  );
}
