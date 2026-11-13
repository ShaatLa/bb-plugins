import { isQuestionOpen } from "./questions";
import type { Task, TaskQuestion } from "./contract";

export function waitingOnOwner(task: Task, unanswered: number): boolean {
  return !task.archivedAt && task.ordinaryVisible !== false && !["done", "canceled"].includes(task.status) && unanswered > 0;
}
export function newestOpenQuestion(questions: readonly TaskQuestion[]) {
  return questions.filter(isQuestionOpen).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
export function waitingOrder(a: Task, b: Task, details?: ReadonlyMap<string, { newestUnansweredAt: string | null }>) {
  const first = details?.get(a.id)?.newestUnansweredAt;
  const second = details?.get(b.id)?.newestUnansweredAt;
  return Number(!!second) - Number(!!first) || (second ?? b.updatedAt).localeCompare(first ?? a.updatedAt) || b.id.localeCompare(a.id);
}
