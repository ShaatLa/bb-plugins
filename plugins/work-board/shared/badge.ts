/** What the Work Board navigation badge can count; a task matching several counts once. */
export const BADGE_CRITERIA = [
  "open",
  "in_review",
  "needs_answer",
  "owner",
  "failed_thread",
  "stale_idle",
] as const;
export type BadgeCriterion = (typeof BADGE_CRITERIA)[number];

export const DEFAULT_BADGE_CRITERIA: readonly BadgeCriterion[] = ["open"];

/** Checkbox labels in Work Board settings. */
export const BADGE_CRITERION_LABELS: Record<BadgeCriterion, string> = {
  open: "Open tasks",
  in_review: "Tasks in review",
  needs_answer: "Tasks with unanswered questions",
  owner: "Owner actions",
  failed_thread: "Tasks with a failed thread",
  stale_idle: "Tasks with an idle thread and no update",
};

const PHRASES: Record<BadgeCriterion, string> = {
  open: "open",
  in_review: "in review",
  needs_answer: "with unanswered questions",
  owner: "for the owner",
  failed_thread: "with a failed thread",
  stale_idle: "with an idle thread and no update",
};

const tasks = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;

/** Tooltip text, e.g. "3 tasks: 2 with unanswered questions, 1 for the owner". */
export function badgeLabel(
  count: number,
  counts: Partial<Record<BadgeCriterion, number>>,
  criteria: readonly BadgeCriterion[],
): string {
  if (criteria.length === 1) return `${tasks(count)} ${PHRASES[criteria[0]!]}`;
  const parts = criteria
    .filter((criterion) => (counts[criterion] ?? 0) > 0)
    .map((criterion) => `${counts[criterion]} ${PHRASES[criterion]}`);
  return `${tasks(count)}: ${parts.join(", ")}`;
}
