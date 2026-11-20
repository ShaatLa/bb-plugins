import { z } from "zod";
import { DEFAULT_TASK_STATUSES, taskStatusSchema } from "./statuses.js";

export const workflowPolicySchema = z.object({
  bugfixStatus: taskStatusSchema.nullable().default("bugfix"),
  doneStatus: taskStatusSchema.nullable().default("done"),
  inProgressStatus: taskStatusSchema.nullable().default("in_progress"),
  reviewStatus: taskStatusSchema.nullable().default("in_review"),
  testingStatus: taskStatusSchema.nullable().default("in_testing"),
  earlyStatuses: z.array(taskStatusSchema).default(["todo", "in_progress"]),
  ownerDecisionLabel: z.string().trim().min(1).max(100).nullable().default("owner decision"),
}).strict();

export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;
export function getWorkflowPolicy(project: { workflowPolicy?: Partial<WorkflowPolicy> | null }): WorkflowPolicy {
  return workflowPolicySchema.parse(project.workflowPolicy ?? {});
}

/**
 * The status that means "in progress" for a project: the policy's `inProgressStatus` when it is set, else `in_progress`
 * when the project has that status, else none (a project without one has no plan gate and no automatic move).
 */
export function effectiveInProgressStatus(project: { workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string }> | null }): string | null {
  const configured = getWorkflowPolicy(project).inProgressStatus;
  if (configured) return configured;
  return (project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES).some((status) => status.id === "in_progress") ? "in_progress" : null;
}

/**
 * The work zone of a project: the effective In progress status and every status after it in the project's order,
 * except `canceled`. With planning required, a card without an approved plan stays out of it.
 */
export function inWorkZone(project: { workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string }> | null }, status: string): boolean {
  const start = effectiveInProgressStatus(project);
  if (!start || status === "canceled") return false;
  const order = (project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES).map((entry) => entry.id);
  const first = order.indexOf(start);
  return first >= 0 && order.indexOf(status) >= first;
}
