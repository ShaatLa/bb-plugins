import { useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const arrow = "grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

export function ProposalCalendar({ value, today, onChange }: {
  value: string; today: string; onChange: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => Temporal.PlainDate.from(value || today).with({ day: 1 }));
  const title = month.toLocaleString("en", { month: "long", year: "numeric" });

  return <div className="space-y-1">
    <div className="flex items-center justify-between gap-2">
      <button type="button" className={arrow} aria-label="Previous month" onClick={() => setMonth(month.subtract({ months: 1 }))}>
        <Icon name="ChevronLeft" aria-hidden className="size-4" />
      </button>
      <h3 aria-live="polite" className="text-sm font-medium">{title}</h3>
      <button type="button" className={arrow} aria-label="Next month" onClick={() => setMonth(month.add({ months: 1 }))}>
        <Icon name="ChevronRight" aria-hidden className="size-4" />
      </button>
    </div>
    <div role="group" aria-label={title} className="grid grid-cols-7 gap-0.5">
      {weekdays.map(day => <span key={day} aria-hidden className="p-1 text-center text-xs text-muted-foreground">{day}</span>)}
      {Array.from({ length: month.daysInMonth }, (_, index) => {
        const day = month.with({ day: index + 1 });
        const iso = day.toString();
        return <button type="button" key={iso} disabled={iso < today} aria-pressed={iso === value}
          aria-current={iso === today ? "date" : undefined}
          aria-label={day.toLocaleString("en", { dateStyle: "long" })}
          style={index === 0 ? { gridColumnStart: day.dayOfWeek % 7 + 1 } : undefined}
          className="h-8 rounded-md text-sm tabular-nums hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
          onClick={() => onChange(iso)}>{day.day}</button>;
      })}
    </div>
  </div>;
}
