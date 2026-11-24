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

it('reads a thread and message from Agent Hub links, bb message chips and same-origin URLs only', async () => {
  const { threadLink } = await import('./open-chat');
  expect(threadLink('/projects/pr_one/threads/thr_example?msg=12')).toEqual({ threadId: 'thr_example', seq: 12 });
  expect(threadLink('/threads/thr_example#msg=3')).toEqual({ threadId: 'thr_example', seq: 3 });
  expect(threadLink(`${window.location.origin}/threads/thr_example`)).toEqual({ threadId: 'thr_example', seq: null });
  expect(threadLink('https://example.com/threads/thr_example')).toBeNull();
  expect(threadLink('/threads/thr_example/files')).toBeNull();
  expect(threadLink('/plugins/agent-hub/agent-hub?thread=thr_example')).toBeNull();
});
it('opens the chat a ?thread= link names even when the page\'s first render is thrown away', async () => {
  vi.resetModules();
  const { ContactPageProvider, useSelectedContact } = await import('./open-chat');
  const { Suspense } = await import('react');
  window.history.replaceState(null, '', '/plugins/agent-hub/agent-hub?thread=thr_linked');
  function Reader() { return <span>{useSelectedContact() ?? 'none'}</span>; }
  // A part of the page that is still loading suspends the first render, which React throws away, as in bb's router.
  let loaded = false, release = () => {};
  const loading = new Promise<void>(resolve => { release = () => { loaded = true; resolve(); }; });
  function Loading() { if (!loaded) throw loading; return null; }
  const view = render(<Suspense fallback="…"><ContactPageProvider><Reader /><Loading /></ContactPageProvider></Suspense>);
  await act(async () => { release(); await loading; });
  expect(view.container.textContent).toBe('thr_linked');
  expect(window.location.search).toBe('');
});
