import { expect, it } from 'vitest';
import { money } from './cost';

const cost = (usd: number | null, over = {}) => ({ usd, tokens: { freshIn: 1500, cacheRead: 1_000_000, cacheWrite: 0, output: 500 }, estimated: false, partial: false, ...over });
it('shows API-equivalent dollars, marks estimates, and falls back to tokens', () => {
  expect(money(cost(1.234))).toBe('$1.23');
  expect(money(cost(1234.5, { partial: true }))).toBe('~$1,235');
  expect(money(cost(0.5, { estimated: true }))).toBe('~$0.50');
  expect(money(cost(null))).toBe('1.0M tokens');
});
