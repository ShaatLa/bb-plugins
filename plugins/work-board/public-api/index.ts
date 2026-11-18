import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { publicRpcContract } from "../shared/public";
import { DEFAULT_TASK_STATUSES, type TaskStatusDefinition, STATUS_ICON_NAME_PREFIX, statusCssColor, statusGlyph } from "../shared/statuses";

/** Tasks currently linked to a thread, newest link first. */
export function threadTasks(store: TasksStore, threadId: string) {
  const tasks = store
    .listTaskThreadsByThreadId(threadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((link) => {
      const task = store.getTask(link.taskId);
      const project = task && store.getProject(task.projectId);
      if (!task || !project) return [];
      const def: TaskStatusDefinition = (project.statuses ?? DEFAULT_TASK_STATUSES).find((s) => s.id === task.status) ?? { id: task.status, name: task.status };
      const status = {
        ...def,
        iconName: STATUS_ICON_NAME_PREFIX + statusGlyph(task.status, def.icon),
        cssColor: statusCssColor(task.status, def.color),
      };
      return [{
        key: task.key,
        title: task.title,
        status,
        projectName: project.name,
        archived: task.archivedAt != null,
        linkName: link.presetName,
        linkedAt: link.updatedAt,
        url: `/plugins/work-board/work-board/task/${task.key}`,
      }];
    });
  return { tasks };
}

export function registerPublicApi(bb: BbPluginApi, store: TasksStore): void {
  bb.rpc.register(publicRpcContract, { threadTasks: (input) => threadTasks(store, input.threadId) }, {
    experimental_discoverable: true,
    experimental_description: "Work Board tasks linked to a thread.",
  });
}
