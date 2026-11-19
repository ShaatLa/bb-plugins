// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, within, waitFor } from '@testing-library/react';
import { useOpenChat } from './open-chat';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
const split = vi.hoisted(() => ({ available: true, ids: [] as string[] }));
const item = { id: 'answers/answers', label: 'Answers', icon: { kind: 'plugin', pluginId: 'agent-hub', icon: null }, action: { kind: 'open-plugin-panel', pluginId: 'agent-hub', panelId: 'agent-hub' }, pluginId: 'agent-hub', isDisabled: false, isVisible: true, isLoading: false, shortcut: null, badge: null };
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), experimental_useSidebarNavigation: () => ({ items: [item] }), experimental_useSidebarNavigationSplit: (id: string, options?: { onDragStart?: () => void }) => { split.ids.push(id); return { isAvailable: split.available, splitProps: { onPointerDown: () => options?.onDragStart?.() } }; }, experimental_useSidebarThreadSplit: () => ({ splitProps: { 'data-thread-split': true } }) }));
afterEach(() => { cleanup(); localStorage.clear(); history.replaceState(null, '', '/'); split.available = true; split.ids = []; vi.useRealTimers(); });
const rows = ['one', 'two'].map(id => ({ threadId: `thr_${id}`, threadTitle: id, projectId: null, projectName: null, unread: 0, lastAt: 1, preview: id }));
const options = { rpc: { recipients: () => ({ recipients: rows }), list: () => ({ items: [], nextCursor: null }), counts: () => ({ unread: 0, waiting: 0, forMe: 0, inbox: 0 }) }, sdk: { threads: { queuedMessages: { list: async () => [] }, context: async () => ({ usage: null }) } } };
const props = { activeThreadId: null, activeProjectId: null, isCompactViewport: false, searchQuery: '', onNavigate: vi.fn() };
async function setup() {
  const app = await loadPluginApp(() => import('./app'));
  const sidebar = renderSlot(app.threadLists[0]!, props, options);
  await sidebar.findByRole('option', { name: /one/ });
  const page = () => renderSlot(app.navPanels[0]!, { subPath: '' }, options);
  return { sidebar, page };
}
const selected = (page: { container: HTMLElement }, name: string) => within(page.container).getByRole('option', { name: new RegExp(name) }).getAttribute('aria-selected');
it('uses the navigation item shape and consumes a drag before a link or saved selection', async () => {
  const { sidebar, page } = await setup();
  console.info('Answers navigation item:', item);
  localStorage.setItem('bb-plugin-answers:page:selected', JSON.stringify('thr_one'));
  history.replaceState(null, '', '/plugins/agent-hub/agent-hub?thread=thr_one');
  fireEvent.pointerDown(within(sidebar.container).getByRole('option', { name: /two/ }));
  const next = page();
  await waitFor(() => expect(selected(next, 'two')).toBe('true'));
  expect(split.ids).toContain(item.id);
  fireEvent.pointerUp(document.body);
  fireEvent.click(within(next.container).getByRole('option', { name: /one/ }));
  const later = page();
  await waitFor(() => expect(selected(later, 'one')).toBe('true'));
});
it('keeps page selections independent and sends sidebar clicks to the last interaction', async () => {
  const { sidebar, page } = await setup();
  function ChatState() { return <span>{useOpenChat().threadId}</span>; }
  const tabs = render(<ChatState />);
  const first = page(), second = page();
  fireEvent.click(await within(first.container).findByRole('option', { name: /one/ }));
  fireEvent.click(await within(second.container).findByRole('option', { name: /two/ }));
  expect(selected(first, 'one')).toBe('true');
  fireEvent.pointerDown(first.container.querySelector('section')!);
  fireEvent.click(within(sidebar.container).getByRole('option', { name: /two/ }));
  await waitFor(() => expect(selected(first, 'two')).toBe('true'));
  fireEvent.focusIn(second.container.querySelector('section')!);
  fireEvent.click(within(sidebar.container).getByRole('option', { name: /one/ }));
  expect(selected(first, 'two')).toBe('true');
  expect(selected(second, 'one')).toBe('true');
  expect(tabs.container.textContent).toBe('thr_one');
  fireEvent.focusIn(first.container.querySelector('section')!);
  expect(tabs.container.textContent).toBe('thr_two');
  expect(within(sidebar.container).getByRole('option', { name: /two/ }).getAttribute('aria-selected')).toBe('true');
  expect(sidebar.inspection.navigateCalls).toEqual([]);
});
it('applies an unconsumed drag after release to the last-interacted page', async () => {
  const { sidebar, page } = await setup();
  const first = page();
  fireEvent.click(await within(first.container).findByRole('option', { name: /one/ }));
  fireEvent.pointerDown(first.container.querySelector('section')!);
  fireEvent.pointerDown(within(sidebar.container).getByRole('option', { name: /two/ }));
  vi.useFakeTimers();
  fireEvent.pointerUp(document.body);
  act(() => vi.runOnlyPendingTimers());
  expect(selected(first, 'two')).toBe('true');
});
it.each(['Escape', 'pointercancel', 'blur', 'sidebar'])('clears a cancelled drag on %s', async cancel => {
  const { sidebar, page } = await setup();
  fireEvent.pointerDown(within(sidebar.container).getByRole('option', { name: /two/ }));
  if (cancel === 'Escape') fireEvent.keyDown(window, { key: 'Escape' }); else if (cancel === 'pointercancel') fireEvent.pointerCancel(window); else if (cancel === 'blur') fireEvent(window, new Event('blur')); else fireEvent.pointerUp(within(sidebar.container).getByRole('option', { name: /two/ }));
  const next = page();
  await within(next.container).findByRole('option', { name: /one/ });
  expect(selected(next, 'two')).toBe('false');
});
it('preserves thread split props when navigation split is unavailable', async () => {
  split.available = false;
  const { sidebar } = await setup();
  expect(within(sidebar.container).getByRole('option', { name: /one/ }).getAttribute('data-thread-split')).toBe('true');
});
it('lets a pane bb mounts just after the release claim the drag, leaving the existing pane alone', async () => {
  const { sidebar, page } = await setup();
  const first = page();
  fireEvent.click(await within(first.container).findByRole('option', { name: /one/ }));
  fireEvent.pointerDown(within(sidebar.container).getByRole('option', { name: /two/ }));
  fireEvent.pointerUp(document.body);
  await new Promise(resolve => setTimeout(resolve, 20));
  const next = page();
  await waitFor(() => expect(selected(next, 'two')).toBe('true'));
  await new Promise(resolve => setTimeout(resolve, 700));
  expect(selected(first, 'one')).toBe('true');
  expect(selected(next, 'two')).toBe('true');
});
