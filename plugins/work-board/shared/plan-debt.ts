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

/** The refusal of an owner check while the card has debt: the plan can still change what the owner would verify. The next step follows the plan state. */
export function planDebtCheckRefusal(key: string, debt: Pick<PlanDebtInfo, "planVersion" | "planState">): string {
  const next = !debt.planState ? `write it (bb work-board plan set ${key} --file plan.md --base-version 0 --summary "Initial plan"), then submit it: bb work-board plan submit ${key} --reviewer …`
    : debt.planState === "draft" ? `submit it for review: bb work-board plan submit ${key} --reviewer …`
    : debt.planState === "changes_requested" ? `revise it (bb work-board plan edit ${key} … --base-version ${debt.planVersion}), then submit it: bb work-board plan submit ${key} --reviewer …`
    : `wait for the review to finish (bb work-board plan show ${key}); if it asks for changes, revise the plan and submit it again: bb work-board plan submit ${key} --reviewer …`;
  return `Plan debt: ${key} is in work without an approved plan (${planPhrase(debt)}). Owner checks wait for an approved plan; ${next}`;
}

/** The reminder, the same for every recipient and role: it states the debt and the command to clear it. `trigger` is the stored trigger key. */
export function planDebtNotice(key: string, debt: PlanDebtInfo, trigger: string): string {
  const why = trigger === "24h" ? "it has been in work for 24 h" : trigger.startsWith("answer:") ? "a decision was answered on it" : "a PR was linked to it";
  return `Plan debt: ${key} is in work without an approved plan (${planPhrase(debt)}), and ${why}. Submit the plan for review: bb work-board plan submit ${key} --reviewer …`;
}
