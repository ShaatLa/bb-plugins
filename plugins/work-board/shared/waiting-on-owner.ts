import { isWaitingOnOwner } from "./questions";
import { ROLE_DEFAULTS } from "./status-roles";
import type { Task, TaskQuestion } from "./contract";

/** `closed` is the closed statuses of the task's project (`resolveRoles(project).closed`); the default is a project with the standard ones. */
export function waitingOnOwner(task: Task, unanswered: number, closed: readonly string[] = ROLE_DEFAULTS.closedStatuses): boolean {
  return !task.archivedAt && !closed.includes(task.status) && unanswered > 0;
}
/** The newest open question the owner is waited on for; `held` is `checkFlow(...).held`, whose checks nobody waits on yet. */
export function newestOpenQuestion(questions: readonly TaskQuestion[], held: ReadonlyMap<string, string> = new Map()) {
  return questions.filter((question) => isWaitingOnOwner(question, held)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
export function waitingOrder(a: Task, b: Task, details?: ReadonlyMap<string, { newestUnansweredAt: string | null }>) {
  const first = details?.get(a.id)?.newestUnansweredAt;
  const second = details?.get(b.id)?.newestUnansweredAt;
  return Number(!!second) - Number(!!first) || (second ?? b.updatedAt).localeCompare(first ?? a.updatedAt) || b.id.localeCompare(a.id);
}
