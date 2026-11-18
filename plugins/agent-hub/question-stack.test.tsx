// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@get-bb/plugin-sdk/app', () => ({ experimental_Icon: () => <span /> }));
import { QuestionStack, useQuestionStack } from './question-stack';
function Card() { const stack = useQuestionStack(); return <><button aria-expanded={!stack?.collapsed} onClick={stack?.toggle}>Question for you · 1</button><div hidden={stack?.collapsed}><div data-pending-title="First question">Body</div></div></>; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('collapses, expands and remembers only its thread', () => {
  const view = render(<QuestionStack threadId="thr_example"><Card /></QuestionStack>);
  const button = screen.getByRole('button', { name: 'Question for you · 1' });
  expect(button.textContent).toContain('Question for you · 1');
  expect(screen.queryByText('1 · First question')).toBeNull();
  fireEvent.click(button);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(true);
  view.unmount();
  const next = render(<QuestionStack threadId="thr_example"><Card /></QuestionStack>);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(true);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('Body').parentElement?.hidden).toBe(false);
  next.unmount();
  render(<QuestionStack threadId="thr_other"><Card /></QuestionStack>);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(false);
});
it('starts collapsed for a tall touch stack', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: window.innerHeight / 2 } as DOMRect);
  render(<QuestionStack threadId="thr_tall"><Card /></QuestionStack>);
  expect(screen.getByText('Body').parentElement?.hidden).toBe(true);
});
