import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type RailTab = "contents" | "notes";

/**
 * The column next to the plan text. In a wide container it is a sticky rail to the right with two tabs, "Contents" and
 * "Notes (n)"; in a narrow one it is two collapsible sections above the text (it comes after the text in the DOM and is
 * moved up with `order`). The container-query classes decide which it looks like. Without contents (compare mode)
 * only the notes are shown.
 */
export function PlanRail({
  contents,
  notes,
  noteCount,
  tab,
  onTab,
  notesOpen,
  onNotesToggle,
}: {
  /** The table of contents; null when there is none to show. */
  contents: ReactNode | null;
  notes: ReactNode;
  noteCount: number;
  tab: RailTab;
  onTab: (tab: RailTab) => void;
  notesOpen: boolean;
  onNotesToggle: () => void;
}) {
  const shown: RailTab = contents === null ? "notes" : tab;
  const label = `Notes (${noteCount})`;
  return (
    <aside
      aria-label="Plan sidebar"
      className="order-first w-full shrink-0 space-y-2 @[56rem]:sticky @[56rem]:top-0 @[56rem]:order-last @[56rem]:w-64 @[56rem]:self-start @[56rem]:border-l @[56rem]:border-border-hairline @[56rem]:pl-4"
    >
      {contents !== null ? (
        <div role="tablist" aria-label="Plan sidebar" className="hidden gap-1 @[56rem]:flex">
          {(["contents", "notes"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={shown === id}
              className={cn("rounded-sm px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground", shown === id && "bg-state-hover text-foreground")}
              onClick={() => onTab(id)}
            >
              {id === "contents" ? "Contents" : label}
            </button>
          ))}
        </div>
      ) : null}
      {contents !== null ? <div className={cn(shown !== "contents" && "@[56rem]:hidden")}>{contents}</div> : null}
      <section aria-label="Notes" className={cn(shown !== "notes" && "@[56rem]:hidden")}>
        <button type="button" aria-expanded={notesOpen} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground @[56rem]:hidden" onClick={onNotesToggle}>
          <Icon name={notesOpen ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
          {label}
        </button>
        <div className={cn("mt-1 @[56rem]:mt-0 @[56rem]:max-h-[calc(100vh-8rem)] @[56rem]:overflow-y-auto", !notesOpen && "hidden @[56rem]:block")}>{notes}</div>
      </section>
    </aside>
  );
}
