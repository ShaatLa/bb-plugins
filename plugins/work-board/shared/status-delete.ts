import { ARRAY_ROLES, ROLE_DEFAULTS, type ArrayRole, type RoleProject, type SingleRole } from "./status-roles.js";
import { getWorkflowPolicy, type WorkflowPolicy } from "./workflow-policy.js";

/** Every single role is nullable except the new-card status, which a project always needs. */
export const roleIsNullable = (role: SingleRole): boolean => role !== "newCardStatus";

/** Single roles that point at `id`, explicitly or through the default of a role the policy leaves out (see `resolveRoles`). */
export function rolesPointingTo(project: RoleProject, id: string): SingleRole[] {
  const policy = getWorkflowPolicy(project as { workflowPolicy?: Partial<WorkflowPolicy> | null });
  const points: Record<SingleRole, boolean> = {
    doneStatus: policy.doneStatus === id,
    canceledStatus: (policy.canceledStatus === undefined ? ROLE_DEFAULTS.canceledStatus : policy.canceledStatus) === id,
    inProgressStatus: policy.inProgressStatus === id,
    reviewStatus: policy.reviewStatus === id,
    testingStatus: policy.testingStatus === id,
    bugfixStatus: policy.bugfixStatus === id,
    planningStatus: policy.planningStatus === id,
    // A default that falls back when its status is missing is not a pointer: only an explicit value is.
    newCardStatus: policy.newCardStatus === id,
    readyStatus: policy.readyStatus === id,
  };
  return (Object.keys(points) as SingleRole[]).filter((role) => points[role]);
}

/** Array roles the delete drops `id` from: the ones the policy holds explicitly (an omitted one follows its default). */
export function arrayRolesHolding(project: RoleProject, id: string): ArrayRole[] {
  const policy = getWorkflowPolicy(project as { workflowPolicy?: Partial<WorkflowPolicy> | null }) as Record<string, unknown>;
  return ARRAY_ROLES.filter((role) => Array.isArray(policy[role]) && (policy[role] as string[]).includes(id));
}

/** What deleting `id` asks of the owner: a move for its cards, a new value for each single role pointing at it, and an FYI on the array roles that drop it. */
export function deletionPlan(project: RoleProject, id: string, held: { cards: number; archived: number } | undefined) {
  return {
    cards: held?.cards ?? 0,
    archived: held?.archived ?? 0,
    roles: rolesPointingTo(project, id),
    arrays: arrayRolesHolding(project, id),
  };
}
