import { useEffect, useRef, useState, type RefObject } from "react";
import type { PlanHeading } from "../../shared/plan.js";
import type { PlanNoteKind } from "../../shared/plan-notes.js";
import { anchorOfRange, type SelectionAnchor } from "./anchors.js";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface Selected extends SelectionAnchor {
  /** Viewport position under the selection, for the floating controls. */
  x: number;
  y: number;
}

const emptyRect = { left: 0, top: 0, width: 0, bottom: 0 };

/** The anchor of the current document selection when it lies inside `root`. */
function currentSelection(root: Element, elements: readonly (Element | null)[], headings: readonly PlanHeading[]): Selected | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const found = anchorOfRange(root, range, elements, headings);
  if (!found) return null;
  // jsdom has no layout; a range there reports no rectangle.
  const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : emptyRect;
  return { ...found, x: rect.left + rect.width / 2, y: rect.bottom };
}

/**
 * Follows the text selection inside the plan body. While the pointer is down (a drag in progress) nothing is reported,
 * so the toolbar appears when the selection is complete.
 */
export function useBodySelection(root: RefObject<HTMLElement | null>, enabled: boolean, elements: readonly (Element | null)[], headings: readonly PlanHeading[]): [Selected | null, () => void] {
  const [selected, setSelected] = useState<Selected | null>(null);
  const latest = useRef({ elements, headings });
  latest.current = { elements, headings };
  useEffect(() => {
    if (!enabled) {
      setSelected(null);
      return;
    }
    let dragging = false;
    const update = () => {
      const element = root.current;
      setSelected(element && !dragging ? currentSelection(element, latest.current.elements, latest.current.headings) : null);
    };
    const down = (event: Event) => {
      if (root.current?.contains(event.target as Node)) dragging = true;
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      update();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [root, enabled]);
  return [selected, () => setSelected(null)];
}

/** Viewport-fixed box below a point, kept inside the window. */
function place(x: number, y: number, width: number): React.CSSProperties {
  const left = Math.max(8, Math.min(x - width / 2, (typeof window === "undefined" ? 1200 : window.innerWidth) - width - 8));
  return { position: "fixed", left, top: y + 6, width };
}

/** "Comment" and "Remove" under a selection. The buttons keep the selection alive (no focus change on press). */
export function SelectionToolbar({ selected, onPick }: { selected: Selected; onPick: (kind: Extract<PlanNoteKind, "comment" | "remove">) => void }) {
  return (
    <div
      role="toolbar"
      aria-label="Note on selection"
      style={place(selected.x, selected.y, 168)}
      className="z-50 flex gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button type="button" size="sm" variant="ghost" className="h-7 flex-1 px-2 text-xs" onClick={() => onPick("comment")}>Comment</Button>
      <Button type="button" size="sm" variant="ghost" className="h-7 flex-1 px-2 text-xs" onClick={() => onPick("remove")}>Remove</Button>
    </div>
  );
}

/** The inline popover for writing a comment on a selected passage. */
export function CommentPopover({
  quote,
  at,
  onAdd,
  onCancel,
}: {
  quote: string;
  at: { x: number; y: number };
  onAdd: (body: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    const failure = await onAdd(text);
    setBusy(false);
    if (failure) setError(failure);
  };
  return (
    <div
      role="dialog"
      aria-label="Add note"
      style={place(at.x, at.y, 280)}
      className="z-50 space-y-2 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <p className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">“{quote}”</p>
      <Textarea aria-label="Note" autoFocus rows={3} value={text} disabled={busy} placeholder="Your comment" className="min-h-16 text-xs" onChange={(event) => setText(event.target.value)} />
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <div className="flex gap-1.5">
        <Button type="button" size="sm" className="h-6 px-2 text-2xs" disabled={busy || text.trim() === ""} onClick={() => void add()}>Add note</Button>
        <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
