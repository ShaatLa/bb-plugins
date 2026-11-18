import { expect, it } from 'vitest';
import { left } from './contacts-footer';

it('counts time to reset like the usage panels: minutes down, no zero hours', () => {
  const now = Date.parse('2026-11-13T00:00:00Z'), at = (minutes: number) => new Date(now + minutes * 60000).toISOString();
  expect(left(at(3 * 1440 + 20), now)).toBe('3d');
  expect(left(at(4 * 1440 + 16 * 60 + 5), now)).toBe('4d 16h');
  expect(left(at(5 * 60 - 0.5), now)).toBe('4h 59m');
  expect(left(at(120), now)).toBe('2h');
  expect(left(at(7), now)).toBe('7m');
});
