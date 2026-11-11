// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { clipSelection, selectionMarkdown, selectionPosition } from './selection';
function selected(html: string, selector: string, start = 0, end?: number) {
  document.body.innerHTML = `<main>${html}</main>`;
  const body = document.querySelector('main')!, node = body.querySelector(selector)!.firstChild!;
  const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end ?? node.textContent!.length);
  return { body, range };
}
describe('selection snapshots', () => {
  it.each([['<strong>bold</strong>', 'strong', '**bold**'], ['<a href="https://example.com">link</a>', 'a', '[link](https://example.com)'], ['<code>code</code>', 'code', '`code`']])('preserves ancestors in %s', (html, selector, expected) => {
    const { body, range } = selected(html, selector); expect(selectionMarkdown(range, body)).toBe(expected);
  });
  it('keeps partial ordered list numbering', () => {
    const { body, range } = selected('<ol start="4"><li>first</li><li>second</li></ol>', 'li:nth-child(2)', 1, 5);
    expect(selectionMarkdown(range, body)).toBe('5.  econ');
  });
  it('quotes text from one nested bullet without list markers, and a multi-item selection as one list level', () => {
    document.body.innerHTML = '<main><ul><li>outer<ul><li><strong>Bold</strong> inner text</li><li>next item</li></ul></li></ul></main>';
    const body = document.querySelector('main')!, [first, second] = Array.from(body.querySelectorAll('li li'));
    const bold = first.querySelector('strong')!.firstChild!, rest = first.lastChild!, next = second.firstChild!;
    const one = document.createRange(); one.setStart(bold, 0); one.setEnd(rest, 6);
    expect(selectionMarkdown(one, body)).toBe('**Bold** inner');
    const two = document.createRange(); two.setStart(rest, 1); two.setEnd(next, 4);
    expect(selectionMarkdown(two, body)).toMatch(/^- +inner text\n- +next$/);
  });
  it('drops renderer chrome and falls back when conversion is empty', () => {
    const { body, range } = selected('<div>text<button>Copy</button><svg>icon</svg><i aria-hidden="true">hidden</i></div>', 'div');
    range.selectNodeContents(body); expect(selectionMarkdown(range, body)).toBe('text');
    body.innerHTML = '<button>Copy</button>'; range.selectNodeContents(body); expect(selectionMarkdown(range, body)).toBe('Copy');
  });
  it('clips a selection to the message body', () => {
    document.body.innerHTML = '<aside>before</aside><main>inside</main><aside>after</aside>';
    const range = document.createRange(); range.selectNodeContents(document.body);
    expect(clipSelection(range, document.querySelector('main')!)?.toString()).toBe('inside');
  });
  it('anchors under the final line inside scroll content and clamps horizontally', () => {
    const { body, range } = selected('<b>two lines</b>', 'b');
    Object.defineProperty(range, 'getClientRects', { value: () => ([{ left: 10, top: 15, bottom: 25, width: 100, height: 10 }, { left: 450, bottom: 55, width: 20, height: 10 }] as any) });
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 10 } as DOMRect);
    Object.defineProperty(body, 'clientWidth', { value: 500 }); body.scrollTop = 100;
    expect(selectionPosition(range, body)).toEqual({ top: 151, above: 99, left: 172 });
  });
});
