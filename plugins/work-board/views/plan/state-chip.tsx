import type { PlanState } from "../../shared/plan.js";
import { cn } from "@/lib/utils";

export const PLAN_STATE_LABELS: Record<PlanState, string> = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
};

const TONES: Record<PlanState, string> = {
  draft: "text-muted-foreground",
  in_review: "border-warning/40 text-warning",
  changes_requested: "border-destructive/40 text-destructive",
  approved: "border-success/40 text-success",
};

export function PlanStateChip({ state, className }: { state: PlanState; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium", TONES[state], className)}>
      {PLAN_STATE_LABELS[state]}
    </span>
  );
}
