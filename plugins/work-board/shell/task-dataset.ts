import type { Task } from "../shared/contract";
import { tasksRpcContract } from "../shared/contract";
import { TASKS_PAGE_MAX_LIMIT } from "../shared/pagination";
import type { TasksRpc } from "./data";
import { readQuerySnapshot } from "./query-snapshot";

type Publish = (tasks: Task[]) => void;
interface Flight { promise: Promise<Task[]>; listeners: Set<Publish>; latest?: Task[]; completed?: boolean; invalidated?: boolean }
const flights = new Map<string, Flight>();

export let taskDatasetEpoch = 0;
export function resetTaskDatasetCachesForTest() { flights.clear(); taskDatasetEpoch++; }
export function invalidateTaskDatasets(force = false) {
  for (const [key, flight] of flights) {
    if (force || flight.completed) flights.delete(key);
    else flight.invalidated = true;
  }
}

export function taskDatasetSnapshot(projectId: string | null) {
  return { name: `task-search-index:${projectId ?? "all"}`, schema: tasksRpcContract.listTasks.output.shape.tasks };
}

// Live UI reads reconcile mutations through realtime patches; CLI cursors remain strict.
// The board and search share one paginated read, publishing each page before metadata arrives.
export function loadTaskDataset(rpc: TasksRpc, projectId: string | null, publish: Publish = () => {}): Promise<Task[]> {
  const snapshot = taskDatasetSnapshot(projectId);
  const existing = flights.get(snapshot.name);
  if (existing) {
    if (!existing.completed) existing.listeners.add(publish);
    if (existing.latest) publish(existing.latest);
    return existing.promise;
  }
  const cached = readQuerySnapshot(snapshot.name, snapshot.schema);
  if (cached) publish(cached);
  const flight: Flight = { listeners: new Set([publish]), latest: cached, promise: Promise.resolve([] as Task[]) };
  flight.promise = Promise.resolve().then(async () => {
    let tasks: Task[] = [];
    let cursor: string | undefined;
    do {
      const page = await rpc.call("listTasks", {
        archive: "active", allowStaleCursor: true, ...(projectId ? { projectId } : {}), limit: TASKS_PAGE_MAX_LIMIT,
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
    if (flight.invalidated && flights.get(snapshot.name) === flight) flights.delete(snapshot.name);
    setTimeout(() => { if (flights.get(snapshot.name) === flight) flights.delete(snapshot.name); }, 1000);
    return tasks;
  }, (error: unknown) => {
    if (flights.get(snapshot.name) === flight) flights.delete(snapshot.name);
    throw error;
  });
  flights.set(snapshot.name, flight);
  return flight.promise;
}
