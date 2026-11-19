import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PlanHeading } from "../../shared/plan.js";
import type { PlanNoteKind } from "../../shared/plan-notes.js";
import { anchorOfRange, type SelectionAnchor } from "./anchors.js";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface Selected extends SelectionAnchor {
  /** Viewport position of the selection: its horizontal middle, its bottom edge (`y`) and its top edge. */
  x: number;
  y: number;
  top: number;
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
  return { ...found, x: rect.left + rect.width / 2, y: rect.bottom, top: rect.top };
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

const MARGIN = 8;
const GAP = 6;

/**
 * Where a floating box of `size` goes for a selection, in viewport coordinates: centered under the selection, kept
 * inside the viewport on both axes, and above the selection when there is no room below it.
 */
export function placeFloating(
  at: { x: number; y: number; top?: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(MARGIN, Math.min(at.x - size.width / 2, viewport.width - size.width - MARGIN));
  const below = at.y + GAP;
  const above = (at.top ?? at.y) - GAP - size.height;
  const fitsBelow = below + size.height <= viewport.height - MARGIN;
  const wanted = fitsBelow || above < MARGIN ? below : above;
  return { left, top: Math.max(MARGIN, Math.min(wanted, viewport.height - size.height - MARGIN)) };
}

/**
 * Renders floating controls into `document.body`. A `position: fixed` box inside the panel would be placed against an
 * ancestor with layout containment (container queries, transforms) instead of the viewport. The wrapper carries the
 * plugin scope that bb's stylesheet needs.
 */
function Floating({ children }: { children: ReactNode }) {
  return createPortal(<div data-bb-plugin="work-board">{children}</div>, document.body);
}

/** Calls `onClose` on Escape and on a press outside `ref`. */
function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current();
    };
    const press = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) latest.current();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", press);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", press);
    };
  }, [ref]);
}

// shortcut: the popover height is an estimate (quote, three-row textarea, buttons); measure it if the content grows.
const TOOLBAR_SIZE = { width: 168, height: 36 };
const POPOVER_SIZE = { width: 280, height: 176 };
const viewportSize = () => ({ width: window.innerWidth, height: window.innerHeight });

/** "Comment" and "Remove" under a selection. The buttons keep the selection alive (no focus change on press). */
export function SelectionToolbar({ selected, onPick, onClose }: { selected: Selected; onPick: (kind: Extract<PlanNoteKind, "comment" | "remove">) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose);
  return (
    <Floating>
        <div
          ref={ref}
          role="toolbar"
          aria-label="Note on selection"
          style={{ position: "fixed", ...placeFloating(selected, TOOLBAR_SIZE, viewportSize()), width: TOOLBAR_SIZE.width }}
          className="z-50 flex gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          onMouseDown={(event) => event.preventDefault()}
        >
          <Button type="button" size="sm" variant="ghost" className="h-7 flex-1 px-2 text-xs" onClick={() => onPick("comment")}>Comment</Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 flex-1 px-2 text-xs" onClick={() => onPick("remove")}>Remove</Button>
        </div>
    </Floating>
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
  at: { x: number; y: number; top: number };
  onAdd: (body: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onCancel);
  const add = async () => {
    setBusy(true);
    const failure = await onAdd(text);
    setBusy(false);
    if (failure) setError(failure);
  };
  return (
    <Floating>
      <div
        ref={ref}
        role="dialog"
        aria-label="Add note"
        style={{ position: "fixed", ...placeFloating(at, POPOVER_SIZE, viewportSize()), width: POPOVER_SIZE.width }}
        className="z-50 space-y-2 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
      >
        <p className="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">“{quote}”</p>
        <Textarea aria-label="Note" autoFocus rows={3} value={text} disabled={busy} placeholder="Your comment" className="min-h-16 text-xs" onChange={(event) => setText(event.target.value)} />
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <div className="flex gap-1.5">
          <Button type="button" size="sm" className="h-6 px-2 text-2xs" disabled={busy || text.trim() === ""} onClick={() => void add()}>Add note</Button>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-2xs" disabled={busy} onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </Floating>
  );
}
