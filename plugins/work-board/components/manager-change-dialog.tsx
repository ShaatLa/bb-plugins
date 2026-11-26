import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export const NO_MANAGER = "No manager";

/** Replacing or removing a set manager waits here for the owner's confirmation; the card and the header share it. */
export function ManagerChangeDialog({ change, from, onCancel, onConfirm }: {
  change: { id: string; title: string } | null; from: string; onCancel: () => void; onConfirm: (id: string) => void;
}) {
  return (
    <Dialog open={change !== null} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{change?.id ? "Replace the manager thread?" : "Remove the manager thread?"}</DialogTitle>
          <DialogDescription>
            From {from} to {change?.title ?? NO_MANAGER}. Stale-status notices and copied PR messages go to the new manager.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" onClick={() => onConfirm(change!.id)}>
            {change?.id ? "Replace manager" : "Remove manager"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
