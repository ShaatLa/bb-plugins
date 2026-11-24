import { useId, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

/** One settings section: a region named by its `h3` heading, with a one-line description. */
export function SettingsCard({ title, description, children, actions, status }: {
  title: string; description: ReactNode; children?: ReactNode; actions?: ReactNode; status?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4 rounded-lg border border-border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 id={id} className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
          {status}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
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

/** A switch with its visible label and a hint that describes it. */
export function SwitchRow({ label, checked, disabled, onChange, hint }: {
  label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; hint: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <label htmlFor={id} className="min-w-0 cursor-pointer [overflow-wrap:anywhere]">{label}</label>
        <Switch id={id} aria-label={label} aria-describedby={`${id}-hint`} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
