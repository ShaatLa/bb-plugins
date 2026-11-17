import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";

/** Shared chevron look for disclosures and selects: one size, the control border color (same token as border-input). */
export const chevronClass = "size-3.5 shrink-0 text-input";

/** Disclosure summary with BB's chevron instead of the native filled triangle (same pattern as Work Board). */
export function Summary({ className, children }: { className?: string; children: ReactNode }) {
  return <summary className={cn("flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden", className)}>
    {/* Rotates only for its own <details>: nested disclosures keep their own state. */}
    <Icon name="ChevronRight" aria-hidden className={cn(chevronClass, "transition-transform motion-reduce:transition-none [details[open]>summary>&]:rotate-90")} />
    {children}
  </summary>;
}
