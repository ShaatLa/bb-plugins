import type { PlanHeading } from "../../shared/plan.js";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Table of contents of a plan: the "Contents" part of the rail (see PlanRail). In a wide container it is a plain list;
 * in a narrow one it is collapsible. The container-query classes decide which it looks like.
 */
export function PlanToc({
  headings,
  active,
  open,
  onToggle,
  onSelect,
}: {
  headings: readonly PlanHeading[];
  active: number | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (index: number) => void;
}) {
  if (headings.length === 0) return null;
  const top = Math.min(...headings.map((heading) => heading.level));
  return (
    <nav aria-label="Table of contents" className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground @[56rem]:hidden"
        onClick={onToggle}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
        Contents ({headings.length})
      </button>
      <ol className={cn("mt-1 space-y-0.5 @[56rem]:mt-0 @[56rem]:block @[56rem]:pl-3 @[56rem]:max-h-[calc(100vh-8rem)] @[56rem]:overflow-y-auto", !open && "hidden")}>
        {headings.map((heading, index) => (
          <li key={index} style={{ paddingLeft: (heading.level - top) * 12 }}>
            <button
              type="button"
              aria-current={active === index ? "location" : undefined}
              className={cn("block w-full truncate rounded-sm px-1.5 py-0.5 text-left text-muted-foreground hover:bg-state-hover hover:text-foreground", active === index && "bg-state-hover font-medium text-foreground")}
              title={heading.text}
              onClick={() => onSelect(index)}
            >
              {heading.text || "(untitled)"}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
