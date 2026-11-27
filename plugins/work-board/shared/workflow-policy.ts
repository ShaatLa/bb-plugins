import { z } from "zod";
import { DEFAULT_TASK_STATUSES, taskStatusSchema } from "./statuses.js";
import { isNotStarted, resolveRoles, ROLE_DEFAULTS } from "./status-roles.js";

export const workflowPolicySchema = z.object({
  bugfixStatus: taskStatusSchema.nullable().default(ROLE_DEFAULTS.bugfixStatus),
  doneStatus: taskStatusSchema.nullable().default(ROLE_DEFAULTS.doneStatus),
  inProgressStatus: taskStatusSchema.nullable().default(ROLE_DEFAULTS.inProgressStatus),
  reviewStatus: taskStatusSchema.nullable().default(ROLE_DEFAULTS.reviewStatus),
  testingStatus: taskStatusSchema.nullable().default(ROLE_DEFAULTS.testingStatus),
  /** The status a card sits in while a session plans it; null turns the automatic move off. Valid only as `planningStatusOf` says. */
  planningStatus: taskStatusSchema.nullable().default(null),
  earlyStatuses: z.array(taskStatusSchema).default([...ROLE_DEFAULTS.earlyStatuses]),
  // The roles below have no schema default on purpose: an omitted role resolves at read time (`resolveRoles`) and is never
  // written back, so a later status list change moves it. Only a project that sets one stores it.
  /** The status a card is closed as canceled in; never plan-gated. Null: no such status. */
  canceledStatus: taskStatusSchema.nullable().optional(),
  /** Every closed status; the done and canceled roles are always closed as well. */
  closedStatuses: z.array(taskStatusSchema).optional(),
  /** The statuses a card has not been started in: start hints, start moves, the stale-status scope. */
  notStartedStatuses: z.array(taskStatusSchema).optional(),
  /** The status of a new card made through the API and the CLI. */
  newCardStatus: taskStatusSchema.optional(),
  /** The status the new-task dialog and a new subtask start in; null means the new-card status. */
  readyStatus: taskStatusSchema.nullable().optional(),
  /** The statuses the stale-status and pause pilot covers. */
  pilotStatuses: z.array(taskStatusSchema).optional(),
  ownerDecisionLabel: z.string().trim().min(1).max(100).nullable().default("owner decision"),
}).strict();

export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;
const MAX_STATUSES = 32;
export function getWorkflowPolicy(project: { workflowPolicy?: Partial<WorkflowPolicy> | null }): WorkflowPolicy {
  return workflowPolicySchema.parse(project.workflowPolicy ?? {});
}

/** A card is closed in the project's closed statuses (see `resolveRoles`): the closed array, the done and the canceled status. */
export function isClosedStatus(project: { workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string }> | null }, status: string): boolean {
  return resolveRoles(project).closed.includes(status);
}

/**
 * The status that means "in progress" for a project: the policy's `inProgressStatus` when it is set, else the default In progress status
 * when the project has that status, else none (a project without one has no plan gate and no automatic move).
 */
export function effectiveInProgressStatus(project: { workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string }> | null }): string | null {
  return resolveRoles({ workflowPolicy: getWorkflowPolicy(project), statuses: project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES }).inProgress;
}

/**
 * Where a card in `fromStatus` moves when work on it (or on a child of it) starts: the effective In progress status, only
 * when it is listed, neither closed nor Backlog/Todo, and strictly after a listed, open `fromStatus` in the status order.
 * Null otherwise, so an unusable mapping is skipped instead of failing anything.
 */
export function usableStartTarget(project: { workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string }> | null }, fromStatus: string): string | null {
  const target = effectiveInProgressStatus(project);
  if (!target || isNotStarted(project, target) || isClosedStatus(project, target) || isClosedStatus(project, fromStatus)) return null;
  const order = (project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES).map((status) => status.id);
  const from = order.indexOf(fromStatus);
  return from >= 0 && order.indexOf(target) > from ? target : null;
}

type ZoneProject = { workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string; requiresApprovedPlan?: boolean }> | null };

/**
 * Whether `id` can serve as the planning status of this project right now: it is listed, not closed, not another workflow
 * role (In progress, review, testing, done, bugfix) and not marked "only with an approved plan".
 */
export function isPlanningTarget(project: ZoneProject, id: string): boolean {
  const entry = (project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES).find((status) => status.id === id) as { requiresApprovedPlan?: boolean } | undefined;
  if (!entry || entry.requiresApprovedPlan === true || isClosedStatus(project, id)) return false;
  const policy = getWorkflowPolicy(project);
  return ![effectiveInProgressStatus(project), policy.inProgressStatus, policy.reviewStatus, policy.testingStatus, policy.doneStatus, policy.bugfixStatus].includes(id);
}

/** The configured planning status while it is a valid target (read at every use, so later settings edits count), else null. */
export function planningStatusOf(project: ZoneProject): string | null {
  const id = getWorkflowPolicy(project).planningStatus;
  return id && isPlanningTarget(project, id) ? id : null;
}

/** The statuses a delegated card leaves for In progress: Backlog, Todo and, while it is a valid target, the planning status. */
export function startsFromStatus(project: ZoneProject, status: string): boolean {
  return isNotStarted(project, status) || (planningStatusOf(project) !== null && status === planningStatusOf(project));
}

/**
 * Settles the planning status of a project whose planning is on, without writing anything. `planningStatus` is the valid
 * target, or null when there is none (the caller then leaves the policy alone and the automatic move stays off; `reason`
 * says why). Cases in order: a valid target already set is kept; a status with the id `planning`, then one named
 * "Planning", is used when it is valid; when either is taken by an invalid status nothing is inserted (a duplicate name is
 * refused by the status rules; both candidates are judged before insertion is blocked); only when both are free, the list has room and In progress is present, an unmarked
 * "Planning" is inserted right before In progress.
 */
export function ensurePlanningStatus<S extends { id: string; name: string; requiresApprovedPlan?: boolean }>(project: {
  workflowPolicy?: Partial<WorkflowPolicy> | null;
  statuses?: readonly S[] | null;
}): { statuses: S[]; planningStatus: string | null; reason: string | null } {
  const list = (project.statuses?.length ? project.statuses : DEFAULT_TASK_STATUSES) as readonly S[];
  const keep = (planningStatus: string | null, reason: string | null = null, statuses: S[] = [...list]) => ({ statuses, planningStatus, reason });
  const current = planningStatusOf({ ...project, statuses: list });
  if (current) return keep(current);
  // Both candidates are judged, in order: an unusable `planning` id must not mask a usable status named Planning.
  const taken = [list.find((status) => status.id === "planning"), list.find((status) => status.name.toLowerCase() === "planning")].filter((status) => status !== undefined);
  const usable = taken.find((status) => isPlanningTarget({ ...project, statuses: list }, status.id));
  if (usable) return keep(usable.id);
  if (taken.length) return keep(null, `status "${taken[0]!.name}" (${taken[0]!.id}) is taken but cannot be a planning status`);
  const start = effectiveInProgressStatus({ ...project, statuses: list });
  const at = start ? list.findIndex((status) => status.id === start) : -1;
  if (at < 0) return keep(null, "the project has no In progress status to put Planning before");
  if (list.length >= MAX_STATUSES) return keep(null, `the status list already holds ${MAX_STATUSES} statuses`);
  const inserted = [...list.slice(0, at), { id: "planning", name: "Planning" } as S, ...list.slice(at)];
  // The new column must pass the same role rules, or Planning would close cards (a policy can already map `planning` to Done).
  if (!isPlanningTarget({ ...project, statuses: inserted }, "planning")) return keep(null, "the id planning is already assigned to a workflow role");
  return keep("planning", null, inserted);
}

/** The policy with `planningStatus` set; the same policy when there is nothing to set or it already holds. */
export function withPlanningStatus(policy: Partial<WorkflowPolicy> | null | undefined, planningStatus: string | null): WorkflowPolicy | null {
  if (planningStatus === null) return policy == null ? null : getWorkflowPolicy({ workflowPolicy: policy });
  return getWorkflowPolicy({ workflowPolicy: { ...policy, planningStatus } });
}

/** The statuses the owner marked "only with an approved plan". The canceled status can never be marked. */
export function planGatedStatuses(project: ZoneProject): string[] {
  const canceled = resolveRoles(project).canceled;
  return (project.statuses ?? []).filter((status) => status.requiresApprovedPlan === true && status.id !== canceled).map((status) => status.id);
}

/** The work zone of a project: its statuses marked "only with an approved plan". Column order does not matter. */
export function inWorkZone(project: ZoneProject, status: string): boolean {
  return planGatedStatuses(project).includes(status);
}

/** The old position rule, used only to prefill the flags: the effective In progress status and every later one, except the canceled status. */
export function inPositionZone(project: ZoneProject, status: string): boolean {
  const start = effectiveInProgressStatus(project);
  if (!start || status === resolveRoles(project).canceled) return false;
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
 * The statuses with their "only with an approved plan" flags settled; a flag is kept only when true, and the canceled status is
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
  const canceled = resolveRoles({ workflowPolicy, statuses: input.statuses }).canceled;
  const edited = input.statuses.some((status) => status.id !== canceled && status.requiresApprovedPlan !== undefined && status.requiresApprovedPlan !== (before.get(status.id) ?? false));
  const marked = input.statuses.map((status) => status.requiresApprovedPlan ?? before.get(status.id) ?? (planning === "required" && byPosition(status.id)));
  const prefill = planning === "required" && !input.initialized && !edited;
  const settled = input.statuses.map((status, index) => {
    const { requiresApprovedPlan: _flag, ...rest } = status;
    const flag = status.id !== canceled && (prefill ? byPosition(status.id) : marked[index]);
    return (flag ? { ...rest, requiresApprovedPlan: true } : rest) as T;
  });
  return { statuses: settled, initialized: input.initialized || edited || prefill };
}
