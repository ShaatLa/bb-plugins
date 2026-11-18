// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@get-bb/plugin-sdk/app', () => ({ experimental_Icon: () => <span /> }));
import { QuestionStack } from './question-stack';
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('collapses, expands and remembers only its thread', () => {
  const view = render(<QuestionStack threadId="thr_example"><div data-pending-title="First question">Body</div></QuestionStack>);
  const button = screen.getByRole('button', { name: 'Pending questions and approvals' });
  expect(button.textContent).toContain('1 · First question');
  expect(button.className).toContain('answers-hit');
  fireEvent.click(button);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(true);
  view.unmount();
  const next = render(<QuestionStack threadId="thr_example"><div data-pending-title="First question">Body</div></QuestionStack>);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(true);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Body').parentElement?.hidden).toBe(false);
  next.unmount();
  render(<QuestionStack threadId="thr_other"><div data-pending-title="Other">Body</div></QuestionStack>);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(false);
});
it('starts collapsed for a tall touch stack', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: window.innerHeight / 2 } as DOMRect);
  render(<QuestionStack threadId="thr_tall"><div data-pending-title="Tall">Body</div></QuestionStack>);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(true);
});
