// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
afterEach(() => { cleanup(); localStorage.clear(); });
it('initializes from the saved chat and publishes selection and completion across trees', async () => {
  localStorage.setItem('bb-plugin-answers:page:selected', JSON.stringify('thr_saved'));
  vi.resetModules();
  const { useOpenChat, setOpenChat } = await import('./open-chat');
  function Reader() { const chat = useOpenChat(); return <span>{chat.threadId ?? 'none'}:{chat.revision}</span>; }
  const first = render(<Reader />), second = render(<Reader />);
  expect(first.container.textContent).toBe('thr_saved:0');
  act(() => setOpenChat('thr_next', true));
  expect(second.container.textContent).toBe('thr_next:1');
  act(() => setOpenChat('thr_next', true));
  expect(first.container.textContent).toBe('thr_next:1');
  act(() => setOpenChat('thr_next', false));
  expect(second.container.textContent).toBe('thr_next:2');
});
it('ignores malformed saved selections', async () => {
  localStorage.setItem('bb-plugin-answers:page:selected', '{broken');
  vi.resetModules();
  const { useOpenChat } = await import('./open-chat');
  function Reader() { return <span>{useOpenChat().threadId ?? 'none'}</span>; }
  expect(render(<Reader />).container.textContent).toBe('none');
});
it('follows the open chat\'s working state without a refetch until its turn completes', async () => {
  vi.resetModules();
  const { useOpenChat, setOpenChat } = await import('./open-chat');
  function Reader() { const chat = useOpenChat(); return <span>{chat.threadId}:{chat.revision}:{String(chat.working)}</span>; }
  const view = render(<Reader />);
  act(() => setOpenChat('thr_a', false)); expect(view.container.textContent).toBe('thr_a:1:false');
  act(() => setOpenChat('thr_a', true)); expect(view.container.textContent).toBe('thr_a:1:true');
  act(() => setOpenChat('thr_a', false)); expect(view.container.textContent).toBe('thr_a:2:false');
});
