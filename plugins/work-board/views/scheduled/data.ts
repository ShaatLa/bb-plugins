import { useMemo } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { useWorkBoardRpc } from "../../shell/host.js";
import type { Task } from "../../shared/contract.js";
import type { ScheduledRpcContract } from "../../shared/scheduled.js";
import { useTasksQuery, type QueryPublish } from "../../shell/data.js";
import type { InvalidationChannel } from "../../shell/signal-scheduler.js";

export function useScheduledRpc() {
  return useWorkBoardRpc<ScheduledRpcContract>();
}
export type ScheduledRpc = ReturnType<typeof useScheduledRpc>;

/**
 * Reuses the shared query runtime (stale-while-revalidate, coalesced realtime refresh)
 * but calls the standalone scheduled RPC contract; the tasks RPC argument is ignored.
 */
export function useScheduledQuery<T>(
  fetcher: (rpc: ScheduledRpc, publish: QueryPublish<T>) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; channels?: readonly InvalidationChannel[] } = {},
) {
  const rpc = useScheduledRpc();
  return useTasksQuery<T>(
    (_tasksRpc, publish) => fetcher(rpc, publish),
    options.channels ?? ["schedules:changed"],
    deps,
    options.enabled === undefined ? {} : { enabled: options.enabled },
  );
}

/** Resolves task ids to tasks once per visible page (no polling); missing tasks are simply absent. */
export function useTasksById(taskIds: readonly string[]): ReadonlyMap<string, Task> {
  const ids = useMemo(() => [...new Set(taskIds)].sort(), [taskIds.join(",")]);
  const query = useTasksQuery<Task[]>(
    async (rpc) => {
      const found = await Promise.all(ids.map((taskId) => rpc.call("getTask", { taskId }).then((result) => result.task, () => null)));
      return found.filter((task): task is Task => task !== null);
    },
    ["tasks:changed"],
    [ids],
    { enabled: ids.length > 0, relevantTaskIds: ids },
  );
  return useMemo(() => new Map((query.data ?? []).map((task) => [task.id, task])), [query.data]);
}


/** One bounded SDK batch per visible target set; no per-row reads or polling. */
export function useThreadNames(threadIds: readonly string[]): ReadonlyMap<string, string> {
  const sdk = useSdk();
  const ids = useMemo(() => [...new Set(threadIds)].sort(), [threadIds.join(",")]);
  const query = useTasksQuery<Array<{ id: string; title: string }>>(
    async () => (await sdk.threads.list({ threadIds: ids, limit: ids.length })).map(thread => ({ id: thread.id, title: thread.title ?? thread.titleFallback ?? "Untitled thread" })),
    [], [ids], { enabled: ids.length > 0 },
  );
  return useMemo(() => new Map((query.data ?? []).map(thread => [thread.id, thread.title])), [query.data]);
}
