import * as Checkbox from "@radix-ui/react-checkbox";
import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { useTasksQuery, useTasksRpc } from "../shell/data.js";
import { BADGE_CRITERIA, BADGE_CRITERION_LABELS, type BadgeCriterion } from "../shared/badge.js";
import { errorMessage } from "../shared/errors.js";

/** Collapsed block in Work Board settings choosing what the navigation badge counts. */
export function NavigationBadgeSettings() {
  const rpc = useTasksRpc();
  const query = useTasksQuery(
    async (rpc) => (await rpc.call("getNavigationBadgeCriteria", null)).criteria,
    ["badge:changed"],
  );
  const [pending, setPending] = useState<BadgeCriterion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = pending ?? query.data ?? [];

  const toggle = async (criterion: BadgeCriterion, checked: boolean) => {
    const next = checked ? [...selected, criterion] : selected.filter((entry) => entry !== criterion);
    setPending(next);
    try {
      await rpc.call("setNavigationBadgeCriteria", { criteria: next });
      setError(null);
      query.refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(null);
    }
  };

  return (
    <details className="group rounded-md border border-border text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Icon
          name="ChevronRight"
          className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"
        />
        Navigation badge
      </summary>
      <div className="space-y-2 border-t border-border-hairline p-3">
        <p className="text-muted-foreground">
          The Work Board badge counts tasks matching any selected option. A task that matches several counts once.
          Done, canceled and archived tasks are never counted.
        </p>
        <div role="group" aria-label="Navigation badge counts">
          {BADGE_CRITERIA.map((criterion) => (
            <label
              key={criterion}
              className="flex cursor-pointer items-center gap-2.5 rounded px-1 py-1.5 hover:bg-state-hover"
            >
              <Checkbox.Root
                aria-label={BADGE_CRITERION_LABELS[criterion]}
                checked={selected.includes(criterion)}
                disabled={query.data === undefined || pending !== null}
                onCheckedChange={(checked) => void toggle(criterion, checked === true)}
                className="flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-input outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background"
              >
                <Checkbox.Indicator>
                  <Icon name="Check" className="size-3" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              <span>{BADGE_CRITERION_LABELS[criterion]}</span>
            </label>
          ))}
        </div>
        <p className="text-muted-foreground">
          The idle-thread option uses the threshold in the plugin setting “Flag idle threads without task updates”.
        </p>
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
