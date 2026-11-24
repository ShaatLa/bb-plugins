import { useId, useState, type FocusEventHandler, type PointerEventHandler, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "../shared/errors.js";

/** An action's result that ends its write without Saved or Failed, e.g. a refusal the card shows as a conflict. */
export const NOT_SAVED = Symbol("not saved");

type Failure = { error: string; retry: () => void };
/** Writes in flight, the failures still unresolved (one per key), and whether any write has saved. */
export type SaveStatus = { saving: number; failures: Partial<Record<string, Failure>>; saved: boolean };

/**
 * The save status of one card's autosaving controls. `track` runs one write under `key` (one per field or control) and
 * shows Saving…, Saved, or Failed with a Retry that runs `retry` (by default the same write again). A failure stays
 * until a later write of the same key saves or is refused, whatever the other keys do; `forget` drops one whose value
 * was replaced, reloaded, discarded or reverted.
 */
export function useSaveStatus() {
  const [status, setStatus] = useState<SaveStatus>({ saving: 0, failures: {}, saved: false });
  const without = (failures: SaveStatus["failures"], key: string) => {
    const { [key]: _resolved, ...rest } = failures;
    return rest;
  };
  const track = async (action: () => Promise<unknown>, retry?: () => void, key = ""): Promise<boolean> => {
    setStatus((current) => ({ ...current, saving: current.saving + 1 }));
    try {
      const result = await action();
      const saved = result !== NOT_SAVED;
      // A refusal (NOT_SAVED, e.g. a conflict with Reload) replaces the key's failure too: its Retry would be refused.
      setStatus((current) => ({ saving: current.saving - 1, saved: current.saved || saved, failures: without(current.failures, key) }));
      return saved;
    } catch (failure) {
      const entry = { error: errorMessage(failure), retry: retry ?? (() => void track(action, undefined, key)) };
      setStatus((current) => ({ ...current, saving: current.saving - 1, failures: { ...current.failures, [key]: entry } }));
      return false;
    }
  };
  const forget = (key = "") => setStatus((current) => (current.failures[key] ? { ...current, failures: without(current.failures, key) } : current));
  return { status, busy: status.saving > 0, track, forget };
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  const failures = Object.entries(status.failures).filter((entry): entry is [string, Failure] => entry[1] !== undefined);
  if (failures.length) return (
    <span role="alert" className="flex flex-col items-end gap-1 text-xs text-destructive" data-testid="save-status">
      {failures.map(([key, failure]) => (
        <span key={key} className="flex flex-wrap items-center gap-1">
          Failed: {failure.error}
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={failure.retry}>Retry</Button>
        </span>
      ))}
    </span>
  );
  if (!status.saving && !status.saved) return null;
  return <span role="status" className="text-xs text-muted-foreground" data-testid="save-status">{status.saving ? "Saving…" : "Saved"}</span>;
}

/** One settings section: a region named by its `h3` heading, with a one-line description and its controls' save status. */
export function SettingsCard({ title, description, children, actions, status, save, onFocus, onBlur, onPointerDown }: {
  title: string; description: ReactNode; children?: ReactNode; actions?: ReactNode; status?: ReactNode; save?: SaveStatus;
  onFocus?: FocusEventHandler<HTMLElement>; onBlur?: FocusEventHandler<HTMLElement>; onPointerDown?: PointerEventHandler<HTMLElement>;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-lg border border-border bg-background p-4" onFocus={onFocus} onBlur={onBlur} onPointerDown={onPointerDown}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 id={id} className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
          {status}
        </div>
        {actions || save ? <div className="flex flex-wrap items-center gap-2">{save ? <SaveIndicator status={save} /> : null}{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function SelectRow<T extends string>({ label, value, options, disabled, onChange, hint }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; disabled: boolean; onChange: (value: T) => void; hint: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {label}
        <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
          <SelectTrigger aria-label={label} className="h-8 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** A switch with its visible label and, when given, a hint that describes it. */
export function SwitchRow({ label, checked, disabled, onChange, hint, children }: {
  label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; hint?: ReactNode; children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <label htmlFor={id} className="min-w-0 cursor-pointer [overflow-wrap:anywhere]">{label}</label>
        <Switch id={id} aria-label={label} aria-describedby={hint ? `${id}-hint` : undefined} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </div>
      {hint ? <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </div>
  );
}
