import { isWaitingOnOwner } from "./questions";
import type { Task, TaskQuestion } from "./contract";

export function waitingOnOwner(task: Task, unanswered: number): boolean {
  return !task.archivedAt && !["done", "canceled"].includes(task.status) && unanswered > 0;
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
