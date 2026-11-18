// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
afterEach(() => { cleanup(); localStorage.clear(); history.replaceState(null, '', '/'); });
const rows = ['one', 'two'].map(id => ({ threadId: `thr_${id}`, threadTitle: id, projectId: null, projectName: null, unread: 1, lastAt: Date.now(), preview: id }));
const rpc = { recipients: () => ({ recipients: rows }), list: () => ({ items: [], nextCursor: null }), counts: () => ({ unread: 2, waiting: 0, forMe: 0, inbox: 2 }), markThreadRead: () => ({ ok: true }) };
const props = { activeThreadId: null, activeProjectId: null, isCompactViewport: false, searchQuery: '', onNavigate: vi.fn() };
it('registers contacts, highlights the bb route and opens the Answers conversation', async () => {
  const app = await loadPluginApp(() => import('./app'));
  expect(app.threadLists[0]).toMatchObject({ id: 'answers', title: 'Agent Hub contacts' });
  const onNavigate = vi.fn(), slot = renderSlot(app.threadLists[0]!, { ...props, activeThreadId: 'thr_two', onNavigate }, { rpc });
  const list = within(await slot.findByRole('listbox', { name: 'Recipients' }));
  expect((await list.findByRole('option', { name: /two/ })).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(list.getByRole('option', { name: /one/ }));
  expect(JSON.parse(localStorage.getItem('bb-plugin-answers:page:selected')!)).toBe('thr_one');
  expect(slot.inspection.navigateCalls).toContainEqual({ method: 'toPluginPanel', path: 'answers', options: { subPath: '?thread=thr_one' } });
  expect(onNavigate).toHaveBeenCalledOnce();
});
it('selects in place from Questions and then changes the mounted conversation', async () => {
  history.replaceState(null, '', '/plugins/answers/answers');
  localStorage.setItem('bb-plugin-answers:page:questions', 'true');
  const app = await loadPluginApp(() => import('./app'));
  const page = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc, sdk: { threads: { queuedMessages: { list: async () => [] }, context: async () => ({ usage: null }) } } });
  const sidebar = renderSlot(app.threadLists[0]!, props, { rpc });
  for (const name of [/two/, /one/]) {
    fireEvent.click(await within(sidebar.container).findByRole('option', { name }));
    await waitFor(() => expect(within(page.container).getByRole('option', { name }).getAttribute('aria-selected')).toBe('true'));
  }
  expect(sidebar.inspection.navigateCalls).toEqual([]);
});
it('shows the unread count on the contact avatar, as messengers do', async () => {
  const app = await loadPluginApp(() => import('./app'));
  const slot = renderSlot(app.threadLists[0]!, props, { rpc });
  const badge = (await slot.findAllByLabelText('1 unread'))[0]!;
  // The badge sits in the avatar's corner wrapper, not at the end of the preview line.
  expect(badge.parentElement!.className).toContain('relative shrink-0');
  expect(badge.className).toContain('absolute');
});
