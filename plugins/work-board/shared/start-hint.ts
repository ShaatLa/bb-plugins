import { DEFAULT_TASK_STATUSES, statusLabel, type TaskStatusDefinition } from "./statuses.js";
import { planningRequired } from "./project-settings.js";
import { isClosedStatus, planningStatusOf, usableStartTarget, type WorkflowPolicy } from "./workflow-policy.js";

type HintProject = {
  planning?: string | null;
  workflowPolicy?: Partial<WorkflowPolicy> | null;
  statuses?: readonly TaskStatusDefinition[] | null;
};

/**
 * The "Next step" text of `bb work-board show` for a card still in Backlog or Todo, or null. `epic` is the card's
 * effective epic (its own, or its parent's). The same text goes to the plain output and to `startHint` in the JSON.
 */
export function startHint(
  project: HintProject,
  task: { key: string; type: string; status: string; archivedAt?: string | null },
  plan: { state: string } | null,
  epic: { key: string; status: string } | null,
): string | null {
  if (task.type === "epic" || task.archivedAt || (task.status !== "backlog" && task.status !== "todo")) return null;
  let target: string | null;
  if (planningRequired(project) && plan?.state !== "approved") {
    target = planningStatusOf(project);
    const order = (project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES).map((status) => status.id);
    // No move line when planning shares the current column or is not ahead of it; the Plan warning already says to plan.
    if (target !== null && order.indexOf(target) <= order.indexOf(task.status)) target = null;
  } else target = usableStartTarget(project, task.status);
  if (!target) return null;
  const lines = [`Taking this task? Move it first: bb work-board update ${task.key} --status ${target}`];
  const epicTarget = epic && (epic.status === "backlog" || epic.status === "todo") ? usableStartTarget(project, epic.status) : null;
  if (epic && epicTarget && target !== "backlog" && target !== "todo" && !isClosedStatus(project, target))
    lines.push(`Its epic ${epic.key} moves to ${statusLabel(epicTarget, project.statuses ?? undefined)} automatically when this task starts.`);
  return lines.join("\n");
}
