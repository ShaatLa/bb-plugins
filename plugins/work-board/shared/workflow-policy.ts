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

type ZoneProject = { workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string; requiresApprovedPlan?: boolean }> | null };

/** The statuses the owner marked "only with an approved plan". `canceled` can never be marked. */
export function planGatedStatuses(project: ZoneProject): string[] {
  return (project.statuses ?? []).filter((status) => status.requiresApprovedPlan === true && status.id !== "canceled").map((status) => status.id);
}

/** The work zone of a project: its statuses marked "only with an approved plan". Column order does not matter. */
export function inWorkZone(project: ZoneProject, status: string): boolean {
  return status !== "canceled" && planGatedStatuses(project).includes(status);
}

/** The old position rule, used only to prefill the flags: the effective In progress status and every later one, except `canceled`. */
export function inPositionZone(project: ZoneProject, status: string): boolean {
  const start = effectiveInProgressStatus(project);
  if (!start || status === "canceled") return false;
  const order = (project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES).map((entry) => entry.id);
  const first = order.indexOf(start);
  return first >= 0 && order.indexOf(status) >= first;
}

/**
 * A card is "in work" for the executor notices when it is in a marked status, once the project's flags are initialized;
 * before that, when it is in the effective In progress status or later by position. Independent of the gate.
 */
export function inWorkNow(project: ZoneProject & { planFlagsInitialized?: boolean }, status: string): boolean {
  return project.planFlagsInitialized ? inWorkZone(project, status) : inPositionZone(project, status);
}

/**
 * The statuses with their "only with an approved plan" flags settled; a flag is kept only when true, and `canceled` is
 * never marked. A status without a flag keeps the one it had (`previous`), and a new one gets the position default when
 * the project requires planning. The flags count as initialized once the owner edited one, or once the project is first
 * switched to `required` while they were not: that switch prefills every flag by position, and nothing refills them later.
 */
export function settlePlanFlags<T extends { id: string; requiresApprovedPlan?: boolean }>(input: {
  statuses: readonly T[];
  previous?: readonly { id: string; requiresApprovedPlan?: boolean }[] | null;
  planning: string;
  initialized: boolean;
  workflowPolicy?: Partial<WorkflowPolicy> | null;
}): { statuses: T[]; initialized: boolean } {
  const { planning, workflowPolicy } = input;
  const before = new Map((input.previous ?? []).map((status) => [status.id, status.requiresApprovedPlan === true]));
  const byPosition = (id: string) => inPositionZone({ workflowPolicy, statuses: input.statuses }, id);
  const edited = input.statuses.some((status) => status.id !== "canceled" && status.requiresApprovedPlan !== undefined && status.requiresApprovedPlan !== (before.get(status.id) ?? false));
  const marked = input.statuses.map((status) => status.requiresApprovedPlan ?? before.get(status.id) ?? (planning === "required" && byPosition(status.id)));
  const prefill = planning === "required" && !input.initialized && !edited;
  const settled = input.statuses.map((status, index) => {
    const { requiresApprovedPlan: _flag, ...rest } = status;
    const flag = status.id !== "canceled" && (prefill ? byPosition(status.id) : marked[index]);
    return (flag ? { ...rest, requiresApprovedPlan: true } : rest) as T;
  });
  return { statuses: settled, initialized: input.initialized || edited || prefill };
}
