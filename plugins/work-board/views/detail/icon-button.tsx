import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** The status card's one icon button: a ghost icon with its name as both the accessible label and the tooltip, as Queue's remove button always was. */
export function IconButton({ label, icon, disabled, onClick }: { label: string; icon: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button asChild size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground">
      <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon name={icon as never} className="size-3.5" /></button>
    </Button>
  );
}
