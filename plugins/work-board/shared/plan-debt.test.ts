import { describe, expect, it } from "vitest";
import { hasPlanDebt, planDebtNotice, planDebtText } from "./plan-debt";

const flagged = [{ id: "todo" }, { id: "in_progress", requiresApprovedPlan: true }, { id: "done", requiresApprovedPlan: true }];
const project = { planning: "required", statuses: flagged };
const card = { type: "task", status: "in_progress", archivedAt: null };

describe("the plan-debt definition", () => {
  it("holds for a card in the work zone of a required-planning project whose plan is missing or not approved", () => {
    for (const plan of [null, "draft", "in_review", "changes_requested"] as const) expect(hasPlanDebt(project, card, plan)).toBe(true);
    expect(hasPlanDebt(project, card, "approved")).toBe(false);
  });

  it("needs the zone, required planning, a non-epic and a card that is not archived", () => {
    expect(hasPlanDebt(project, { ...card, status: "todo" }, null)).toBe(false);
    expect(hasPlanDebt({ ...project, planning: "optional" }, card, null)).toBe(false);
    expect(hasPlanDebt({ ...project, planning: "off" }, card, null)).toBe(false);
    expect(hasPlanDebt({ ...project, planning: null }, card, null)).toBe(false);
    expect(hasPlanDebt(project, { ...card, type: "epic" }, null)).toBe(false);
    expect(hasPlanDebt(project, { ...card, archivedAt: "2026-01-01T00:00:00.000Z" }, null)).toBe(false);
    expect(hasPlanDebt({ planning: "required", statuses: null }, card, null)).toBe(false);
  });

  it("never holds for a closed card, even in a marked closed status", () => {
    expect(hasPlanDebt(project, { ...card, status: "done" }, "draft")).toBe(false);
    expect(hasPlanDebt(project, { ...card, status: "canceled" }, null)).toBe(false);
    const custom = { ...project, workflowPolicy: { doneStatus: "shipped" }, statuses: [...flagged, { id: "shipped", requiresApprovedPlan: true }] };
    expect(hasPlanDebt(custom, { ...card, status: "shipped" }, null)).toBe(false);
    expect(hasPlanDebt(custom, card, null)).toBe(true);
  });

  it("words the advisory and the reminders from the plan as it is now", () => {
    expect(planDebtText("EXA-1", { since: "2026-01-01T00:00:00.000Z", planVersion: 2, planState: "in_review" })).toBe("Plan debt since 2026-01-01T00:00:00.000Z: plan v2 is in review. Submit it for review: bb work-board plan submit EXA-1 --reviewer …");
    expect(planDebtText("EXA-1", { since: "s", planVersion: null, planState: null })).toContain(": no plan.");
    const debt = { since: "s", planVersion: 1, planState: "draft" as const };
    expect(planDebtNotice("EXA-1", debt, "24h", false)).toContain("it has been in work for 24 h");
    expect(planDebtNotice("EXA-1", debt, "answer:q:2", false)).toContain("a decision was answered on it");
    expect(planDebtNotice("EXA-1", debt, "pr:owner/repo#1", false)).toContain("a PR was linked to it");
    expect(planDebtNotice("EXA-1", debt, "24h", true)).toContain("Its executors were reminded");
  });
});
