import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** The Scheduled clock shared by the main toolbar and the side-panel kanban header. */
export function ScheduledButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "size-7 shrink-0 text-muted-foreground hover:text-foreground max-md:pointer-coarse:size-9",
              active && "bg-state-active text-foreground",
            )}
            aria-label="Scheduled"
            aria-pressed={active}
            onClick={onClick}
          >
            <Icon name="Clock" className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Scheduled</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
