import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  publishCommentsChanged,
  publishTasksChanged,
  type TasksApiStore,
} from "../api";

export function autoArchiveTasks(
  bb: BbPluginApi,
  store: TasksApiStore,
) {
  const changed = store.transaction(() => {
    const tasks = [];
    for (const project of store.tasks.listProjects()) {
      const days = project.autoArchiveAfterDays ?? "off";
      if (days === "off") continue;
      const cutoff = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
      const archived = store.tasks.archiveCompletedTasks(project.id, cutoff);
      for (const task of archived)
        store.tasks.createComment({
          taskId: task.id,
          kind: "system",
          authorName: "Work Board",
          body: `Task automatically archived after ${days} days without activity`,
        });
      tasks.push(...archived);
    }
    return tasks;
  });
  for (const task of changed) {
    publishTasksChanged(bb, task.id, task.projectId);
    publishCommentsChanged(bb, task.id);
  }
  return changed.length;
}
