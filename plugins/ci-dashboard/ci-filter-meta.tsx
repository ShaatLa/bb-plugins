import type { ReactNode } from "react";
import { ChevronSelect } from "./components/ui/chevron-select";
import type { CiFilter } from "./ci-filter";

/** The second header line of a card: `Workflow ▾ · Event ▾ · notes`, muted, wrapping. The pickers read and write the one shared choice. */
export function FilterMeta({ filter, label, pickers, notes }: { filter: CiFilter; label: string; pickers: boolean; notes: ReactNode[] }) {
  const { workflows, workflow, events, event } = filter;
  const items: ReactNode[] = [];
  if (pickers && workflows.length > 0) items.push(<span key="workflow" className="inline-flex items-center gap-1">Workflow
    <ChevronSelect label={`${label} workflow`} value={workflow ? String(workflow.id) : "all"} className="text-xs text-muted-foreground hover:text-foreground" onChange={(value) => filter.setWorkflow(value === "all" ? "all" : Number(value))}>
      <option value="all">All workflows</option>
      {workflows.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </ChevronSelect></span>);
  if (pickers && events.length > 0) items.push(<span key="event" className="inline-flex items-center gap-1">Event
    <ChevronSelect label={`${label} event`} value={event} className="text-xs text-muted-foreground hover:text-foreground" onChange={filter.setEvent}>
      <option value="all">All events</option>
      {events.map((entry) => <option key={entry.event} value={entry.event}>{entry.event} · {entry.total.toLocaleString()} {entry.total === 1 ? "run" : "runs"}</option>)}
    </ChevronSelect></span>);
  items.push(...notes);
  return items.length > 0 ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    {/* The separator wraps with the item after it, so no line ends on a lone dot. */}
    {items.map((node, index) => index ? <span key={index} className="inline-flex items-center gap-x-2"><span aria-hidden="true">·</span>{node}</span> : node)}
  </div> : null;
}
