import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";

/**
 * The summary row of a collapsible `<details>` section in the Evidence style: a chevron that turns when open and no
 * native marker. The chevron follows only its own `<details>`, so nested sections do not turn each other's chevrons.
 */
export function DisclosureSummary({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden ${className}`}>
      <Icon name="ChevronRight" aria-hidden className="size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none [details[open]>summary>&]:rotate-90" />
      {children}
    </summary>
  );
}
