import type {
  TaskType,
  TaskPriority,
  TaskStatus,
} from "../../shared/contract.js";

/** Older versions persisted the draft here; it is now in memory only and this key is purged. */
export const NEW_TASK_DRAFT_STORAGE_KEY = "bb-work-board:new-task-draft";

export interface NewTaskDraft {
  projectId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labelIds: string[];
  dueDate: string;
  type: TaskType;
  epicId: string | null;
}

export function hasDraftContent(draft: NewTaskDraft): boolean {
  return draft.title.trim() !== "" || draft.description.trim() !== "";
}

export function clearNewTaskDraft(): void {
  try {
    window.localStorage.removeItem(NEW_TASK_DRAFT_STORAGE_KEY);
  } catch {}
}
