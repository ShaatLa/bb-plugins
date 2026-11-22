import type { Task } from "../shared/contract";
import { tasksRpcContract } from "../shared/contract";
import { TASKS_PAGE_MAX_LIMIT } from "../shared/pagination";
import type { TasksRpc } from "./data";
import { readQuerySnapshot } from "./query-snapshot";

type Publish = (tasks: Task[]) => void;
interface Flight { promise: Promise<Task[]>; listeners: Set<Publish>; latest?: Task[]; completed?: boolean; invalidated?: boolean }
const flights = new Map<string, Flight>();
const taskReads = new Map<string, Promise<Task | null>>();

/** Drop shared task reads so a read issued after a change never joins one issued before it. */
export function forgetTaskReads() { taskReads.clear(); }

export function getSharedTask(rpc: TasksRpc, taskId: string): Promise<Task | null> {
  const existing = taskReads.get(taskId);
  if (existing) return existing;
  const read = rpc.call("getTask", { taskId }).then(({ task }) => task);
  taskReads.set(taskId, read);
  void read.finally(() => { if (taskReads.get(taskId) === read) taskReads.delete(taskId); }).catch(() => undefined);
  return read;
}

export let taskDatasetEpoch = 0;
export function resetTaskDatasetCachesForTest() { flights.clear(); taskReads.clear(); taskDatasetEpoch++; }
export function invalidateTaskDatasets(force = false) {
  for (const [key, flight] of flights) {
    if (force || flight.completed) flights.delete(key);
    else flight.invalidated = true;
  }
}

const fullFlightKey = (projectId: string | null) => `task-search-index-full:${projectId ?? "all"}`;

/** Drop the scoped description read so a later lookup starts its own instead of joining one a cleared search abandoned. */
export function evictFullTaskDataset(projectId: string | null) { flights.delete(fullFlightKey(projectId)); }

export function taskDatasetSnapshot(projectId: string | null) {
  return { name: `task-search-index:${projectId ?? "all"}`, schema: tasksRpcContract.listTasks.output.shape.tasks };
}

// Live UI reads reconcile mutations through realtime patches; CLI cursors remain strict.
// The board and search share one paginated read, publishing each page before metadata arrives.
// Dataset rows carry no description/progressNote (listTasks `omitBodies`); detail reads use getTask*. Only the
// description search passes `full` to read bodies; that read has its own flight and is never persisted.
export function loadTaskDataset(rpc: TasksRpc, projectId: string | null, publish: Publish = () => {}, full = false): Promise<Task[]> {
  const snapshot = taskDatasetSnapshot(projectId);
  const flightKey = full ? fullFlightKey(projectId) : snapshot.name;
  const existing = flights.get(flightKey);
  if (existing) {
    if (!existing.completed) existing.listeners.add(publish);
    if (existing.latest) publish(existing.latest);
    return existing.promise;
  }
  const cached = full ? undefined : readQuerySnapshot(snapshot.name, snapshot.schema);
  if (cached) publish(cached);
  const flight: Flight = { listeners: new Set([publish]), latest: cached, promise: Promise.resolve([] as Task[]) };
  flight.promise = Promise.resolve().then(async () => {
    let tasks: Task[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc.call("listTasks", {
        archive: "active", allowStaleCursor: true, ...(full ? {} : { omitBodies: true }), ...(projectId ? { projectId } : {}), limit: TASKS_PAGE_MAX_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      tasks = [...new Map([...tasks, ...page.tasks].map((task) => [task.id, task])).values()];
      const partial = page.nextCursor && cached
        ? [...new Map([...cached, ...tasks].map((task) => [task.id, task])).values()]
        : tasks;
      flight.latest = partial;
      for (const listener of flight.listeners) listener(partial);
      cursor = page.nextCursor ?? undefined;
      if (cursor && typeof window !== "undefined") await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    } while (cursor);
    return tasks;
  }).then((tasks) => {
    flight.completed = true;
    flight.listeners.clear();
    if (flight.invalidated && flights.get(flightKey) === flight) flights.delete(flightKey);
    setTimeout(() => { if (flights.get(flightKey) === flight) flights.delete(flightKey); }, 1000);
    return tasks;
  }, (error: unknown) => {
    if (flights.get(flightKey) === flight) flights.delete(flightKey);
    throw error;
  });
  flights.set(flightKey, flight);
  return flight.promise;
}
