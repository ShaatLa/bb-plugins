import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import * as Popover from "@radix-ui/react-popover";
import type { Proposal, rpcContract } from "./contract";
import { overlayScope } from "./controls";
import { ProposalCalendar } from "./proposal-calendar";
import { isOpen } from "./states";
import { dateIn, localMinute, timeOn } from "./time";

type DateField = "deadline" | "check";
const labels = { deadline: "Deadline", check: "Measurement check" };
type DateDraft = {
  revision: number; zone: string; field: DateField; value: string;
};

function resolveLocal(value: string, zone: string) {
  if (!value) return undefined;
  try {
    const [day, time] = value.split("T");
    return day && time ? timeOn(day, time, zone) : undefined;
  } catch {
    return undefined;
  }
}

export function ProposalDates({ proposal, timeZone, linked, disabled, refresh, date, children }: {
  proposal: Proposal; timeZone: string; linked: boolean; disabled: boolean; refresh: () => void;
  date: (at: number) => string; children: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [anchor, setAnchor] = useState<DateField>();
  const [draft, setDraft] = useState<DateDraft>();
  const [saved, setSaved] = useState<Proposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = saved && saved.revision > proposal.revision ? saved : proposal;
  const open = isOpen(current.state);
  const measuring = current.state === "measuring";
  const today = dateIn(Date.now(), timeZone);
  const deadline = localMinute(current.deadlineAt, timeZone);
  const check = current.checkAt === null ? "" : localMinute(current.checkAt, timeZone);
  const stale = !!draft && (draft.revision !== current.revision || draft.zone !== timeZone);

  function show(field: DateField) {
    setAnchor(field);
    if (draft?.field !== field || stale) {
      setDraft({ revision: current.revision, zone: timeZone, field, value: field === "deadline" ? deadline : check });
    }
    setError("");
  }

  async function save() {
    setAnchor(undefined);
    if (!draft || !open || busy || disabled) return;
    if (stale) {
      setDraft(undefined);
      setError("Proposal dates changed. Reopen the calendar before editing.");
      refresh();
      return;
    }
    const editingDeadline = draft.field === "deadline";
    if (draft.value === (editingDeadline ? deadline : check)) {
      setDraft(undefined);
      return;
    }
    const at = resolveLocal(draft.value, timeZone);
    if (at === undefined) {
      setError("Enter a valid date and time.");
      return;
    }
    if (at === (editingDeadline ? current.deadlineAt : current.checkAt)) {
      setDraft(undefined);
      return;
    }
    if (at <= Date.now()) {
      setError("Changed dates must be in the future.");
      return;
    }
    const deadlineAt = editingDeadline ? at : current.deadlineAt;
    const checkAt = editingDeadline ? current.checkAt : at;
    if (checkAt != null && checkAt >= deadlineAt) {
      setError("The measurement check must be before the deadline.");
      return;
    }
    const patch = editingDeadline ? { deadlineAt: at } : { checkAt: at };
    setBusy(true);
    setError("");
    try {
      const result = await rpc.call("proposal.update", {
        projectId: current.projectId, proposalId: current.id, revision: draft.revision, patch,
      });
      setSaved(result);
      setDraft(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save dates");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  function editor(edit: DateDraft) {
    const { value } = edit;
    const [day, time] = value.split("T");
    const epoch = resolveLocal(value, edit.zone);
    const resolved = epoch === undefined ? value : localMinute(epoch, edit.zone);
    const setValue = (value: string) => setDraft(latest => latest && { ...latest, value });
    const linkedDay = linked && edit.field === "check" && !!day && day !== check.split("T")[0];
    return <>
      <ProposalCalendar key={edit.field} value={day ?? ""} today={today}
        onChange={day => setValue(`${day}T${time ?? localMinute(Date.now(), edit.zone).split("T")[1]}`)} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {labels[edit.field]} time
        <input type="time" value={time ?? ""} className="min-w-0 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground [&::-webkit-calendar-picker-indicator]:hidden"
          onChange={event => setValue(`${day || today}T${event.target.value}`)} />
      </label>
      <p className="text-xs text-muted-foreground">Project timezone · {edit.zone}</p>
      {resolved !== value && <p className="text-xs text-muted-foreground">Resolves to {resolved.replace("T", " ")}.</p>}
      {linkedDay && <p className="text-xs text-muted-foreground">Work Board can update the linked card’s due date on the next reconciliation.</p>}
    </>;
  }

  function field(key: DateField, label: string, at: number | null, editable: boolean) {
    const row = <dd className="flex min-h-8 flex-wrap items-center gap-1.5">
      <span>{at === null ? "Not set" : date(at)}</span>
      {editable && <Popover.Trigger type="button" aria-label={`Edit ${label.toLowerCase()}`} title={`Edit ${label.toLowerCase()}`}
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        disabled={busy || disabled}>
        <Icon name="Edit" aria-hidden className="size-3.5" />
      </Popover.Trigger>}
    </dd>;
    return <div className="min-w-0">
      <dt className="mb-0.5 text-xs text-muted-foreground">{label}</dt>
      {editable ? <Popover.Root open={anchor === key}
        onOpenChange={next => { if (next) show(key); else void save(); }}>
        <Popover.Anchor asChild>{row}</Popover.Anchor>
        {anchor === key && draft && <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} collisionPadding={8} {...overlayScope} aria-label={`${label} calendar`}
            className="z-50 max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-1rem)] space-y-2 overflow-auto rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lift"
            onEscapeKeyDown={event => {
              event.preventDefault();
              setAnchor(undefined);
              setDraft(undefined);
            }}
            onKeyDown={event => {
              if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
                event.preventDefault();
                void save();
              }
            }}>
            {editor(draft)}
          </Popover.Content>
        </Popover.Portal>}
      </Popover.Root> : row}
    </div>;
  }

  return <div className="rounded-md border border-border-hairline bg-muted/25 px-3 py-2.5 text-sm">
    <dl className="flex flex-wrap items-start gap-x-6 gap-y-3">
      {children}
      {field("deadline", open ? labels.deadline : "Closed", current.deadlineAt, open)}
      {(measuring || current.checkAt !== null) && field("check", labels.check, current.checkAt, measuring)}
    </dl>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </div>;
}
