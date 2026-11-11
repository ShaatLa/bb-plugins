import TurndownService from 'turndown';
const markdown = new TurndownService({ codeBlockStyle: 'fenced', headingStyle: 'atx', bulletListMarker: '-' });
export function clipSelection(range: Range, body: HTMLElement) {
  if (!range.intersectsNode(body)) return null;
  const clipped = range.cloneRange(), bounds = document.createRange();
  bounds.selectNodeContents(body);
  if (clipped.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) clipped.setStart(bounds.startContainer, bounds.startOffset);
  if (clipped.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) clipped.setEnd(bounds.endContainer, bounds.endOffset);
  return clipped.collapsed ? null : clipped;
}
export function selectionMarkdown(range: Range, body: HTMLElement) {
  const clipped = clipSelection(range, body);
  if (!clipped) return '';
  try {
    let fragment: Node = clipped.cloneContents();
    let ancestor = clipped.commonAncestorContainer;
    if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentNode!;
    // Only the nearest list level is kept: outer levels of a nested list would quote as '- - text', and a bullet around
    // text from a single item is noise (an ordered item keeps its number).
    let inItem = false, listed = false;
    while (ancestor && ancestor !== body) {
      const tag = ancestor instanceof HTMLElement ? ancestor.tagName : '';
      const skip = /^(LI|OL|UL)$/.test(tag) && (listed || (tag === 'LI' && ancestor.parentElement?.tagName !== 'OL') || (tag === 'UL' && inItem));
      if (tag === 'LI') inItem = true; else if (tag === 'OL' || tag === 'UL') listed = true;
      if (!skip && ancestor instanceof HTMLElement && /^(STRONG|B|EM|I|A|CODE|PRE|LI|OL|UL|BLOCKQUOTE|H[1-6])$/.test(ancestor.tagName)) {
        const wrapper = ancestor.cloneNode(false) as HTMLElement;
        if (wrapper.tagName === 'OL') {
          const li = clipped.startContainer.nodeType === Node.ELEMENT_NODE ? clipped.startContainer as Element : clipped.startContainer.parentElement;
          const first = li?.closest('li');
          if (first?.parentElement === ancestor) wrapper.setAttribute('start', String(Number(ancestor.getAttribute('start') || 1) + Array.from(ancestor.children).indexOf(first)));
        }
        wrapper.append(fragment); fragment = wrapper;
      }
      ancestor = ancestor.parentNode!;
    }
    const container = document.createElement('div'); container.append(fragment);
    container.querySelectorAll('button,[aria-hidden="true"],[data-copy],svg').forEach(node => node.remove());
    return markdown.turndown(container.innerHTML).trim() || clipped.toString();
  } catch { return clipped.toString(); }
}
export function selectionPosition(range: Range, container: HTMLElement, width = 320) {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width && rect.height);
  const rect = rects.at(-1) ?? range.getBoundingClientRect(), bounds = container.getBoundingClientRect();
  const first = rects[0] ?? rect;
  // above: where the popup's bottom edge goes if it has to flip over the selection.
  return { top: rect.bottom - bounds.top + container.scrollTop + 6, above: first.top - bounds.top + container.scrollTop - 6, left: Math.max(8, Math.min(rect.left - bounds.left, container.clientWidth - width - 8)) };
}
