import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { roleIsNullable, type deletionPlan } from "../shared/status-delete.js";
import type { ArrayRole, SingleRole } from "../shared/status-roles.js";
import type { TaskStatusDefinition } from "../shared/statuses.js";

const NONE = "__none__";
export const ROLE_LABELS: Record<SingleRole | ArrayRole, string> = {
  doneStatus: "Done status",
  canceledStatus: "Canceled status",
  inProgressStatus: "In progress status",
  reviewStatus: "Review status",
  testingStatus: "Testing status",
  bugfixStatus: "Bugfix status",
  planningStatus: "Planning status",
  newCardStatus: "New card status",
  readyStatus: "Ready status",
  earlyStatuses: "Early statuses",
  closedStatuses: "Closed statuses",
  notStartedStatuses: "Not-started statuses",
  pilotStatuses: "Pilot statuses",
};

export type StatusDeletion = { statusMoves?: Record<string, string>; roles: Partial<Record<SingleRole, string | null>> };

/**
 * The one dialog behind deleting a status. It shows only the parts that apply: a move for the cards still in it, a new
 * value for each single workflow role pointing at it, and a note on the array roles that simply drop it. Delete stays
 * disabled until every picker shown has a value, then sends everything in one request.
 */
export function DeleteStatusDialog({ status, plan, remaining, pending, error, onCancel, onDelete }: {
  status: TaskStatusDefinition;
  plan: ReturnType<typeof deletionPlan>;
  /** The statuses the project keeps. */
  remaining: readonly TaskStatusDefinition[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onDelete: (deletion: StatusDeletion) => void;
}) {
  const [moveTo, setMoveTo] = useState("");
  const [roleValues, setRoleValues] = useState<Partial<Record<SingleRole, string>>>({});
  const ready = (plan.cards === 0 || moveTo !== "") && plan.roles.every((role) => roleValues[role] !== undefined);
  const options = (nullable: boolean) => (
    <SelectContent>
      {nullable ? <SelectItem value={NONE}>None</SelectItem> : null}
      {remaining.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
    </SelectContent>
  );
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {status.name}</DialogTitle>
          <DialogDescription>Choose what replaces it before it is deleted.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {plan.cards > 0 ? (
            <div className="space-y-1.5">
              <p>
                {plan.cards} {plan.cards === 1 ? "card is" : "cards are"} in {status.name}
                {plan.archived > 0 ? ` (${plan.archived} archived)` : ""}. Move {plan.cards === 1 ? "it" : "them"} to:
              </p>
              <Select value={moveTo} onValueChange={setMoveTo}>
                <SelectTrigger aria-label="Move cards to" className="h-8"><SelectValue placeholder="Choose a status" /></SelectTrigger>
                {options(false)}
              </Select>
            </div>
          ) : null}
          {plan.roles.map((role) => (
            <div key={role} className="space-y-1.5">
              <p>{ROLE_LABELS[role]} is {status.name}. Use instead:</p>
              <Select value={roleValues[role] ?? ""} onValueChange={(value) => setRoleValues((current) => ({ ...current, [role]: value }))}>
                <SelectTrigger aria-label={ROLE_LABELS[role]} className="h-8"><SelectValue placeholder="Choose a status" /></SelectTrigger>
                {options(roleIsNullable(role))}
              </Select>
            </div>
          ))}
          {plan.arrays.length > 0 ? (
            <p className="text-xs text-muted-foreground">{status.name} will also be removed from {plan.arrays.map((role) => ROLE_LABELS[role]).join(", ")}.</p>
          ) : null}
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>Cancel</Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || !ready}
            onClick={() => onDelete({
              ...(plan.cards > 0 ? { statusMoves: { [status.id]: moveTo } } : {}),
              roles: Object.fromEntries(plan.roles.map((role) => [role, roleValues[role] === NONE ? null : roleValues[role]!])),
            })}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
