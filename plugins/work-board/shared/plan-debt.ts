import type { PlanState } from "./plan";
import { planningRequired } from "./project-settings";
import { inWorkZone, isClosedStatus, type WorkflowPolicy } from "./workflow-policy";

/** How long a card may stay in the work zone with debt before its executors, and the manager, are reminded. */
export const PLAN_DEBT_REMINDER_MS = 24 * 3_600_000;

type DebtProject = { planning?: string | null; workflowPolicy?: Partial<WorkflowPolicy> | null; statuses?: ReadonlyArray<{ id: string; requiresApprovedPlan?: boolean }> | null };
type DebtTask = { type: string; status: string; archivedAt?: string | null };

/** Plan debt: an open (not Done, configured-done or canceled) card in the work zone of a required-planning project whose plan is missing or not approved. Every surface and trigger asks this. */
export function hasPlanDebt(project: DebtProject, task: DebtTask, planState: PlanState | null): boolean {
  return planningRequired(project) && task.type !== "epic" && !task.archivedAt && !isClosedStatus(project, task.status) && inWorkZone(project, task.status) && planState !== "approved";
}

export interface PlanDebtInfo { since: string; planVersion: number | null; planState: PlanState | null }

const stateLabel = (state: PlanState) => state.replace("_", " ");
const planPhrase = (debt: Pick<PlanDebtInfo, "planVersion" | "planState">) => (debt.planState && debt.planVersion !== null ? `plan v${debt.planVersion} is ${stateLabel(debt.planState)}` : "no plan");

export function planDebtText(key: string, debt: PlanDebtInfo): string {
  return `Plan debt since ${debt.since}: ${planPhrase(debt)}. Submit it for review: bb work-board plan submit ${key} --reviewer …`;
}

/** The reminder an executor (or, for `24h`, the manager) receives. `trigger` is the stored trigger key. */
export function planDebtNotice(key: string, debt: PlanDebtInfo, trigger: string, forManager: boolean): string {
  const why = trigger === "24h" ? "it has been in work for 24 h" : trigger.startsWith("answer:") ? "a decision was answered on it" : "a PR was linked to it";
  return forManager
    ? `Plan debt: ${key} has been in work without an approved plan since ${debt.since} (${planPhrase(debt)}). The plan is still outstanding.`
    : `Plan debt: ${key} is in work without an approved plan (${planPhrase(debt)}), and ${why}. Submit the plan for review: bb work-board plan submit ${key} --reviewer …`;
}
