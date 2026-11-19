import { useState } from "react";
import type { PlanNote } from "../../shared/contract.js";
import type { TextSpan } from "../../shared/plan-anchor.js";
import { noteKindLabel, noteLabel, type PlanNoteState } from "../../shared/plan-notes.js";
import type { Outcome, usePlanReviewActions } from "./notes-data.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const STATE_LABELS: Record<PlanNoteState, string> = { draft: "Draft", sent: "Sent", addressed: "Addressed", resolved: "Resolved" };
const STATE_TONES: Record<PlanNoteState, string> = {
  draft: "text-muted-foreground",
  sent: "border-warning/40 text-warning",
  addressed: "border-success/40 text-success",
  resolved: "text-muted-foreground",
};
const KIND_ICONS = { comment: ["MessageSquare", "File"], remove: ["Trash2", "X"], general: ["MessageCircle", "File"] } as const;

const chip = "inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-px text-2xs font-medium";

/** Placed notes by position in the text, then the ones whose quote is gone, then general ones; by number when positions are unknown. */
export function sortNotes(notes: readonly PlanNote[], placements: ReadonlyMap<string, TextSpan | null> | null): PlanNote[] {
  const rank = (note: PlanNote) => (note.kind === "general" ? 2 : placements?.get(note.id) ? 0 : placements ? 1 : 0);
  return [...notes].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    if (rank(a) === 0 && placements) return placements.get(a.id)!.start - placements.get(b.id)!.start || a.number - b.number;
    return a.number - b.number;
  });
}

type Actions = ReturnType<typeof usePlanReviewActions>;

function NoteBodyEditor({ note, actions, onDone }: { note: PlanNote; actions: Actions; onDone: () => void }) {
  const [text, setText] = useState(note.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const optional = note.kind === "remove";
  const save = async () => {
    setBusy(true);
    const result = await actions.update(note.id, text);
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.message);
  };
  return (
    <div className="mt-1.5 space-y-1.5">
      <Textarea
        aria-label={optional ? `Reason for ${noteLabel(note.number)} (optional)` : `Text of ${noteLabel(note.number)}`}
        autoFocus
        rows={3}
        value={text}
        placeholder={optional ? "Reason (optional)" : undefined}
        disabled={busy}
        className="min-h-16 text-xs"
        onChange={(event) => setText(event.target.value)}
      />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-1.5">
        <Button type="button" size="sm" className="h-6 px-2 text-2xs" disabled={busy || (!optional && text.trim() === "")} onClick={() => void save()}>Save</Button>
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" disabled={busy} onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function NoteItem({
  note,
  span,
  known,
  readOnly,
  editing,
  actions,
  onEdit,
  onJump,
  onHover,
}: {
  note: PlanNote;
  span: TextSpan | null | undefined;
  /** Whether the positions are known at all (the body is on screen). */
  known: boolean;
  readOnly: boolean;
  editing: boolean;
  actions: Actions;
  onEdit: (editing: boolean) => void;
  onJump: (noteId: string) => void;
  onHover: (noteId: string | null) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [kindIcon, kindFallback] = KIND_ICONS[note.kind];
  const unanchored = known && note.kind !== "general" && !span;
  const act = async (call: () => Promise<Outcome>) => {
    const result = await call();
    setError(result.ok ? null : result.message);
  };
  const head = (
    <>
      <span className="shrink-0 font-semibold">{noteLabel(note.number)}</span>
      <Icon name={kindIcon} fallback={kindFallback} className="mt-px size-3 shrink-0 text-muted-foreground" aria-label={noteKindLabel(note.kind)} />
      {note.exact ? <span className="line-clamp-1 min-w-0 flex-1 text-muted-foreground [overflow-wrap:anywhere]" title={note.exact}>“{note.exact}”</span> : <span className="flex-1 text-muted-foreground">General note</span>}
    </>
  );
  return (
    <li
      data-note={note.number}
      className="rounded-md border border-border bg-card p-2 text-xs"
      onMouseEnter={() => onHover(note.id)}
      onMouseLeave={() => onHover(null)}
    >
      {note.kind !== "general" && !unanchored ? (
        <button type="button" aria-label={`Show ${noteLabel(note.number)} in the plan`} className="flex w-full items-start gap-1.5 text-left" onClick={() => onJump(note.id)} onFocus={() => onHover(note.id)} onBlur={() => onHover(null)}>
          {head}
        </button>
      ) : (
        <div className="flex w-full items-start gap-1.5">{head}</div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className={cn(chip, STATE_TONES[note.state])}>{STATE_LABELS[note.state]}</span>
        {unanchored ? <span className={cn(chip, "text-muted-foreground")} title={`The quoted text is not in this version (the note was made on v${note.madeOnVersion})`}>Unanchored</span> : null}
        {note.kind === "remove" ? <span className="text-2xs text-muted-foreground">Remove this</span> : null}
      </div>
      {editing ? (
        <NoteBodyEditor note={note} actions={actions} onDone={() => onEdit(false)} />
      ) : note.body ? (
        <p className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">{note.body}</p>
      ) : null}
      {note.reply ? (
        <div className="mt-1.5 border-l-2 border-border pl-2">
          <p className="text-2xs text-muted-foreground">
            {note.replyBy ?? "Agent"}
            {note.addressedInVersion ? ` · addressed in v${note.addressedInVersion}` : " · replied"}
          </p>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{note.reply}</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-destructive">{error}</p> : null}
      {!readOnly && !editing ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {note.state === "draft" ? (
            <>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" aria-label={`Edit ${noteLabel(note.number)}`} onClick={() => onEdit(true)}>Edit</Button>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" aria-label={`Delete ${noteLabel(note.number)}`} onClick={() => void act(() => actions.remove(note.id))}>Delete</Button>
            </>
          ) : null}
          {note.state === "addressed" ? (
            <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-2xs" aria-label={`Resolve ${noteLabel(note.number)}`} onClick={() => void act(() => actions.setState(note.id, "resolved"))}>Resolve</Button>
          ) : null}
          {note.state === "addressed" || note.state === "resolved" ? (
            <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" aria-label={`Reopen ${noteLabel(note.number)}`} onClick={() => void act(() => actions.setState(note.id, "draft"))}>Reopen</Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The notes of a plan: quote, text, state, the agent's reply, and the owner's actions on them. */
export function PlanNotesList({
  notes,
  placements,
  readOnly,
  editingId,
  onEditingChange,
  actions,
  onJump,
  onHover,
}: {
  notes: readonly PlanNote[];
  placements: ReadonlyMap<string, TextSpan | null> | null;
  readOnly: boolean;
  editingId: string | null;
  onEditingChange: (noteId: string | null) => void;
  actions: Actions;
  onJump: (noteId: string) => void;
  onHover: (noteId: string | null) => void;
}) {
  if (notes.length === 0)
    return <p className="text-xs text-muted-foreground">{readOnly ? "No notes." : "No notes yet. Select text in the plan to comment on it, or add a general note."}</p>;
  return (
    <ul aria-label="Plan notes" className="space-y-1.5">
      {sortNotes(notes, placements).map((note) => (
        <NoteItem
          key={note.id}
          note={note}
          span={placements?.get(note.id)}
          known={placements !== null}
          readOnly={readOnly}
          editing={editingId === note.id}
          actions={actions}
          onEdit={(editing) => onEditingChange(editing ? note.id : null)}
          onJump={onJump}
          onHover={onHover}
        />
      ))}
    </ul>
  );
}
