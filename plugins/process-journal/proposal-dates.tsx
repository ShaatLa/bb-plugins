import { useState, type FormEvent, type ReactNode } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { Proposal, rpcContract } from "./contract";
import { isOpen } from "./states";
import { dateIn, localMinute, timeOn } from "./time";

const input = "min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = `${input} hover:bg-muted disabled:opacity-50`;
type DateField = "deadline" | "check";
type Dates = Pick<Proposal, "deadlineAt" | "checkAt" | "revision" | "state">;

function startEdit(base: Dates, timeZone: string, fields: DateField[]) {
  const originalDeadline = localMinute(base.deadlineAt, timeZone);
  const originalCheck = base.checkAt === null ? "" : localMinute(base.checkAt, timeZone);
  return { base, timeZone, fields, originalDeadline, originalCheck, deadline: originalDeadline, check: originalCheck };
}

function resolveLocal(value: string, timeZone: string) {
  if (!value) return undefined;
  try {
    const [date, time] = value.split("T");
    return date && time ? timeOn(date, time, timeZone) : undefined;
  } catch {
    return undefined;
  }
}

function fieldResolution(value: string, original: string, epoch: number | null, timeZone: string) {
  if (value === original) return { epoch, resolved: undefined };
  const changed = resolveLocal(value, timeZone);
  const local = changed === undefined ? undefined : localMinute(changed, timeZone);
  return { epoch: changed, resolved: local === value ? undefined : local };
}

export function ProposalDates({ proposal, timeZone, linked, disabled, refresh, date, children }: {
  proposal: Proposal; timeZone: string; linked: boolean; disabled: boolean; refresh: () => void;
  date: (at: number) => string; children: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [edit, setEdit] = useState<ReturnType<typeof startEdit>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const open = isOpen(proposal.state);
  const measuring = proposal.state === "measuring";
  const base = edit?.base ?? proposal;
  const zone = edit?.timeZone ?? timeZone;
  const reference = { projectId: proposal.projectId, proposalId: proposal.id };
  const stale = !!edit && (proposal.revision > base.revision || timeZone !== zone);
  const deadline = edit ? fieldResolution(edit.deadline, edit.originalDeadline, base.deadlineAt, zone) : undefined;
  const check = edit ? fieldResolution(edit.check, edit.originalCheck, base.checkAt, zone) : undefined;
  const checkChanged = !!edit && measuring && edit.check !== edit.originalCheck;
  const linkedDateChanged = linked && checkChanged && check?.epoch != null
    && (base.checkAt === null || dateIn(check.epoch, zone) !== dateIn(base.checkAt, zone));

  function openField(field: DateField) {
    if (!edit) setError("");
    setEdit(current => current ? { ...current, fields: [...current.fields, field] } : startEdit(proposal, timeZone, [field]));
  }

  function field(key: DateField, label: string, at: number | null, editable: boolean) {
    const active = editable && edit?.fields.includes(key);
    const resolved = key === "deadline" ? deadline?.resolved : check?.resolved;
    return <div className="min-w-0">
      <dt className="mb-0.5 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-h-8 flex-wrap items-center gap-1.5">
        {active && edit ? <>
          <input aria-label={label} autoFocus className={input} type="datetime-local" required={key === "deadline" || at !== null}
            value={edit[key]} disabled={busy || disabled} onChange={event => {
              const value = event.target.value;
              setEdit(current => current && { ...current, [key]: value });
            }} />
          {resolved && <span className="basis-full text-xs text-muted-foreground">Resolves to {resolved.replace("T", " ")}.</span>}
        </> : <>
          <span>{at === null ? "Not set" : date(at)}</span>
          {editable && <button type="button" aria-label={`Edit ${label.toLowerCase()}`} title={`Edit ${label.toLowerCase()}`}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            disabled={busy || disabled} onClick={() => openField(key)}>
            <Icon name="Pencil" aria-hidden className="size-3.5" />
          </button>}
        </>}
      </dd>
    </div>;
  }

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const current = await rpc.call("proposal.detail", reference);
      setEdit(draft => draft && isOpen(current.proposal.state) ? startEdit(current.proposal, timeZone, draft.fields) : undefined);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reload dates");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!edit || !open || busy || stale || disabled) return;
    const deadlineAt = deadline?.epoch, checkAt = check?.epoch;
    if (deadlineAt == null || (checkChanged && checkAt == null)) {
      setError("Enter a valid deadline and measurement check.");
      return;
    }
    const patch = {
      ...(deadlineAt === base.deadlineAt ? {} : { deadlineAt }),
      ...(checkChanged && checkAt != null && checkAt !== base.checkAt ? { checkAt } : {}),
    };
    if (Object.values(patch).some(value => value <= Date.now())) {
      setError("Changed dates must be in the future.");
      return;
    }
    if (checkAt != null && checkAt >= deadlineAt) {
      setError("The measurement check must be before the deadline.");
      return;
    }
    if (Object.keys(patch).length === 0) {
      setEdit(undefined);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await rpc.call("proposal.update", { ...reference, revision: base.revision, patch });
      setEdit(undefined);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save dates");
      refresh();
    } finally {
      setBusy(false);
    }
  }

  return <form aria-label={edit && open ? "Edit proposal dates" : undefined}
    className="rounded-md border border-border-hairline bg-muted/25 px-3 py-2.5 text-sm" onSubmit={submit}>
    <dl className="flex flex-wrap items-start gap-x-6 gap-y-3">
      {children}
      {field("deadline", open ? "Deadline" : "Closed", proposal.deadlineAt, open)}
      {(measuring || proposal.checkAt !== null) && field("check", "Measurement check", proposal.checkAt, measuring)}
    </dl>
    {edit && open && <div className="mt-2 space-y-2">
      <p className="text-xs text-muted-foreground">Project timezone · {zone}</p>
      {linkedDateChanged && <p className="text-xs text-muted-foreground">
        The next Work Board reconciliation can update the linked card’s due date or show a conflict if it also changed.
      </p>}
      {(error || stale) && <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="text-sm text-destructive">{stale ? "Proposal dates changed. Reload before saving." : error}</p>
        <button type="button" className={button} disabled={busy || disabled} onClick={() => void reload()}>Reload dates</button>
      </div>}
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy || stale || disabled}>Save dates</button>
        <button type="button" className={button} disabled={busy} onClick={() => setEdit(undefined)}>Cancel</button>
      </div>
    </div>}
  </form>;
}
