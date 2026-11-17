// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
afterEach(() => { cleanup(); localStorage.clear(); history.replaceState(null, '', '/'); });
const key = 'bb-plugin-answers:page:contacts-hidden';
const rpc = { recipients: () => ({ recipients: [{ threadId: 'thr_one', threadTitle: 'One', projectId: null, projectName: null, unread: 0, lastAt: 1, preview: '' }] }), list: () => ({ items: [], nextCursor: null }), counts: () => ({ unread: 0, waiting: 0, forMe: 0, inbox: 0 }) };
const sdk = { threads: { queuedMessages: { list: async () => [] }, context: async () => ({ usage: null }) } };
it('hides and restores the contacts column and resize handle only on wide screens', async () => {
  const app = await loadPluginApp(() => import('./app'));
  const page = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc, sdk });
  const column = () => page.container.querySelector('[data-contacts-column]')!;
  fireEvent.click(page.getByRole('button', { name: 'Hide contacts' }));
  expect(column().classList.contains('min-[640px]:hidden')).toBe(true);
  expect(column().hasAttribute('hidden')).toBe(false);
  expect(page.getByRole('separator', { name: 'Resize contacts' }).classList.contains('min-[640px]:hidden')).toBe(true);
  await waitFor(() => expect(localStorage.getItem(key)).toBe('true'));
  fireEvent.click(page.getByRole('button', { name: 'Show contacts' }));
  expect(column().classList.contains('min-[640px]:hidden')).toBe(false);
  await waitFor(() => expect(localStorage.getItem(key)).toBe('false'));
});
it('remembers hidden contacts across remounts and still accepts sidebar selections', async () => {
  history.replaceState(null, '', '/plugins/answers/answers');
  const app = await loadPluginApp(() => import('./app'));
  const first = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc, sdk });
  fireEvent.click(first.getByRole('button', { name: 'Hide contacts' }));
  first.unmount();
  const page = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc, sdk });
  expect(page.getByRole('button', { name: 'Show contacts' })).toBeTruthy();
  const sidebar = renderSlot(app.threadLists[0]!, { activeThreadId: null, activeProjectId: null, isCompactViewport: false, searchQuery: '', onNavigate: vi.fn() }, { rpc });
  fireEvent.click(await within(sidebar.container).findByRole('option', { name: /One/ }));
  await waitFor(() => expect(within(page.container).getByRole('option', { name: /One/ }).getAttribute('aria-selected')).toBe('true'));
  expect(page.container.querySelector('[data-contacts-column]')!.classList.contains('min-[640px]:hidden')).toBe(true);
});
