// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { money, ThreadCostLabel } from './cost';
afterEach(cleanup);

const cost = (usd: number | null, over = {}) => ({ usd, tokens: { freshIn: 1500, cacheRead: 1_000_000, cacheWrite: 0, output: 500 }, estimated: false, partial: false, ...over });
it('shows API-equivalent dollars, marks estimates, and falls back to tokens', () => {
  expect(money(cost(1.234))).toBe('$1.23');
  expect(money(cost(1234.5, { partial: true }))).toBe('~$1,235');
  expect(money(cost(0.5, { estimated: true }))).toBe('~$0.50');
  expect(money(cost(null))).toBe('1.0M tokens');
});

it('opens Tokenomos on click, leaving modified clicks alone', () => {
  window.history.replaceState(null, '', '/plugins/answers/answers');
  const moved = vi.fn(); window.addEventListener('popstate', moved);
  const view = render(<ThreadCostLabel cost={{ own: cost(0.8), total: cost(1.24), descendantCount: 3 }} />), label = view.getByRole('button', { name: /This session: \$0\.80/ });
  fireEvent.click(label, { metaKey: true }); expect(window.location.pathname).toBe('/plugins/answers/answers');
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
