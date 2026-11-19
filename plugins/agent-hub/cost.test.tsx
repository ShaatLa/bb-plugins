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

it('opens Tokenomos on click, leaving modified clicks alone', () => {
  window.history.replaceState(null, '', '/plugins/agent-hub/agent-hub');
  const moved = vi.fn(); window.addEventListener('popstate', moved);
  const view = render(<ThreadCostLabel cost={{ own: cost(0.8), total: cost(1.24), descendantCount: 3 }} />), label = view.getByRole('button', { name: /This session: \$0\.80/ });
  fireEvent.click(label, { metaKey: true }); expect(window.location.pathname).toBe('/plugins/agent-hub/agent-hub');
  fireEvent.click(label); expect(window.location.pathname).toBe('/plugins/tokenomos/tokenomos'); expect(moved).toHaveBeenCalledOnce();
  window.removeEventListener('popstate', moved);
});
it('shows the sub-sessions as a delta and hides it when it rounds to nothing', () => {
  const tokens = (n: number) => ({ freshIn: n, cacheRead: 0, cacheWrite: 0, output: 0 });
  const view = render(<ThreadCostLabel cost={{ own: cost(0.8), total: cost(1.24), descendantCount: 3 }} />);
  expect(view.getByRole('button').textContent).toBe('$0.80· +$0.44 in 3 subs'); cleanup();
  const same = render(<ThreadCostLabel cost={{ own: cost(14.2, { tokens: tokens(100) }), total: cost(14.3, { tokens: tokens(120) }), descendantCount: 1 }} />);
  expect(same.getByRole('button').textContent).toBe('$14');
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
