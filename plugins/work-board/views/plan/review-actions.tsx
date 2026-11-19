import { useState, type ReactNode } from "react";
import type { PlanState } from "../../shared/plan.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A tooltip that also works on a disabled control: the span keeps it reachable. */
function WithTooltip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A small form in a popover: a textarea, a confirm button and Cancel. `onSubmit` resolves to an error message or null. */
function NoteForm({ label, placeholder, confirm, required, intro, onSubmit, onClose }: { label: string; placeholder: string; confirm: string; required: boolean; intro?: ReactNode; onSubmit: (text: string) => Promise<string | null>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const failure = await onSubmit(text);
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  };
  return (
    <div className="space-y-2 text-xs">
      {intro}
      <Textarea aria-label={label} rows={3} value={text} disabled={busy} placeholder={placeholder} className="min-h-16 text-xs" onChange={(event) => setText(event.target.value)} />
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <div className="flex gap-1.5">
        <Button type="button" size="sm" className="h-7 px-2.5 text-xs" disabled={busy || (required && text.trim() === "")} onClick={() => void submit()}>{confirm}</Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2.5 text-xs" disabled={busy} onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

/** Icon button that opens a popover to write a note on the plan as a whole. */
export function GeneralNoteButton({ onAdd, inline = false }: { onAdd: (body: string) => Promise<string | null>; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      {inline ? (
        <PopoverTrigger asChild>
          <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline">add a general note</button>
        </PopoverTrigger>
      ) : (
        <TooltipProvider delayDuration={300}>
          <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className={cn("size-7 shrink-0 text-muted-foreground hover:text-foreground", open && "bg-state-hover text-foreground")} aria-label="Add general note">
                  <Icon name="MessageSquarePlus" fallback="MessageSquare" className="size-3.5" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Add general note</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <PopoverContent align="end" className="w-72 p-3" mobileTitle="General note">
        <NoteForm label="General note" placeholder="A note on the plan as a whole" confirm="Add note" required onSubmit={onAdd} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Sends every draft note to the agent in one message. */
export function SendFeedbackButton({ drafts, busy, onSend }: { drafts: number; busy: boolean; onSend: () => void }) {
  const button = (
    <Button type="button" size="sm" className="ml-1 h-7 px-2.5 text-xs" disabled={drafts === 0 || busy} onClick={onSend}>
      Send feedback ({drafts})
    </Button>
  );
  return drafts === 0 ? <WithTooltip text="Add a note first: select text in the plan or add a general note">{button}</WithTooltip> : button;
}

/** Approves the plan after a confirmation with an optional note; explains why it is disabled when it is. */
export function ApproveButton({ state, version, drafts, busy, onApprove }: { state: PlanState; version: number; drafts: number; busy: boolean; onApprove: (note: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const why = state === "approved" ? `Plan v${version} is already approved` : drafts > 0 ? `Send or delete the ${drafts} draft note${drafts === 1 ? "" : "s"} first` : null;
  const trigger = (
    <Button type="button" size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={why !== null || busy}>
      Approve
    </Button>
  );
  if (why) return <WithTooltip text={why}>{trigger}</WithTooltip>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3" mobileTitle="Approve plan">
        <NoteForm
          label="Approval note"
          placeholder="Note for the agent (optional)"
          confirm="Approve plan"
          required={false}
          intro={
            <div>
              <p className="font-medium">Approve plan v{version}?</p>
              <p className="text-muted-foreground">The agent is told to start work. A new version returns the plan to draft.</p>
            </div>
          }
          onSubmit={onApprove}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
