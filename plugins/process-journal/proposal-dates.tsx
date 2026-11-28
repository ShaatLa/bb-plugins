import { useState, type FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { Proposal, rpcContract } from "./contract";
import { isOpen } from "./states";
import { dateIn, localMinute, timeOn } from "./time";

const input = "min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = `${input} hover:bg-muted disabled:opacity-50`;
type Dates = Pick<Proposal, "deadlineAt" | "checkAt" | "revision" | "state">;

function startEdit(base: Dates, timeZone: string) {
  const originalDeadline = localMinute(base.deadlineAt, timeZone);
  const originalCheck = base.checkAt === null ? "" : localMinute(base.checkAt, timeZone);
  return { base, timeZone, originalDeadline, originalCheck, deadline: originalDeadline, check: originalCheck };
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

export function ProposalDates({ proposal, timeZone, linked, disabled, refresh }: {
  proposal: Proposal; timeZone: string; linked: boolean; disabled: boolean; refresh: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [edit, setEdit] = useState<ReturnType<typeof startEdit>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!isOpen(proposal.state)) return null;
  if (!edit) return <button type="button" className={button} disabled={disabled} onClick={() => {
    setError("");
    setEdit(startEdit(proposal, timeZone));
  }}>Edit dates</button>;

  const { base, timeZone: zone } = edit;
  const reference = { projectId: proposal.projectId, proposalId: proposal.id };
  const stale = proposal.revision > base.revision || timeZone !== zone;
  const deadline = fieldResolution(edit.deadline, edit.originalDeadline, base.deadlineAt, zone);
  const check = fieldResolution(edit.check, edit.originalCheck, base.checkAt, zone);
  const editableCheck = base.state === "measuring";
  const checkChanged = editableCheck && edit.check !== edit.originalCheck;
  const linkedDateChanged = linked && checkChanged && check.epoch != null
    && (base.checkAt === null || dateIn(check.epoch, zone) !== dateIn(base.checkAt, zone));

  async function reload() {
    setBusy(true);
    setError("");
    try {
      const current = await rpc.call("proposal.detail", reference);
      setEdit(isOpen(current.proposal.state) ? startEdit(current.proposal, timeZone) : undefined);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reload dates");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || stale || disabled) return;
    const deadlineAt = deadline.epoch, checkAt = check.epoch;
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

  return <form aria-label="Edit proposal dates" className="space-y-2 rounded-md border border-border-hairline p-3" onSubmit={submit}>
    <p className="text-xs text-muted-foreground">Project timezone · {zone}</p>
    <div className="flex flex-wrap gap-3">
      <label className="flex min-w-0 flex-col gap-1 text-xs">Deadline
        <input className={input} type="datetime-local" required value={edit.deadline} disabled={busy || disabled}
          onChange={event => setEdit({ ...edit, deadline: event.target.value })} />
        {deadline.resolved && <span className="text-muted-foreground">Resolves to {deadline.resolved.replace("T", " ")}.</span>}
      </label>
      {editableCheck && <label className="flex min-w-0 flex-col gap-1 text-xs">Measurement check
        <input className={input} type="datetime-local" required={base.checkAt !== null} value={edit.check} disabled={busy || disabled}
          onChange={event => setEdit({ ...edit, check: event.target.value })} />
        {check.resolved && <span className="text-muted-foreground">Resolves to {check.resolved.replace("T", " ")}.</span>}
      </label>}
    </div>
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
  </form>;
}
