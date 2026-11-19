// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { money, ThreadCostLabel, useThreadCost } from './cost';
afterEach(cleanup);

const cost = (usd: number | null, over = {}) => ({ usd, tokens: { freshIn: 1500, cacheRead: 1_000_000, cacheWrite: 0, output: 500 }, estimated: false, partial: false, ...over });
it('shows API-equivalent dollars, marks estimates, and falls back to tokens', () => {
  expect(money(cost(1.234))).toBe('$1.23');
  expect(money(cost(1234.5, { partial: true }))).toBe('~$1,235');
  expect(money(cost(0.5, { estimated: true }))).toBe('~$0.50');
  expect(money(cost(null))).toBe('1.0M tokens');
});

const own = { threadId: 'thr_a', own: cost(0.8), total: cost(1.24), descendantCount: 3 };
const details = { available: true, today: cost(0.3), week: cost(2.5), models: [1, 2, 3, 4, 5, 6, 7].map(i => ({ provider: 'p', model: `model-${i}`, cost: cost(i), calls: 1 })) };
async function open(rpc: unknown) {
  const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
  const slot = renderSlot({ component: () => <ThreadCostLabel cost={own} /> }, { threadId: 'thr_a' }, { rpc: { threadCostDetails: rpc } } as never);
  return slot;
}
it('shows only the own cost on the chip and toggles the details dialog on click, leaving modified clicks alone', async () => {
  const rpc = vi.fn(() => details), slot = await open(rpc), chip = slot.getByRole('button', { name: /This session: \$0\.80/ });
  expect(chip.textContent).toBe('$0.80'); expect(chip.getAttribute('aria-haspopup')).toBe('dialog'); expect(chip.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(chip, { metaKey: true }); expect(slot.queryByRole('dialog')).toBeNull();
  fireEvent.click(chip);
  const dialog = slot.getByRole('dialog', { name: 'Cost details' }), text = () => dialog.textContent ?? '';
  expect(chip.getAttribute('aria-expanded')).toBe('true');
  expect(text()).toContain('This session$0.80'); expect(text()).toContain('Sub-sessions (3)$0.44'); expect(text()).toContain('Total$1.24');
  await waitFor(() => expect(text()).toContain('Today$0.30')); expect(text()).toContain('Last 7 days$2.50');
  expect(text()).toContain('model-1$1.00 · 4%'); expect(text()).not.toContain('model-6'); expect(text()).toContain('Other$13 · 46%');
  expect(text()).not.toContain('Open Tokenomos'); expect(slot.queryByRole('button', { name: 'Open Tokenomos' })).toBeNull();
  const donut = slot.getByRole('img', { name: /model-1 4%.*model-5 18%.*Other 46%/ });
  expect(donut.querySelectorAll('circle')).toHaveLength(6); expect(donut.getAttribute('aria-label')).not.toContain('model-6');
  expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thr_a' }));
  fireEvent.click(chip); expect(slot.queryByRole('dialog')).toBeNull();
});
it('grows the hovered slice and marks its legend row, from either side', async () => {
  const slot = await open(vi.fn(() => details)); fireEvent.click(slot.getByRole('button', { name: /This session/ }));
  await waitFor(() => expect(slot.container.ownerDocument.querySelector('[data-slice="model-1"]')).not.toBeNull());
  const doc = slot.container.ownerDocument, slice = (n: string) => doc.querySelector(`[data-slice="${n}"]`)!, row = (n: string) => doc.querySelector(`[data-legend="${n}"]`)!;
  fireEvent.mouseEnter(slice('model-1'));
  expect(slice('model-1').getAttribute('stroke-width')).toBe('12'); expect(row('model-1').hasAttribute('data-hot')).toBe(true); expect(slice('model-2').getAttribute('stroke-width')).toBe('10');
  fireEvent.mouseLeave(slice('model-1')); fireEvent.mouseEnter(row('Other'));
  expect(slice('Other').getAttribute('stroke-width')).toBe('12'); expect(row('model-1').hasAttribute('data-hot')).toBe(false);
});
it('closes the details on Escape and on a click outside', async () => {
  const slot = await open(() => details), chip = slot.getByRole('button');
  fireEvent.click(chip); fireEvent.keyDown(document, { key: 'Escape' }); expect(slot.queryByRole('dialog')).toBeNull();
  fireEvent.click(chip); fireEvent.mouseDown(document.body); expect(slot.queryByRole('dialog')).toBeNull();
});
it('says details are unavailable when the read fails', async () => {
  const slot = await open(() => { throw new Error('down'); });
  fireEvent.click(slot.getByRole('button'));
  await waitFor(() => expect(slot.getByRole('dialog').textContent).toContain('Details unavailable'));
});
it('never renders the previous thread cost after switching', async () => {
  const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
  const seen: unknown[] = [];
  function Probe({ threadId }: { threadId: string }) { const value = useThreadCost(threadId, false); seen.push(value); return <span>{value?.own.usd}</span>; }
  const slot = renderSlot({ component: Probe }, { threadId: 'cost_first' }, { rpc: { threadCost: () => ({ available: true, own: cost(7), total: cost(7), descendantCount: 0 }) } });
  await waitFor(() => expect(slot.getByText('7')).toBeTruthy());
  seen.length = 0;
  slot.rerender(<Probe threadId="cost_second" />);
  expect(seen[0]).toBeNull();
});

it('reads the cost of a chat that is busy when opened, once', async () => {
  const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
  const read = vi.fn(() => ({ available: true, own: cost(5), total: cost(5), descendantCount: 0 }));
  function Probe() { const value = useThreadCost('cost_busy', true); return <span>{value?.own.usd ?? 'none'}</span>; }
  const slot = renderSlot({ component: Probe }, { threadId: 'cost_busy' }, { rpc: { threadCost: read } });
  await waitFor(() => expect(slot.getByText('5')).toBeTruthy());
  slot.rerender(<Probe />); expect(read).toHaveBeenCalledTimes(1);
});

it('rolls only the changed characters of the cost: the new one in from above, the old one out below', async () => {
  const { RollingText } = await import('./rolling-text');
  const runs: { frames: Keyframe[]; animation: { onfinish: (() => void) | null } }[] = [];
  const animate = vi.fn(function (frames: Keyframe[]) { const animation = { onfinish: null as (() => void) | null }; runs.push({ frames, animation }); return animation; });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  try {
    const view = render(<RollingText text="$472" />);
    expect(view.container.textContent).toBe('$472'); expect(animate).not.toHaveBeenCalled();
    view.rerender(<RollingText text="$480" />);
    // Two changed digits, two animations each (in and out); '$' and '4' stay.
    expect(animate).toHaveBeenCalledTimes(4);
    expect(runs.map(r => (r.frames[0] as { transform: string }).transform)).toEqual(['translateY(-100%)', 'translateY(0)', 'translateY(-100%)', 'translateY(0)']);
    expect(view.container.querySelectorAll('[data-rolling]')).toHaveLength(2);
    runs.forEach(r => r.animation.onfinish?.());
    await waitFor(() => expect(view.container.querySelectorAll('[data-rolling]')).toHaveLength(0));
    expect(view.container.textContent).toBe('$480');
  } finally { delete (HTMLElement.prototype as { animate?: unknown }).animate; }
});
