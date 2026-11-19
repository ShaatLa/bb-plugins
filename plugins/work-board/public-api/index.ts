import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { publicRpcContract } from "../shared/public";
import { DEFAULT_TASK_STATUSES, type TaskStatusDefinition, STATUS_ICON_NAME_PREFIX, statusCssColor, statusGlyph } from "../shared/statuses";

const taskUrl = (key: string) => `/plugins/work-board/work-board/task/${key}`;

function publicStatus(statuses: readonly TaskStatusDefinition[], id: string) {
  const def: TaskStatusDefinition = statuses.find((s) => s.id === id) ?? { id, name: id };
  return { ...def, iconName: STATUS_ICON_NAME_PREFIX + statusGlyph(id, def.icon), cssColor: statusCssColor(id, def.color) };
}

export const THREAD_BOARD_COLUMN_CARDS = 30;

/** The board of the project linked to the thread's bb project, as the thread side panel tab shows it. */
export function threadBoard(store: TasksStore, threadId: string, bbProjectId: string | null) {
  const links = store.listTaskThreadsByThreadId(threadId);
  const mine = new Set(links.map((link) => link.taskId));
  const linked = store.listProjects().filter((project) => bbProjectId !== null && project.linkedBbProjectId === bbProjectId);
  // Several boards can share one bb project: prefer the one holding this thread's tasks.
  const project = linked.find((candidate) => links.some((link) => store.getTask(link.taskId)?.projectId === candidate.id)) ?? linked[0];
  if (!project) return { project: null, columns: [] };
  const statuses = project.statuses ?? DEFAULT_TASK_STATUSES;
  const tasks = store.listTasks({ projectId: project.id, archive: "active" })
    .filter((task) => task.parentTaskId === null)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const columns = statuses.map((def) => {
    const all = tasks.filter((task) => task.status === def.id);
    // Cards past the cap are dropped, except this thread's own.
    const cards = all.filter((task, index) => index < THREAD_BOARD_COLUMN_CARDS || mine.has(task.id));
    return {
      status: publicStatus(statuses, def.id),
      total: all.length,
      cards: cards.map((task) => ({ key: task.key, title: task.title, type: task.type, priority: task.priority, mine: mine.has(task.id), url: taskUrl(task.key) })),
    };
  });
  return { project: { id: project.id, name: project.name, url: `/plugins/work-board/work-board/${project.id}?view=board` }, columns };
}

/** Tasks currently linked to a thread, newest link first. */
export function threadTasks(store: TasksStore, threadId: string) {
  const tasks = store
    .listTaskThreadsByThreadId(threadId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((link) => {
      const task = store.getTask(link.taskId);
      const project = task && store.getProject(task.projectId);
      if (!task || !project) return [];
      const status = publicStatus(project.statuses ?? DEFAULT_TASK_STATUSES, task.status);
      return [{
        key: task.key,
        title: task.title,
        status,
        projectName: project.name,
        archived: task.archivedAt != null,
        linkName: link.presetName,
        linkedAt: link.updatedAt,
        url: taskUrl(task.key),
      }];
    });
  return { tasks };
}

export function registerPublicApi(bb: BbPluginApi, store: TasksStore): void {
  bb.rpc.register(publicRpcContract, {
    threadTasks: (input) => threadTasks(store, input.threadId),
    threadBoard: async (input) => {
      const bbProjectId = await bb.sdk.threads.get({ threadId: input.threadId }).then((thread) => thread.projectId, () => null);
      return threadBoard(store, input.threadId, bbProjectId);
    },
  }, {
    experimental_discoverable: true,
    experimental_description: "Work Board tasks linked to a thread, and the board of the thread's project.",
  });
}
