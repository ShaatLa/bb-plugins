import { useEffect, useState, type RefObject } from "react";
import { headingPath, type PlanHeading } from "../../shared/plan.js";
import { buildAnchor, type TextAnchor, type TextSpan } from "../../shared/plan-anchor.js";

// DOM side of plan note anchoring. The anchor text is the plain text of the rendered body, that is, the text
// nodes of the container in document order; the pure matching lives in shared/plan-anchor.ts.

/** The text nodes of `root` in document order; their concatenation is the plain text of the body. */
export function textNodesOf(root: Node): Text[] {
  const nodes: Text[] = [];
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

export const textOf = (root: Node): string => textNodesOf(root).map((node) => node.data).join("");

/** Offset in the plain text of `root` of a DOM point (a text node and an offset, or an element and a child index). */
export function textOffsetOf(root: Node, container: Node, offset: number): number | null {
  if (!root.contains(container)) return null;
  const nodes = textNodesOf(root);
  let before = 0;
  if (container.nodeType === Node.TEXT_NODE) {
    for (const node of nodes) {
      if (node === container) return before + offset;
      before += node.data.length;
    }
    return null;
  }
  // A point between children: it sits before the first text node that starts at or after it.
  const point = root.ownerDocument!.createRange();
  point.setStart(container, offset);
  point.collapse(true);
  for (const node of nodes) {
    if (point.comparePoint(node, 0) >= 0) return before;
    before += node.data.length;
  }
  return before;
}

/** The path of the nearest heading before (or around) `node`; `elements` pair with `headings` by index. */
export function headingPathAt(elements: readonly (Element | null)[], headings: readonly PlanHeading[], node: Node): string | null {
  for (let index = Math.min(elements.length, headings.length) - 1; index >= 0; index--) {
    const element = elements[index];
    if (element && (element === node || element.contains(node) || element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) return headingPath(headings[index]!);
  }
  return null;
}

export interface SelectionAnchor {
  anchor: TextAnchor;
  headingPath: string | null;
}

/** The anchor of a selection made inside `root`; null when it reaches outside, is collapsed or blank. */
export function anchorOfRange(root: Element, range: Range, elements: readonly (Element | null)[], headings: readonly PlanHeading[]): SelectionAnchor | null {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = textOffsetOf(root, range.startContainer, range.startOffset);
  const end = textOffsetOf(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  const anchor = buildAnchor(textOf(root), start, end);
  return anchor && { anchor, headingPath: headingPathAt(elements, headings, range.startContainer) };
}

/** A DOM range over a span of the plain text of `root`. */
export function rangeOfSpan(root: Element, span: TextSpan): Range | null {
  let from: { node: Text; offset: number } | null = null;
  let to: { node: Text; offset: number } | null = null;
  let before = 0;
  for (const node of textNodesOf(root)) {
    const length = node.data.length;
    if (!from && span.start < before + length) from = { node, offset: span.start - before };
    if (span.end <= before + length) {
      to = { node, offset: span.end - before };
      break;
    }
    before += length;
  }
  if (!from || !to) return null;
  const range = root.ownerDocument!.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** The plain text of the container, kept current while the editor renders into it. */
export function useBodyText(root: RefObject<HTMLElement | null>, contentKey: string): string {
  const [text, setText] = useState("");
  useEffect(() => {
    const element = root.current;
    if (!element) {
      setText("");
      return;
    }
    const read = () => setText(textOf(element));
    read();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(read);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [root, contentKey]);
  return text;
}

// The CSS Custom Highlight API paints ranges without touching the (read-only) editor DOM. Where it is missing
// (older engines, jsdom) notes simply stay unhighlighted; the list and the scroll to a note still work.
interface HighlightRegistry {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
}
const registry = (): HighlightRegistry | undefined => (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
const HighlightClass = (): (new (...ranges: Range[]) => unknown) | undefined => (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

export const NOTE_HIGHLIGHT = "wb-plan-note";
export const ACTIVE_NOTE_HIGHLIGHT = "wb-plan-note-active";

export function paintHighlight(name: string, ranges: readonly Range[]): void {
  const highlights = registry();
  const Highlight = HighlightClass();
  if (!highlights || !Highlight) return;
  if (ranges.length === 0) highlights.delete(name);
  else highlights.set(name, new Highlight(...ranges));
}

/** CSS for the two highlights; the colors fall back when the host theme has no warning token. */
export const NOTE_HIGHLIGHT_CSS = `
::highlight(${NOTE_HIGHLIGHT}) { background-color: color-mix(in srgb, var(--color-warning, var(--warning, #f59e0b)) 26%, transparent); }
::highlight(${ACTIVE_NOTE_HIGHLIGHT}) { background-color: color-mix(in srgb, var(--color-warning, var(--warning, #f59e0b)) 58%, transparent); }
`;
