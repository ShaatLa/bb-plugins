import { useState } from "react";
import { Icon } from "@/components/ui/icon";

const entries = (text: string) => text.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean);

/**
 * A list of names edited as separate removable chips, like tags on a task. Enter or a comma adds the typed name,
 * a pasted list is split into names, and leaving the field keeps an unfinished name instead of dropping it.
 */
export function TagInput({ id, values, onChange, label, describedBy, placeholder }: {
  id?: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  label: string;
  describedBy?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (text: string) => {
    const added = entries(text);
    if (added.length) onChange([...new Set([...values, ...added])]);
    setDraft("");
  };
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input px-1.5 py-1 focus-within:ring-1 focus-within:ring-ring">
      {values.length ? (
        <ul aria-label={`${label}: added`} className="contents">
          {values.map((value) => (
            <li key={value} className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-border bg-muted py-px pl-2 pr-0.5 text-xs">
              <span className="truncate">{value}</span>
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => onChange(values.filter((entry) => entry !== value))}
              >
                <Icon name="X" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <input
        type="text"
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        placeholder={values.length ? undefined : placeholder}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => add(draft)}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (!/[\n,]/.test(text)) return;
          event.preventDefault();
          add(draft + text);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && draft === "" && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
      />
    </div>
  );
}
