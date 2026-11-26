import type { CSSProperties, ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { chevronClass } from "./summary";

/** A borderless select that reads as text, with a chevron so it still looks like a control. At least 24 px tall; long names wrap the line, never get cut. */
export function ChevronSelect({ id, label, value, onChange, className, children }: {
  id?: string; label: string; value: string; onChange: (value: string) => void; className: string; children: ReactNode;
}) {
  // Padding on both sides of the hover background; the negative margin keeps the text aligned with the lines below.
  return <span className="relative -ml-1 inline-flex max-w-full items-center">
    <select id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} style={{ fieldSizing: "content" } as CSSProperties}
      className={`min-h-6 max-w-full cursor-pointer appearance-none rounded-sm bg-transparent py-0.5 pl-1 pr-6 outline-none hover:bg-state-hover focus-visible:bg-state-hover ${className}`}>
      {children}
    </select>
    <Icon name="ChevronDown" aria-hidden className={`pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 ${chevronClass}`} />
  </span>;
}
