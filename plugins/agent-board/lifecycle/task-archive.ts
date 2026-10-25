import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  publishCommentsChanged,
  publishTasksChanged,
  type TasksApiStore,
} from "../api";

export function autoArchiveTasks(
  bb: BbPluginApi,
  store: TasksApiStore,
  days: number,
) {
  if (![7, 14, 30].includes(days))
    throw new Error("Invalid auto-archive interval");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const changed = store.transaction(() => {
    const tasks = store.tasks
      .listProjects()
      .flatMap((project) =>
        store.tasks.archiveCompletedTasks(project.id, cutoff),
      );
    for (const task of tasks)
      store.tasks.createComment({
        taskId: task.id,
        kind: "system",
        authorName: "Agent Board",
        body: `Task automatically archived after ${days} days without activity`,
      });
    return tasks;
  });
  for (const task of changed) {
    publishTasksChanged(bb, task.id, task.projectId);
    publishCommentsChanged(bb, task.id);
  }
  return changed.length;
}
